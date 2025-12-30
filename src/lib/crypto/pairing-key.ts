/**
 * Pairing Key - Countersigned keys for bidirectional trust
 *
 * This module provides functions to create and verify pairing keys.
 * A pairing key binds two peers together using HMAC-SHA256 signatures
 * from both parties, proving mutual consent to communicate.
 *
 * Pairing flow:
 * 1. Peer A creates a pairing request with their signature (createPairingRequest)
 * 2. Peer B confirms the request (confirmPairingRequest) - cannot verify A's signature
 * 3. Both peers use the same pairing key for send/receive
 * 4. Each peer can verify their OWN signature by authenticating (verifyOwnSignature)
 *
 * Key format: Raw JSON object with dual HMAC signatures and verification secrets
 *
 * SECURITY:
 * - Signing keys are HMAC keys derived from passkey PRF - fully non-extractable
 * - No private key bytes are ever exposed to JavaScript
 * - Each peer can only verify their own signature (requires passkey auth)
 * - The other peer's signature cannot be verified without their passkey
 * - Verification secrets enable handshake-time authentication to prevent impersonation
 *   with stolen keys (each peer must prove they control their passkey)
 */

import { publicKeyToFingerprint, constantTimeEqualBytes } from './ecdh'

/** Maximum byte length for comment field to prevent overly large keys */
const MAX_COMMENT_BYTES = 256

/** Identity card TTL in seconds (24 hours) */
export const IDENTITY_CARD_TTL_SECONDS = 24 * 60 * 60

/**
 * Pairing request - created by initiator, waiting for confirmation
 */
export interface PairingRequest {
  /** Party A's public ID (base64, 32 bytes) - lexicographically smaller */
  a_id: string
  /** Party A's peer public key (base64, 32 bytes) - derived from PRF */
  a_ppk: string
  /** Party B's public ID (base64, 32 bytes) - lexicographically larger */
  b_id: string
  /** Party B's peer public key (base64, 32 bytes) - derived from PRF */
  b_ppk: string
  /** Identity card issued-at timestamp (Unix seconds) - copied from Signer's identity card, valid for 24 hours */
  iat: number
  /** Which party initiated the pairing ('a' or 'b') */
  init_party: 'a' | 'b'
  /** Initiator's HMAC-SHA256 signature (base64, 32 bytes) */
  init_sig: string
  /** Initiator's verification secret (base64, 32 bytes) - for handshake auth */
  init_vs: string
  /** Optional comment (max 256 bytes) */
  comment?: string
}

/**
 * Complete pairing key - both peers have signed
 */
export interface PairingKeyPayload extends PairingRequest {
  /** Confirmer's HMAC-SHA256 signature (base64, 32 bytes) */
  counter_sig: string
  /** Confirmer's verification secret (base64, 32 bytes) - for handshake auth */
  counter_vs: string
}

/**
 * Result of parsing a pairing key (without signature verification)
 */
export interface ParsedPairingKey {
  /** Party A's public ID (32 bytes) - lexicographically smaller */
  partyAPublicId: Uint8Array
  /** Party A's fingerprint */
  partyAFingerprint: string
  /** Party A's peer public key (32 bytes) - derived from PRF */
  partyAPeerKey: Uint8Array
  /** Party A's verification secret (32 bytes) - for handshake auth */
  partyAVerificationSecret: Uint8Array

  /** Party B's public ID (32 bytes) - lexicographically larger */
  partyBPublicId: Uint8Array
  /** Party B's fingerprint */
  partyBFingerprint: string
  /** Party B's peer public key (32 bytes) - derived from PRF */
  partyBPeerKey: Uint8Array
  /** Party B's verification secret (32 bytes) - for handshake auth */
  partyBVerificationSecret: Uint8Array

  /** Pairing key creation timestamp */
  issuedAt: Date
  /** Optional comment */
  comment?: string
}

/**
 * Result of verifying your own signature on a pairing key
 */
