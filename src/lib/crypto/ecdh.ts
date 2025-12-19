import { AES_KEY_LENGTH } from './constants'

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
 * ECDH key pair with raw public key bytes for QR encoding
 */
export interface ECDHKeyPair {
  publicKey: CryptoKey
  privateKey: CryptoKey
  publicKeyBytes: Uint8Array // 65 bytes uncompressed P-256 (0x04 || x || y)
}

/**
 * Generate an ephemeral ECDH key pair using P-256 curve
 * Returns the key pair along with raw public key bytes for encoding in QR
 */
export async function generateECDHKeyPair(): Promise<ECDHKeyPair> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'ECDH',
      namedCurve: 'P-256',
    },
    true, // extractable so we can get raw bytes
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
 * Import a peer's public key from raw bytes
 */
export async function importECDHPublicKey(publicKeyBytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    toArrayBuffer(publicKeyBytes),
    {
      name: 'ECDH',
      namedCurve: 'P-256',
    },
    true,
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
 * Derive AES-256-GCM key from ECDH shared secret using HKDF
 * Salt ensures different keys even with same shared secret
 */
export async function deriveAESKeyFromSecret(
  sharedSecret: Uint8Array,
  salt: Uint8Array
): Promise<CryptoKey> {
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
