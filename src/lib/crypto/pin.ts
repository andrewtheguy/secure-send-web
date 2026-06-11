import {
  PIN_LENGTH,
  PIN_CHARSET,
  PIN_WORDLIST,
  NOSTR_FIRST_CHARSET,
  QR_FIRST_CHARSET,
  PIN_CHECKSUM_LENGTH,
  PIN_HINT_LENGTH,
  PIN_HINT_SALT,
  PIN_HINT_BUCKET_SEC,
  PIN_HINT_ITERATIONS,
} from './constants'
import { importPinKey } from './kdf'
import { wipeBufferSource } from './memory'

/**
 * Compute checksum character using weighted sum
 * Detects single-character errors and transpositions
 */
function computeChecksum(data: string): string {
  let sum = 0
  for (let i = 0; i < data.length; i++) {
    const charIndex = PIN_CHARSET.indexOf(data[i])
    sum += charIndex * (i + 1) // Weight by position
  }
  return PIN_CHARSET[sum % PIN_CHARSET.length]
}


/**
 * Generate random character from a charset using rejection sampling
 */
function randomCharFromCharset(charset: string): string {
  const n = charset.length
  const maxMultiple = Math.floor(256 / n) * n
  const buffer = new Uint8Array(2)

  while (true) {
    crypto.getRandomValues(buffer)
    for (const byte of buffer) {
      if (byte < maxMultiple) {
        return charset[byte % n]
      }
    }
  }
}


/**
 * Generate random PIN with checksum with signaling method encoded in first character
 * Charset excludes confusing characters: I, O, i, l, o, 0, 1
 * Uses rejection sampling to eliminate modulo bias
 * Last character is a checksum for typo detection
 * - Uppercase first char (A-Z excluding I,L,O) = Nostr
 * - '2' first char = QR/Manual
 */
export function generatePinForMethod(method: 'nostr' | 'manual'): string {
  const firstCharset = method === 'nostr' ? NOSTR_FIRST_CHARSET : QR_FIRST_CHARSET

  const dataLength = PIN_LENGTH - PIN_CHECKSUM_LENGTH

  // Generate first character from method-specific charset
  const firstChar = randomCharFromCharset(firstCharset)

  // Generate remaining characters from full charset
  const n = PIN_CHARSET.length
  const maxMultiple = Math.floor(256 / n) * n
  const remainingLength = dataLength - 1

  const result: string[] = [firstChar]
  const buffer = new Uint8Array(remainingLength * 2)

  while (result.length < dataLength) {
    crypto.getRandomValues(buffer)
    for (const byte of buffer) {
      if (byte < maxMultiple) {
        result.push(PIN_CHARSET[byte % n])
        if (result.length === dataLength) break
      }
    }
  }

  const data = result.join('')
  const checksum = computeChecksum(data)
  return data + checksum
}

/**
 * Detect signaling method from PIN's first character
 * - Uppercase = Nostr
 * - '2' = QR/Manual
 * - Other = null (reserved for future protocols)
 */
export function detectSignalingMethod(pin: string): 'nostr' | 'manual' | null {
  if (!pin || pin.length === 0) return null
  const firstChar = pin[0]
  if (QR_FIRST_CHARSET.includes(firstChar)) return 'manual'
  if (NOSTR_FIRST_CHARSET.includes(firstChar)) return 'nostr'
  return null // Reserved for future protocols
}

/**
 * Validate PIN format and checksum
 */
export function isValidPin(pin: string): boolean {
  if (pin.length !== PIN_LENGTH) return false
  if (![...pin].every((char) => PIN_CHARSET.includes(char))) return false

  // Verify checksum
  const data = pin.slice(0, PIN_LENGTH - PIN_CHECKSUM_LENGTH)
  const expectedChecksum = computeChecksum(data)
  const actualChecksum = pin.slice(-PIN_CHECKSUM_LENGTH)
  return expectedChecksum === actualChecksum
}

/**
 * Convert alphanumeric PIN to word-based PIN (7 words using BIP-39)
 */
export function pinToWords(pin: string): string[] {
  if (!pin) return Array(7).fill('')

  const charsetSize = BigInt(PIN_CHARSET.length)
  const wordlistSize = BigInt(PIN_WORDLIST.length)

  // Convert PIN (base 69) to BigInt
  let num = BigInt(0)
  for (let i = 0; i < pin.length; i++) {
    const charIndex = PIN_CHARSET.indexOf(pin[i])
    if (charIndex === -1) return Array(7).fill('')
    num = num * charsetSize + BigInt(charIndex)
  }

  // Convert BigInt to words (base 2048)
  const result: string[] = []
  for (let i = 0; i < 7; i++) {
    const wordIndex = Number(num % wordlistSize)
    result.unshift(PIN_WORDLIST[wordIndex])
    num = num / wordlistSize
  }

  return result
}

/**
 * Convert 7-word PIN back to 12-character alphanumeric PIN
 */
export function wordsToPin(words: string[]): string {
  if (words.length === 0 || words.every(w => !w)) return ''

  const charsetSize = BigInt(PIN_CHARSET.length)
  const wordlistSize = BigInt(PIN_WORDLIST.length)

  // Convert words (base 2048) back to BigInt
  let num = BigInt(0)
  for (const word of words) {
    const wordIndex = PIN_WORDLIST.indexOf(word.toLowerCase())
    if (wordIndex === -1) return ''
    num = num * wordlistSize + BigInt(wordIndex)
  }

  // Convert BigInt back to PIN (base 69)
  const result: string[] = []
  for (let i = 0; i < PIN_LENGTH; i++) {
    const charIndex = Number(num % charsetSize)
    result.unshift(PIN_CHARSET[charIndex])
    num = num / charsetSize
  }

  return result.join('')
}

