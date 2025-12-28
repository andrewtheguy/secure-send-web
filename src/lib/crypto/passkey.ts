/**
 * Passkey (WebAuthn PRF) encryption utilities
 *
 * Uses WebAuthn PRF extension to derive deterministic ECDH keypairs from passkeys.
 * Supports cross-device key derivation when passkeys are synced via 1Password/iCloud/Google.
 */

import { p256 } from '@noble/curves/nist.js'
import {
  publicKeyToFingerprint,
  importECDHPrivateKey,
  generateECDHKeyPair,
  deriveSharedSecretKey,
} from './ecdh'

// Constants
const PASSKEY_ECDH_LABEL = 'secure-send-passkey-ecdh-v1'
const SESSION_BINDING_LABEL = 'secure-send-session-bind-v1'

/**
 * Derive deterministic ECDH keypair from passkey master key.
 * Same passkey will always derive the same keypair across devices.
 *
 * SECURITY NOTE - Why raw bytes are temporarily needed:
 *
 * Web Crypto API cannot compute P-256 public key from private key material,
 * so we use @noble/curves (p256.getPublicKey) which requires raw bytes.
 * The seed bytes exist in memory only during this function call (~milliseconds)
 * and are zeroed in a finally block before returning.
 *
 * Residual risk (standard JS limitation):
 * - V8/browser may retain copies during GC
 *
 * Impact if raw bytes are exfiltrated:
 * - High: PRF output / derived seed == ECDH private key material.
 * - An attacker could derive the same shared secret and decrypt transfers
 *   tied to this passkey (past/future within protocol limits).
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/deriveBits
 */
export async function deriveECDHKeypairFromMasterKey(masterKey: CryptoKey): Promise<{
  publicKeyBytes: Uint8Array // 65 bytes uncompressed P-256 (0x04 || X || Y)
  privateKey: CryptoKey // Non-extractable ECDH private key
}> {
  // Derive 32 bytes (256 bits) of seed from master key using HKDF deriveBits
  // This is cleaner than deriveKey+export - directly gets raw bytes
  const info = new TextEncoder().encode(PASSKEY_ECDH_LABEL)
  const seedBits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(32), // Empty salt - label provides domain separation
      info,
    },
    masterKey,
    256 // 32 bytes = 256 bits for P-256 private key
  )

  const seedBytes = new Uint8Array(seedBits)

  try {
    // Compute public key using noble/curves (Web Crypto can't do this)
    const publicKeyBytes = p256.getPublicKey(seedBytes, false)

    // Import as non-extractable CryptoKey for all future ECDH operations
    const privateKey = await importECDHPrivateKey(seedBytes)

    return { publicKeyBytes, privateKey }
  } finally {
    // SECURITY: Zero out seed bytes immediately - best effort cleanup
    // Note: JS/V8 may retain copies but this prevents casual inspection
    seedBytes.fill(0)
  }
}

/**
 * Get passkey master key (HKDF base key) from passkey authentication.
 * Returns the master key for subsequent ECDH keypair derivation.
 *
 * @param credentialId - Optional base64url credential ID to use specific passkey (skips picker)
 */
export async function getPasskeyMasterKey(credentialId?: string): Promise<CryptoKey> {
  const prfInput = new TextEncoder().encode(PASSKEY_ECDH_LABEL)

  // Build allowCredentials if a specific credential is requested
  let allowCredentials: PublicKeyCredentialDescriptor[] | undefined
  if (credentialId) {
    try {
      allowCredentials = [{ type: 'public-key' as const, id: base64urlDecode(credentialId) }]
    } catch (err) {
      throw new Error(
        `Invalid credentialId: not valid base64url encoding`,
        { cause: err }
      )
    }
  }

  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials,
      userVerification: 'required',
      extensions: {
        prf: {
          eval: {
            first: prfInput,
          },
        },
      },
    },
  })

  if (!assertion) {
    throw new Error('User cancelled passkey authentication or no credentials available')
  }

  const credential = assertion as PublicKeyCredential

  const extResults = credential.getClientExtensionResults() as {
    prf?: { results?: { first?: ArrayBuffer } }
  }

  if (!extResults.prf?.results?.first) {
    throw new Error('PRF evaluation failed - authenticator may not support PRF extension')
  }

  // Import PRF output as HKDF master key.
  // SECURITY: This PRF output is sensitive key material. If exposed, it can be
  // used to deterministically re-derive the ECDH private key and decrypt data.
  return crypto.subtle.importKey(
    'raw',
    extResults.prf.results.first,
    'HKDF',
    false, // extractable: false per CLAUDE.md
    ['deriveKey', 'deriveBits']
  )
}

