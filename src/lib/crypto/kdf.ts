import { PBKDF2_ITERATIONS, PBKDF2_HASH, SALT_LENGTH, AES_KEY_LENGTH } from './constants'

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
  const encoder = new TextEncoder()
  const pinData = encoder.encode(pin)

  // Import PIN as key material
  const keyMaterial = await crypto.subtle.importKey('raw', pinData, 'PBKDF2', false, [
    'deriveBits',
    'deriveKey',
  ])

  // Derive AES key
  return crypto.subtle.deriveKey(
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
