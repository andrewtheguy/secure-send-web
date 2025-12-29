/**
 * Contact Token - Tamper-proof contact storage using WebAuthn ECDSA signatures
 *
 * This module provides functions to create and verify signed contact tokens.
 * Tokens bind a recipient's public ID to the signer's passkey using WebAuthn
 * ECDSA (ES256) signatures, ensuring the contact information hasn't been tampered with.
 *
 * SECURITY: WebAuthn ensures the private key never leaves the authenticator.
 * Verification can be done without authentication using the stored credential public key.
 */

import { publicKeyToFingerprint, constantTimeEqualBytes } from './ecdh'
import { getCredentialPublicKey, getAllCredentialPublicKeys } from './passkey'

/**
 * Token payload structure (encoded as JSON, then base64)
 */
export interface ContactTokenPayload {
  /** Recipient's public ID (base64, 32 bytes decoded) */
  sub: string
  /** Signer's credential public key (base64, 65 bytes uncompressed P-256) */
  cpk: string
  /** Issued at timestamp (Unix seconds) */
  iat: number
  /** Authenticator data from WebAuthn response (base64) */
  authData: string
  /** Client data JSON from WebAuthn response (base64) */
  clientDataJSON: string
  /** ECDSA signature from WebAuthn response (base64, DER encoded) */
  sig: string
}

/**
 * Result of verifying a token
 */
export interface VerifiedContactToken {
  recipientPublicId: Uint8Array
  signerCredentialPublicKey: Uint8Array
  signerFingerprint: string
  issuedAt: Date
}

// Helper: base64 encode
function uint8ArrayToBase64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (c) => String.fromCharCode(c)).join(''))
}

// Helper: base64 decode
function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

// Helper: base64url decode
function base64urlDecode(str: string): Uint8Array {
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
  return bytes
}

/**
 * Check if a string looks like a valid contact token format.
 * Does NOT verify the signature - just checks structure.
 */
export function isContactTokenFormat(input: string): boolean {
  const trimmed = input.trim()
  if (!trimmed) return false

  try {
    // Token is base64-encoded JSON
    const json = atob(trimmed)
    const payload = JSON.parse(json) as unknown

    // Check required fields exist
    if (typeof payload !== 'object' || payload === null) return false
    const p = payload as Record<string, unknown>

    return (
      typeof p.sub === 'string' &&
      typeof p.cpk === 'string' &&
      typeof p.iat === 'number' &&
      typeof p.authData === 'string' &&
      typeof p.clientDataJSON === 'string' &&
      typeof p.sig === 'string'
    )
  } catch {
    return false
  }
}

/**
 * Create a signed contact token using WebAuthn.
 *
 * The token contains the recipient's public ID along with a WebAuthn ECDSA
 * signature that proves the signer created this token with their passkey.
 *
 * @param credentialId - Signer's credential ID (base64url)
 * @param credentialPublicKey - Signer's credential public key (65 bytes)
 * @param recipientPublicIdBase64 - Recipient's public ID (base64 encoded)
 * @returns Base64-encoded contact token
 */
