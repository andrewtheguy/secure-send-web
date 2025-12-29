/**
 * Contact Token - Tamper-proof contact storage using HMAC/HKDF binding
 *
 * This module provides functions to create and verify bound contact tokens.
 * Tokens bind a recipient's public ID to the signer's passkey using HKDF,
 * ensuring the contact information hasn't been tampered with.
 *
 * SECURITY: Unlike ECDSA signatures, HKDF binding never exposes raw private
 * key bytes to JavaScript. All key material stays inside Web Crypto as
 * non-extractable CryptoKeys.
 *
 * Trade-off: Verification requires the signer to re-authenticate with their
 * passkey, but this is acceptable since they authenticate anyway when sending.
 */

import { deriveContactBinding } from './passkey'
import { constantTimeEqualBytes } from './ecdh'

/**
 * Token payload structure (encoded as JSON, then base64)
 */
export interface ContactTokenPayload {
  /** Recipient's public ID (base64, 32 bytes decoded) */
  sub: string
  /** Signer's public ID fingerprint (16 hex chars uppercase) */
  spk: string
  /** HKDF binding (base64, 32 bytes decoded) */
  bind: string
  /** Issued at timestamp (Unix seconds) */
  iat: number
}

/**
 * Result of parsing a token without verification
 */
export interface ParsedContactToken {
  recipientPublicId: Uint8Array
  signerFingerprint: string
  binding: Uint8Array
  issuedAt: Date
}

/**
 * Result of verifying a token
 */
export interface VerifiedContactToken {
  recipientPublicId: Uint8Array
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

/**
 * Check if a string looks like a valid contact token format.
 * Does NOT verify the binding - just checks structure.
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
      typeof p.spk === 'string' &&
      typeof p.bind === 'string' &&
      typeof p.iat === 'number'
    )
  } catch {
    return false
  }
}

/**
 * Parse a contact token WITHOUT verification.
 * Use this for display purposes before the user authenticates.
 *
 * WARNING: The returned data is NOT verified. Only use for UI hints.
 * Always call verifyContactToken() before using the recipient public ID.
 *
 * @param token - The contact token string
 * @returns Parsed token data, or null if parsing fails
 */
export function parseContactTokenUnsafe(token: string): ParsedContactToken | null {
  try {
    const trimmed = token.trim()
    const json = atob(trimmed)
    const payload = JSON.parse(json) as ContactTokenPayload

    // Validate field types
    if (
      typeof payload.sub !== 'string' ||
      typeof payload.spk !== 'string' ||
      typeof payload.bind !== 'string' ||
      typeof payload.iat !== 'number'
    ) {
      return null
    }

    // Decode recipient public ID
    const recipientPublicId = base64ToUint8Array(payload.sub)
    if (recipientPublicId.length !== 32) {
      return null
    }

    // Validate fingerprint format (16 hex chars)
    if (!/^[0-9A-F]{16}$/i.test(payload.spk)) {
      return null
    }

    // Decode binding
    const binding = base64ToUint8Array(payload.bind)
    if (binding.length !== 32) {
      return null
    }

    return {
      recipientPublicId,
      signerFingerprint: payload.spk.toUpperCase(),
      binding,
      issuedAt: new Date(payload.iat * 1000),
    }
  } catch {
    return null
  }
}

/**
 * Create a bound contact token.
 *
 * The token contains the recipient's public ID along with an HKDF binding
 * that proves the signer created this token with their passkey.
 *
 * @param masterKey - Signer's non-extractable HKDF master key from passkey
 * @param signerFingerprint - Signer's public ID fingerprint (16 hex chars)
 * @param recipientPublicIdBase64 - Recipient's public ID (base64 encoded)
 * @returns Base64-encoded contact token
 */
export async function createContactToken(
  masterKey: CryptoKey,
  signerFingerprint: string,
  recipientPublicIdBase64: string
): Promise<string> {
  // Decode and validate recipient public ID
  const recipientPublicId = base64ToUint8Array(recipientPublicIdBase64)
  if (recipientPublicId.length !== 32) {
    throw new Error('Invalid recipient public ID: expected 32 bytes')
  }

  // Validate fingerprint format
  if (!/^[0-9A-F]{16}$/i.test(signerFingerprint)) {
    throw new Error('Invalid fingerprint format: expected 16 hex characters')
  }

  // Derive binding using HKDF (no raw key exposure)
  const binding = await deriveContactBinding(masterKey, recipientPublicId)

  // Create payload
  const payload: ContactTokenPayload = {
    sub: recipientPublicIdBase64,
    spk: signerFingerprint.toUpperCase(),
    bind: uint8ArrayToBase64(binding),
    iat: Math.floor(Date.now() / 1000),
  }

  // Encode as base64 JSON
  const json = JSON.stringify(payload)
  return btoa(json)
}

/**
 * Verify a contact token and extract the recipient public ID.
 *
 * This requires the signer's passkey master key to recompute and verify
 * the HKDF binding. If verification fails, an error is thrown.
 *
 * @param masterKey - Signer's non-extractable HKDF master key from passkey
 * @param token - The contact token string to verify
 * @returns Verified token data
 * @throws Error if token is invalid or binding verification fails
 */
export async function verifyContactToken(
  masterKey: CryptoKey,
  token: string
): Promise<VerifiedContactToken> {
  // Parse the token
  const parsed = parseContactTokenUnsafe(token)
  if (!parsed) {
    throw new Error('Invalid contact token format')
  }

  // Recompute binding using the master key
  const expectedBinding = await deriveContactBinding(masterKey, parsed.recipientPublicId)

  // Constant-time comparison to prevent timing attacks
  if (!constantTimeEqualBytes(expectedBinding, parsed.binding)) {
    throw new Error('Contact token binding verification failed - token may be tampered or signed by different passkey')
  }

  return {
    recipientPublicId: parsed.recipientPublicId,
    signerFingerprint: parsed.signerFingerprint,
    issuedAt: parsed.issuedAt,
  }
}
