/**
 * Passkey (WebAuthn PRF) encryption utilities
 *
 * Uses WebAuthn PRF extension to derive a passkey master key (HKDF base key).
 * A shareable public identifier and fingerprints are derived from that master key.
 * Supports cross-device derivation when passkeys are synced via 1Password/iCloud/Google.
 */

import {
  publicKeyToFingerprint,
  importECDHPublicKey,
  generateECDHKeyPair,
} from './ecdh'

// Constants
const PASSKEY_MASTER_LABEL = 'secure-send-passkey-master-v1'
const PASSKEY_PUBLIC_ID_LABEL = 'secure-send-passkey-public-id-v1'
const SESSION_BINDING_LABEL = 'secure-send-session-bind-v1'
const HMAC_KEY_LABEL = 'secure-send-hmac-key-v1'
const PEER_PUBLIC_KEY_LABEL = 'secure-send-peer-public-key-v1'

/**
 * Derive a stable, shareable public identifier from the passkey master key.
 * This identifier is NOT an ECDH public key; it is a derived, non-secret tag.
 *
 * SECURITY: Derived via HKDF; no raw private key material is exposed.
 */
export async function derivePasskeyPublicId(masterKey: CryptoKey): Promise<Uint8Array> {
  const info = new TextEncoder().encode(PASSKEY_PUBLIC_ID_LABEL)
  const idBits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(32), // Empty salt - label provides domain separation
      info,
    },
    masterKey,
    256 // 32 bytes
  )

  return new Uint8Array(idBits)
}

/**
 * Derive your own HMAC-SHA256 signing key from the passkey master key.
 * Used for signing pairing keys (NOT the peer's key - each party has their own).
 *
 * SECURITY:
 * - No raw key material is ever exposed to JavaScript
 * - Key is derived directly via deriveKey() - fully non-extractable
 * - Can sign and verify, but raw key bytes cannot be read
 *
 * @param masterKey - HKDF master key from passkey PRF
 * @returns Non-extractable HMAC CryptoKey for signing/verification
 */
export async function deriveHmacKey(masterKey: CryptoKey): Promise<CryptoKey> {
  const info = new TextEncoder().encode(HMAC_KEY_LABEL)
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(32), // Empty salt - label provides domain separation
      info,
    },
    masterKey,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false, // non-extractable per CLAUDE.md
    ['sign', 'verify']
  )
}

/**
 * Derive a peer public key (32 bytes) from the passkey master key.
 * This is NOT an EC public key - it's a direct HKDF derivation used for identity binding.
 *
 * SECURITY:
 * - No private key material involved (unlike EC key derivation)
 * - This IS the public value - safe to share in identity cards
 * - Used for identity binding during file transfers
 *
 * @param masterKey - HKDF master key from passkey PRF
 * @returns 32-byte peer public key for identity binding
 */
export async function derivePeerPublicKey(masterKey: CryptoKey): Promise<Uint8Array> {
  const info = new TextEncoder().encode(PEER_PUBLIC_KEY_LABEL)
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(32), // Empty salt - label provides domain separation
      info,
    },
    masterKey,
    256 // 32 bytes
  )
  return new Uint8Array(bits)
}

/**
 * Get passkey master key (HKDF base key) from passkey authentication.
 * Returns the master key and the credentialId used for authentication.
 *
 * @param credentialId - Optional base64url credential ID to use specific passkey (skips picker)
 * @returns Object with masterKey (HKDF CryptoKey) and credentialId (base64url string)
 */
export async function getPasskeyMasterKey(credentialId?: string): Promise<{
  masterKey: CryptoKey
  credentialId: string
}> {
  const prfInput = new TextEncoder().encode(PASSKEY_MASTER_LABEL)

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

  const prfBytes = new Uint8Array(extResults.prf.results.first)

  // Import PRF output as HKDF master key.
  // SECURITY: This PRF output is sensitive key material. If exposed, it can be
  // used to derive encryption keys for this passkey.
  const masterKey = await crypto.subtle.importKey(
    'raw',
    prfBytes,
    'HKDF',
    false, // extractable: false per CLAUDE.md
    ['deriveKey', 'deriveBits']
  )
  // Best-effort cleanup of PRF bytes
  prfBytes.fill(0)

  // Extract the credential ID from the response (base64url encoded)
  const usedCredentialId = base64urlEncode(new Uint8Array(credential.rawId))

  return { masterKey, credentialId: usedCredentialId }
}

/**
 * Single call: authenticate with passkey and derive public identifier + fingerprint.
 * This is the main entry point for passkey identity info.
 *
 * Also derives a peer HMAC key and public key for pairing key creation.
 * Both are deterministic - same passkey always produces same keys.
 *
 * SECURITY:
 * - HMAC key is fully non-extractable (no raw bytes ever exposed)
 * - Peer public key is a 32-byte HKDF derivation (no EC private key involved)
 *
 * @param credentialId - Optional base64url credential ID to use specific passkey (skips picker)
 * @returns Identity with prfSupported flag (true if we got here, throws otherwise), and credentialId used
 */