/**
 * Check if a word is in the PIN wordlist
 */
export function isValidPinWord(word: string): boolean {
  if (!word) return false
  return PIN_WORDLIST.includes(word.toLowerCase())
}

/**
 * Salt for the PIN hint KDF, scoped to a time bucket.
 *
 * `bucketOffset` counts buckets backwards from the current one: 0 = the current
 * bucket, 1 = the previous bucket, etc. The receiver derives offset 0 and offset 1
 * so it can match a hint the sender published just before a bucket rollover (the
 * same look-back the QR signaling parser does for its per-bucket XOR obfuscation).
 */
function pinHintSalt(bucketOffset: number): string {
  const bucket = Math.floor(Date.now() / 1000 / PIN_HINT_BUCKET_SEC) - bucketOffset
  return `${PIN_HINT_SALT}:${bucket}`
}

/**
 * Derive PIN_HINT_LENGTH hex chars from a salted PBKDF2-SHA-256 derivation of the PIN,
 * using already-imported PBKDF2 key material and an explicit salt string.
 */
async function derivePinBits(keyMaterial: CryptoKey, saltStr: string): Promise<string> {
  const encoder = new TextEncoder()

  // Each byte produces 2 hex chars; ceil handles odd PIN_HINT_LENGTH
  const byteCount = Math.ceil(PIN_HINT_LENGTH / 2)
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: encoder.encode(saltStr),
      iterations: PIN_HINT_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    byteCount * 8,
  )

  const hex = Array.from(new Uint8Array(derivedBits))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

  // Truncate to exact length (needed if PIN_HINT_LENGTH is odd)
  return hex.slice(0, PIN_HINT_LENGTH)
}

/**
 * Compute PIN hint (first PIN_HINT_LENGTH hex chars of a salted PBKDF2-SHA-256 derivation)
 * Used for event filtering without revealing the PIN.
 *
 * Uses a shared, public domain-separation salt (PIN_HINT_SALT) plus the current
 * time bucket so the sender and receiver derive an identical hint from the same PIN
 * within the same window, while PBKDF2's iteration count makes brute-forcing the PIN
 * from the hint expensive and defeats generic precomputed-hash (rainbow table) attacks.
 *
 * `bucketOffset` selects an earlier time bucket (0 = current, 1 = previous, ...).
 */
export async function computePinHint(pin: string, bucketOffset = 0): Promise<string> {
  const keyMaterial = await importPinKey(pin)
  return derivePinBits(keyMaterial, pinHintSalt(bucketOffset))
}

/**
 * Compute a PIN hint from previously imported PBKDF2 key material (see importPinKey).
 * Lets the receiver derive both the current and look-back hints without re-importing
 * the PIN (which is wiped after the key material is created).
 *
 * `bucketOffset` selects an earlier time bucket (0 = current, 1 = previous, ...).
 */
export async function computePinHintFromKey(keyMaterial: CryptoKey, bucketOffset = 0): Promise<string> {
  return derivePinBits(keyMaterial, pinHintSalt(bucketOffset))
}

/**
 * Compute the PIN fingerprint: a stable, time-independent one-way derivation of the PIN,
 * displayed to both sender and receiver so they can visually confirm they entered the
 * same PIN.
 *
 * Unlike the wire hint (computePinHint), this is a single salted SHA-256 — NOT the
 * expensive 600,000-iteration PBKDF2 — because the fingerprint never crosses the network
 * and is only compared by humans on-device. There is no published value for an attacker
 * to brute-force, so the PBKDF2 work-factor (which exists to slow reversing a relayed
 * hint back to its PIN) buys nothing here; a fast hash keeps PIN entry/display snappy.
 *
 * Salted with the static PIN_HINT_SALT (no time bucket) so the two sides always display
 * the same value, even across a time-bucket rollover, and domain-separated from any
 * other PIN derivation.
 */
export async function computePinFingerprint(pin: string): Promise<string> {
  const encoder = new TextEncoder()
  // Encode salt and PIN separately (avoids materializing a concatenated PIN string)
  const saltBytes = encoder.encode(`${PIN_HINT_SALT}:`)
  const pinBytes = encoder.encode(pin)
  const input = new Uint8Array(saltBytes.length + pinBytes.length)
  input.set(saltBytes, 0)
  input.set(pinBytes, saltBytes.length)

  try {
    const digest = await crypto.subtle.digest('SHA-256', input)
    const hex = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')

    // Truncate to exact length (needed if PIN_HINT_LENGTH is odd)
    return hex.slice(0, PIN_HINT_LENGTH)
  } finally {
    // Best-effort: clear the PIN bytes from the temporary buffers
    wipeBufferSource(pinBytes)
    wipeBufferSource(input)
  }
}

/**
 * Format a PIN hint for display as the user-visible PIN fingerprint.
 * Uppercases and groups the full hint into 4-char blocks (e.g. ABCD-EF01-2345-6789)
 * so the sender and receiver can visually confirm they derived the same PIN.
 */
export function formatPinHint(hint: string): string {
  const compact = hint.toUpperCase()
  return compact.match(/.{1,4}/g)?.join('-') ?? compact
}

/**
 * Generate a random transfer ID (16 hex characters)
 */
export function generateTransferId(): string {
  const array = new Uint8Array(8)
  crypto.getRandomValues(array)
  return Array.from(array)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