export async function createContactToken(
  credentialId: string,
  credentialPublicKey: Uint8Array,
  recipientPublicIdBase64: string
): Promise<string> {
  // Decode and validate recipient public ID
  const recipientPublicId = base64ToUint8Array(recipientPublicIdBase64)
  if (recipientPublicId.length !== 32) {
    throw new Error('Invalid recipient public ID: expected 32 bytes')
  }

  // Validate credential public key
  if (credentialPublicKey.length !== 65 || credentialPublicKey[0] !== 0x04) {
    throw new Error('Invalid credential public key: expected 65-byte uncompressed P-256')
  }

  const iat = Math.floor(Date.now() / 1000)

  // Create challenge that includes the data we want to sign
  // challenge = SHA256(sub || cpk || iat)
  const dataToSign = new Uint8Array(32 + 65 + 8)
  dataToSign.set(recipientPublicId, 0)
  dataToSign.set(credentialPublicKey, 32)
  const iatBytes = new DataView(new ArrayBuffer(8))
  iatBytes.setBigUint64(0, BigInt(iat), false) // big-endian
  dataToSign.set(new Uint8Array(iatBytes.buffer), 97)

  const challenge = new Uint8Array(await crypto.subtle.digest('SHA-256', dataToSign))

  // Get WebAuthn signature
  const credentialIdBytes = base64urlDecode(credentialId)
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge,
      allowCredentials: [{ type: 'public-key' as const, id: credentialIdBytes as BufferSource }],
      userVerification: 'required',
    },
  })

  if (!assertion) {
    throw new Error('User cancelled passkey authentication')
  }

  const credential = assertion as PublicKeyCredential
  const response = credential.response as AuthenticatorAssertionResponse

  // Create payload
  const payload: ContactTokenPayload = {
    sub: recipientPublicIdBase64,
    cpk: uint8ArrayToBase64(credentialPublicKey),
    iat,
    authData: uint8ArrayToBase64(new Uint8Array(response.authenticatorData)),
    clientDataJSON: uint8ArrayToBase64(new Uint8Array(response.clientDataJSON)),
    sig: uint8ArrayToBase64(new Uint8Array(response.signature)),
  }

  // Encode as base64 JSON
  const json = JSON.stringify(payload)
  return btoa(json)
}

/**
 * Verify a contact token's WebAuthn signature.
 *
 * This does NOT require the signer to authenticate - verification uses
 * the credential public key stored in the token.
 *
 * @param token - The contact token string to verify
 * @param trustedCredentialPublicKey - Optional: if provided, token must be signed by this key
 * @returns Verified token data
 * @throws Error if token is invalid or signature verification fails
 */
export async function verifyContactToken(
  token: string,
  trustedCredentialPublicKey?: Uint8Array
): Promise<VerifiedContactToken> {
  // Parse the token
  const trimmed = token.trim()
  let payload: ContactTokenPayload
  try {
    const json = atob(trimmed)
    payload = JSON.parse(json) as ContactTokenPayload
  } catch {
    throw new Error('Invalid contact token format: failed to parse')
  }

  // Validate required fields
  if (
    typeof payload.sub !== 'string' ||
    typeof payload.cpk !== 'string' ||
    typeof payload.iat !== 'number' ||
    typeof payload.authData !== 'string' ||
    typeof payload.clientDataJSON !== 'string' ||
    typeof payload.sig !== 'string'
  ) {
    throw new Error('Invalid contact token format: missing required fields')
  }

  // Decode fields
  const recipientPublicId = base64ToUint8Array(payload.sub)
  if (recipientPublicId.length !== 32) {
    throw new Error('Invalid recipient public ID: expected 32 bytes')
  }

  const signerCredentialPublicKey = base64ToUint8Array(payload.cpk)
  if (signerCredentialPublicKey.length !== 65 || signerCredentialPublicKey[0] !== 0x04) {
    throw new Error('Invalid credential public key: expected 65-byte uncompressed P-256')
  }

  // If trusted key is provided, verify it matches
  if (trustedCredentialPublicKey) {
    if (!constantTimeEqualBytes(signerCredentialPublicKey, trustedCredentialPublicKey)) {
      throw new Error('Token not signed by trusted credential')
    }
  }

  const authData = base64ToUint8Array(payload.authData)
  const clientDataJSON = base64ToUint8Array(payload.clientDataJSON)
  const signature = base64ToUint8Array(payload.sig)

  // Parse and validate clientDataJSON
  const clientData = JSON.parse(new TextDecoder().decode(clientDataJSON)) as {
    type: string
    challenge: string
    origin: string
  }

  if (clientData.type !== 'webauthn.get') {
    throw new Error('Invalid clientData type')
  }

  // Verify challenge matches expected value
  const dataToSign = new Uint8Array(32 + 65 + 8)
  dataToSign.set(recipientPublicId, 0)
  dataToSign.set(signerCredentialPublicKey, 32)
  const iatBytes = new DataView(new ArrayBuffer(8))
  iatBytes.setBigUint64(0, BigInt(payload.iat), false)
  dataToSign.set(new Uint8Array(iatBytes.buffer), 97)

  const expectedChallenge = new Uint8Array(await crypto.subtle.digest('SHA-256', dataToSign))
  const actualChallenge = base64urlDecode(clientData.challenge)

  if (!constantTimeEqualBytes(expectedChallenge, actualChallenge)) {
    throw new Error('Challenge mismatch - token data may be tampered')
  }

  // Import credential public key for verification
  const publicKey = await crypto.subtle.importKey(
    'raw',
    signerCredentialPublicKey as BufferSource,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  )

  // WebAuthn signature is over: authData || SHA256(clientDataJSON)
  const clientDataHash = await crypto.subtle.digest('SHA-256', clientDataJSON as BufferSource)
  const signatureBase = new Uint8Array(authData.length + 32)
  signatureBase.set(authData, 0)
  signatureBase.set(new Uint8Array(clientDataHash), authData.length)

  // Convert DER signature to raw format for Web Crypto
  const rawSignature = derToRaw(signature)

  // Verify ECDSA signature
  const valid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    publicKey,
    rawSignature as BufferSource,
    signatureBase as BufferSource
  )

  if (!valid) {
    throw new Error('Signature verification failed')
  }

  const signerFingerprint = await publicKeyToFingerprint(signerCredentialPublicKey)

  return {
    recipientPublicId,
    signerCredentialPublicKey,
    signerFingerprint,
    issuedAt: new Date(payload.iat * 1000),
  }
}

