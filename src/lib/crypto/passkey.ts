/**
 * Passkey (WebAuthn PRF) encryption utilities
 *
 * Uses WebAuthn PRF extension to derive deterministic ECDH keypairs from passkeys.
 * Supports cross-device key derivation when passkeys are synced via 1Password/iCloud/Google.
 */

import { p256 } from '@noble/curves/nist.js'
import { publicKeyToFingerprint, importECDHPrivateKey } from './ecdh'

// Constants
const PASSKEY_ECDH_LABEL = 'secure-send-passkey-ecdh-v1'

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

  // Import PRF output as HKDF master key
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
