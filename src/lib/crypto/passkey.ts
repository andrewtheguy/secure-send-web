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
 * @param credentialId - Optional base64url credential ID to use specific passkey (skips picker)
 * @returns Identity with prfSupported flag (true if we got here, throws otherwise), and credentialId used
 */
export async function getPasskeyIdentity(credentialId?: string): Promise<{
  publicIdBytes: Uint8Array
  publicIdFingerprint: string
  prfSupported: boolean
  credentialId: string
}> {
  const { masterKey, credentialId: usedCredentialId } = await getPasskeyMasterKey(credentialId)
  const publicIdBytes = await derivePasskeyPublicId(masterKey)
  const publicIdFingerprint = await publicKeyToFingerprint(publicIdBytes)

  // If we got here, PRF worked (getPasskeyMasterKey throws if PRF fails)
  return { publicIdBytes, publicIdFingerprint, prfSupported: true, credentialId: usedCredentialId }
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
): Promise<{ credentialId: string; prfSupported: boolean; credentialPublicKey: Uint8Array }> {
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

  // Extract public key from attestation response
  const response = credential.response as AuthenticatorAttestationResponse
  const credentialPublicKey = extractPublicKeyFromAttestation(response)

  // Store the public key for later signature verification
  storeCredentialPublicKey(credentialId, credentialPublicKey)

  return { credentialId, prfSupported, credentialPublicKey }
}

// ============================================================================
// CREDENTIAL PUBLIC KEY EXTRACTION AND STORAGE
// ============================================================================

const CREDENTIAL_PUBKEY_STORAGE_KEY = 'secure-send-credential-pubkey'

/**
 * Extract the public key from WebAuthn attestation response.
 * Returns the uncompressed P-256 public key (65 bytes: 0x04 || x || y)
 */
export function extractPublicKeyFromAttestation(
  response: AuthenticatorAttestationResponse
): Uint8Array {
  const attestationObject = new Uint8Array(response.attestationObject)

  // Parse CBOR attestation object to extract authData
  const authData = parseCBORAttestationObject(attestationObject)

  // Parse authData to extract COSE public key
  // authData structure:
  // - rpIdHash (32 bytes)
  // - flags (1 byte)
  // - signCount (4 bytes)
  // - attestedCredentialData (if AT flag set):
  //   - aaguid (16 bytes)
  //   - credentialIdLength (2 bytes, big-endian)
  //   - credentialId (variable)
  //   - credentialPublicKey (COSE_Key, CBOR)

  const flags = authData[32]
  const hasAttestedCredentialData = (flags & 0x40) !== 0

  if (!hasAttestedCredentialData) {
    throw new Error('Attestation response missing credential data')
  }

  // Skip: rpIdHash (32) + flags (1) + signCount (4) + aaguid (16) = 53 bytes
  const credIdLenOffset = 53
  const credIdLen = (authData[credIdLenOffset] << 8) | authData[credIdLenOffset + 1]

  // COSE public key starts after credentialId
  const coseKeyOffset = credIdLenOffset + 2 + credIdLen
  const coseKeyBytes = authData.slice(coseKeyOffset)

  // Parse COSE_Key to extract raw P-256 public key
  return parseCOSEPublicKey(coseKeyBytes)
}

/**
 * Minimal CBOR parser for attestation object.
 * Only handles the specific structure we need: { authData: bytes, fmt: string, attStmt: map }
 */
function parseCBORAttestationObject(data: Uint8Array): Uint8Array {
  let offset = 0

  // Expect map with 3 items (0xa3)
  if ((data[offset] & 0xf0) !== 0xa0) {
    throw new Error('Expected CBOR map')
  }
  const mapLen = data[offset] & 0x0f
  offset++

  let authData: Uint8Array | null = null

  for (let i = 0; i < mapLen; i++) {
    // Parse key (text string)
    const keyInfo = parseCBORTextString(data, offset)
    offset = keyInfo.nextOffset
    const key = keyInfo.value

    if (key === 'authData') {
      // Parse value (byte string)
      const valueInfo = parseCBORByteString(data, offset)
      offset = valueInfo.nextOffset
      authData = valueInfo.value
    } else if (key === 'fmt') {
      // Skip text string value
      const valueInfo = parseCBORTextString(data, offset)
      offset = valueInfo.nextOffset
    } else if (key === 'attStmt') {
      // Skip map (for attestation: 'none', this is empty map 0xa0)
      if ((data[offset] & 0xf0) === 0xa0) {
        const attStmtMapLen = data[offset] & 0x0f
        offset++
        // Skip map contents (should be empty for 'none' attestation)
        for (let j = 0; j < attStmtMapLen; j++) {
          offset = skipCBORValue(data, offset)
          offset = skipCBORValue(data, offset)
        }
      } else {
        throw new Error('Unexpected attStmt format')
      }
    }
  }

  if (!authData) {
    throw new Error('authData not found in attestation object')
  }

  return authData
}

function parseCBORTextString(data: Uint8Array, offset: number): { value: string; nextOffset: number } {
  const majorType = (data[offset] & 0xe0) >> 5
  if (majorType !== 3) throw new Error('Expected CBOR text string')

  const additionalInfo = data[offset] & 0x1f
  offset++

  let length: number
  if (additionalInfo < 24) {
    length = additionalInfo
  } else if (additionalInfo === 24) {
    length = data[offset++]
  } else if (additionalInfo === 25) {
    length = (data[offset] << 8) | data[offset + 1]
    offset += 2
  } else {
    throw new Error('Unsupported CBOR text string length')
  }

  const value = new TextDecoder().decode(data.slice(offset, offset + length))
  return { value, nextOffset: offset + length }
}