/**
 * Single call: authenticate with passkey and get ECDH keypair with fingerprint.
 * This is the main entry point for passkey-based ECDH.
 *
 * SECURITY: Returns non-extractable CryptoKey for private key operations.
 *
 * @param credentialId - Optional base64url credential ID to use specific passkey (skips picker)
 * @returns Keypair with prfSupported flag (true if we got here, throws otherwise)
 */
export async function getPasskeyECDHKeypair(credentialId?: string): Promise<{
  publicKeyBytes: Uint8Array
  privateKey: CryptoKey // Non-extractable ECDH private key
  publicKeyFingerprint: string
  prfSupported: boolean
}> {
  const masterKey = await getPasskeyMasterKey(credentialId)
  const { publicKeyBytes, privateKey } = await deriveECDHKeypairFromMasterKey(masterKey)
  const publicKeyFingerprint = await publicKeyToFingerprint(publicKeyBytes)

  // If we got here, PRF worked (getPasskeyMasterKey throws if PRF fails)
  return { publicKeyBytes, privateKey, publicKeyFingerprint, prfSupported: true }
}

// publicKeyToFingerprint is used from ecdh.ts

/**
 * Check if WebAuthn and PRF extension are supported.
 *
 * Note: PRF support is assumed (not verified) if a platform authenticator exists.
 * Actual PRF support can only be confirmed during credential creation/assertion.
 * This is a best-effort pre-check to provide early feedback to users.
 */
export async function checkWebAuthnSupport(): Promise<{
  webauthnSupported: boolean
  prfSupported: boolean
  error?: string
}> {
  // Check basic WebAuthn support
  if (!window.PublicKeyCredential) {
    return {
      webauthnSupported: false,
      prfSupported: false,
      error: 'WebAuthn is not supported in this browser',
    }
  }

  // Check if platform authenticator is available
  const platformAuthAvailable =
    await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
  if (!platformAuthAvailable) {
    return {
      webauthnSupported: true,
      prfSupported: false,
      error: 'No platform authenticator available (e.g., Touch ID, Face ID, Windows Hello)',
    }
  }

  // PRF support can only be confirmed by attempting credential creation/get
  // Assume PRF is supported if platform authenticator exists (best-effort check)
  return {
    webauthnSupported: true,
    prfSupported: true,
  }
}

/**
 * Check if a hostname is an IP address (IPv4 or IPv6).
 * WebAuthn does not allow IP addresses as rpId per spec.
 */
function isIpAddress(hostname: string): boolean {
  // More robust IPv4 pattern
  const ipv4Pattern =
    /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/

  // IPv6 pattern (supports full, compressed, and IPv4-mapped forms)
  const ipv6Pattern =
    /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|::([fF]{4}:)?((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?))$/

  return ipv4Pattern.test(hostname) || ipv6Pattern.test(hostname)
}

/**
 * Create a new passkey credential for this app.
 * Uses navigator.credentials.create() with PRF extension.
 *
 * Note: This only creates the credential. To get the ECDH public key and fingerprint,
 * a separate authentication via getPasskeyECDHKeypair() or testPasskeyAndGetFingerprint()
 * is required (PRF output is only available during authentication, not registration).
 *
 * Note: WebAuthn requires a valid domain name as rpId. IP addresses are not allowed
 * per the WebAuthn spec. Use localhost or a proper domain name for development.
 */
