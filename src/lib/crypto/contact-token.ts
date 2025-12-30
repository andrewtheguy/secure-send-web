/**
 * Mutual Contact Token - Countersigned tokens for bidirectional trust
 *
 * This module provides functions to create and verify mutual contact tokens.
 * A mutual token binds two parties together using HMAC-SHA256 signatures
 * from both parties, proving mutual consent to communicate.
 *
 * Token flow:
 * 1. Party A creates a token request with their signature (createMutualTokenInit)
 * 2. Party B signs the request (countersignMutualToken) - cannot verify A's signature
 * 3. Both parties use the same mutual token for send/receive
 * 4. Each party can verify their OWN signature by authenticating (verifyOwnSignature)
 *
 * Token format: Raw JSON object with dual HMAC signatures and verification secrets
 *
 * SECURITY:
 * - Signing keys are HMAC keys derived from passkey PRF - fully non-extractable
 * - No private key bytes are ever exposed to JavaScript
 * - Each party can only verify their own signature (requires passkey auth)
 * - The other party's signature cannot be verified without their passkey
 * - Verification secrets enable handshake-time authentication to prevent impersonation
 *   with stolen tokens (each party must prove they control their passkey)
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
  /** Party A's contact public key (base64, 32 bytes) - derived from PRF */
  a_cpk: string
  /** Party B's public ID (base64, 32 bytes) - lexicographically larger */
  b_id: string
  /** Party B's contact public key (base64, 32 bytes) - derived from PRF */
  b_cpk: string
  /** Created at timestamp (Unix seconds) - set by initiator */
  iat: number
  /** Which party initiated the token ('a' or 'b') */
  init_party: 'a' | 'b'
  /** Initiator's HMAC-SHA256 signature (base64, 32 bytes) */
  init_sig: string
  /** Initiator's verification secret (base64, 32 bytes) - for handshake auth */
  init_vs: string
  /** Optional comment (max 256 bytes) */
  comment?: string
}

/**
 * Complete mutual token - both parties have signed
 */
export interface MutualContactTokenPayload extends PendingTokenRequest {
  /** Countersigner's HMAC-SHA256 signature (base64, 32 bytes) */
  counter_sig: string
  /** Countersigner's verification secret (base64, 32 bytes) - for handshake auth */
  counter_vs: string
}

/**
 * Result of parsing a mutual token (without signature verification)
 */
export interface ParsedMutualToken {
  /** Party A's public ID (32 bytes) - lexicographically smaller */
  partyAPublicId: Uint8Array
  /** Party A's fingerprint */
  partyAFingerprint: string
  /** Party A's contact public key (32 bytes) - derived from PRF */
  partyAContactKey: Uint8Array
  /** Party A's verification secret (32 bytes) - for handshake auth */
  partyAVerificationSecret: Uint8Array

  /** Party B's public ID (32 bytes) - lexicographically larger */
  partyBPublicId: Uint8Array
  /** Party B's fingerprint */
  partyBFingerprint: string
  /** Party B's contact public key (32 bytes) - derived from PRF */
  partyBContactKey: Uint8Array
  /** Party B's verification secret (32 bytes) - for handshake auth */
  partyBVerificationSecret: Uint8Array

  /** Token creation timestamp */
  issuedAt: Date
  /** Optional comment */
  comment?: string
}

/**
 * Result of verifying your own signature on a token
 */
export interface VerifiedOwnSignature {
  /** Which party you are */
  myRole: 'A' | 'B'
  /** Your public ID */
  myPublicId: Uint8Array
  /** Your fingerprint */
  myFingerprint: string
  /** Counterparty's public ID */
  counterpartyPublicId: Uint8Array
  /** Counterparty's fingerprint */
  counterpartyFingerprint: string
  /** Counterparty's contact public key (for identity binding) */
  counterpartyContactKey: Uint8Array
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

  // Total: 32 + 32 + 32 + 32 + 8 + commentBytes.length = 136 + comment
  const baseLength = 136
  const data = new Uint8Array(baseLength + commentBytes.length)
  let offset = 0

