/**
 * Mutual Contact Token - Countersigned tokens for bidirectional trust
 *
 * This module provides functions to create and verify mutual contact tokens.
 * A mutual token binds two parties together using WebAuthn ECDSA signatures
 * from both parties, proving mutual consent to communicate.
 *
 * Token flow:
 * 1. Party A creates a token request with their signature (createMutualTokenInit)
 * 2. Party B verifies and signs the request (countersignMutualToken)
 * 3. Both parties use the same mutual token for send/receive
 *
 * Token format: Raw JSON object with dual signatures
 *
 * SECURITY: WebAuthn ensures private keys never leave the authenticator.
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
  /** Party A's credential public key (base64, 65 bytes P-256) */
  a_cpk: string
  /** Party B's public ID (base64, 32 bytes) - lexicographically larger */
  b_id: string
  /** Party B's credential public key (base64, 65 bytes P-256) */
  b_cpk: string
  /** Created at timestamp (Unix seconds) - set by initiator */
  iat: number
  /** Initiator's WebAuthn authenticator data (base64) */
  init_authData: string
  /** Initiator's WebAuthn client data JSON (base64) */
  init_clientDataJSON: string
  /** Initiator's ECDSA signature (base64, DER encoded) */
  init_sig: string
  /** Optional comment (max 256 chars) */
  comment?: string
}

/**
 * Complete mutual token - both parties have signed
 */
export interface MutualContactTokenPayload extends PendingTokenRequest {
  /** Countersigner's WebAuthn authenticator data (base64) */
  counter_authData: string
  /** Countersigner's WebAuthn client data JSON (base64) */
  counter_clientDataJSON: string
  /** Countersigner's ECDSA signature (base64, DER encoded) */
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
  /** Party A's credential public key (65 bytes P-256) */
  partyACredentialKey: Uint8Array

  /** Party B's public ID (32 bytes) - lexicographically larger */
  partyBPublicId: Uint8Array
  /** Party B's fingerprint */
  partyBFingerprint: string
  /** Party B's credential public key (65 bytes P-256) */
  partyBCredentialKey: Uint8Array

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

// Helper: base64url decode to Uint8Array
function base64urlDecodeToBytes(str: string): Uint8Array {
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

// Helper: base64url decode to ArrayBuffer (for WebAuthn APIs)
function base64urlDecode(str: string): ArrayBuffer {
  return base64urlDecodeToBytes(str).buffer as ArrayBuffer
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

    // Must have initiator signature fields but NOT countersigner fields
    return (
      typeof p.a_id === 'string' &&
      typeof p.a_cpk === 'string' &&
      typeof p.b_id === 'string' &&
      typeof p.b_cpk === 'string' &&
      typeof p.iat === 'number' &&
      typeof p.init_authData === 'string' &&
      typeof p.init_clientDataJSON === 'string' &&
      typeof p.init_sig === 'string' &&
      p.counter_authData === undefined &&
      p.counter_clientDataJSON === undefined &&
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

    // Must have both initiator AND countersigner signature fields
    return (
      typeof p.a_id === 'string' &&
      typeof p.a_cpk === 'string' &&
      typeof p.b_id === 'string' &&
      typeof p.b_cpk === 'string' &&
      typeof p.iat === 'number' &&
      typeof p.init_authData === 'string' &&
      typeof p.init_clientDataJSON === 'string' &&
      typeof p.init_sig === 'string' &&
      typeof p.counter_authData === 'string' &&
      typeof p.counter_clientDataJSON === 'string' &&
      typeof p.counter_sig === 'string'
    )
  } catch {
    return false
  }
}

/**
 * Create initial mutual token (initiator signs first).
 *
 * The initiator must know the counterparty's public ID and credential public key.
 * The token will contain both parties' identity information with the initiator's signature.
 *
 * @param credentialId - Initiator's WebAuthn credential ID (base64url)
 * @param credentialPublicKey - Initiator's credential public key (65 bytes)
 * @param initiatorPublicIdBase64 - Initiator's passkey public ID (base64)
 * @param counterpartyPublicIdBase64 - Counterparty's public ID (base64)
 * @param counterpartyCpkBase64 - Counterparty's credential public key (base64)
 * @param comment - Optional comment (max 256 chars)
 * @returns Token request (JSON string) to send to counterparty for signing
 */
export async function createMutualTokenInit(
  credentialId: string,
  credentialPublicKey: Uint8Array,
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

  // Validate initiator's credential public key
  if (credentialPublicKey.length !== 65 || credentialPublicKey[0] !== 0x04) {
    throw new Error('Invalid initiator credential public key: expected 65-byte uncompressed P-256')
  }

  // Decode and validate counterparty's credential public key
  const counterpartyCpk = base64ToUint8Array(counterpartyCpkBase64)
  if (counterpartyCpk.length !== 65 || counterpartyCpk[0] !== 0x04) {
    throw new Error('Invalid counterparty credential public key: expected 65-byte uncompressed P-256')
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
    aCpk = credentialPublicKey
    bId = counterpartyPublicId
    bCpk = counterpartyCpk
  } else {
    // initiator is party B
    aId = counterpartyPublicId
    aCpk = counterpartyCpk
    bId = initiatorPublicId
    bCpk = credentialPublicKey
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

  // Get WebAuthn signature
  const credentialIdBytes = base64urlDecode(credentialId)
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: challenge.buffer as ArrayBuffer,
      allowCredentials: [{ type: 'public-key' as const, id: credentialIdBytes }],
      userVerification: 'required',
    },
  })

