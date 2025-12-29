#!/usr/bin/env npx tsx
/**
 * Standalone mutual contact token verifier
 *
 * Usage: npx tsx scripts/verify-contact-token.ts
 *
 * Token format: Raw JSON object (mutual token with dual signatures)
 *   {"a_id":"...","a_cpk":"...","b_id":"...","b_cpk":"...","iat":...,"init_authData":"...","init_clientDataJSON":"...","init_sig":"...","counter_authData":"...","counter_clientDataJSON":"...","counter_sig":"..."}
 *
 * Example:
 *   echo '{"a_id":"...","a_cpk":"..."}' | npx tsx scripts/verify-contact-token.ts
 *   pbpaste | npx tsx scripts/verify-contact-token.ts
 *
 * Verifies both WebAuthn ECDSA signatures without needing a browser.
 */

import { webcrypto, timingSafeEqual } from 'crypto'

const crypto = webcrypto

interface PendingMutualToken {
  a_id: string
  a_cpk: string
  b_id: string
  b_cpk: string
  iat: number
  init_authData: string
  init_clientDataJSON: string
  init_sig: string
  comment?: string
}

interface MutualContactTokenPayload extends PendingMutualToken {
  counter_authData: string
  counter_clientDataJSON: string
  counter_sig: string
}

interface ClientData {
  type: string
  challenge: string
  origin: string
}

// Base64 decode
function base64Decode(str: string): Uint8Array {
  return Uint8Array.from(Buffer.from(str, 'base64'))
}

// Base64url decode
function base64urlDecode(str: string): Uint8Array {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/')
  const pad = base64.length % 4
  if (pad) base64 += '='.repeat(4 - pad)
  return Uint8Array.from(Buffer.from(base64, 'base64'))
}

// Convert DER signature to raw (r || s) format
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
  let r = der.subarray(offset, offset + rLen)
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
  let s = der.subarray(offset, offset + sLen)

  // Remove leading zero bytes (used for sign in DER encoding)
  if (r.length === 33 && r[0] === 0) r = r.subarray(1)
  if (s.length === 33 && s[0] === 0) s = s.subarray(1)

  // Pad to 32 bytes
  const raw = new Uint8Array(64)
  raw.set(r, 32 - r.length)
  raw.set(s, 64 - s.length)
  return raw
}

// Compute fingerprint (first 8 bytes of SHA-256, hex)
async function fingerprint(data: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Buffer.from(new Uint8Array(hash).subarray(0, 8)).toString('hex').toUpperCase()
}

// Format fingerprint as XXXX-XXXX-XXXX-XXXX
function formatFingerprint(fp: string): string {
  return fp.match(/.{4}/g)!.join('-')
}

// Compare two 32-byte public IDs lexicographically
function compareIds(id1: Uint8Array, id2: Uint8Array): number {
  for (let i = 0; i < 32; i++) {
    if (id1[i] < id2[i]) return -1
    if (id1[i] > id2[i]) return 1
  }
  return 0
}

// Compute the mutual challenge
async function computeMutualChallenge(
  aId: Uint8Array,
  aCpk: Uint8Array,
  bId: Uint8Array,
  bCpk: Uint8Array,
  iat: number
): Promise<Uint8Array> {
  // Total: 32 + 65 + 32 + 65 + 8 = 202 bytes
  const data = new Uint8Array(202)
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

  return new Uint8Array(await crypto.subtle.digest('SHA-256', data))
}