export async function createPasskeyCredential(
  userName: string
): Promise<{ credentialId: string; prfSupported: boolean }> {
  // Generate random user ID (we don't persist this - it's just for WebAuthn ceremony)
  const userId = crypto.getRandomValues(new Uint8Array(32))

  // Get relying party ID from current domain
  const rpId = window.location.hostname

  // Validate rpId - WebAuthn does not allow IP addresses
  if (isIpAddress(rpId)) {
    throw new Error(
      `Cannot create passkey: IP addresses are not allowed as WebAuthn rpId. ` +
        `Current host "${rpId}" is an IP address. ` +
        `Please access this app via "localhost" or a domain name instead.`
    )
  }

  const createOptions: PublicKeyCredentialCreationOptions = {
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    rp: {
      name: 'Secure Transfer',
      id: rpId,
    },
    user: {
      id: userId,
      name: userName,
      displayName: userName,
    },
    pubKeyCredParams: [
      { alg: -7, type: 'public-key' }, // ES256
      { alg: -257, type: 'public-key' }, // RS256
    ],
    authenticatorSelection: {
      authenticatorAttachment: 'platform',
      residentKey: 'required',
      userVerification: 'required',
    },
    timeout: 60000,
    attestation: 'none', // We don't need attestation
    extensions: {
      prf: {}, // Enable PRF extension (empty object signals intent)
    },
  }

  const credential = (await navigator.credentials.create({
    publicKey: createOptions,
  })) as PublicKeyCredential | null

  if (!credential) {
    throw new Error('User cancelled passkey creation or no credential returned')
  }

  // Check if PRF is enabled for this credential
  const extResults = credential.getClientExtensionResults() as {
    prf?: { enabled?: boolean }
  }

  const prfSupported = extResults.prf?.enabled === true

  if (!prfSupported) {
    throw new Error(
      'PRF extension not supported by this authenticator. ' +
        'Passkey encryption requires PRF support (available in 1Password, iCloud Keychain, etc.)'
    )
  }

  const credentialIdBytes = new Uint8Array(credential.rawId)
  const credentialId = base64urlEncode(credentialIdBytes)

  return { credentialId, prfSupported }
}

// Base64url encoding utility
function base64urlEncode(data: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i])
  }
  const base64 = btoa(binary)
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Decode a base64url-encoded string to an ArrayBuffer.
 * @param str - Base64url-encoded string (URL-safe alphabet, optional padding)
 * @returns Decoded bytes as ArrayBuffer
 * @throws If input contains invalid base64 characters
 */
function base64urlDecode(str: string): ArrayBuffer {
  // Add padding if needed
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/')
  const pad = base64.length % 4
  if (pad) {
    base64 += '='.repeat(4 - pad)
  }
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes.buffer
}

// ============================================================================
// EPHEMERAL SESSION KEYS FOR PERFECT FORWARD SECRECY
// ============================================================================

/**
 * Result of ephemeral session keypair generation with identity binding.
 */
export interface EphemeralSessionKeypair {
  /** Ephemeral public key bytes (65 bytes uncompressed P-256) for transmission */
  ephemeralPublicKeyBytes: Uint8Array
  /** Ephemeral private key - non-extractable CryptoKey, raw bytes NEVER exposed */
  ephemeralPrivateKey: CryptoKey
  /** Identity public key bytes from passkey derivation (for fingerprint display) */
  identityPublicKeyBytes: Uint8Array
  /** Identity fingerprint (16 hex chars) for UI verification */
  identityFingerprint: string
  /**
   * Session binding - cryptographic proof that this ephemeral key is authorized
   * by the passkey identity. Computed as: HKDF(identitySharedSecret, ephemeralPub)
   * Both parties can verify this because they share the identity-level ECDH secret.
   */
  sessionBinding: Uint8Array
}

