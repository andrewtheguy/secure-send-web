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

// Base64url encoding/decoding utilities
function base64urlEncode(data: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i])
  }
  const base64 = btoa(binary)
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function credentialIdToFingerprint(credentialId: Uint8Array): Promise<string> {
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
