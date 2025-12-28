/**
 * Passkey (WebAuthn PRF) encryption utilities
 *
 * Uses WebAuthn PRF extension to derive encryption keys from passkeys.
 * Supports cross-device encryption when passkeys are synced via 1Password/iCloud/Google.
 */

import { AES_NONCE_LENGTH, SALT_LENGTH } from './constants'
import { encrypt, decrypt } from './aes-gcm'

// Constants
const RP_NAME = 'Secure Send'
const CREDENTIAL_STORAGE_KEY = 'passkey-encryption-credential'
const PRF_SALT_PREFIX = 'secure-send-passkey-encryption-v1'
const PASSKEY_MASTER_PRF_LABEL = 'secure-send-passkey-master-v1'

// Minimum encrypted blob length: salt + nonce + tag
const MIN_BLOB_LENGTH = SALT_LENGTH + AES_NONCE_LENGTH + 16

/**
 * Check if the browser supports WebAuthn with PRF extension
 */
export async function checkPRFSupport(): Promise<boolean> {
  if (!window.PublicKeyCredential) {
    return false
  }

  // Check if conditional mediation is supported (indicates modern WebAuthn support)
  try {
    const isConditionalSupported =
      typeof PublicKeyCredential.isConditionalMediationAvailable === 'function' &&
      (await PublicKeyCredential.isConditionalMediationAvailable())

    // PRF is generally available on platforms that support conditional mediation
    // But we can't truly test PRF without creating a credential
    return isConditionalSupported
  } catch {
    return false
  }
}

/**
 * Create a discoverable passkey with PRF extension for encryption
 * The passkey will be synced via 1Password/iCloud/Google if available
 */
export async function createEncryptionPasskey(): Promise<{
  credentialId: string
  prfSupported: boolean
}> {
  const challenge = crypto.getRandomValues(new Uint8Array(32))
  const userId = crypto.getRandomValues(new Uint8Array(16))

  const credential = (await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: {
        name: RP_NAME,
        id: location.hostname,
      },
      user: {
        id: userId,
        name: `secure-send-${Date.now()}`,
        displayName: 'Secure Send Encryption',
      },
      pubKeyCredParams: [
        { alg: -7, type: 'public-key' }, // ES256 (P-256)
        { alg: -257, type: 'public-key' }, // RS256 fallback
      ],
      authenticatorSelection: {
        residentKey: 'required', // Discoverable - user can pick from list
        userVerification: 'required', // Always require biometric/PIN
      },
      attestation: 'none',
      extensions: {
        prf: {}, // Enable PRF extension
      },
    },
  })) as PublicKeyCredential

  // Check if PRF is supported by this credential
  const extResults = credential.getClientExtensionResults() as { prf?: { enabled?: boolean } }
  const prfSupported = extResults.prf?.enabled === true

  // Store credential ID for convenience (not strictly required for discoverable credentials)
  const credentialId = base64urlEncode(new Uint8Array(credential.rawId))
  localStorage.setItem(CREDENTIAL_STORAGE_KEY, credentialId)

  return { credentialId, prfSupported }
}

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

  const extResults = assertion.getClientExtensionResults() as {
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
 * Encrypt data using passkey-derived key
 * Returns: salt (16 bytes) || nonce (12 bytes) || ciphertext || tag (16 bytes)
 */
export async function encryptWithPasskey(data: Uint8Array): Promise<Uint8Array> {
  // Generate random salt for this encryption
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH))

  // Derive key from passkey (will prompt user)
  const key = await deriveKeyFromPasskey(salt)

  // Encrypt data (returns nonce || ciphertext || tag)
  const encrypted = await encrypt(key, data)

  // Prepend salt to encrypted data
  const result = new Uint8Array(salt.length + encrypted.length)
  result.set(salt, 0)
  result.set(encrypted, salt.length)

  return result
}

/**
 * Decrypt data using passkey-derived key
 * Input: salt (16 bytes) || nonce (12 bytes) || ciphertext || tag (16 bytes)
 */
export async function decryptWithPasskey(blob: Uint8Array): Promise<Uint8Array> {
  if (blob.length < MIN_BLOB_LENGTH) {
    throw new Error(`Encrypted blob too short: expected at least ${MIN_BLOB_LENGTH} bytes`)
  }

  // Extract salt from blob
  const salt = blob.slice(0, SALT_LENGTH)
  const encrypted = blob.slice(SALT_LENGTH)

  // Derive key from passkey using same salt (will prompt user)
  const key = await deriveKeyFromPasskey(salt)

  // Decrypt data
  return decrypt(key, encrypted)
}

/**
 * Encrypt a string message using passkey
 */
export async function encryptMessageWithPasskey(message: string): Promise<Uint8Array> {
  const encoder = new TextEncoder()
  const data = encoder.encode(message)
  return encryptWithPasskey(data)
}

/**
 * Decrypt to a string message using passkey
 */
export async function decryptMessageWithPasskey(blob: Uint8Array): Promise<string> {
  const data = await decryptWithPasskey(blob)
  const decoder = new TextDecoder()
  return decoder.decode(data)
}

/**
 * Get stored credential ID (if any)
 */
export function getStoredCredentialId(): string | null {
  return localStorage.getItem(CREDENTIAL_STORAGE_KEY)
}

/**
 * Clear stored credential ID
 */
export function clearStoredCredential(): void {
  localStorage.removeItem(CREDENTIAL_STORAGE_KEY)
}

/**
 * Check if a passkey has been created
 */
export function hasStoredCredential(): boolean {
  return localStorage.getItem(CREDENTIAL_STORAGE_KEY) !== null
}

/**
 * Get credential fingerprint for identification
 * Used as the "hint" in passkey mode (like PIN hint in regular mode)
 * Returns 11 alphanumeric chars to fit PIN format: 'P' + fingerprint
 */
export async function getCredentialFingerprint(): Promise<string> {
  // Authenticate to get credential ID
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      userVerification: 'required',
    },
  })) as PublicKeyCredential

  return credentialIdToFingerprint(new Uint8Array(assertion.rawId))
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

  const extResults = assertion.getClientExtensionResults() as {
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

  const fingerprint = await credentialIdToFingerprint(new Uint8Array(assertion.rawId))
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

  const extResults = assertion.getClientExtensionResults() as {
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

  const fingerprint = await credentialIdToFingerprint(new Uint8Array(assertion.rawId))
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
  const base64 = btoa(String.fromCharCode(...data))
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function credentialIdToFingerprint(credentialId: Uint8Array): Promise<string> {
  const credentialBytes = new Uint8Array(credentialId)
  const hash = await crypto.subtle.digest('SHA-256', credentialBytes as BufferSource)
  const hashArray = new Uint8Array(hash)

  // Convert first 8 bytes to alphanumeric (base36-ish)
  // This gives us ~11 chars which fits nicely after 'P' prefix
  let fingerprint = ''
  for (let i = 0; i < 8 && fingerprint.length < 11; i++) {
    fingerprint += hashArray[i].toString(36)
  }

  return fingerprint.slice(0, 11).toUpperCase()
}

export function base64urlDecode(str: string): Uint8Array {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  const binary = atob(padded)
  return new Uint8Array([...binary].map((c) => c.charCodeAt(0)))
}
