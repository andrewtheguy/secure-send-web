/**
 * Mutual Contact Token - Countersigned tokens for bidirectional trust
 *
 * This module provides functions to create and verify mutual contact tokens.
 * A mutual token binds two parties together using ECDSA P-256 signatures
 * from both parties, proving mutual consent to communicate.
 *
 * Token flow:
 * 1. Party A creates a token request with their signature (createMutualTokenInit)
 * 2. Party B verifies and signs the request (countersignMutualToken)
 * 3. Both parties use the same mutual token for send/receive
 *
 * Token format: Raw JSON object with dual ECDSA signatures
 *
 * SECURITY: Signing keys are derived from passkey PRF and are non-extractable.
 * Both signatures must be valid for the token to verify.
 */

import { publicKeyToFingerprint, constantTimeEqualBytes } from './ecdh'

/** Maximum byte length for comment field to prevent overly large tokens */
const MAX_COMMENT_BYTES = 256

/**
 * Token request - created by initiator, waiting for countersigner
 */
export interface PendingTokenRequest {
  /** Party A's public ID (base64, 32 bytes) - lexicographically smaller */
  a_id: string
  /** Party A's contact public key (base64, 65 bytes P-256) - derived from PRF */
  a_cpk: string
  /** Party B's public ID (base64, 32 bytes) - lexicographically larger */
  b_id: string
  /** Party B's contact public key (base64, 65 bytes P-256) - derived from PRF */
  b_cpk: string
  /** Created at timestamp (Unix seconds) - set by initiator */
  iat: number
  /** Initiator's ECDSA signature (base64, raw 64 bytes r||s) */
  init_sig: string
  /** Optional comment (max 256 bytes) */
  comment?: string
}

/**
 * Complete mutual token - both parties have signed
 */
export interface MutualContactTokenPayload extends PendingTokenRequest {
  /** Countersigner's ECDSA signature (base64, raw 64 bytes r||s) */
  counter_sig: string
}

/**
 * Result of verifying a mutual token
 */
export interface VerifiedMutualToken {
  /** Party A's public ID (32 bytes) - lexicographically smaller */
  partyAPublicId: Uint8Array
  /** Party A's fingerprint */
  partyAFingerprint: string
  /** Party A's contact public key (65 bytes P-256) - derived from PRF */
  partyAContactKey: Uint8Array

  /** Party B's public ID (32 bytes) - lexicographically larger */
  partyBPublicId: Uint8Array
  /** Party B's fingerprint */
  partyBFingerprint: string
  /** Party B's contact public key (65 bytes P-256) - derived from PRF */
  partyBContactKey: Uint8Array