  data.set(aId, offset)
  offset += 32
  data.set(aCpk, offset)
  offset += 32
  data.set(bId, offset)
  offset += 32
  data.set(bCpk, offset)
  offset += 32

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
 * Compute a verification secret for handshake authentication.
 * VS = HMAC(contact_hmac_key, "verification-secret" || counterparty_cpk)
 *
 * This secret is included in the token and allows the counterparty to verify
 * that you control your passkey during the handshake (preventing impersonation
 * with a stolen token).
 */
async function computeVerificationSecret(
  contactHmacKey: CryptoKey,
  counterpartyCpk: Uint8Array
): Promise<Uint8Array> {
  const label = new TextEncoder().encode('verification-secret')
  const data = new Uint8Array(label.length + counterpartyCpk.length)
  data.set(label, 0)
  data.set(counterpartyCpk, label.length)

  const vsBuffer = await crypto.subtle.sign(
    'HMAC',
    contactHmacKey,
    data as Uint8Array<ArrayBuffer>
  )
  return new Uint8Array(vsBuffer)
}

/**
 * Compute a handshake proof that proves you control the passkey.
 * Proof = HMAC(verification_secret, ephemeral_pub || nonce || counterparty_fingerprint)
 *
 * @param verificationSecret - Your verification secret (from token, 32 bytes)
 * @param ephemeralPub - Your ephemeral public key (65 bytes)
 * @param nonce - Random nonce from the handshake (16 bytes)
 * @param counterpartyFingerprint - Counterparty's fingerprint string
 * @returns Handshake proof (32 bytes)
 */
export async function computeHandshakeProof(
  verificationSecret: Uint8Array,
  ephemeralPub: Uint8Array,
  nonce: Uint8Array,
  counterpartyFingerprint: string
): Promise<Uint8Array> {
  // Import VS as HMAC key
  const vsKey = await crypto.subtle.importKey(
    'raw',
    verificationSecret as Uint8Array<ArrayBuffer>,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )

  // Compute proof: HMAC(vs, epk || nonce || fingerprint_bytes)
  const fingerprintBytes = new TextEncoder().encode(counterpartyFingerprint)
  const data = new Uint8Array(ephemeralPub.length + nonce.length + fingerprintBytes.length)
  let offset = 0
  data.set(ephemeralPub, offset)
  offset += ephemeralPub.length
  data.set(nonce, offset)
  offset += nonce.length
  data.set(fingerprintBytes, offset)

  const proofBuffer = await crypto.subtle.sign(
    'HMAC',
    vsKey,
    data as Uint8Array<ArrayBuffer>
  )
  return new Uint8Array(proofBuffer)
}

/**
 * Verify a handshake proof from the counterparty.
 *
 * @param counterpartyVs - Counterparty's verification secret (from token, 32 bytes)
 * @param proof - The handshake proof to verify (32 bytes)
 * @param counterpartyEphemeralPub - Counterparty's ephemeral public key (65 bytes)
 * @param nonce - Random nonce from the handshake (16 bytes)
 * @param myFingerprint - Your fingerprint string
 * @returns true if proof is valid
 */
export async function verifyHandshakeProof(
  counterpartyVs: Uint8Array,
  proof: Uint8Array,
  counterpartyEphemeralPub: Uint8Array,
  nonce: Uint8Array,
  myFingerprint: string
): Promise<boolean> {
  // Import counterparty's VS as HMAC key
  const vsKey = await crypto.subtle.importKey(
    'raw',
    counterpartyVs as Uint8Array<ArrayBuffer>,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  )

  // Verify proof: HMAC(vs, epk || nonce || fingerprint_bytes)
  const fingerprintBytes = new TextEncoder().encode(myFingerprint)
  const data = new Uint8Array(counterpartyEphemeralPub.length + nonce.length + fingerprintBytes.length)
  let offset = 0
  data.set(counterpartyEphemeralPub, offset)
  offset += counterpartyEphemeralPub.length
  data.set(nonce, offset)
  offset += nonce.length
  data.set(fingerprintBytes, offset)

  return crypto.subtle.verify(
    'HMAC',
    vsKey,
    proof as Uint8Array<ArrayBuffer>,
    data as Uint8Array<ArrayBuffer>
  )
}

/**
 * Get the counterparty's verification secret from a parsed token.
 */
export function getCounterpartyVerificationSecret(
  parsed: ParsedMutualToken,
  myPublicId: Uint8Array
): Uint8Array {
  if (constantTimeEqualBytes(myPublicId, parsed.partyAPublicId)) {
    return parsed.partyBVerificationSecret
  } else if (constantTimeEqualBytes(myPublicId, parsed.partyBPublicId)) {
    return parsed.partyAVerificationSecret
  } else {
    throw new Error('You are not a party to this token')
  }
}

/**
 * Get your own verification secret from a parsed token.
 */
export function getOwnVerificationSecret(
  parsed: ParsedMutualToken,
  myPublicId: Uint8Array
): Uint8Array {
  if (constantTimeEqualBytes(myPublicId, parsed.partyAPublicId)) {
    return parsed.partyAVerificationSecret
  } else if (constantTimeEqualBytes(myPublicId, parsed.partyBPublicId)) {
    return parsed.partyBVerificationSecret
  } else {
    throw new Error('You are not a party to this token')
  }
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
      (p.init_party === 'a' || p.init_party === 'b') &&
      typeof p.init_sig === 'string' &&
      typeof p.init_vs === 'string' &&
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

    // Must have both initiator AND countersigner signatures and verification secrets
    return (
      typeof p.a_id === 'string' &&
      typeof p.a_cpk === 'string' &&
      typeof p.b_id === 'string' &&
      typeof p.b_cpk === 'string' &&
      typeof p.iat === 'number' &&
      (p.init_party === 'a' || p.init_party === 'b') &&
      typeof p.init_sig === 'string' &&
      typeof p.init_vs === 'string' &&
      typeof p.counter_sig === 'string' &&
      typeof p.counter_vs === 'string'
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
 * @param contactHmacKey - Initiator's non-extractable HMAC signing key (from PRF)
 * @param contactPublicKey - Initiator's contact public key (32 bytes, derived from PRF)
 * @param initiatorPublicIdBase64 - Initiator's passkey public ID (base64)
 * @param counterpartyPublicIdBase64 - Counterparty's public ID (base64)
 * @param counterpartyCpkBase64 - Counterparty's contact public key (base64)
 * @param comment - Optional comment (max 256 bytes)
 * @returns Token request (JSON string) to send to counterparty for signing
 */
export async function createMutualTokenInit(
  contactHmacKey: CryptoKey,
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

  // Validate initiator's contact public key (now 32 bytes, not 65)
  if (contactPublicKey.length !== 32) {
    throw new Error('Invalid initiator contact public key: expected 32 bytes')
  }

  // Decode and validate counterparty's contact public key
  const counterpartyCpk = base64ToUint8Array(counterpartyCpkBase64)
  if (counterpartyCpk.length !== 32) {
    throw new Error('Invalid counterparty contact public key: expected 32 bytes')
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

  // Sign with HMAC-SHA256 (32 bytes)
  const signatureBuffer = await crypto.subtle.sign(
    'HMAC',
    contactHmacKey,
    challenge as Uint8Array<ArrayBuffer>
  )
  const signature = new Uint8Array(signatureBuffer)

  // Compute verification secret for handshake authentication
  // VS = HMAC(contact_hmac_key, "verification-secret" || counterparty_cpk)
  const initiatorVs = await computeVerificationSecret(contactHmacKey, counterpartyCpk)

  // Determine initiator's party role
  const initParty: 'a' | 'b' = cmp < 0 ? 'a' : 'b'

  // Build token request
  const payload: PendingTokenRequest = {
    a_id: uint8ArrayToBase64(aId),
    a_cpk: uint8ArrayToBase64(aCpk),
    b_id: uint8ArrayToBase64(bId),
    b_cpk: uint8ArrayToBase64(bCpk),
    iat,
    init_party: initParty,
    init_sig: uint8ArrayToBase64(signature),
    init_vs: uint8ArrayToBase64(initiatorVs),
  }

  if (trimmedComment) {
    payload.comment = trimmedComment
  }

  return JSON.stringify(payload)
}

/**
 * Sign a token request to create the final mutual token.
 *
 * NOTE: With HMAC, we CANNOT verify the initiator's signature (we don't have their key).
 * We trust that the token came from the intended party via out-of-band verification.
 *
 * @param tokenRequest - The token request JSON from initiator
 * @param contactHmacKey - Signer's non-extractable HMAC signing key (from PRF)
 * @param contactPublicKey - Signer's contact public key (32 bytes, derived from PRF)
 * @param signerPublicIdBase64 - Signer's passkey public ID (base64)
 * @returns Completed mutual token (JSON string)
 */
export async function countersignMutualToken(
  tokenRequest: string,
  contactHmacKey: CryptoKey,
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
    (request.init_party !== 'a' && request.init_party !== 'b') ||
    typeof request.init_sig !== 'string' ||
    typeof request.init_vs !== 'string'
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
  const initVs = base64ToUint8Array(request.init_vs)

  if (aId.length !== 32) throw new Error('Invalid a_id: expected 32 bytes')
  if (bId.length !== 32) throw new Error('Invalid b_id: expected 32 bytes')
  if (aCpk.length !== 32) throw new Error('Invalid a_cpk: expected 32 bytes')
  if (bCpk.length !== 32) throw new Error('Invalid b_cpk: expected 32 bytes')
  if (initVs.length !== 32) throw new Error('Invalid init_vs: expected 32 bytes')

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
  if (contactPublicKey.length !== 32) {
    throw new Error('Invalid signer contact public key: expected 32 bytes')
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

  // NOTE: We cannot verify the initiator's signature with HMAC (we don't have their key)
  // Trust is established via out-of-band fingerprint verification

  // Compute challenge (same for both signatures, includes comment if present)
  const challenge = await computeMutualChallenge(aId, aCpk, bId, bCpk, request.iat, request.comment)

  // Sign with HMAC-SHA256 (32 bytes)
  const signatureBuffer = await crypto.subtle.sign(
    'HMAC',
    contactHmacKey,
    challenge as Uint8Array<ArrayBuffer>
  )
  const signature = new Uint8Array(signatureBuffer)

  // Compute verification secret for handshake authentication
  // Countersigner's VS is computed against the initiator's cpk
  // Use init_party to determine who the initiator was (not inferred from countersigner position)
  const initiatorCpk = request.init_party === 'a' ? aCpk : bCpk
  const counterVs = await computeVerificationSecret(contactHmacKey, initiatorCpk)

  // Build complete token with comment at the end for readability
  const complete: MutualContactTokenPayload = {
    a_id: request.a_id,
    a_cpk: request.a_cpk,
    b_id: request.b_id,
    b_cpk: request.b_cpk,
    iat: request.iat,
    init_party: request.init_party,
    init_sig: request.init_sig,
    init_vs: request.init_vs,
    counter_sig: uint8ArrayToBase64(signature),
    counter_vs: uint8ArrayToBase64(counterVs),
    ...(request.comment ? { comment: request.comment } : {}),
  }

  return JSON.stringify(complete)
}

/**
 * Parse a mutual token WITHOUT verifying signatures.
 * Use this to extract party information for display.
 *
 * For signature verification, use verifyOwnSignature() which requires passkey auth.
 *
 * @param token - The mutual token JSON string
 * @param myPublicId - Optional: check that you're a party to the token
 * @returns Parsed token data
 */
export async function parseToken(
  token: string,
  myPublicId?: Uint8Array
): Promise<ParsedMutualToken> {
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
    (payload.init_party !== 'a' && payload.init_party !== 'b') ||
    typeof payload.init_sig !== 'string' ||
    typeof payload.init_vs !== 'string' ||
    typeof payload.counter_sig !== 'string' ||
    typeof payload.counter_vs !== 'string'
  ) {
    throw new Error('Invalid mutual token: missing required fields')
  }

  // Decode fields
  const aId = base64ToUint8Array(payload.a_id)
  const aCpk = base64ToUint8Array(payload.a_cpk)
  const bId = base64ToUint8Array(payload.b_id)
  const bCpk = base64ToUint8Array(payload.b_cpk)
  const initVs = base64ToUint8Array(payload.init_vs)
  const counterVs = base64ToUint8Array(payload.counter_vs)

  if (aId.length !== 32) throw new Error('Invalid a_id: expected 32 bytes')
  if (bId.length !== 32) throw new Error('Invalid b_id: expected 32 bytes')
  if (aCpk.length !== 32) throw new Error('Invalid a_cpk: expected 32 bytes')
  if (bCpk.length !== 32) throw new Error('Invalid b_cpk: expected 32 bytes')
  if (initVs.length !== 32) throw new Error('Invalid init_vs: expected 32 bytes')
  if (counterVs.length !== 32) throw new Error('Invalid counter_vs: expected 32 bytes')

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

  // Generate fingerprints
  const partyAFingerprint = await publicKeyToFingerprint(aId)
  const partyBFingerprint = await publicKeyToFingerprint(bId)

  // Map verification secrets to parties based on who initiated
  // init_vs belongs to the initiator, counter_vs belongs to the countersigner
  const partyAVs = payload.init_party === 'a' ? initVs : counterVs
  const partyBVs = payload.init_party === 'a' ? counterVs : initVs

  return {
    partyAPublicId: aId,
    partyAFingerprint,
    partyAContactKey: aCpk,
    partyAVerificationSecret: partyAVs,
    partyBPublicId: bId,
    partyBFingerprint,
    partyBContactKey: bCpk,
    partyBVerificationSecret: partyBVs,
    issuedAt: new Date(payload.iat * 1000),
    comment: payload.comment,
  }
}

/**
 * Verify YOUR OWN signature on a mutual token.
 * Requires passkey authentication to derive the HMAC key.
 *
 * NOTE: You can only verify your own signature. The other party's signature
 * cannot be verified without their passkey.
 *
 * @param token - The mutual token JSON string
 * @param contactHmacKey - Your non-extractable HMAC key (from getPasskeyIdentity)
 * @param myPublicId - Your public ID (from getPasskeyIdentity)
 * @returns Verification result with party info
 */
export async function verifyOwnSignature(
  token: string,
  contactHmacKey: CryptoKey,
  myPublicId: Uint8Array
): Promise<VerifiedOwnSignature> {
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

  if (aId.length !== 32) throw new Error('Invalid a_id: expected 32 bytes')
  if (bId.length !== 32) throw new Error('Invalid b_id: expected 32 bytes')
  if (aCpk.length !== 32) throw new Error('Invalid a_cpk: expected 32 bytes')
  if (bCpk.length !== 32) throw new Error('Invalid b_cpk: expected 32 bytes')

  // Determine which party I am
  const isPartyA = constantTimeEqualBytes(myPublicId, aId)
  const isPartyB = constantTimeEqualBytes(myPublicId, bId)

  if (!isPartyA && !isPartyB) {
    throw new Error('You are not a party to this token')
  }

  const myRole: 'A' | 'B' = isPartyA ? 'A' : 'B'

  // Compute challenge
  const challenge = await computeMutualChallenge(aId, aCpk, bId, bCpk, payload.iat, payload.comment)

  // Determine which signature is mine (could be init_sig or counter_sig)
  // We need to try both since we don't know if we were the initiator or countersigner
  const initSig = base64ToUint8Array(payload.init_sig)
  const counterSig = base64ToUint8Array(payload.counter_sig)

  // Verify my signature with HMAC
  const verifyHmac = async (sig: Uint8Array): Promise<boolean> => {
    return crypto.subtle.verify(
      'HMAC',
      contactHmacKey,
      sig as Uint8Array<ArrayBuffer>,
      challenge as Uint8Array<ArrayBuffer>
    )
  }

  const initSigValid = await verifyHmac(initSig)
  const counterSigValid = await verifyHmac(counterSig)

  if (!initSigValid && !counterSigValid) {
    throw new Error('Your signature verification failed - this token was not signed by your passkey')
  }

  // Generate fingerprints
  const partyAFingerprint = await publicKeyToFingerprint(aId)
  const partyBFingerprint = await publicKeyToFingerprint(bId)

  return {
    myRole,
    myPublicId: isPartyA ? aId : bId,
    myFingerprint: isPartyA ? partyAFingerprint : partyBFingerprint,
    counterpartyPublicId: isPartyA ? bId : aId,
    counterpartyFingerprint: isPartyA ? partyBFingerprint : partyAFingerprint,
    counterpartyContactKey: isPartyA ? bCpk : aCpk,
    issuedAt: new Date(payload.iat * 1000),
    comment: payload.comment,
  }
}

/**
 * Get the counterparty's info from a parsed mutual token.
 * Convenience helper for send/receive flows.
 */
export function getCounterpartyFromParsedToken(
  parsed: ParsedMutualToken,
  myPublicId: Uint8Array
): { publicId: Uint8Array; fingerprint: string; contactKey: Uint8Array } {
  if (constantTimeEqualBytes(myPublicId, parsed.partyAPublicId)) {
    return {
      publicId: parsed.partyBPublicId,
      fingerprint: parsed.partyBFingerprint,
      contactKey: parsed.partyBContactKey,
    }
  } else if (constantTimeEqualBytes(myPublicId, parsed.partyBPublicId)) {
    return {
      publicId: parsed.partyAPublicId,
      fingerprint: parsed.partyAFingerprint,
      contactKey: parsed.partyAContactKey,
    }
  } else {
    throw new Error('You are not a party to this token')
  }
}
