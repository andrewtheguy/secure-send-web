import { PIN_CHARSET, PIN_LENGTH, PIN_HINT_LENGTH } from './constants'

/**
 * Generate random 8-character PIN from unambiguous charset
 * Charset excludes confusing characters: I, O, i, l, o, 0, 1
 * Uses rejection sampling to eliminate modulo bias
 */
export function generatePin(): string {
  const n = PIN_CHARSET.length
  // Largest multiple of n that fits in a byte (0-255)
  const maxMultiple = Math.floor(256 / n) * n

  const result: string[] = []
  const buffer = new Uint8Array(PIN_LENGTH * 2) // Over-allocate for rejections

  while (result.length < PIN_LENGTH) {
    crypto.getRandomValues(buffer)
    for (const byte of buffer) {
      // Reject bytes >= maxMultiple to eliminate modulo bias
      if (byte < maxMultiple) {
        result.push(PIN_CHARSET[byte % n])
        if (result.length === PIN_LENGTH) break
      }
    }
  }

  return result.join('')
}

/**
 * Validate PIN format
 */
export function isValidPin(pin: string): boolean {
  if (pin.length !== PIN_LENGTH) return false
  return [...pin].every((char) => PIN_CHARSET.includes(char))
}

/**
 * Compute PIN hint (first PIN_HINT_LENGTH hex chars of SHA-256)
 * Used for event filtering without revealing the PIN
 */
export async function computePinHint(pin: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(pin)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = new Uint8Array(hashBuffer)

  // Each byte produces 2 hex chars; ceil handles odd PIN_HINT_LENGTH
  const byteCount = Math.ceil(PIN_HINT_LENGTH / 2)
  const hex = Array.from(hashArray.slice(0, byteCount))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

  // Truncate to exact length (needed if PIN_HINT_LENGTH is odd)
  return hex.slice(0, PIN_HINT_LENGTH)
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
