#!/usr/bin/env npx tsx
/**
 * Standalone contact token verifier
 *
 * Usage: npx tsx scripts/verify-contact-token.ts <token>
 *
 * Token format: Raw JSON object
 *   {"sub":"...","cpk":"...","spk":"...","iat":...,"authData":"...","clientDataJSON":"...","sig":"...","comment":"..."}
 *
 * Example:
 *   echo '{"sub":"...","cpk":"..."}' | npx tsx scripts/verify-contact-token.ts
 *
 * Verifies the WebAuthn ECDSA signature without needing a browser.
 */

import { webcrypto, timingSafeEqual } from 'crypto'

const crypto = webcrypto

interface ContactTokenPayload {
  sub: string
  cpk: string
  spk: string
  iat: number
  authData: string
  clientDataJSON: string
  sig: string
  comment?: string
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
  if (der[0] !== 0x30) throw new Error('Invalid DER: expected SEQUENCE')

  let offset = 2
  if (der[1] & 0x80) offset = 2 + (der[1] & 0x7f)

  if (der[offset] !== 0x02) throw new Error('Invalid DER: expected INTEGER for r')
  offset++
  const rLen = der[offset++]
  let r = der.slice(offset, offset + rLen)
  offset += rLen

  if (der[offset] !== 0x02) throw new Error('Invalid DER: expected INTEGER for s')
  offset++
  const sLen = der[offset++]
  let s = der.slice(offset, offset + sLen)

  // Remove leading zero bytes
  if (r.length === 33 && r[0] === 0) r = r.slice(1)
  if (s.length === 33 && s[0] === 0) s = s.slice(1)

  // Pad to 32 bytes
  const raw = new Uint8Array(64)
  raw.set(r, 32 - r.length)
  raw.set(s, 64 - s.length)
  return raw
}

// Compute fingerprint (first 8 bytes of SHA-256, hex)
async function fingerprint(data: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Buffer.from(new Uint8Array(hash).slice(0, 8)).toString('hex').toUpperCase()
}

interface VerificationResult {
  recipientPublicId: string
  signerPublicId: string
  signerCredentialPublicKey: string
  issuedAt: Date
  origin: string
  comment?: string
}

