import { AES_NONCE_LENGTH } from './constants'

/**
 * Safely convert Uint8Array to ArrayBuffer
 * Handles views correctly by extracting only the relevant bytes
 */
function toArrayBuffer(arr: Uint8Array): ArrayBuffer {
  return arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength) as ArrayBuffer
}

/**
 * Generate random nonce for AES-GCM
 */
export function generateNonce(): Uint8Array {
  const nonce = new Uint8Array(AES_NONCE_LENGTH)
  crypto.getRandomValues(nonce)
  return nonce
}

/**
 * Derive nonce from chunk number (for chunk encryption)
 * Ensures unique nonce per chunk without randomness
 */
export function deriveChunkNonce(chunkNum: number): Uint8Array {
  const nonce = new Uint8Array(AES_NONCE_LENGTH)
  const view = new DataView(nonce.buffer)
  view.setUint32(0, chunkNum, true) // little-endian
  return nonce
}

/**
 * Encrypt data with AES-256-GCM
 * Returns: nonce (12 bytes) || ciphertext || tag (16 bytes)
 */
export async function encrypt(
  key: CryptoKey,
  plaintext: Uint8Array,
  nonce?: Uint8Array
): Promise<Uint8Array> {
  const iv = nonce ?? generateNonce()

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(plaintext)
  )

  // Combine nonce + ciphertext (tag is appended automatically by Web Crypto)
  const result = new Uint8Array(iv.length + ciphertext.byteLength)
  result.set(iv, 0)
  result.set(new Uint8Array(ciphertext), iv.length)

  return result
}

/**
 * Decrypt data with AES-256-GCM
 * Input: nonce (12 bytes) || ciphertext || tag (16 bytes)
 */
export async function decrypt(key: CryptoKey, encrypted: Uint8Array): Promise<Uint8Array> {
  const nonce = encrypted.slice(0, AES_NONCE_LENGTH)
  const ciphertext = encrypted.slice(AES_NONCE_LENGTH)

  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(nonce) },
    key,
    toArrayBuffer(ciphertext)
  )

  return new Uint8Array(plaintext)
}

/**
 * Encrypt a string message
 */
export async function encryptMessage(key: CryptoKey, message: string): Promise<Uint8Array> {
  const encoder = new TextEncoder()
  const plaintext = encoder.encode(message)
  return encrypt(key, plaintext)
}

/**
 * Decrypt to a string message
 */
export async function decryptMessage(key: CryptoKey, encrypted: Uint8Array): Promise<string> {
  const plaintext = await decrypt(key, encrypted)
  const decoder = new TextDecoder()
  return decoder.decode(plaintext)
}