/**
 * Generate ephemeral session ECDH keypair with identity binding for Perfect Forward Secrecy.
 *
 * SECURITY: Unlike deriveECDHKeypairFromMasterKey, this function provides PFS:
 * - Uses Web Crypto's generateKey which NEVER exposes raw private key material
 * - Each session uses fresh ephemeral keys
 * - Compromising one session's memory doesn't affect past/future sessions
 * - Similar to how TLS/HTTPS uses ephemeral ECDHE for forward secrecy
 *
 * The passkey-derived identity is still used for:
 * - Identity verification (fingerprint display to users)
 * - Session binding (proving ephemeral keys are authorized by this identity)
 *
 * Protocol flow:
 * 1. Sender generates ephemeral keypair with binding
 * 2. Sender includes ephemralPub + sessionBinding in initial event
 * 3. Receiver verifies binding using their copy of identitySharedSecret
 * 4. Receiver generates their ephemeral keypair with binding
 * 5. Receiver includes ephemeralPub + sessionBinding in ACK
 * 6. Sender verifies receiver's binding
 * 7. Both compute: ECDH(ownEphemeralPriv, peerEphemeralPub) = sessionSecret
 * 8. File encryption uses sessionSecret (PFS protected)
 *
 * @param identitySharedSecretKey - HKDF CryptoKey from passkey-level ECDH (deriveSharedSecretKey)
 * @param ownIdentityPublicKeyBytes - Own passkey-derived public key (for fingerprint)
 * @returns Ephemeral session keypair with identity binding
 */
export async function generateEphemeralSessionKeypair(
  identitySharedSecretKey: CryptoKey,
  ownIdentityPublicKeyBytes: Uint8Array
): Promise<EphemeralSessionKeypair> {
  // Generate ephemeral ECDH keypair using Web Crypto
  // SECURITY: Raw private key material is NEVER exposed to JavaScript
  const ephemeralKeypair = await generateECDHKeyPair()

  // Compute identity fingerprint for UI display
  const identityFingerprint = await publicKeyToFingerprint(ownIdentityPublicKeyBytes)

  // Create session binding: HKDF(identitySharedSecret, salt=ephemeralPub, info=label)
  // This proves the ephemeral key is authorized by the passkey identity pair.
  // Both parties can compute and verify this because they share identitySharedSecretKey.
  const bindingBits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: ephemeralKeypair.publicKeyBytes as BufferSource,
      info: new TextEncoder().encode(SESSION_BINDING_LABEL),
    },
    identitySharedSecretKey,
    256 // 32 bytes
  )

  return {
    ephemeralPublicKeyBytes: ephemeralKeypair.publicKeyBytes,
    ephemeralPrivateKey: ephemeralKeypair.privateKey,
    identityPublicKeyBytes: ownIdentityPublicKeyBytes,
    identityFingerprint,
    sessionBinding: new Uint8Array(bindingBits),
  }
}

/**
 * Verify that an ephemeral public key is bound to a passkey identity.
 * This prevents ephemeral key substitution attacks (MITM).
 *
 * @param identitySharedSecretKey - HKDF CryptoKey from passkey-level ECDH
 * @param ephemeralPublicKeyBytes - Peer's ephemeral public key to verify
 * @param expectedBinding - Session binding provided by peer
 * @returns true if binding is valid, false otherwise
 */
export async function verifySessionBinding(
  identitySharedSecretKey: CryptoKey,
  ephemeralPublicKeyBytes: Uint8Array,
  expectedBinding: Uint8Array
): Promise<boolean> {
  // Recompute the binding using shared identity secret
  const computedBits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: ephemeralPublicKeyBytes as BufferSource,
      info: new TextEncoder().encode(SESSION_BINDING_LABEL),
    },
    identitySharedSecretKey,
    256 // 32 bytes
  )

  const computed = new Uint8Array(computedBits)

  // Constant-time comparison to prevent timing attacks
  if (computed.length !== expectedBinding.length) return false
  let result = 0
  for (let i = 0; i < computed.length; i++) {
    result |= computed[i] ^ expectedBinding[i]
  }
  return result === 0
}