async function verifyContactToken(token: string): Promise<VerificationResult> {
  // Parse raw JSON
  let payload: ContactTokenPayload
  try {
    payload = JSON.parse(token.trim()) as ContactTokenPayload
  } catch {
    throw new Error('Invalid format: expected raw JSON object')
  }

  // Validate required fields exist and have correct types
  if (typeof payload.sub !== 'string') {
    throw new Error('Missing or invalid field: sub (expected base64 string)')
  }
  if (typeof payload.cpk !== 'string') {
    throw new Error('Missing or invalid field: cpk (expected base64 string)')
  }
  if (typeof payload.spk !== 'string') {
    throw new Error('Missing or invalid field: spk (expected base64 string)')
  }
  if (typeof payload.iat !== 'number' || !Number.isFinite(payload.iat)) {
    throw new Error('Missing or invalid field: iat (expected numeric timestamp)')
  }
  if (typeof payload.authData !== 'string') {
    throw new Error('Missing or invalid field: authData (expected base64 string)')
  }
  if (typeof payload.clientDataJSON !== 'string') {
    throw new Error('Missing or invalid field: clientDataJSON (expected base64 string)')
  }
  if (typeof payload.sig !== 'string') {
    throw new Error('Missing or invalid field: sig (expected base64 string)')
  }

  console.log('\n=== Contact Token ===\n')
  if (payload.comment) {
    console.log('Comment:', payload.comment)
  }
  console.log('Issued at:', new Date(payload.iat * 1000).toISOString())

  // Decode fields (safe after validation)
  const recipientPublicId = base64Decode(payload.sub)
  const signerCredentialPublicKey = base64Decode(payload.cpk)
  const signerPublicId = base64Decode(payload.spk)
  const authData = base64Decode(payload.authData)
  const clientDataJSON = base64Decode(payload.clientDataJSON)
  const signature = base64Decode(payload.sig)

  // Validate sizes
  if (recipientPublicId.length !== 32) {
    throw new Error(`Invalid recipient public ID: expected 32 bytes, got ${recipientPublicId.length}`)
  }
  if (signerCredentialPublicKey.length !== 65 || signerCredentialPublicKey[0] !== 0x04) {
    throw new Error('Invalid credential public key: expected 65-byte uncompressed P-256')
  }
  if (signerPublicId.length !== 32) {
    throw new Error(`Invalid signer public ID: expected 32 bytes, got ${signerPublicId.length}`)
  }

  // Show fingerprints
  const recipientFp = await fingerprint(recipientPublicId)
  const signerFp = await fingerprint(signerPublicId)
  const credentialFp = await fingerprint(signerCredentialPublicKey)
  console.log('\nRecipient fingerprint:', recipientFp.match(/.{4}/g)!.join('-'))
  console.log('Signer fingerprint:', signerFp.match(/.{4}/g)!.join('-'), '(passkey public ID)')
  console.log('Credential fingerprint:', credentialFp.match(/.{4}/g)!.join('-'), '(WebAuthn key)')

  // Parse clientDataJSON
  const clientData = JSON.parse(Buffer.from(clientDataJSON).toString('utf8')) as ClientData
  console.log('\nClient data:')
  console.log('  Type:', clientData.type)
  console.log('  Origin:', clientData.origin)

  if (clientData.type !== 'webauthn.get') {
    throw new Error(`Invalid clientData type: ${clientData.type}`)
  }

  // Verify challenge matches expected value
  // challenge = SHA256(sub || spk || cpk || iat)
  const dataToSign = new Uint8Array(32 + 32 + 65 + 8)
  dataToSign.set(recipientPublicId, 0)
  dataToSign.set(signerPublicId, 32)
  dataToSign.set(signerCredentialPublicKey, 64)
  const iatView = new DataView(new ArrayBuffer(8))
  iatView.setBigUint64(0, BigInt(payload.iat), false)
  dataToSign.set(new Uint8Array(iatView.buffer), 129)

  const expectedChallenge = new Uint8Array(await crypto.subtle.digest('SHA-256', dataToSign))
  const actualChallenge = base64urlDecode(clientData.challenge)

  // Verify lengths match before byte comparison
  if (actualChallenge.length !== expectedChallenge.length) {
    throw new Error(
      `Challenge length mismatch: expected ${expectedChallenge.length} bytes, got ${actualChallenge.length} bytes`
    )
  }

  // Constant-time byte comparison using Node's timingSafeEqual
  if (!timingSafeEqual(Buffer.from(expectedChallenge), Buffer.from(actualChallenge))) {
    throw new Error('Challenge mismatch - token data may be tampered')
  }
  console.log('\nChallenge: VALID (matches token data)')

  // Import public key
  const publicKey = await crypto.subtle.importKey(
    'raw',
    signerCredentialPublicKey,
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
    throw new Error('SIGNATURE VERIFICATION FAILED')
  }

  console.log('Signature: VALID')
  console.log('\n=== VERIFICATION PASSED ===\n')

  return {
    recipientPublicId: Buffer.from(recipientPublicId).toString('base64'),
    signerPublicId: Buffer.from(signerPublicId).toString('base64'),
    signerCredentialPublicKey: Buffer.from(signerCredentialPublicKey).toString('base64'),
    issuedAt: new Date(payload.iat * 1000),
    origin: clientData.origin,
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
    console.error("Usage: echo '{\"sub\":\"...\",\"cpk\":\"...\"}' | npx tsx scripts/verify-contact-token.ts")
    console.error('')
    console.error('Token format: Raw JSON object')
    console.error('')
    console.error('Examples:')
    console.error("  echo '{\"sub\":\"...\",\"cpk\":\"...\"}' | npx tsx scripts/verify-contact-token.ts")
    console.error('  pbpaste | npx tsx scripts/verify-contact-token.ts')
    console.error('  cat token.txt | npx tsx scripts/verify-contact-token.ts')
    process.exit(1)
  }

  try {
    await verifyContactToken(token)
  } catch (err) {
    console.error('\n=== VERIFICATION FAILED ===')
    console.error('Error:', err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}

main()