  if (!assertion) {
    throw new Error('User cancelled passkey authentication')
  }

  const credential = assertion as PublicKeyCredential
  const response = credential.response as AuthenticatorAssertionResponse

  // Build token request
  const payload: PendingTokenRequest = {
    a_id: uint8ArrayToBase64(aId),
    a_cpk: uint8ArrayToBase64(aCpk),
    b_id: uint8ArrayToBase64(bId),
    b_cpk: uint8ArrayToBase64(bCpk),
    iat,
    init_authData: uint8ArrayToBase64(new Uint8Array(response.authenticatorData)),
    init_clientDataJSON: uint8ArrayToBase64(new Uint8Array(response.clientDataJSON)),
    init_sig: uint8ArrayToBase64(new Uint8Array(response.signature)),
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
 * @param credentialId - Signer's WebAuthn credential ID (base64url)
 * @param credentialPublicKey - Signer's credential public key (65 bytes)
 * @param signerPublicIdBase64 - Signer's passkey public ID (base64)
 * @returns Completed mutual token (JSON string)
 */
export async function countersignMutualToken(
  tokenRequest: string,
  credentialId: string,
  credentialPublicKey: Uint8Array,
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
    typeof request.init_authData !== 'string' ||
    typeof request.init_clientDataJSON !== 'string' ||
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

  // Validate countersigner's credential public key
  if (credentialPublicKey.length !== 65 || credentialPublicKey[0] !== 0x04) {
    throw new Error('Invalid signer credential public key: expected 65-byte P-256')
  }

  // Determine which party the countersigner is
  const isPartyA = constantTimeEqualBytes(signerPublicId, aId)
  const isPartyB = constantTimeEqualBytes(signerPublicId, bId)

  if (!isPartyA && !isPartyB) {
    throw new Error('You are not a party to this token')
  }

  // Verify countersigner's credential matches the expected slot
  const expectedCpk = isPartyA ? aCpk : bCpk
  if (!constantTimeEqualBytes(credentialPublicKey, expectedCpk)) {
    throw new Error('Your credential public key does not match the token')
  }

  // Determine initiator's credential key (the other party)
  const initiatorCpk = isPartyA ? bCpk : aCpk

  // Verify initiator's signature first (challenge includes comment if present)
  const challenge = await computeMutualChallenge(aId, aCpk, bId, bCpk, request.iat, request.comment)
  await verifyWebAuthnSignature(
    initiatorCpk,
    base64ToUint8Array(request.init_authData),
    base64ToUint8Array(request.init_clientDataJSON),
    base64ToUint8Array(request.init_sig),
    challenge
  )

  // Get countersigner's WebAuthn signature
  const credentialIdBytes = base64urlDecode(credentialId)
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: challenge.buffer as ArrayBuffer,
      allowCredentials: [{ type: 'public-key' as const, id: credentialIdBytes }],
      userVerification: 'required',
    },
  })

  if (!assertion) {
    throw new Error('User cancelled passkey authentication')
  }

  const credential = assertion as PublicKeyCredential
  const response = credential.response as AuthenticatorAssertionResponse

  // Build complete token with comment at the end for readability
  // Destructure to exclude comment, then add it back at the end
  const { comment, ...requestWithoutComment } = request
  const complete: MutualContactTokenPayload = {
    ...requestWithoutComment,
    counter_authData: uint8ArrayToBase64(new Uint8Array(response.authenticatorData)),
    counter_clientDataJSON: uint8ArrayToBase64(new Uint8Array(response.clientDataJSON)),
    counter_sig: uint8ArrayToBase64(new Uint8Array(response.signature)),
    ...(comment ? { comment } : {}),
  }

  return JSON.stringify(complete)
}

