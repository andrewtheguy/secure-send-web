import { AES_KEY_LENGTH } from './constants'

/**
 * ECDH Key Exchange for Mutual Authentication
 *
 * SECURITY: Keys are generated as non-extractable to prevent exfiltration.
 * Public keys can still be exported even when non-extractable.
 */

/**
 * Helper to get a proper ArrayBuffer from Uint8Array (handles subarray views)
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer
  }
  // Create a copy for subarray views
  return bytes.slice().buffer as ArrayBuffer
}

/**
 * ECDH key pair with raw public key bytes for transmission.
 * WARNING: privateKey must never be exported or stored - use only for deriveBits.
 */
export interface ECDHKeyPair {
  publicKey: CryptoKey
  privateKey: CryptoKey // Ephemeral only - never export or store
  publicKeyBytes: Uint8Array // 65 bytes uncompressed P-256 (0x04 || x || y)
}

/**
 * Generate an ephemeral ECDH key pair using P-256 curve.
 * Returns the key pair along with raw public key bytes for transmission.
 *
 * Keys are generated as non-extractable for security.
 */
export async function generateECDHKeyPair(): Promise<ECDHKeyPair> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'ECDH',
      namedCurve: 'P-256',
    },
    false, // non-extractable
    ['deriveBits']
  )

  // Export public key to raw format (65 bytes for P-256 uncompressed)
  const publicKeyBytes = new Uint8Array(
    await crypto.subtle.exportKey('raw', keyPair.publicKey)
  )

  return {
    publicKey: keyPair.publicKey,
    privateKey: keyPair.privateKey,
    publicKeyBytes,
  }
}

/**
 * Import a peer's public key from raw bytes.
 * Expects 65-byte uncompressed P-256 format: 0x04 || X (32 bytes) || Y (32 bytes)
 */
export async function importECDHPublicKey(publicKeyBytes: Uint8Array): Promise<CryptoKey> {
  // Validate uncompressed P-256 public key format
  if (!(publicKeyBytes instanceof Uint8Array) || publicKeyBytes.length !== 65) {
    throw new TypeError(
      'Invalid ECDH public key: expected 65-byte uncompressed P-256 key (0x04 || X || Y)'
    )
  }
  if (publicKeyBytes[0] !== 0x04) {
    throw new TypeError(
      'Invalid ECDH public key: missing uncompressed point prefix (0x04)'
    )
  }

  return crypto.subtle.importKey(
    'raw',
    toArrayBuffer(publicKeyBytes),
    {
      name: 'ECDH',
      namedCurve: 'P-256',
    },
    false, // non-extractable - only used for deriveBits
    []
  )
}

/**
 * Derive shared secret from our private key and peer's public key
 * Returns 32 bytes of shared secret
 */
export async function deriveSharedSecret(
  privateKey: CryptoKey,
  peerPublicKeyBytes: Uint8Array
): Promise<Uint8Array> {
  const peerPublicKey = await importECDHPublicKey(peerPublicKeyBytes)

  const sharedBits = await crypto.subtle.deriveBits(
    {
      name: 'ECDH',
      public: peerPublicKey,
    },
    privateKey,
    256 // 32 bytes
  )

  return new Uint8Array(sharedBits)
}

/**
 * Derive AES-256-GCM key from ECDH shared secret using HKDF.
 * Salt ensures different keys even with same shared secret.
 *
 * The info label "secure-send-mutual" provides domain separation,
 * ensuring keys derived here cannot be confused with keys from other protocols.
 */
export async function deriveAESKeyFromSecret(
  sharedSecret: Uint8Array,
  salt: Uint8Array
): Promise<CryptoKey> {
  // Validate inputs
  if (sharedSecret.length !== 32) {
    throw new Error(`Invalid shared secret length: expected 32 bytes, got ${sharedSecret.length}`)
  }
  if (salt.length < 16) {
    throw new Error(`Salt too short: expected at least 16 bytes, got ${salt.length}`)
  }

  // Import shared secret as HKDF key material
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(sharedSecret),
    'HKDF',
    false,
    ['deriveKey']
  )

  // Derive AES key using HKDF
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: toArrayBuffer(salt),
      info: new TextEncoder().encode('secure-send-mutual'),
    },
    keyMaterial,
    { name: 'AES-GCM', length: AES_KEY_LENGTH },
    false,
    ['encrypt', 'decrypt']
  )
}
