/**
 * Passkey (WebAuthn PRF) encryption utilities
 *
 * Uses WebAuthn PRF extension to derive encryption keys from passkeys.
 * Supports cross-device encryption when passkeys are synced via 1Password/iCloud/Google.
 */

// Constants
const PRF_SALT_PREFIX = 'secure-send-passkey-encryption-v1'
const PASSKEY_MASTER_PRF_LABEL = 'secure-send-passkey-master-v1'

/**
 * Derive AES-256-GCM key from passkey using PRF extension
 * Same passkey + same salt = same key (deterministic)
 */
export async function deriveKeyFromPasskey(salt: Uint8Array): Promise<CryptoKey> {
  // Combine prefix with salt for PRF input
  const prfInput = new TextEncoder().encode(PRF_SALT_PREFIX + base64urlEncode(salt))

  // Use discoverable credential flow - passkey picker will appear
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      userVerification: 'required',
      extensions: {
        prf: {
          eval: {
            first: prfInput,
          },
        },
      },
    },
  })) as PublicKeyCredential

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

  // Import PRF output as AES-256-GCM key
  return crypto.subtle.importKey(
    'raw',
    extResults.prf.results.first,
    { name: 'AES-GCM' },
    false, // extractable: false per CLAUDE.md
    ['encrypt', 'decrypt']
  )
}

/**
 * Get credential fingerprint for identification
 * Used as the "hint" in passkey mode (like PIN hint in regular mode)
 * Returns 11 alphanumeric chars to fit PIN format: 'P' + fingerprint
 */
export async function getCredentialFingerprint(): Promise<string> {
  // Authenticate to get credential ID
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      userVerification: 'required',
    },
  })

  if (!assertion) {
    throw new Error('User cancelled passkey authentication or no credentials available')
  }

  const credential = assertion as PublicKeyCredential

  return credentialIdToFingerprint(new Uint8Array(credential.rawId))
}

/**
 * Derive key from passkey with externally-provided salt
 * Used when salt comes from signaling (sender provides salt to receiver)
 * This is an alias for deriveKeyFromPasskey for clarity
 */
export async function deriveKeyFromPasskeyWithSalt(salt: Uint8Array): Promise<CryptoKey> {
  return deriveKeyFromPasskey(salt)
}

/**
 * Derive key and fingerprint in one passkey assertion (single prompt)
 */
export async function deriveKeyAndFingerprintFromPasskey(
  salt: Uint8Array
): Promise<{ key: CryptoKey; fingerprint: string }> {
  const prfInput = new TextEncoder().encode(PRF_SALT_PREFIX + base64urlEncode(salt))

  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
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

  const key = await crypto.subtle.importKey(
    'raw',
    extResults.prf.results.first,
    { name: 'AES-GCM' },
    false, // extractable: false per CLAUDE.md
    ['encrypt', 'decrypt']
  )

  const fingerprint = await credentialIdToFingerprint(new Uint8Array(credential.rawId))
  return { key, fingerprint }
}

/**
 * Derive a master key and fingerprint in one passkey assertion (single prompt).
 * Use the master key with HKDF + per-transfer salt to derive the AES key.
 */
export async function getPasskeyMasterKeyAndFingerprint(): Promise<{
  masterKey: CryptoKey
  fingerprint: string
}> {
  const prfInput = new TextEncoder().encode(PASSKEY_MASTER_PRF_LABEL)

  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
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

  const masterKey = await crypto.subtle.importKey(
    'raw',
    extResults.prf.results.first,
    'HKDF',
    false, // extractable: false per CLAUDE.md
    ['deriveKey']
  )

  const fingerprint = await credentialIdToFingerprint(new Uint8Array(credential.rawId))
  return { masterKey, fingerprint }
}

/**
 * Derive per-transfer AES key from passkey master key and salt (no prompt).
 */
export async function deriveKeyFromPasskeyMasterKey(
  masterKey: CryptoKey,
  salt: Uint8Array
): Promise<CryptoKey> {
  const info = new TextEncoder().encode(PRF_SALT_PREFIX)
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: salt as BufferSource,
      info,
    },
    masterKey,
    { name: 'AES-GCM', length: 256 },
    false, // extractable: false per CLAUDE.md
    ['encrypt', 'decrypt']
  )
}

/**
 * Generate a "passkey PIN" for display and signaling
 * Format: 'P' + 11-char fingerprint = 12 chars (same as regular PIN)
 */
export function generatePasskeyPin(fingerprint: string): string {
  if (fingerprint.length < 11) {
    throw new Error(`Passkey fingerprint must be at least 11 characters; received ${fingerprint.length}`)
  }
  return 'P' + fingerprint.slice(0, 11)
}

/**
 * Check if a PIN indicates passkey mode
 */
export function isPasskeyPin(pin: string): boolean {
  return pin.startsWith('P')
}

/**
 * Extract fingerprint from passkey PIN
 */
export function extractPasskeyFingerprint(pin: string): string {
  return pin.slice(1)
}

/**
 * Check if WebAuthn and PRF extension are supported
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
  const platformAuthAvailable = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
  if (!platformAuthAvailable) {
    return {
      webauthnSupported: true,
      prfSupported: false,
      error: 'No platform authenticator available (e.g., Touch ID, Face ID, Windows Hello)',
    }
  }

  // PRF support can only be confirmed by attempting credential creation/get
  // For now, assume PRF is supported if platform authenticator exists
  return {
    webauthnSupported: true,
    prfSupported: true,
  }
}

/**
 * Create a new passkey credential for this app
 * Uses navigator.credentials.create() with PRF extension
 * Returns the fingerprint of the newly created credential and PRF support status
 */
export async function createPasskeyCredential(
  userName: string
): Promise<{ fingerprint: string; credentialId: string; prfSupported: boolean }> {
  // Generate random user ID (we don't persist this - it's just for WebAuthn ceremony)
  const userId = crypto.getRandomValues(new Uint8Array(32))

  // Get relying party ID from current domain
  const rpId = window.location.hostname

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

  const credential = await navigator.credentials.create({
    publicKey: createOptions,
  }) as PublicKeyCredential | null

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
  const fingerprint = await credentialIdToFingerprint(credentialIdBytes)
  const credentialIdBase64 = base64urlEncode(credentialIdBytes)

  return { fingerprint, credentialId: credentialIdBase64, prfSupported }
}

/**
 * Test an existing passkey and return its fingerprint
 * Uses the same flow as getPasskeyMasterKeyAndFingerprint but discards the key
 */
export async function testPasskeyAndGetFingerprint(): Promise<{
  fingerprint: string
  prfSupported: boolean
}> {
  const prfInput = new TextEncoder().encode(PASSKEY_MASTER_PRF_LABEL)

  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
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

  const prfSupported = !!extResults.prf?.results?.first
  const fingerprint = await credentialIdToFingerprint(new Uint8Array(credential.rawId))

  return { fingerprint, prfSupported }
}

// Base64url encoding/decoding utilities
function base64urlEncode(data: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i])
  }
  const base64 = btoa(binary)
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function credentialIdToFingerprint(credentialId: Uint8Array): Promise<string> {
  const credentialBytes = new Uint8Array(credentialId)
  const hash = await crypto.subtle.digest('SHA-256', credentialBytes as BufferSource)
  const hashArray = new Uint8Array(hash)

  let value = 0n
  for (let i = 0; i < 8; i++) {
    value = (value << 8n) | BigInt(hashArray[i])
  }
  const fingerprint = value
    .toString(36)
    .padStart(11, '0')
    .toUpperCase()
    .slice(0, 11)

  return fingerprint
}