/**
 * Complete passkey authentication and generate ephemeral session keypair.
 * This is the main entry point for passkey-based transfers with PFS.
 *
 * SECURITY: Provides Perfect Forward Secrecy:
 * - Identity keypair derived from passkey (for fingerprint, temporarily exposes raw bytes)
 * - Ephemeral keypair generated via Web Crypto (raw bytes NEVER exposed)
 * - Actual encryption uses ephemeral keys, not identity keys
 * - Compromising identity raw bytes doesn't help decrypt past sessions
 *
 * @param peerIdentityPublicKeyBytes - Peer's passkey-derived public key
 * @param credentialId - Optional credential ID to use specific passkey
 * @returns Session keypair with identity info and binding for verification
 */
export async function getPasskeySessionKeypair(
  peerIdentityPublicKeyBytes: Uint8Array,
  credentialId?: string
): Promise<{
  ephemeral: EphemeralSessionKeypair
  identityPrivateKey: CryptoKey // For legacy compatibility, may be removed
  identitySharedSecretKey: CryptoKey // Non-extractable HKDF key for session binding
}> {
  // Get passkey master key
  const masterKey = await getPasskeyMasterKey(credentialId)

  // Derive identity keypair (temporarily exposes raw bytes for public key computation)
  const { publicKeyBytes: identityPublicKeyBytes, privateKey: identityPrivateKey } =
    await deriveECDHKeypairFromMasterKey(masterKey)

  // Derive identity-level shared secret (for session binding verification)
  // SECURITY: Raw shared secret bytes stay inside Web Crypto as non-extractable key
  const identitySharedSecretKey = await deriveSharedSecretKey(
    identityPrivateKey,
    peerIdentityPublicKeyBytes
  )

  // Generate ephemeral session keypair with identity binding
  // SECURITY: Ephemeral private key is NEVER exposed as raw bytes
  const ephemeral = await generateEphemeralSessionKeypair(
    identitySharedSecretKey,
    identityPublicKeyBytes
  )

  return {
    ephemeral,
    identityPrivateKey,
    identitySharedSecretKey,
  }
}

/**
 * Derive session encryption key from ephemeral ECDH.
 * This is the key used for actual file encryption (PFS protected).
 *
 * @param ephemeralPrivateKey - Own ephemeral private key (non-extractable)
 * @param peerEphemeralPublicKeyBytes - Peer's ephemeral public key
 * @param salt - Per-transfer salt for key derivation
 * @returns Non-extractable AES-GCM key for encryption/decryption
 */
export async function deriveSessionEncryptionKey(
  ephemeralPrivateKey: CryptoKey,
  peerEphemeralPublicKeyBytes: Uint8Array,
  salt: Uint8Array
): Promise<CryptoKey> {
  // Import the peer's ephemeral public key and compute shared secret
  const { importECDHPublicKey } = await import('./ecdh')
  const peerEphemeralPublicKey = await importECDHPublicKey(peerEphemeralPublicKeyBytes)

  // Derive shared secret as HKDF key (never exposed as raw bytes)
  const ephemeralSharedSecretKey = await crypto.subtle.deriveKey(
    {
      name: 'ECDH',
      public: peerEphemeralPublicKey,
    },
    ephemeralPrivateKey,
    {
      name: 'HKDF',
    },
    false, // non-extractable
    ['deriveKey', 'deriveBits']
  )

  // Derive AES-256-GCM key from ephemeral shared secret
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: salt as BufferSource,
      info: new TextEncoder().encode('secure-send-session-key-v1'),
    },
    ephemeralSharedSecretKey,
    { name: 'AES-GCM', length: 256 },
    false, // non-extractable
    ['encrypt', 'decrypt']
  )
}