/**
 * Check if a token was signed by one of our stored credentials.
 * Returns the matching credential ID if found.
 */
export async function findSignerCredential(token: string): Promise<string | null> {
  try {
    const verified = await verifyContactToken(token)

    const allCredentials = getAllCredentialPublicKeys()
    for (const { credentialId, publicKey } of allCredentials) {
      if (constantTimeEqualBytes(publicKey, verified.signerCredentialPublicKey)) {
        return credentialId
      }
    }

    return null
  } catch {
    return null
  }
}

/**
 * Check if we have the credential public key for a given credential ID.
 */
export function hasCredentialPublicKey(credentialId: string): boolean {
  return getCredentialPublicKey(credentialId) !== null
}

/**
 * Convert DER-encoded ECDSA signature to raw format (r || s).
 * WebAuthn returns DER, but Web Crypto expects raw 64-byte format for P-256.
 */
function derToRaw(der: Uint8Array): Uint8Array {
  // DER format: 0x30 <len> 0x02 <r-len> <r> 0x02 <s-len> <s>
  if (der[0] !== 0x30) {
    throw new Error('Invalid DER signature: expected SEQUENCE')
  }

  let offset = 2 // Skip 0x30 and length byte

  // Handle multi-byte length
  if (der[1] & 0x80) {
    const lenBytes = der[1] & 0x7f
    offset = 2 + lenBytes
  }

  // Parse r
  if (der[offset] !== 0x02) {
    throw new Error('Invalid DER signature: expected INTEGER for r')
  }
  offset++
  const rLen = der[offset++]
  let r = der.slice(offset, offset + rLen)
  offset += rLen

  // Parse s
  if (der[offset] !== 0x02) {
    throw new Error('Invalid DER signature: expected INTEGER for s')
  }
  offset++
  const sLen = der[offset++]
  let s = der.slice(offset, offset + sLen)

  // Remove leading zero bytes (used for sign in DER encoding)
  if (r.length === 33 && r[0] === 0) {
    r = r.slice(1)
  }
  if (s.length === 33 && s[0] === 0) {
    s = s.slice(1)
  }

  // Pad to 32 bytes if needed
  const raw = new Uint8Array(64)
  raw.set(r, 32 - r.length)
  raw.set(s, 64 - s.length)

  return raw
}