// Verify a single WebAuthn signature
async function verifySignature(
  credentialPublicKey: Uint8Array,
  authData: Uint8Array,
  clientDataJSON: Uint8Array,
  signature: Uint8Array,
  expectedChallenge: Uint8Array,
  label: string
): Promise<string> {
  // Parse clientDataJSON
  const clientData = JSON.parse(Buffer.from(clientDataJSON).toString('utf8')) as ClientData

  if (clientData.type !== 'webauthn.get') {
    throw new Error(`${label}: Invalid clientData type: ${clientData.type}`)
  }

  // Verify challenge matches
  const actualChallenge = base64urlDecode(clientData.challenge)
  if (actualChallenge.length !== expectedChallenge.length) {
    throw new Error(`${label}: Challenge length mismatch`)
  }
  if (!timingSafeEqual(Buffer.from(expectedChallenge), Buffer.from(actualChallenge))) {
    throw new Error(`${label}: Challenge mismatch - token data may be tampered`)
  }

  // Import public key
  const publicKey = await crypto.subtle.importKey(
    'raw',
    credentialPublicKey,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  )

  // WebAuthn signature is over: authData || SHA256(clientDataJSON)
  const clientDataHash = await crypto.subtle.digest('SHA-256', clientDataJSON)
  const signatureBase = new Uint8Array(authData.length + 32)
  signatureBase.set(authData, 0)
  signatureBase.set(new Uint8Array(clientDataHash), authData.length)

  // Convert DER to raw and verify
  const rawSignature = derToRaw(signature)
  const valid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    publicKey,
    rawSignature,
    signatureBase
  )

  if (!valid) {
    throw new Error(`${label}: SIGNATURE VERIFICATION FAILED`)
  }

  return clientData.origin
}

interface VerificationResult {
  partyAPublicId: string
  partyAFingerprint: string
  partyBPublicId: string
  partyBFingerprint: string
  issuedAt: Date
  initOrigin: string
  counterOrigin?: string
  isPending: boolean
  comment?: string
}

