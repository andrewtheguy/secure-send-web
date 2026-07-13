import {
  PIN_CHARSET,
  PIN_CHECKSUM_LENGTH,
  PIN_FINGERPRINT_ITERATIONS,
  PIN_FINGERPRINT_LENGTH,
  PIN_FINGERPRINT_SALT,
  PIN_HINT_BUCKET_SEC,
  PIN_HINT_ITERATIONS,
  PIN_HINT_LENGTH,
  PIN_HINT_SALT,
  PIN_LENGTH,
  PIN_WORDLIST,
} from './constants';
import { importPinKey } from './kdf';

/**
 * Compute checksum character using weighted sum
 * Detects single-character errors and transpositions
 */
function computeChecksum(data: string): string {
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const charIndex = PIN_CHARSET.indexOf(data[i]);
    sum += charIndex * (i + 1); // Weight by position
  }
  return PIN_CHARSET[sum % PIN_CHARSET.length];
}

/**
 * Generate a random PIN with checksum.
 *
 * All characters are drawn from PIN_CHARSET — which excludes confusing characters
 * (I, O, i, l, o, 0, 1) — using rejection sampling to eliminate modulo bias, and the
 * final character is a checksum for typo detection.
 */
export function generatePin(): string {
  const dataLength = PIN_LENGTH - PIN_CHECKSUM_LENGTH;

  const n = PIN_CHARSET.length;
  const maxMultiple = Math.floor(256 / n) * n;

  const result: string[] = [];
  const buffer = new Uint8Array(dataLength * 2);

  while (result.length < dataLength) {
    crypto.getRandomValues(buffer);
    for (const byte of buffer) {
      if (byte < maxMultiple) {
        result.push(PIN_CHARSET[byte % n]);
        if (result.length === dataLength) break;
      }
    }
  }

  const data = result.join('');
  const checksum = computeChecksum(data);
  return data + checksum;
}

/**
 * Validate PIN format and checksum.
 */
export function isValidPin(pin: string): boolean {
  if (pin.length !== PIN_LENGTH) return false;
  if (![...pin].every((char) => PIN_CHARSET.includes(char))) return false;

  // Verify checksum
  const data = pin.slice(0, PIN_LENGTH - PIN_CHECKSUM_LENGTH);
  const expectedChecksum = computeChecksum(data);
  const actualChecksum = pin.slice(-PIN_CHECKSUM_LENGTH);
  return expectedChecksum === actualChecksum;
}

/**
 * Convert alphanumeric PIN to word-based PIN (7 words using BIP-39)
 */
export function pinToWords(pin: string): string[] {
  if (!pin) return Array(7).fill('');

  const charsetSize = BigInt(PIN_CHARSET.length);
  const wordlistSize = BigInt(PIN_WORDLIST.length);

  // Convert PIN (base 69) to BigInt
  let num = BigInt(0);
  for (let i = 0; i < pin.length; i++) {
    const charIndex = PIN_CHARSET.indexOf(pin[i]);
    if (charIndex === -1) return Array(7).fill('');
    num = num * charsetSize + BigInt(charIndex);
  }

  // Convert BigInt to words (base 2048)
  const result: string[] = [];
  for (let i = 0; i < 7; i++) {
    const wordIndex = Number(num % wordlistSize);
    result.unshift(PIN_WORDLIST[wordIndex]);
    num = num / wordlistSize;
  }

  return result;
}

/**
 * Convert 7-word PIN back to 12-character alphanumeric PIN
 */
export function wordsToPin(words: string[]): string {
  if (words.length === 0 || words.every((w) => !w)) return '';

  const charsetSize = BigInt(PIN_CHARSET.length);
  const wordlistSize = BigInt(PIN_WORDLIST.length);

  // Convert words (base 2048) back to BigInt
  let num = BigInt(0);
  for (const word of words) {
    const wordIndex = PIN_WORDLIST.indexOf(word.toLowerCase());
    if (wordIndex === -1) return '';
    num = num * wordlistSize + BigInt(wordIndex);
  }

  // Convert BigInt back to PIN (base 69)
  const result: string[] = [];
  for (let i = 0; i < PIN_LENGTH; i++) {
    const charIndex = Number(num % charsetSize);
    result.unshift(PIN_CHARSET[charIndex]);
    num = num / charsetSize;
  }

  return result.join('');
}

/**
 * Check if a word is in the PIN wordlist
 */
export function isValidPinWord(word: string): boolean {
  if (!word) return false;
  return PIN_WORDLIST.includes(word.toLowerCase());
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
  const bucket =
    Math.floor(Date.now() / 1000 / PIN_HINT_BUCKET_SEC) - bucketOffset;
  return `${PIN_HINT_SALT}:${bucket}`;
}

/**
 * Uppercase RFC 4648 base32 alphabet (A–Z, 2–7), the same alphabet used by Tor v3
 * .onion addresses. It omits 0/1/8/9 so the encoded fingerprint stays unambiguous
 * when read aloud or copied by hand.
 */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Encode bytes as unpadded uppercase base32 (RFC 4648), 5 bits per output char.
 */