  /** Token creation timestamp */
  issuedAt: Date
  /** Optional comment */
  comment?: string
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
 * Compare two 32-byte public IDs lexicographically.
 * @returns negative if id1 < id2, positive if id1 > id2, 0 if equal
 */
function compareIds(id1: Uint8Array, id2: Uint8Array): number {
  for (let i = 0; i < 32; i++) {
    if (id1[i] < id2[i]) return -1
    if (id1[i] > id2[i]) return 1
  }
  return 0
}

/**
 * Compute the mutual challenge that both parties sign.
 * Challenge = SHA256(a_id || a_cpk || b_id || b_cpk || iat || comment_bytes)
 *
 * IDs are sorted lexicographically to ensure deterministic ordering.
 * Comment is optional; if provided, it is UTF-8 encoded and appended to the challenge input.
 */
async function computeMutualChallenge(
  aId: Uint8Array,
  aCpk: Uint8Array,
  bId: Uint8Array,
  bCpk: Uint8Array,
  iat: number,
  comment?: string
): Promise<Uint8Array> {
  // Encode comment as UTF-8 bytes (empty array if no comment)
  const commentBytes = comment ? new TextEncoder().encode(comment) : new Uint8Array(0)

  // Total: 32 + 65 + 32 + 65 + 8 + commentBytes.length
  const baseLength = 202
  const data = new Uint8Array(baseLength + commentBytes.length)
  let offset = 0

  data.set(aId, offset)
  offset += 32
  data.set(aCpk, offset)
  offset += 65
  data.set(bId, offset)
  offset += 32
  data.set(bCpk, offset)
  offset += 65

  const iatBytes = new DataView(new ArrayBuffer(8))
  iatBytes.setBigUint64(0, BigInt(iat), false) // big-endian
  data.set(new Uint8Array(iatBytes.buffer), offset)
  offset += 8

  // Append comment bytes if present
  if (commentBytes.length > 0) {
    data.set(commentBytes, offset)
  }

  return new Uint8Array(await crypto.subtle.digest('SHA-256', data))
}

/**
 * Check if a string looks like a token request (single signature).
 * Does NOT verify the signature - just checks structure.
 */
export function isTokenRequest(input: string): boolean {
  try {
    const payload = JSON.parse(input.trim()) as unknown
    if (typeof payload !== 'object' || payload === null) return false
    const p = payload as Record<string, unknown>

    // Must have initiator signature but NOT countersigner signature
    return (
      typeof p.a_id === 'string' &&
      typeof p.a_cpk === 'string' &&
      typeof p.b_id === 'string' &&
      typeof p.b_cpk === 'string' &&
      typeof p.iat === 'number' &&
      typeof p.init_sig === 'string' &&
      p.counter_sig === undefined
    )
  } catch {
    return false
  }
}

/**
 * Check if a string looks like a complete mutual token (dual signatures).
 * Does NOT verify signatures - just checks structure.
 */
export function isMutualTokenFormat(input: string): boolean {
  try {
    const payload = JSON.parse(input.trim()) as unknown
    if (typeof payload !== 'object' || payload === null) return false
    const p = payload as Record<string, unknown>

    // Must have both initiator AND countersigner signatures
    return (
      typeof p.a_id === 'string' &&
      typeof p.a_cpk === 'string' &&
      typeof p.b_id === 'string' &&
      typeof p.b_cpk === 'string' &&
      typeof p.iat === 'number' &&
      typeof p.init_sig === 'string' &&
      typeof p.counter_sig === 'string'
    )
  } catch {
    return false
  }
}

/**
 * Create initial mutual token (initiator signs first).
 *
 * The initiator must know the counterparty's public ID and contact public key.
 * The token will contain both parties' identity information with the initiator's signature.
 *
 * @param contactSigningKey - Initiator's non-extractable ECDSA signing key (from PRF)
 * @param contactPublicKey - Initiator's contact public key (65 bytes, derived from PRF)
 * @param initiatorPublicIdBase64 - Initiator's passkey public ID (base64)
 * @param counterpartyPublicIdBase64 - Counterparty's public ID (base64)
 * @param counterpartyCpkBase64 - Counterparty's contact public key (base64)
 * @param comment - Optional comment (max 256 bytes)
 * @returns Token request (JSON string) to send to counterparty for signing
 */
export async function createMutualTokenInit(
  contactSigningKey: CryptoKey,
  contactPublicKey: Uint8Array,
  initiatorPublicIdBase64: string,
  counterpartyPublicIdBase64: string,
  counterpartyCpkBase64: string,
  comment?: string
): Promise<string> {
  // Decode and validate initiator's public ID
  const initiatorPublicId = base64ToUint8Array(initiatorPublicIdBase64)
  if (initiatorPublicId.length !== 32) {
    throw new Error('Invalid initiator public ID: expected 32 bytes')
  }

  // Decode and validate counterparty's public ID
  const counterpartyPublicId = base64ToUint8Array(counterpartyPublicIdBase64)
  if (counterpartyPublicId.length !== 32) {
    throw new Error('Invalid counterparty public ID: expected 32 bytes')
  }

  // Validate initiator's contact public key
  if (contactPublicKey.length !== 65 || contactPublicKey[0] !== 0x04) {
    throw new Error('Invalid initiator contact public key: expected 65-byte uncompressed P-256')
  }

  // Decode and validate counterparty's contact public key
  const counterpartyCpk = base64ToUint8Array(counterpartyCpkBase64)
  if (counterpartyCpk.length !== 65 || counterpartyCpk[0] !== 0x04) {
    throw new Error('Invalid counterparty contact public key: expected 65-byte uncompressed P-256')
  }

  // Determine lexicographic ordering
  const cmp = compareIds(initiatorPublicId, counterpartyPublicId)
  if (cmp === 0) {
    throw new Error('Cannot create mutual token with yourself')
  }

  // Assign to a_id/b_id based on lexicographic order
  let aId: Uint8Array, aCpk: Uint8Array, bId: Uint8Array, bCpk: Uint8Array
  if (cmp < 0) {
    // initiator is party A
    aId = initiatorPublicId
    aCpk = contactPublicKey
    bId = counterpartyPublicId
    bCpk = counterpartyCpk
  } else {
    // initiator is party B
    aId = counterpartyPublicId
    aCpk = counterpartyCpk
    bId = initiatorPublicId
    bCpk = contactPublicKey
  }

  const iat = Math.floor(Date.now() / 1000)

  // Trim and validate comment before signing (byte length, not character count)
  const trimmedComment = comment?.trim()
  if (trimmedComment) {
    const commentByteLength = new TextEncoder().encode(trimmedComment).length
    if (commentByteLength > MAX_COMMENT_BYTES) {
      throw new Error(`Comment exceeds maximum size of ${MAX_COMMENT_BYTES} bytes (got ${commentByteLength} bytes)`)
    }
  }

  // Compute challenge (includes comment if present)
  const challenge = await computeMutualChallenge(aId, aCpk, bId, bCpk, iat, trimmedComment)

  // Sign with ECDSA P-256 (raw 64-byte r||s format)
  const signatureBuffer = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    contactSigningKey,
    challenge as BufferSource
  )
  const signature = new Uint8Array(signatureBuffer)