export async function getPasskeyIdentity(credentialId?: string): Promise<{
  publicIdBytes: Uint8Array
  publicIdFingerprint: string
  prfSupported: boolean
  credentialId: string
  peerPublicKey: Uint8Array // 32 bytes for identity card and identity binding
  /** Your own non-extractable HMAC signing key (NOT the peer's key) for pairing keys */
  hmacKey: CryptoKey
}> {
  const { masterKey, credentialId: usedCredentialId } = await getPasskeyMasterKey(credentialId)
  const publicIdBytes = await derivePasskeyPublicId(masterKey)
  const publicIdFingerprint = await publicKeyToFingerprint(publicIdBytes)

  // Derive keys from same master key
  // SECURITY: HMAC key never exposed as raw bytes, peer public key is the public value itself
  const hmacKey = await deriveHmacKey(masterKey)
  const peerPublicKey = await derivePeerPublicKey(masterKey)

  // If we got here, PRF worked (getPasskeyMasterKey throws if PRF fails)
  return {
    publicIdBytes,
    publicIdFingerprint,
    prfSupported: true,
    credentialId: usedCredentialId,
    peerPublicKey,
    hmacKey,
  }
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
 * Note: This only creates the credential. To get the public ID and fingerprint,
 * a separate authentication via getPasskeyIdentity()
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

  // Check if PRF is reported as enabled for this credential
  // Note: Some authenticators (e.g., 1Password on mobile) don't report prf.enabled=true
  // during creation but PRF still works during authentication. We don't throw here -
  // actual PRF validation happens during authentication in getPasskeyMasterKey().
  const extResults = credential.getClientExtensionResults() as {
    prf?: { enabled?: boolean }
  }

  const prfSupported = extResults.prf?.enabled === true

  if (!prfSupported) {
    console.warn(
      'PRF extension not reported as enabled during creation. ' +
        'PRF support will be verified during authentication.'
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
  /** Public identifier bytes derived from passkey (for fingerprint display) */
  identityPublicKeyBytes: Uint8Array
  /** Passkey fingerprint (16 hex chars) for UI verification */
  identityFingerprint: string
  /**
   * Session binding - cryptographic proof that this ephemeral key is authorized
   * by the passkey identity. Computed as: HKDF(passkey master key, ephemeralPub)
   * Both parties can verify this because they share the passkey master key.
   */
  sessionBinding: Uint8Array
}

/**
 * Generate ephemeral session ECDH keypair with identity binding for Perfect Forward Secrecy.
 *
 * SECURITY: Unlike passkey identity derivation, this function provides PFS:
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
 * 2. Sender includes ephemeralPub + sessionBinding in initial event
 * 3. Receiver verifies binding using their copy of identitySharedSecret
 * 4. Receiver generates their ephemeral keypair with binding
 * 5. Receiver includes ephemeralPub + sessionBinding in ACK
 * 6. Sender verifies receiver's binding
 * 7. Both compute: ECDH(ownEphemeralPriv, peerEphemeralPub) = sessionSecret
 * 8. File encryption uses sessionSecret (PFS protected)
 *
 * @param identitySharedSecretKey - HKDF master key from passkey PRF
 * @param ownIdentityPublicKeyBytes - Own passkey-derived public ID (for fingerprint)
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
 * @param identitySharedSecretKey - HKDF master key from passkey PRF
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
 * - Passkey master key stays non-extractable (no raw private key material exposed)
 * - Ephemeral keypair generated via Web Crypto (raw bytes NEVER exposed)
 * - Actual encryption uses ephemeral keys, not identity keys
 * - Compromising the passkey-derived public ID does not help decrypt sessions
 *
 * @param credentialId - Optional credential ID to use specific passkey
 * @returns Session keypair with identity info and binding for verification
 */
export async function getPasskeySessionKeypair(
  credentialId?: string
): Promise<{
  ephemeral: EphemeralSessionKeypair
  identitySharedSecretKey: CryptoKey // Non-extractable HKDF master key for session binding
}> {
  // Get passkey master key
  const { masterKey } = await getPasskeyMasterKey(credentialId)

  // Derive stable public identifier from master key (for fingerprint display)
  const identityPublicKeyBytes = await derivePasskeyPublicId(masterKey)

  // Generate ephemeral session keypair with identity binding
  // SECURITY: Ephemeral private key is NEVER exposed as raw bytes
  const ephemeral = await generateEphemeralSessionKeypair(
    masterKey,
    identityPublicKeyBytes
  )

  return {
    ephemeral,
    identitySharedSecretKey: masterKey,
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