/**
 * Verify a WebAuthn signature against a challenge.
 * Internal helper used by both verification paths.
 */
async function verifyWebAuthnSignature(
  credentialPublicKey: Uint8Array,
  authData: Uint8Array,
  clientDataJSON: Uint8Array,
  signature: Uint8Array,
  expectedChallenge: Uint8Array
): Promise<void> {
  // Parse clientDataJSON
  let clientData: { type: string; challenge: string; origin: string }
  try {
    clientData = JSON.parse(new TextDecoder().decode(clientDataJSON)) as typeof clientData
  } catch {
    throw new Error('Failed to parse clientDataJSON')
  }

  if (clientData.type !== 'webauthn.get') {
    throw new Error('Invalid clientData type')
  }

  // Verify challenge matches
  const actualChallenge = base64urlDecodeToBytes(clientData.challenge)
  if (!constantTimeEqualBytes(expectedChallenge, actualChallenge)) {
    throw new Error('Challenge mismatch - token data may be tampered')
  }

  // Import credential public key
  const publicKey = await crypto.subtle.importKey(
    'raw',
    credentialPublicKey as BufferSource,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  )

  // WebAuthn signature is over: authData || SHA256(clientDataJSON)
  const clientDataHash = await crypto.subtle.digest('SHA-256', clientDataJSON as BufferSource)
  const signatureBase = new Uint8Array(authData.length + 32)
  signatureBase.set(authData, 0)
  signatureBase.set(new Uint8Array(clientDataHash), authData.length)

  // Convert DER signature to raw format
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
    typeof payload.init_authData !== 'string' ||
    typeof payload.init_clientDataJSON !== 'string' ||
    typeof payload.init_sig !== 'string' ||
    typeof payload.counter_authData !== 'string' ||
    typeof payload.counter_clientDataJSON !== 'string' ||
    typeof payload.counter_sig !== 'string'
  ) {
    throw new Error('Invalid mutual token: missing required fields')
  }

  // Decode fields
  const aId = base64ToUint8Array(payload.a_id)
  const aCpk = base64ToUint8Array(payload.a_cpk)
  const bId = base64ToUint8Array(payload.b_id)
  const bCpk = base64ToUint8Array(payload.b_cpk)

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

  // Determine which party was the initiator by checking whose signature is in init_*
  // We need to try both and see which one verifies
  // Actually, we need to verify BOTH signatures - one with each credential
  // The initiator could be either party A or party B

  // Parse init clientDataJSON to check its challenge
  const initClientDataJSON = base64ToUint8Array(payload.init_clientDataJSON)
  const counterClientDataJSON = base64ToUint8Array(payload.counter_clientDataJSON)

  // Try verifying init signature with aCpk first, then bCpk
  let counterSignerCpk: Uint8Array

  try {
    await verifyWebAuthnSignature(
      aCpk,
      base64ToUint8Array(payload.init_authData),
      initClientDataJSON,
      base64ToUint8Array(payload.init_sig),
      challenge
    )
    // aCpk signed the init signature, so bCpk must have signed the counter
    counterSignerCpk = bCpk
  } catch {
    // Try with bCpk as initiator
    try {
      await verifyWebAuthnSignature(
        bCpk,
        base64ToUint8Array(payload.init_authData),
        initClientDataJSON,
        base64ToUint8Array(payload.init_sig),
        challenge
      )
      // bCpk signed the init signature, so aCpk must have signed the counter
      counterSignerCpk = aCpk
    } catch {
      throw new Error('Initiator signature verification failed')
    }
  }

  // Verify countersigner's signature
  await verifyWebAuthnSignature(
    counterSignerCpk,
    base64ToUint8Array(payload.counter_authData),
    counterClientDataJSON,
    base64ToUint8Array(payload.counter_sig),
    challenge
  )

  // Generate fingerprints
  const partyAFingerprint = await publicKeyToFingerprint(aId)
  const partyBFingerprint = await publicKeyToFingerprint(bId)

  return {
    partyAPublicId: aId,
    partyAFingerprint,
    partyACredentialKey: aCpk,
    partyBPublicId: bId,
    partyBFingerprint,
    partyBCredentialKey: bCpk,
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
): { publicId: Uint8Array; fingerprint: string; credentialKey: Uint8Array } {
  if (constantTimeEqualBytes(myPublicId, verified.partyAPublicId)) {
    return {
      publicId: verified.partyBPublicId,
      fingerprint: verified.partyBFingerprint,
      credentialKey: verified.partyBCredentialKey,
    }
  } else if (constantTimeEqualBytes(myPublicId, verified.partyBPublicId)) {
    return {
      publicId: verified.partyAPublicId,
      fingerprint: verified.partyAFingerprint,
      credentialKey: verified.partyACredentialKey,
    }
  } else {
    throw new Error('You are not a party to this token')
  }
}