  // Build token request
  const payload: PendingTokenRequest = {
    a_id: uint8ArrayToBase64(aId),
    a_cpk: uint8ArrayToBase64(aCpk),
    b_id: uint8ArrayToBase64(bId),
    b_cpk: uint8ArrayToBase64(bCpk),
    iat,
    init_sig: uint8ArrayToBase64(signature),
  }

  if (trimmedComment) {
    payload.comment = trimmedComment
  }

  return JSON.stringify(payload)
}

/**
 * Sign a token request to create the final mutual token.
 *
 * The signer verifies the initiator's signature and adds their own.
 * The resulting mutual token can be used by both parties.
 *
 * @param tokenRequest - The token request JSON from initiator
 * @param contactSigningKey - Signer's non-extractable ECDSA signing key (from PRF)
 * @param contactPublicKey - Signer's contact public key (65 bytes, derived from PRF)
 * @param signerPublicIdBase64 - Signer's passkey public ID (base64)
 * @returns Completed mutual token (JSON string)
 */
export async function countersignMutualToken(
  tokenRequest: string,
  contactSigningKey: CryptoKey,
  contactPublicKey: Uint8Array,
  signerPublicIdBase64: string
): Promise<string> {
  // Parse token request
  let request: PendingTokenRequest
  try {
    request = JSON.parse(tokenRequest.trim()) as PendingTokenRequest
  } catch {
    throw new Error('Invalid token request: failed to parse JSON')
  }

  // Validate required fields
  if (
    typeof request.a_id !== 'string' ||
    typeof request.a_cpk !== 'string' ||
    typeof request.b_id !== 'string' ||
    typeof request.b_cpk !== 'string' ||
    typeof request.iat !== 'number' ||
    !Number.isFinite(request.iat) ||
    typeof request.init_sig !== 'string'
  ) {
    throw new Error('Invalid token request: missing required fields')
  }

  // Validate comment byte length if present
  if (request.comment !== undefined) {
    if (typeof request.comment !== 'string') {
      throw new Error('Invalid token request: comment must be a string')
    }
    const commentByteLength = new TextEncoder().encode(request.comment).length
    if (commentByteLength > MAX_COMMENT_BYTES) {
      throw new Error(`Comment exceeds maximum size of ${MAX_COMMENT_BYTES} bytes`)
    }
  }

  // Decode fields
  const aId = base64ToUint8Array(request.a_id)
  const aCpk = base64ToUint8Array(request.a_cpk)
  const bId = base64ToUint8Array(request.b_id)
  const bCpk = base64ToUint8Array(request.b_cpk)

  if (aId.length !== 32) throw new Error('Invalid a_id: expected 32 bytes')
  if (bId.length !== 32) throw new Error('Invalid b_id: expected 32 bytes')
  if (aCpk.length !== 65 || aCpk[0] !== 0x04) throw new Error('Invalid a_cpk: expected 65-byte P-256')
  if (bCpk.length !== 65 || bCpk[0] !== 0x04) throw new Error('Invalid b_cpk: expected 65-byte P-256')

  // Verify lexicographic ordering
  if (compareIds(aId, bId) >= 0) {
    throw new Error('Invalid token: a_id must be lexicographically smaller than b_id')
  }

  // Decode countersigner's public ID
  const signerPublicId = base64ToUint8Array(signerPublicIdBase64)
  if (signerPublicId.length !== 32) {
    throw new Error('Invalid signer public ID: expected 32 bytes')
  }

  // Validate countersigner's contact public key
  if (contactPublicKey.length !== 65 || contactPublicKey[0] !== 0x04) {
    throw new Error('Invalid signer contact public key: expected 65-byte P-256')
  }

  // Determine which party the countersigner is
  const isPartyA = constantTimeEqualBytes(signerPublicId, aId)
  const isPartyB = constantTimeEqualBytes(signerPublicId, bId)

  if (!isPartyA && !isPartyB) {
    throw new Error('You are not a party to this token')
  }

  // Verify countersigner's contact key matches the expected slot
  const expectedCpk = isPartyA ? aCpk : bCpk
  if (!constantTimeEqualBytes(contactPublicKey, expectedCpk)) {
    throw new Error('Your contact public key does not match the token')
  }

  // Determine initiator's contact key (the other party)
  const initiatorCpk = isPartyA ? bCpk : aCpk

  // Verify initiator's signature first (challenge includes comment if present)
  const challenge = await computeMutualChallenge(aId, aCpk, bId, bCpk, request.iat, request.comment)
  await verifyECDSASignature(
    initiatorCpk,
    base64ToUint8Array(request.init_sig),
    challenge
  )

  // Sign with ECDSA P-256 (raw 64-byte r||s format)
  const signatureBuffer = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    contactSigningKey,
    challenge as BufferSource
  )
  const signature = new Uint8Array(signatureBuffer)

  // Build complete token with comment at the end for readability
  const complete: MutualContactTokenPayload = {
    a_id: request.a_id,
    a_cpk: request.a_cpk,
    b_id: request.b_id,
    b_cpk: request.b_cpk,
    iat: request.iat,
    init_sig: request.init_sig,
    counter_sig: uint8ArrayToBase64(signature),
    ...(request.comment ? { comment: request.comment } : {}),
  }

  return JSON.stringify(complete)
}

