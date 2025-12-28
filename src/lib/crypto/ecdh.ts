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
 * Generate fingerprint from public key bytes.
 * Returns 16 uppercase hex characters (64 bits from SHA-256 hash).
 * Used for event filtering and verification display.
 */
export async function publicKeyToFingerprint(publicKeyBytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', publicKeyBytes as BufferSource)
  const hashArray = new Uint8Array(hash)

  // Take first 8 bytes (64 bits) and convert to uppercase hex
  return Array.from(hashArray.slice(0, 8), (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()
}

/**
 * Format a fingerprint for human-readable display.
 * Input: 16 hex chars (e.g., "A1B2C3D4E5F67890")
 * Output: "A1B2-C3D4-E5F6-7890"
 */
export function formatFingerprint(fingerprint: string): string {
  const fp = fingerprint.toUpperCase()
  return `${fp.slice(0, 4)}-${fp.slice(4, 8)}-${fp.slice(8, 12)}-${fp.slice(12, 16)}`
}

/**
 * Import P-256 private key from raw bytes (32 bytes) for ECDH.
 * Uses JWK format internally since Web Crypto doesn't support raw private key import for P-256.
 *
 * @param privateKeyBytes - 32-byte private key scalar
 * @returns CryptoKey for ECDH deriveBits operations
 */
export async function importECDHPrivateKey(privateKeyBytes: Uint8Array): Promise<CryptoKey> {
  if (privateKeyBytes.length !== 32) {
    throw new TypeError(
      `Invalid private key length: expected 32 bytes, got ${privateKeyBytes.length}`
    )
  }

  // We need to compute the public key from the private key to create a valid JWK
  // Using @noble/curves to compute the public key
  const { p256 } = await import('@noble/curves/nist.js')
  const publicKeyBytes = p256.getPublicKey(privateKeyBytes, false) // Uncompressed: 0x04 || X || Y

  // Extract X and Y coordinates (skip the 0x04 prefix)
  const x = publicKeyBytes.slice(1, 33)
  const y = publicKeyBytes.slice(33, 65)

  // Convert to base64url for JWK
  const d = bytesToBase64url(privateKeyBytes)
  const xB64 = bytesToBase64url(x)
  const yB64 = bytesToBase64url(y)

  // Import as JWK
  const jwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    x: xB64,
    y: yB64,
    d: d,
  }

  return crypto.subtle.importKey(
    'jwk',
    jwk,
    {
      name: 'ECDH',
      namedCurve: 'P-256',
    },
    false, // non-extractable
    ['deriveBits']
  )
}

/**
 * Helper: Convert bytes to base64url encoding (for JWK)
 */
function bytesToBase64url(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  const base64 = btoa(binary)
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
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