function toBase32(bytes: Uint8Array): string {
  let value = 0;
  let bits = 0;
  let output = '';

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

/**
 * Derive `byteCount` raw bytes from a salted PBKDF2-SHA-256 derivation of the PIN,
 * using already-imported PBKDF2 key material, an explicit salt string, and an explicit
 * iteration count (the published wire hint and the local-only fingerprint use different
 * work factors and widths — see
 * PIN_HINT_LENGTH/PIN_HINT_ITERATIONS vs PIN_FINGERPRINT_LENGTH/PIN_FINGERPRINT_ITERATIONS).
 */
async function derivePinBytes(
  keyMaterial: CryptoKey,
  saltStr: string,
  iterations: number,
  byteCount: number,
): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: encoder.encode(saltStr),
      iterations,
      hash: 'SHA-256',
    },
    keyMaterial,
    byteCount * 8,
  );

  return new Uint8Array(derivedBits);
}

/**
 * Derive `hexLength` lowercase hex chars from a salted PBKDF2-SHA-256 derivation of the PIN.
 */
async function derivePinHex(
  keyMaterial: CryptoKey,
  saltStr: string,
  iterations: number,
  hexLength: number,
): Promise<string> {
  // Each byte produces 2 hex chars; ceil handles odd hexLength
  const bytes = await derivePinBytes(
    keyMaterial,
    saltStr,
    iterations,
    Math.ceil(hexLength / 2),
  );

  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  // Truncate to exact length (needed if hexLength is odd)
  return hex.slice(0, hexLength);
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
export async function computePinHint(
  pin: string,
  bucketOffset = 0,
): Promise<string> {
  const keyMaterial = await importPinKey(pin);
  return derivePinHex(
    keyMaterial,
    pinHintSalt(bucketOffset),
    PIN_HINT_ITERATIONS,
    PIN_HINT_LENGTH,
  );
}

/**
 * Compute a PIN hint from previously imported PBKDF2 key material (see importPinKey).
 * Lets the receiver derive both the current and look-back hints without re-importing
 * the PIN (which is wiped after the key material is created).
 *
 * `bucketOffset` selects an earlier time bucket (0 = current, 1 = previous, ...).
 */
export async function computePinHintFromKey(
  keyMaterial: CryptoKey,
  bucketOffset = 0,
): Promise<string> {
  return derivePinHex(
    keyMaterial,
    pinHintSalt(bucketOffset),
    PIN_HINT_ITERATIONS,
    PIN_HINT_LENGTH,
  );
}

/**
 * Compute the PIN fingerprint: a stable, time-independent one-way derivation of the PIN,
 * displayed to both sender and receiver so they can visually confirm they entered the
 * same PIN.
 *
 * Like the wire hint (computePinHint), this is a salted PBKDF2-SHA-256 derivation, but
 * with a lighter work factor (PIN_FINGERPRINT_ITERATIONS, < PIN_HINT_ITERATIONS) because
 * the fingerprint never crosses the network and is only compared by humans on-device.
 * There is no relayed value for an attacker to brute-force, so the full hint work factor
 * buys nothing here; the lighter stretch is defence in depth against an attacker who only
 * ever sees the on-screen fingerprint, while keeping PIN entry/display snappy.
 *
 * Salted with the static, dedicated PIN_FINGERPRINT_SALT (no time bucket) so the two
 * sides always display the same value, even across a time-bucket rollover, and so the
 * fingerprint is domain-separated from the wire hint and every other PIN derivation.
 *
 * Encoded as PIN_FINGERPRINT_LENGTH uppercase base32 chars (RFC 4648, the Tor v3
 * .onion alphabet) so the human-compared value avoids ambiguous glyphs.
 */
export async function computePinFingerprint(pin: string): Promise<string> {
  const keyMaterial = await importPinKey(pin);
  const bytes = await derivePinBytes(
    keyMaterial,
    PIN_FINGERPRINT_SALT,
    PIN_FINGERPRINT_ITERATIONS,
    // 5 bits per base32 char; ceil covers a non-multiple-of-8 bit width
    Math.ceil((PIN_FINGERPRINT_LENGTH * 5) / 8),
  );
  return toBase32(bytes).slice(0, PIN_FINGERPRINT_LENGTH);
}

/**
 * Format a PIN hint for display as the user-visible PIN fingerprint.
 * Uppercases and groups the full value into 4-char blocks (e.g. ABCD-EF01)
 * so the sender and receiver can visually confirm they derived the same PIN.
 */
export function formatPinHint(hint: string): string {
  const compact = hint.toUpperCase();
  return compact.match(/.{1,4}/g)?.join('-') ?? compact;
}

/**
 * Generate a random transfer ID (16 hex characters)
 */
export function generateTransferId(): string {
  const array = new Uint8Array(8);
  crypto.getRandomValues(array);
  return Array.from(array)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