async function verifyMutualToken(token: string): Promise<VerificationResult> {
  // Parse raw JSON
  let payload: PendingMutualToken | MutualContactTokenPayload
  try {
    payload = JSON.parse(token.trim()) as PendingMutualToken | MutualContactTokenPayload
  } catch {
    throw new Error('Invalid format: expected raw JSON object')
  }

  // Validate required fields for pending token
  if (typeof payload.a_id !== 'string') {
    throw new Error('Missing or invalid field: a_id (expected base64 string)')
  }
  if (typeof payload.a_cpk !== 'string') {
    throw new Error('Missing or invalid field: a_cpk (expected base64 string)')
  }
  if (typeof payload.b_id !== 'string') {
    throw new Error('Missing or invalid field: b_id (expected base64 string)')
  }
  if (typeof payload.b_cpk !== 'string') {
    throw new Error('Missing or invalid field: b_cpk (expected base64 string)')
  }
  if (typeof payload.iat !== 'number' || !Number.isFinite(payload.iat)) {
    throw new Error('Missing or invalid field: iat (expected numeric timestamp)')
  }
  if (typeof payload.init_authData !== 'string') {
    throw new Error('Missing or invalid field: init_authData (expected base64 string)')
  }
  if (typeof payload.init_clientDataJSON !== 'string') {
    throw new Error('Missing or invalid field: init_clientDataJSON (expected base64 string)')
  }
  if (typeof payload.init_sig !== 'string') {
    throw new Error('Missing or invalid field: init_sig (expected base64 string)')
  }

  // Check if complete or pending
  const hasCounterSig =
    typeof (payload as MutualContactTokenPayload).counter_authData === 'string' &&
    typeof (payload as MutualContactTokenPayload).counter_clientDataJSON === 'string' &&
    typeof (payload as MutualContactTokenPayload).counter_sig === 'string'

  const isPending = !hasCounterSig

  console.log('\n=== Mutual Contact Token ===\n')
  console.log('Status:', isPending ? 'PENDING (single signature)' : 'COMPLETE (dual signatures)')
  if (payload.comment) {
    console.log('Comment:', payload.comment)
  }
  console.log('Issued at:', new Date(payload.iat * 1000).toISOString())

  // Decode fields
  const aId = base64Decode(payload.a_id)
  const aCpk = base64Decode(payload.a_cpk)
  const bId = base64Decode(payload.b_id)
  const bCpk = base64Decode(payload.b_cpk)
  const initAuthData = base64Decode(payload.init_authData)
  const initClientDataJSON = base64Decode(payload.init_clientDataJSON)
  const initSig = base64Decode(payload.init_sig)

  // Validate sizes
  if (aId.length !== 32) {
    throw new Error(`Invalid a_id: expected 32 bytes, got ${aId.length}`)
  }
  if (bId.length !== 32) {
    throw new Error(`Invalid b_id: expected 32 bytes, got ${bId.length}`)
  }
  if (aCpk.length !== 65 || aCpk[0] !== 0x04) {
    throw new Error('Invalid a_cpk: expected 65-byte uncompressed P-256')
  }
  if (bCpk.length !== 65 || bCpk[0] !== 0x04) {
    throw new Error('Invalid b_cpk: expected 65-byte uncompressed P-256')
  }

  // Verify lexicographic ordering
  if (compareIds(aId, bId) >= 0) {
    throw new Error('Invalid token: a_id must be lexicographically smaller than b_id')
  }

  // Show fingerprints
  const aFp = await fingerprint(aId)
  const bFp = await fingerprint(bId)
  const aCpkFp = await fingerprint(aCpk)
  const bCpkFp = await fingerprint(bCpk)

  console.log('\nParty A:')
  console.log('  Public ID:', formatFingerprint(aFp))
  console.log('  Credential:', formatFingerprint(aCpkFp))
  console.log('\nParty B:')
  console.log('  Public ID:', formatFingerprint(bFp))
  console.log('  Credential:', formatFingerprint(bCpkFp))

  // Compute challenge
  const challenge = await computeMutualChallenge(aId, aCpk, bId, bCpk, payload.iat)

  // Try to verify init signature with aCpk first, then bCpk
  let initOrigin: string
  let initiatorCpk: Uint8Array
  let counterSignerCpk: Uint8Array
  let initiatorLabel: string

  try {
    initOrigin = await verifySignature(aCpk, initAuthData, initClientDataJSON, initSig, challenge, 'Initiator')
    initiatorCpk = aCpk
    counterSignerCpk = bCpk
    initiatorLabel = 'Party A'
  } catch {
    try {
      initOrigin = await verifySignature(bCpk, initAuthData, initClientDataJSON, initSig, challenge, 'Initiator')
      initiatorCpk = bCpk
      counterSignerCpk = aCpk
      initiatorLabel = 'Party B'
    } catch {
      throw new Error('Initiator signature verification failed - neither party\'s key matches')
    }
  }

  console.log(`\nInitiator: ${initiatorLabel}`)
  console.log('  Origin:', initOrigin)
  console.log('  Signature: VALID')

  // Verify counter signature if present
  let counterOrigin: string | undefined
  if (!isPending) {
    const complete = payload as MutualContactTokenPayload
    const counterAuthData = base64Decode(complete.counter_authData)
    const counterClientDataJSON = base64Decode(complete.counter_clientDataJSON)
    const counterSig = base64Decode(complete.counter_sig)

    counterOrigin = await verifySignature(
      counterSignerCpk,
      counterAuthData,
      counterClientDataJSON,
      counterSig,
      challenge,
      'Countersigner'
    )

    const counterLabel = initiatorCpk === aCpk ? 'Party B' : 'Party A'
    console.log(`\nCountersigner: ${counterLabel}`)
    console.log('  Origin:', counterOrigin)
    console.log('  Signature: VALID')
  }

  if (isPending) {
    console.log('\n=== PENDING TOKEN - NEEDS COUNTERSIGNATURE ===\n')
  } else {
    console.log('\n=== VERIFICATION PASSED - BOTH SIGNATURES VALID ===\n')
  }

  return {
    partyAPublicId: Buffer.from(aId).toString('base64'),
    partyAFingerprint: aFp,
    partyBPublicId: Buffer.from(bId).toString('base64'),
    partyBFingerprint: bFp,
    issuedAt: new Date(payload.iat * 1000),
    initOrigin,
    counterOrigin,
    isPending,
    comment: payload.comment,
  }
}

// Read from stdin
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8').trim()
}

// Main
async function main(): Promise<void> {
  const token = await readStdin()
  if (!token) {
    console.error('Usage: echo \'{"a_id":"...","a_cpk":"..."}\' | npx tsx scripts/verify-contact-token.ts')
    console.error('')
    console.error('Token format: Raw JSON object (mutual token with dual signatures)')
    console.error('')
    console.error('Examples:')
    console.error('  echo \'{"a_id":"...","a_cpk":"..."}\' | npx tsx scripts/verify-contact-token.ts')
    console.error('  pbpaste | npx tsx scripts/verify-contact-token.ts')
    console.error('  cat token.txt | npx tsx scripts/verify-contact-token.ts')
    process.exit(1)
  }

  try {
    await verifyMutualToken(token)
  } catch (err) {
    console.error('\n=== VERIFICATION FAILED ===')
    console.error('Error:', err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}

main()