function parseCBORByteString(data: Uint8Array, offset: number): { value: Uint8Array; nextOffset: number } {
  const majorType = (data[offset] & 0xe0) >> 5
  if (majorType !== 2) throw new Error('Expected CBOR byte string')

  const additionalInfo = data[offset] & 0x1f
  offset++

  let length: number
  if (additionalInfo < 24) {
    length = additionalInfo
  } else if (additionalInfo === 24) {
    length = data[offset++]
  } else if (additionalInfo === 25) {
    length = (data[offset] << 8) | data[offset + 1]
    offset += 2
  } else {
    throw new Error('Unsupported CBOR byte string length')
  }

  return { value: data.slice(offset, offset + length), nextOffset: offset + length }
}

function skipCBORValue(data: Uint8Array, offset: number): number {
  const majorType = (data[offset] & 0xe0) >> 5
  const additionalInfo = data[offset] & 0x1f
  offset++

  let length = 0
  if (additionalInfo < 24) {
    length = additionalInfo
  } else if (additionalInfo === 24) {
    length = data[offset++]
  } else if (additionalInfo === 25) {
    length = (data[offset] << 8) | data[offset + 1]
    offset += 2
  }

  if (majorType === 2 || majorType === 3) {
    // byte string or text string - skip length bytes
    return offset + length
  } else if (majorType === 4) {
    // array - skip items
    for (let i = 0; i < length; i++) {
      offset = skipCBORValue(data, offset)
    }
    return offset
  } else if (majorType === 5) {
    // map - skip key-value pairs
    for (let i = 0; i < length; i++) {
      offset = skipCBORValue(data, offset)
      offset = skipCBORValue(data, offset)
    }
    return offset
  }

  return offset
}

/**
 * Parse COSE_Key for EC2 P-256 and return uncompressed public key (65 bytes)
 */
function parseCOSEPublicKey(coseKey: Uint8Array): Uint8Array {
  // COSE_Key for ES256:
  // { 1: 2, 3: -7, -1: 1, -2: x (32 bytes), -3: y (32 bytes) }
  // We need to extract x and y coordinates

  let offset = 0
  const majorType = (coseKey[offset] & 0xe0) >> 5
  if (majorType !== 5) throw new Error('COSE_Key must be a map')

  const mapLen = coseKey[offset] & 0x1f
  offset++

  let x: Uint8Array | null = null
  let y: Uint8Array | null = null

  for (let i = 0; i < mapLen; i++) {
    // Parse key (integer, possibly negative)
    const keyResult = parseCBORInteger(coseKey, offset)
    offset = keyResult.nextOffset
    const key = keyResult.value

    if (key === -2) {
      // x-coordinate
      const valueResult = parseCBORByteString(coseKey, offset)
      offset = valueResult.nextOffset
      x = valueResult.value
    } else if (key === -3) {
      // y-coordinate
      const valueResult = parseCBORByteString(coseKey, offset)
      offset = valueResult.nextOffset
      y = valueResult.value
    } else {
      // Skip other values
      offset = skipCBORValue(coseKey, offset)
    }
  }

  if (!x || !y || x.length !== 32 || y.length !== 32) {
    throw new Error('Invalid COSE_Key: missing or invalid P-256 coordinates')
  }

  // Return uncompressed P-256 public key: 0x04 || x || y
  const publicKey = new Uint8Array(65)
  publicKey[0] = 0x04
  publicKey.set(x, 1)
  publicKey.set(y, 33)
  return publicKey
}

function parseCBORInteger(data: Uint8Array, offset: number): { value: number; nextOffset: number } {
  const majorType = (data[offset] & 0xe0) >> 5
  const additionalInfo = data[offset] & 0x1f
  offset++

  let value: number
  if (additionalInfo < 24) {
    value = additionalInfo
  } else if (additionalInfo === 24) {
    value = data[offset++]
  } else if (additionalInfo === 25) {
    value = (data[offset] << 8) | data[offset + 1]
    offset += 2
  } else {
    throw new Error('Unsupported CBOR integer size')
  }

  // Major type 0 = unsigned, major type 1 = negative
  if (majorType === 1) {
    value = -1 - value
  }

  return { value, nextOffset: offset }
}

/**
 * Store credential public key in localStorage.
 * The key is associated with the credential ID.
 */
export function storeCredentialPublicKey(credentialId: string, publicKey: Uint8Array): void {
  const storage = getPublicKeyStorage()
  storage[credentialId] = uint8ArrayToBase64(publicKey)
  localStorage.setItem(CREDENTIAL_PUBKEY_STORAGE_KEY, JSON.stringify(storage))
}

/**
 * Retrieve credential public key from localStorage.
 */
export function getCredentialPublicKey(credentialId: string): Uint8Array | null {
  const storage = getPublicKeyStorage()
  const base64 = storage[credentialId]
  if (!base64) return null
  return base64ToUint8Array(base64)
}

/**
 * Get all stored credential public keys.
 */
export function getAllCredentialPublicKeys(): Array<{ credentialId: string; publicKey: Uint8Array }> {
  const storage = getPublicKeyStorage()
  return Object.entries(storage).map(([credentialId, base64]) => ({
    credentialId,
    publicKey: base64ToUint8Array(base64),
  }))
}

function getPublicKeyStorage(): Record<string, string> {
  try {
    const stored = localStorage.getItem(CREDENTIAL_PUBKEY_STORAGE_KEY)
    return stored ? JSON.parse(stored) : {}
  } catch {
    return {}
  }
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (c) => String.fromCharCode(c)).join(''))
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
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