/**
 * Verify an ECDSA P-256 signature against data.
 * Internal helper used by both verification paths.
 *
 * @param contactPublicKey - 65-byte uncompressed P-256 public key
 * @param signature - Raw 64-byte ECDSA signature (r||s format)
 * @param data - The data that was signed
 */
async function verifyECDSASignature(
  contactPublicKey: Uint8Array,
  signature: Uint8Array,
  data: Uint8Array
): Promise<void> {
  // Import contact public key for verification
  const publicKey = await crypto.subtle.importKey(
    'raw',
    contactPublicKey as BufferSource,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  )

  // Verify ECDSA signature (raw 64-byte r||s format)
  const valid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    publicKey,
    signature as BufferSource,
    data as BufferSource
  )

  if (!valid) {
    throw new Error('Signature verification failed')
  }
}

/**
 * Verify a complete mutual token's signatures.
 *
 * This verifies both the initiator's and countersigner's signatures.
 * Optionally checks that a specific public ID is a party to the token.
 *
 * @param token - The mutual token JSON string
 * @param myPublicId - Optional: verifier's public ID to confirm they're a party
 * @returns Verified token data
 * @throws Error if invalid or verifier is not a party
 */
export async function verifyMutualToken(
  token: string,
  myPublicId?: Uint8Array
): Promise<VerifiedMutualToken> {
  // Parse token
  let payload: MutualContactTokenPayload
  try {
    payload = JSON.parse(token.trim()) as MutualContactTokenPayload
  } catch {
    throw new Error('Invalid mutual token: failed to parse JSON')
  }

  // Validate required fields
  if (
    typeof payload.a_id !== 'string' ||
    typeof payload.a_cpk !== 'string' ||
    typeof payload.b_id !== 'string' ||
    typeof payload.b_cpk !== 'string' ||
    typeof payload.iat !== 'number' ||
    !Number.isFinite(payload.iat) ||
    typeof payload.init_sig !== 'string' ||
    typeof payload.counter_sig !== 'string'
  ) {
    throw new Error('Invalid mutual token: missing required fields')
  }

  // Decode fields
  const aId = base64ToUint8Array(payload.a_id)
  const aCpk = base64ToUint8Array(payload.a_cpk)
  const bId = base64ToUint8Array(payload.b_id)
  const bCpk = base64ToUint8Array(payload.b_cpk)
  const initSig = base64ToUint8Array(payload.init_sig)
  const counterSig = base64ToUint8Array(payload.counter_sig)

  if (aId.length !== 32) throw new Error('Invalid a_id: expected 32 bytes')
  if (bId.length !== 32) throw new Error('Invalid b_id: expected 32 bytes')
  if (aCpk.length !== 65 || aCpk[0] !== 0x04) throw new Error('Invalid a_cpk: expected 65-byte P-256')
  if (bCpk.length !== 65 || bCpk[0] !== 0x04) throw new Error('Invalid b_cpk: expected 65-byte P-256')

  // Verify lexicographic ordering
  if (compareIds(aId, bId) >= 0) {
    throw new Error('Invalid token: a_id must be lexicographically smaller than b_id')
  }

  // Verify caller is a party (if specified)
  if (myPublicId) {
    const isPartyA = constantTimeEqualBytes(myPublicId, aId)
    const isPartyB = constantTimeEqualBytes(myPublicId, bId)
    if (!isPartyA && !isPartyB) {
      throw new Error('You are not a party to this token')
    }
  }

  // Compute challenge (same for both signatures, includes comment if present)
  const challenge = await computeMutualChallenge(aId, aCpk, bId, bCpk, payload.iat, payload.comment)

  // Determine which party was the initiator by trying both
  // The initiator could be either party A or party B
  let counterSignerCpk: Uint8Array

  try {
    await verifyECDSASignature(aCpk, initSig, challenge)
    // aCpk signed the init signature, so bCpk must have signed the counter
    counterSignerCpk = bCpk
  } catch {
    // Try with bCpk as initiator
    try {
      await verifyECDSASignature(bCpk, initSig, challenge)
      // bCpk signed the init signature, so aCpk must have signed the counter
      counterSignerCpk = aCpk
    } catch {
      throw new Error('Initiator signature verification failed')
    }
  }

  // Verify countersigner's signature
  await verifyECDSASignature(counterSignerCpk, counterSig, challenge)

  // Generate fingerprints
  const partyAFingerprint = await publicKeyToFingerprint(aId)
  const partyBFingerprint = await publicKeyToFingerprint(bId)

  return {
    partyAPublicId: aId,
    partyAFingerprint,
    partyAContactKey: aCpk,
    partyBPublicId: bId,
    partyBFingerprint,
    partyBContactKey: bCpk,
    issuedAt: new Date(payload.iat * 1000),
    comment: payload.comment,
  }
}

/**
 * Get the counterparty's public ID from a verified mutual token.
 * Convenience helper for send/receive flows.
 */
export function getCounterpartyFromToken(
  verified: VerifiedMutualToken,
  myPublicId: Uint8Array
): { publicId: Uint8Array; fingerprint: string; contactKey: Uint8Array } {
  if (constantTimeEqualBytes(myPublicId, verified.partyAPublicId)) {
    return {
      publicId: verified.partyBPublicId,
      fingerprint: verified.partyBFingerprint,
      contactKey: verified.partyBContactKey,
    }
  } else if (constantTimeEqualBytes(myPublicId, verified.partyBPublicId)) {
    return {
      publicId: verified.partyAPublicId,
      fingerprint: verified.partyAFingerprint,
      contactKey: verified.partyAContactKey,
    }
  } else {
    throw new Error('You are not a party to this token')
  }
}
