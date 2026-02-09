import { PBKDF2_ITERATIONS, PBKDF2_HASH, SALT_LENGTH, AES_KEY_LENGTH } from './constants'

/**
 * Import a PIN into non-extractable PBKDF2 key material.
 * The raw Uint8Array buffer is zeroed after import to avoid lingering plaintext.
 *
 * SECURITY IMPACT: If pinData is exposed in memory, an attacker can derive the
 * same PBKDF2 keys and decrypt PIN-protected transfers.
 * Scope note: PIN-derived keys are session-scoped and typically expire (~1 hour),
 * so exposure risk is bounded to that TTL window, but still high within it.
 */
export async function importPinKey(pin: string): Promise<CryptoKey> {
  const encoder = new TextEncoder()
  const pinData = encoder.encode(pin)

  try {
    return await crypto.subtle.importKey('raw', pinData, 'PBKDF2', false, ['deriveBits', 'deriveKey'])
  } finally {
    // Best-effort zeroization of the temporary buffer
    pinData.fill(0)
  }
}

/**
 * Derive AES-256 key from previously imported PIN key material.
 */
export async function deriveKeyFromPinKey(keyMaterial: CryptoKey, salt: Uint8Array): Promise<CryptoKey> {
  return await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: PBKDF2_HASH,
    },
    keyMaterial,
    { name: 'AES-GCM', length: AES_KEY_LENGTH },
    false,
    ['encrypt', 'decrypt']
  )
}

/**
 * Generate random salt for key derivation
 */
export function generateSalt(): Uint8Array {
  const salt = new Uint8Array(SALT_LENGTH)
  crypto.getRandomValues(salt)
  return salt
}

/**
 * Derive AES-256 key from PIN using PBKDF2
 * Uses 600,000 iterations (OWASP 2023 recommendation)
 */
export async function deriveKeyFromPin(pin: string, salt: Uint8Array): Promise<CryptoKey> {
  const keyMaterial = await importPinKey(pin)
  return deriveKeyFromPinKey(keyMaterial, salt)
}