/**
 * Convert DER-encoded ECDSA signature to raw format (r || s).
 * WebAuthn returns DER, but Web Crypto expects raw 64-byte format for P-256.
 */
function derToRaw(der: Uint8Array): Uint8Array {
  // DER format: 0x30 <len> 0x02 <r-len> <r> 0x02 <s-len> <s>
  if (der.length < 8) {
    throw new Error('Invalid DER signature: truncated input (too short)')
  }
  if (der[0] !== 0x30) {
    throw new Error('Invalid DER signature: expected SEQUENCE')
  }

  let offset = 2 // Skip 0x30 and length byte

  // Handle multi-byte length encoding
  if (der[1] & 0x80) {
    const lenBytes = der[1] & 0x7f
    if (lenBytes === 0 || lenBytes > 2) {
      throw new Error('Invalid DER signature: unsupported length encoding')
    }
    if (2 + lenBytes > der.length) {
      throw new Error('Invalid DER signature: truncated length bytes')
    }
    let seqLen = 0
    for (let i = 0; i < lenBytes; i++) {
      seqLen = (seqLen << 8) | der[2 + i]
    }
    offset = 2 + lenBytes
    if (offset + seqLen > der.length) {
      throw new Error('Invalid DER signature: sequence length exceeds buffer')
    }
  } else {
    const seqLen = der[1]
    if (2 + seqLen > der.length) {
      throw new Error('Invalid DER signature: sequence length exceeds buffer')
    }
  }

  // Parse r INTEGER
  if (offset >= der.length || der[offset] !== 0x02) {
    throw new Error('Invalid DER signature: expected INTEGER for r')
  }
  offset++
  if (offset >= der.length) {
    throw new Error('Invalid DER signature: truncated r length')
  }
  const rLen = der[offset++]
  if (rLen < 1 || rLen > 33) {
    throw new Error(`Invalid DER signature: bad r length (${rLen})`)
  }
  if (offset + rLen > der.length) {
    throw new Error('Invalid DER signature: r extends past buffer')
  }
  let r = der.slice(offset, offset + rLen)
  offset += rLen

  // Parse s INTEGER
  if (offset >= der.length || der[offset] !== 0x02) {
    throw new Error('Invalid DER signature: expected INTEGER for s')
  }
  offset++
  if (offset >= der.length) {
    throw new Error('Invalid DER signature: truncated s length')
  }
  const sLen = der[offset++]
  if (sLen < 1 || sLen > 33) {
    throw new Error(`Invalid DER signature: bad s length (${sLen})`)
  }
  if (offset + sLen > der.length) {
    throw new Error('Invalid DER signature: s extends past buffer')
  }
  let s = der.slice(offset, offset + sLen)

  // Remove leading zero bytes (used for sign in DER encoding)
  if (r.length === 33 && r[0] === 0) r = r.slice(1)
  if (s.length === 33 && s[0] === 0) s = s.slice(1)

  // Pad to 32 bytes
  const raw = new Uint8Array(64)
  raw.set(r, 32 - r.length)
  raw.set(s, 64 - s.length)

  return raw
}