export interface VerifiedOwnSignature {
  /** Which party you are */
  myRole: 'A' | 'B'
  /** Your public ID */
  myPublicId: Uint8Array
  /** Your fingerprint */
  myFingerprint: string
  /** Peer's public ID */
  peerPublicId: Uint8Array
  /** Peer's fingerprint */
  peerFingerprint: string
  /** Peer's peer public key (for identity binding) */
  peerPeerKey: Uint8Array
  /** Pairing key creation timestamp */
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
 * Helper to get a proper ArrayBuffer from Uint8Array (handles subarray views).
 * Required for crypto.subtle methods in TypeScript 5.9+ with strict ArrayBuffer typing.
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer
  }
  // Create a copy for subarray views
  return bytes.slice().buffer as ArrayBuffer
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
 * Compute the mutual challenge that both peers sign.
 * Challenge = SHA256(a_id || a_ppk || b_id || b_ppk || iat || comment_bytes)
 *
 * IDs are sorted lexicographically to ensure deterministic ordering.
 * Comment is optional; if provided, it is UTF-8 encoded and appended to the challenge input.
 * iat is the Identity Card timestamp (copied from Signer's identity card).
 */
async function computeMutualChallenge(
  aId: Uint8Array,
  aPpk: Uint8Array,
  bId: Uint8Array,
  bPpk: Uint8Array,
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
  data.set(aPpk, offset)
  offset += 32
  data.set(bId, offset)
  offset += 32
  data.set(bPpk, offset)
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
 * VS = HMAC(hmac_key, "verification-secret" || peer_ppk)
 *
 * This secret is included in the pairing key and allows the peer to verify
 * that you control your passkey during the handshake (preventing impersonation
 * with a stolen key).
 *
 * @param hmacKey - Your own non-extractable HMAC signing key (NOT the peer's)
 * @param peerPpk - The peer's public key for binding
 */
async function computeVerificationSecret(
  hmacKey: CryptoKey,
  peerPpk: Uint8Array
): Promise<Uint8Array> {
  const label = new TextEncoder().encode('verification-secret')
  const data = new Uint8Array(label.length + peerPpk.length)
  data.set(label, 0)
  data.set(peerPpk, label.length)

  const vsBuffer = await crypto.subtle.sign('HMAC', hmacKey, toArrayBuffer(data))
  return new Uint8Array(vsBuffer)
}

/**
 * Compute a handshake proof that proves you control the passkey.
 * Proof = HMAC(verification_secret, ephemeral_pub || nonce || peer_fingerprint)
 *
 * @param verificationSecret - Your verification secret (from pairing key, 32 bytes)
 * @param ephemeralPub - Your ephemeral public key (65 bytes)
 * @param nonce - Random nonce from the handshake (16 bytes)
 * @param peerFingerprint - Peer's fingerprint string
 * @returns Handshake proof (32 bytes)
 */
export async function computeHandshakeProof(
  verificationSecret: Uint8Array,
  ephemeralPub: Uint8Array,
  nonce: Uint8Array,
  peerFingerprint: string
): Promise<Uint8Array> {
  // Import VS as HMAC key
  const vsKey = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(verificationSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )

  // Compute proof: HMAC(vs, epk || nonce || fingerprint_bytes)
  const fingerprintBytes = new TextEncoder().encode(peerFingerprint)
  const data = new Uint8Array(ephemeralPub.length + nonce.length + fingerprintBytes.length)
  let offset = 0
  data.set(ephemeralPub, offset)
  offset += ephemeralPub.length
  data.set(nonce, offset)
  offset += nonce.length
  data.set(fingerprintBytes, offset)

  const proofBuffer = await crypto.subtle.sign('HMAC', vsKey, toArrayBuffer(data))
  return new Uint8Array(proofBuffer)
}

/**
 * Verify a handshake proof from the peer.
 *
 * @param peerVs - Peer's verification secret (from pairing key, 32 bytes)
 * @param proof - The handshake proof to verify (32 bytes)
 * @param peerEphemeralPub - Peer's ephemeral public key (65 bytes)
 * @param nonce - Random nonce from the handshake (16 bytes)
 * @param myFingerprint - Your fingerprint string
 * @returns true if proof is valid
 */
export async function verifyHandshakeProof(
  peerVs: Uint8Array,
  proof: Uint8Array,
  peerEphemeralPub: Uint8Array,
  nonce: Uint8Array,
  myFingerprint: string
): Promise<boolean> {
  // Import peer's VS as HMAC key
  const vsKey = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(peerVs),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  )

  // Verify proof: HMAC(vs, epk || nonce || fingerprint_bytes)
  const fingerprintBytes = new TextEncoder().encode(myFingerprint)
  const data = new Uint8Array(peerEphemeralPub.length + nonce.length + fingerprintBytes.length)
  let offset = 0
  data.set(peerEphemeralPub, offset)
  offset += peerEphemeralPub.length
  data.set(nonce, offset)
  offset += nonce.length
  data.set(fingerprintBytes, offset)

  return crypto.subtle.verify('HMAC', vsKey, toArrayBuffer(proof), toArrayBuffer(data))
}

/**
 * Get the peer's verification secret from a parsed pairing key.
 */
export function getPeerVerificationSecret(
  parsed: ParsedPairingKey,
  myPublicId: Uint8Array
): Uint8Array {
  if (constantTimeEqualBytes(myPublicId, parsed.partyAPublicId)) {
    return parsed.partyBVerificationSecret
  } else if (constantTimeEqualBytes(myPublicId, parsed.partyBPublicId)) {
    return parsed.partyAVerificationSecret
  } else {
    throw new Error('You are not a party to this pairing key')
  }
}

/**
 * Get your own verification secret from a parsed pairing key.
 */
export function getOwnVerificationSecret(
  parsed: ParsedPairingKey,
  myPublicId: Uint8Array
): Uint8Array {
  if (constantTimeEqualBytes(myPublicId, parsed.partyAPublicId)) {
    return parsed.partyAVerificationSecret
  } else if (constantTimeEqualBytes(myPublicId, parsed.partyBPublicId)) {
    return parsed.partyBVerificationSecret
  } else {
    throw new Error('You are not a party to this pairing key')
  }
}

/**
 * Check if a string looks like a pairing request (single signature).
 * Does NOT verify the signature - just checks structure.
 */
export function isPairingRequestFormat(input: string): boolean {
  try {
    const payload = JSON.parse(input.trim()) as unknown
    if (typeof payload !== 'object' || payload === null) return false
    const p = payload as Record<string, unknown>

    // Must have initiator signature but NOT confirmer signature
    return (
      typeof p.a_id === 'string' &&
      typeof p.a_ppk === 'string' &&
      typeof p.b_id === 'string' &&
      typeof p.b_ppk === 'string' &&
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
 * Check if a string looks like a complete pairing key (dual signatures).
 * Does NOT verify signatures - just checks structure.
 */
export function isPairingKeyFormat(input: string): boolean {
  try {
    const payload = JSON.parse(input.trim()) as unknown
    if (typeof payload !== 'object' || payload === null) return false
    const p = payload as Record<string, unknown>

    // Must have both initiator AND confirmer signatures and verification secrets
    return (
      typeof p.a_id === 'string' &&
      typeof p.a_ppk === 'string' &&
      typeof p.b_id === 'string' &&
      typeof p.b_ppk === 'string' &&
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
 * Create initial pairing request (initiator signs first).
 *
 * The initiator must know the peer's public ID and peer public key.
 * The request will contain both peers' identity information with the initiator's signature.
 *
 * @param hmacKey - Your own non-extractable HMAC signing key (NOT the peer's - from PRF)
 * @param peerPublicKey - Initiator's peer public key (32 bytes, derived from PRF)
 * @param initiatorPublicIdBase64 - Initiator's passkey public ID (base64)
 * @param peerPublicIdBase64 - Peer's public ID (base64)
 * @param peerPpkBase64 - Peer's peer public key (base64)
 * @param identityCardIat - Signer's identity card issued-at timestamp (Unix seconds)
 * @param comment - Optional comment (max 256 bytes)
 * @returns Pairing request (JSON string) to send to peer for confirmation
 * @throws Error if the identity card has expired (>24 hours old)
 */
export async function createPairingRequest(
  hmacKey: CryptoKey,
  peerPublicKey: Uint8Array,
  initiatorPublicIdBase64: string,
  peerPublicIdBase64: string,
  peerPpkBase64: string,
  identityCardIat: number,
  comment?: string
): Promise<string> {
  // Validate identity card TTL
  const now = Math.floor(Date.now() / 1000)
  if (now - identityCardIat > IDENTITY_CARD_TTL_SECONDS) {
    throw new Error('Identity card has expired (valid for 24 hours)')
  }
  // Decode and validate initiator's public ID
  const initiatorPublicId = base64ToUint8Array(initiatorPublicIdBase64)
  if (initiatorPublicId.length !== 32) {
    throw new Error('Invalid initiator public ID: expected 32 bytes')
  }

  // Decode and validate peer's public ID
  const peerPublicId = base64ToUint8Array(peerPublicIdBase64)
  if (peerPublicId.length !== 32) {
    throw new Error('Invalid peer public ID: expected 32 bytes')
  }

  // Validate initiator's peer public key (now 32 bytes, not 65)
  if (peerPublicKey.length !== 32) {
    throw new Error('Invalid initiator peer public key: expected 32 bytes')
  }

  // Decode and validate peer's peer public key
  const peerPpk = base64ToUint8Array(peerPpkBase64)
  if (peerPpk.length !== 32) {
    throw new Error('Invalid peer peer public key: expected 32 bytes')
  }

  // Determine lexicographic ordering
  const cmp = compareIds(initiatorPublicId, peerPublicId)
  if (cmp === 0) {
    throw new Error('Cannot create pairing key with yourself')
  }

  // Assign to a_id/b_id based on lexicographic order
  let aId: Uint8Array, aPpk: Uint8Array, bId: Uint8Array, bPpk: Uint8Array
  if (cmp < 0) {
    // initiator is party A
    aId = initiatorPublicId
    aPpk = peerPublicKey
    bId = peerPublicId
    bPpk = peerPpk
  } else {
    // initiator is party B
    aId = peerPublicId
    aPpk = peerPpk
    bId = initiatorPublicId
    bPpk = peerPublicKey
  }

  // Trim and validate comment before signing (byte length, not character count)
  const trimmedComment = comment?.trim()
  if (trimmedComment) {
    const commentByteLength = new TextEncoder().encode(trimmedComment).length
    if (commentByteLength > MAX_COMMENT_BYTES) {
      throw new Error(`Comment exceeds maximum size of ${MAX_COMMENT_BYTES} bytes (got ${commentByteLength} bytes)`)
    }
  }

  // Compute challenge using the Identity Card's iat (includes comment if present)
  const challenge = await computeMutualChallenge(aId, aPpk, bId, bPpk, identityCardIat, trimmedComment)

  // Sign with HMAC-SHA256 (32 bytes)
  const signatureBuffer = await crypto.subtle.sign('HMAC', hmacKey, toArrayBuffer(challenge))
  const signature = new Uint8Array(signatureBuffer)

  // Compute verification secret for handshake authentication
  // VS = HMAC(hmac_key, "verification-secret" || peer_ppk)
  const initiatorVs = await computeVerificationSecret(hmacKey, peerPpk)

  // Determine initiator's party role
  const initParty: 'a' | 'b' = cmp < 0 ? 'a' : 'b'

  // Build pairing request (iat is copied from Identity Card)
  const payload: PairingRequest = {
    a_id: uint8ArrayToBase64(aId),
    a_ppk: uint8ArrayToBase64(aPpk),
    b_id: uint8ArrayToBase64(bId),
    b_ppk: uint8ArrayToBase64(bPpk),
    iat: identityCardIat,
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
 * Confirm a pairing request to create the final pairing key.
 *
 * NOTE: With HMAC, we CANNOT verify the initiator's signature (we don't have their key).
 * We trust that the request came from the intended peer via out-of-band verification.
 *
 * @param pairingRequest - The pairing request JSON from initiator
 * @param hmacKey - Your own non-extractable HMAC signing key (NOT the peer's - from PRF)
 * @param peerPublicKey - Signer's peer public key (32 bytes, derived from PRF)
 * @param signerPublicIdBase64 - Signer's passkey public ID (base64)
 * @returns Completed pairing key (JSON string)
 */
export async function confirmPairingRequest(
  pairingRequest: string,
  hmacKey: CryptoKey,
  peerPublicKey: Uint8Array,
  signerPublicIdBase64: string
): Promise<string> {
  // Parse pairing request
  let request: PairingRequest
  try {
    request = JSON.parse(pairingRequest.trim()) as PairingRequest
  } catch {
    throw new Error('Invalid pairing request: failed to parse JSON')
  }

  // Support both old (a_cpk/b_cpk) and new (a_ppk/b_ppk) field names
  const requestAny = request as unknown as Record<string, unknown>
  const aPpkField = requestAny.a_ppk ?? requestAny.a_cpk
  const bPpkField = requestAny.b_ppk ?? requestAny.b_cpk

  // Validate required fields
  if (
    typeof request.a_id !== 'string' ||
    typeof aPpkField !== 'string' ||
    typeof request.b_id !== 'string' ||
    typeof bPpkField !== 'string' ||
    typeof request.iat !== 'number' ||
    !Number.isFinite(request.iat) ||
    (request.init_party !== 'a' && request.init_party !== 'b') ||
    typeof request.init_sig !== 'string' ||
    typeof request.init_vs !== 'string'
  ) {
    throw new Error('Invalid pairing request: missing required fields')
  }

  // Validate identity card TTL (protects confirmer even if initiator bypassed check)
  const now = Math.floor(Date.now() / 1000)
  if (now - request.iat > IDENTITY_CARD_TTL_SECONDS) {
    throw new Error('Identity card has expired (valid for 24 hours)')
  }

  // Validate comment byte length if present
  if (request.comment !== undefined) {
    if (typeof request.comment !== 'string') {
      throw new Error('Invalid pairing request: comment must be a string')
    }
    const commentByteLength = new TextEncoder().encode(request.comment).length
    if (commentByteLength > MAX_COMMENT_BYTES) {
      throw new Error(`Comment exceeds maximum size of ${MAX_COMMENT_BYTES} bytes`)
    }
  }

  // Decode fields
  const aId = base64ToUint8Array(request.a_id)
  const aPpk = base64ToUint8Array(aPpkField as string)
  const bId = base64ToUint8Array(request.b_id)
  const bPpk = base64ToUint8Array(bPpkField as string)
  const initVs = base64ToUint8Array(request.init_vs)

  if (aId.length !== 32) throw new Error('Invalid a_id: expected 32 bytes')
  if (bId.length !== 32) throw new Error('Invalid b_id: expected 32 bytes')
  if (aPpk.length !== 32) throw new Error('Invalid a_ppk: expected 32 bytes')
  if (bPpk.length !== 32) throw new Error('Invalid b_ppk: expected 32 bytes')
  if (initVs.length !== 32) throw new Error('Invalid init_vs: expected 32 bytes')

  // Verify lexicographic ordering
  if (compareIds(aId, bId) >= 0) {
    throw new Error('Invalid pairing request: a_id must be lexicographically smaller than b_id')
  }

  // Decode confirmer's public ID
  const signerPublicId = base64ToUint8Array(signerPublicIdBase64)
  if (signerPublicId.length !== 32) {
    throw new Error('Invalid signer public ID: expected 32 bytes')
  }

  // Validate confirmer's peer public key
  if (peerPublicKey.length !== 32) {
    throw new Error('Invalid signer peer public key: expected 32 bytes')
  }

  // Determine which party the confirmer is
  const isPartyA = constantTimeEqualBytes(signerPublicId, aId)
  const isPartyB = constantTimeEqualBytes(signerPublicId, bId)

  if (!isPartyA && !isPartyB) {
    throw new Error('You are not a party to this pairing request')
  }

  // Verify confirmer's peer key matches the expected slot
  const expectedPpk = isPartyA ? aPpk : bPpk
  if (!constantTimeEqualBytes(peerPublicKey, expectedPpk)) {
    throw new Error('Your peer public key does not match the pairing request')
  }

  // NOTE: We cannot verify the initiator's signature with HMAC (we don't have their key)
  // Trust is established via out-of-band fingerprint verification

  // Compute challenge (same for both signatures, includes comment if present)
  const challenge = await computeMutualChallenge(aId, aPpk, bId, bPpk, request.iat, request.comment)

  // Sign with HMAC-SHA256 (32 bytes)
  const signatureBuffer = await crypto.subtle.sign('HMAC', hmacKey, toArrayBuffer(challenge))
  const signature = new Uint8Array(signatureBuffer)

  // Compute verification secret for handshake authentication
  // Confirmer's VS is computed against the initiator's ppk
  // Use init_party to determine who the initiator was (not inferred from confirmer position)
  const initiatorPpk = request.init_party === 'a' ? aPpk : bPpk
  const counterVs = await computeVerificationSecret(hmacKey, initiatorPpk)

  // Build complete pairing key with comment at the end for readability
  const complete: PairingKeyPayload = {
    a_id: request.a_id,
    a_ppk: uint8ArrayToBase64(aPpk),
    b_id: request.b_id,
    b_ppk: uint8ArrayToBase64(bPpk),
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
 * Parse a pairing key WITHOUT verifying signatures.
 * Use this to extract party information for display.
 *
 * For signature verification, use verifyOwnSignature() which requires passkey auth.
 *
 * @param pairingKey - The pairing key JSON string
 * @param myPublicId - Optional: check that you're a party to the pairing key
 * @returns Parsed pairing key data
 */
export async function parsePairingKey(
  pairingKey: string,
  myPublicId?: Uint8Array
): Promise<ParsedPairingKey> {
  // Parse pairing key
  let payload: PairingKeyPayload
  try {
    payload = JSON.parse(pairingKey.trim()) as PairingKeyPayload
  } catch {
    throw new Error('Invalid pairing key: failed to parse JSON')
  }

  // Support both old (a_cpk/b_cpk) and new (a_ppk/b_ppk) field names
  const payloadAny = payload as unknown as Record<string, unknown>
  const aPpkField = payloadAny.a_ppk ?? payloadAny.a_cpk
  const bPpkField = payloadAny.b_ppk ?? payloadAny.b_cpk

  // Validate required fields
  if (
    typeof payload.a_id !== 'string' ||
    typeof aPpkField !== 'string' ||
    typeof payload.b_id !== 'string' ||
    typeof bPpkField !== 'string' ||
    typeof payload.iat !== 'number' ||
    !Number.isFinite(payload.iat) ||
    (payload.init_party !== 'a' && payload.init_party !== 'b') ||
    typeof payload.init_sig !== 'string' ||
    typeof payload.init_vs !== 'string' ||
    typeof payload.counter_sig !== 'string' ||
    typeof payload.counter_vs !== 'string'
  ) {
    throw new Error('Invalid pairing key: missing required fields')
  }

  // Decode fields
  const aId = base64ToUint8Array(payload.a_id)
  const aPpk = base64ToUint8Array(aPpkField as string)
  const bId = base64ToUint8Array(payload.b_id)
  const bPpk = base64ToUint8Array(bPpkField as string)
  const initVs = base64ToUint8Array(payload.init_vs)
  const counterVs = base64ToUint8Array(payload.counter_vs)

  if (aId.length !== 32) throw new Error('Invalid a_id: expected 32 bytes')
  if (bId.length !== 32) throw new Error('Invalid b_id: expected 32 bytes')
  if (aPpk.length !== 32) throw new Error('Invalid a_ppk: expected 32 bytes')
  if (bPpk.length !== 32) throw new Error('Invalid b_ppk: expected 32 bytes')
  if (initVs.length !== 32) throw new Error('Invalid init_vs: expected 32 bytes')
  if (counterVs.length !== 32) throw new Error('Invalid counter_vs: expected 32 bytes')

  // Verify lexicographic ordering
  if (compareIds(aId, bId) >= 0) {
    throw new Error('Invalid pairing key: a_id must be lexicographically smaller than b_id')
  }

  // Verify caller is a party (if specified)
  if (myPublicId) {
    const isPartyA = constantTimeEqualBytes(myPublicId, aId)
    const isPartyB = constantTimeEqualBytes(myPublicId, bId)
    if (!isPartyA && !isPartyB) {
      throw new Error('You are not a party to this pairing key')
    }
  }

  // Generate fingerprints
  const partyAFingerprint = await publicKeyToFingerprint(aId)
  const partyBFingerprint = await publicKeyToFingerprint(bId)

  // Map verification secrets to parties based on who initiated
  // init_vs belongs to the initiator, counter_vs belongs to the confirmer
  const partyAVs = payload.init_party === 'a' ? initVs : counterVs
  const partyBVs = payload.init_party === 'a' ? counterVs : initVs

  return {
    partyAPublicId: aId,
    partyAFingerprint,
    partyAPeerKey: aPpk,
    partyAVerificationSecret: partyAVs,
    partyBPublicId: bId,
    partyBFingerprint,
    partyBPeerKey: bPpk,
    partyBVerificationSecret: partyBVs,
    issuedAt: new Date(payload.iat * 1000),
    comment: payload.comment,
  }
}

/**
 * Verify YOUR OWN signature on a pairing key.
 * Requires passkey authentication to derive the HMAC key.
 *
 * NOTE: You can only verify your own signature. The other peer's signature
 * cannot be verified without their passkey.
 *
 * @param pairingKey - The pairing key JSON string
 * @param hmacKey - Your own non-extractable HMAC key (NOT the peer's - from getPasskeyIdentity)
 * @param myPublicId - Your public ID (from getPasskeyIdentity)
 * @returns Verification result with party info
 */
export async function verifyOwnSignature(
  pairingKey: string,
  hmacKey: CryptoKey,
  myPublicId: Uint8Array
): Promise<VerifiedOwnSignature> {
  // Parse pairing key
  let payload: PairingKeyPayload
  try {
    payload = JSON.parse(pairingKey.trim()) as PairingKeyPayload
  } catch {
    throw new Error('Invalid pairing key: failed to parse JSON')
  }

  // Support both old (a_cpk/b_cpk) and new (a_ppk/b_ppk) field names
  const payloadAny = payload as unknown as Record<string, unknown>
  const aPpkField = payloadAny.a_ppk ?? payloadAny.a_cpk
  const bPpkField = payloadAny.b_ppk ?? payloadAny.b_cpk

  // Validate required fields
  if (
    typeof payload.a_id !== 'string' ||
    typeof aPpkField !== 'string' ||
    typeof payload.b_id !== 'string' ||
    typeof bPpkField !== 'string' ||
    typeof payload.iat !== 'number' ||
    !Number.isFinite(payload.iat) ||
    typeof payload.init_sig !== 'string' ||
    typeof payload.counter_sig !== 'string'
  ) {
    throw new Error('Invalid pairing key: missing required fields')
  }

  // Decode fields
  const aId = base64ToUint8Array(payload.a_id)
  const aPpk = base64ToUint8Array(aPpkField as string)
  const bId = base64ToUint8Array(payload.b_id)
  const bPpk = base64ToUint8Array(bPpkField as string)

  if (aId.length !== 32) throw new Error('Invalid a_id: expected 32 bytes')
  if (bId.length !== 32) throw new Error('Invalid b_id: expected 32 bytes')
  if (aPpk.length !== 32) throw new Error('Invalid a_ppk: expected 32 bytes')
  if (bPpk.length !== 32) throw new Error('Invalid b_ppk: expected 32 bytes')

  // Determine which party I am
  const isPartyA = constantTimeEqualBytes(myPublicId, aId)
  const isPartyB = constantTimeEqualBytes(myPublicId, bId)

  if (!isPartyA && !isPartyB) {
    throw new Error('You are not a party to this pairing key')
  }

  const myRole: 'A' | 'B' = isPartyA ? 'A' : 'B'

  // Compute challenge
  const challenge = await computeMutualChallenge(aId, aPpk, bId, bPpk, payload.iat, payload.comment)

  // Determine which signature is mine (could be init_sig or counter_sig)
  // We need to try both since we don't know if we were the initiator or confirmer
  const initSig = base64ToUint8Array(payload.init_sig)
  const counterSig = base64ToUint8Array(payload.counter_sig)

  // Verify my signature with HMAC (using my own HMAC key, not the peer's)
  const challengeBuffer = toArrayBuffer(challenge)
  const verifyHmac = async (sig: Uint8Array): Promise<boolean> => {
    return crypto.subtle.verify('HMAC', hmacKey, toArrayBuffer(sig), challengeBuffer)
  }

  const initSigValid = await verifyHmac(initSig)
  const counterSigValid = await verifyHmac(counterSig)

  if (!initSigValid && !counterSigValid) {
    throw new Error('Your signature verification failed - this pairing key was not signed by your passkey')
  }

  // Generate fingerprints
  const partyAFingerprint = await publicKeyToFingerprint(aId)
  const partyBFingerprint = await publicKeyToFingerprint(bId)

  return {
    myRole,
    myPublicId: isPartyA ? aId : bId,
    myFingerprint: isPartyA ? partyAFingerprint : partyBFingerprint,
    peerPublicId: isPartyA ? bId : aId,
    peerFingerprint: isPartyA ? partyBFingerprint : partyAFingerprint,
    peerPeerKey: isPartyA ? bPpk : aPpk,
    issuedAt: new Date(payload.iat * 1000),
    comment: payload.comment,
  }
}

/**
 * Get the peer's info from a parsed pairing key.
 * Convenience helper for send/receive flows.
 */
export function getPeerFromParsedPairingKey(
  parsed: ParsedPairingKey,
  myPublicId: Uint8Array
): { publicId: Uint8Array; fingerprint: string; peerKey: Uint8Array } {
  if (constantTimeEqualBytes(myPublicId, parsed.partyAPublicId)) {
    return {
      publicId: parsed.partyBPublicId,
      fingerprint: parsed.partyBFingerprint,
      peerKey: parsed.partyBPeerKey,
    }
  } else if (constantTimeEqualBytes(myPublicId, parsed.partyBPublicId)) {
    return {
      publicId: parsed.partyAPublicId,
      fingerprint: parsed.partyAFingerprint,
      peerKey: parsed.partyAPeerKey,
    }
  } else {
    throw new Error('You are not a party to this pairing key')
  }
}

// Legacy aliases for backward compatibility during migration
/** @deprecated Use isPairingRequestFormat instead */
export const isTokenRequest = isPairingRequestFormat
/** @deprecated Use isPairingKeyFormat instead */
export const isMutualTokenFormat = isPairingKeyFormat
/** @deprecated Use createPairingRequest instead */
export const createMutualTokenInit = createPairingRequest
/** @deprecated Use confirmPairingRequest instead */
export const countersignMutualToken = confirmPairingRequest
/** @deprecated Use parsePairingKey instead */
export const parseToken = parsePairingKey
/** @deprecated Use getPeerVerificationSecret instead */
export const getCounterpartyVerificationSecret = getPeerVerificationSecret
/** @deprecated Use getPeerFromParsedPairingKey instead */
export const getCounterpartyFromParsedToken = getPeerFromParsedPairingKey
/** @deprecated Use ParsedPairingKey instead */
export type ParsedMutualToken = ParsedPairingKey
/** @deprecated Use PairingKeyPayload instead */
export type MutualContactTokenPayload = PairingKeyPayload
/** @deprecated Use PairingRequest instead */
export type PendingTokenRequest = PairingRequest
