import { PIN_CHARSET, PIN_LENGTH, PIN_HINT_LENGTH } from './constants'

/**
 * Generate random 8-character PIN from unambiguous charset
 * Charset excludes confusing characters: I, O, i, l, o, 0, 1
 */
export function generatePin(): string {
  const array = new Uint8Array(PIN_LENGTH)
  crypto.getRandomValues(array)
  return Array.from(array)
    .map((byte) => PIN_CHARSET[byte % PIN_CHARSET.length])
    .join('')
}

/**
 * Validate PIN format
 */
export function isValidPin(pin: string): boolean {
  if (pin.length !== PIN_LENGTH) return false
  return [...pin].every((char) => PIN_CHARSET.includes(char))
}

/**
 * Compute PIN hint (first 8 hex chars of SHA256)
 * Used for event filtering without revealing the PIN
 */
export async function computePinHint(pin: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(pin)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = new Uint8Array(hashBuffer)
  return Array.from(hashArray.slice(0, PIN_HINT_LENGTH / 2))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
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
