#!/usr/bin/env node
/**
 * Standalone contact token verifier
 *
 * Usage: node scripts/verify-contact-token.mjs <token>
 *
 * Token format (SSH-like):
 *   sswct-es256 <base64-payload> [optional comment]
 *
 * Example:
 *   node scripts/verify-contact-token.mjs "sswct-es256 eyJzdWIi... Alice's work laptop"
 *
 * Verifies the WebAuthn ECDSA signature without needing a browser.
 */

import { webcrypto } from 'crypto'

const crypto = webcrypto
const TOKEN_TYPE = 'sswct-es256'

// Parse SSH-like format
function parseTokenFormat(input) {
  const trimmed = input.trim()
  if (!trimmed.startsWith(TOKEN_TYPE + ' ')) {
    return null
  }

  const afterType = trimmed.slice(TOKEN_TYPE.length + 1)
  const spaceIndex = afterType.indexOf(' ')

  if (spaceIndex === -1) {
    return { payload: afterType, comment: null }
  }

  return {
    payload: afterType.slice(0, spaceIndex),
    comment: afterType.slice(spaceIndex + 1),
  }
}

// Base64 decode
function base64Decode(str) {
  return Uint8Array.from(Buffer.from(str, 'base64'))
}

// Base64url decode
function base64urlDecode(str) {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/')
  const pad = base64.length % 4
  if (pad) base64 += '='.repeat(4 - pad)
  return Uint8Array.from(Buffer.from(base64, 'base64'))
}

// Convert DER signature to raw (r || s) format
function derToRaw(der) {
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
async function fingerprint(data) {
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Buffer.from(new Uint8Array(hash).slice(0, 8)).toString('hex').toUpperCase()
}

async function verifyContactToken(token) {
  // Parse SSH-like format
  const parsed = parseTokenFormat(token)
  if (!parsed) {
    throw new Error(`Invalid format: expected "${TOKEN_TYPE} <payload> [comment]"`)
  }

  console.log('\n=== Contact Token ===\n')
  console.log('Format:', TOKEN_TYPE)
  if (parsed.comment) {
    console.log('Comment:', parsed.comment)
  }

  // Decode payload
  const json = Buffer.from(parsed.payload, 'base64').toString('utf8')
  const payload = JSON.parse(json)

  console.log('Issued at:', new Date(payload.iat * 1000).toISOString())

  // Decode fields
  const recipientPublicId = base64Decode(payload.sub)
  const signerPublicKey = base64Decode(payload.cpk)
  const authData = base64Decode(payload.authData)
  const clientDataJSON = base64Decode(payload.clientDataJSON)
  const signature = base64Decode(payload.sig)

  // Validate sizes
  if (recipientPublicId.length !== 32) {
    throw new Error(`Invalid recipient public ID: expected 32 bytes, got ${recipientPublicId.length}`)
  }
  if (signerPublicKey.length !== 65 || signerPublicKey[0] !== 0x04) {
    throw new Error('Invalid credential public key: expected 65-byte uncompressed P-256')
  }

  // Show fingerprints
  const recipientFp = await fingerprint(recipientPublicId)
  const signerFp = await fingerprint(signerPublicKey)
  console.log('\nRecipient fingerprint:', recipientFp.match(/.{4}/g).join('-'))
  console.log('Signer fingerprint:', signerFp.match(/.{4}/g).join('-'))

  // Parse clientDataJSON
  const clientData = JSON.parse(Buffer.from(clientDataJSON).toString('utf8'))
  console.log('\nClient data:')
  console.log('  Type:', clientData.type)
  console.log('  Origin:', clientData.origin)

  if (clientData.type !== 'webauthn.get') {
    throw new Error(`Invalid clientData type: ${clientData.type}`)
  }

  // Verify challenge matches expected value
  // challenge = SHA256(sub || cpk || iat)
  const dataToSign = new Uint8Array(32 + 65 + 8)
  dataToSign.set(recipientPublicId, 0)
  dataToSign.set(signerPublicKey, 32)
  const iatView = new DataView(new ArrayBuffer(8))
  iatView.setBigUint64(0, BigInt(payload.iat), false)
  dataToSign.set(new Uint8Array(iatView.buffer), 97)

  const expectedChallenge = new Uint8Array(await crypto.subtle.digest('SHA-256', dataToSign))
  const actualChallenge = base64urlDecode(clientData.challenge)

  if (!expectedChallenge.every((b, i) => b === actualChallenge[i])) {
    throw new Error('Challenge mismatch - token data may be tampered')
  }
  console.log('\nChallenge: VALID (matches token data)')

  // Import public key
  const publicKey = await crypto.subtle.importKey(
    'raw',
    signerPublicKey,
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
    signerPublicKey: Buffer.from(signerPublicKey).toString('base64'),
    issuedAt: new Date(payload.iat * 1000),
    origin: clientData.origin,
    comment: parsed.comment,
  }
}

// Read from stdin
async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8').trim()
}

// Main
const token = await readStdin()
if (!token) {
  console.error('Usage: echo "sswct-es256 <payload> [comment]" | node scripts/verify-contact-token.mjs')
  console.error('')
  console.error('Token format: sswct-es256 <base64-payload> [optional comment]')
  console.error('')
  console.error('Examples:')
  console.error('  echo "sswct-es256 eyJzdWIi... Alice" | node scripts/verify-contact-token.mjs')
  console.error('  pbpaste | node scripts/verify-contact-token.mjs')
  console.error('  cat token.txt | node scripts/verify-contact-token.mjs')
  process.exit(1)
}

try {
  await verifyContactToken(token)
} catch (err) {
  console.error('\n=== VERIFICATION FAILED ===')
  console.error('Error:', err.message)
  process.exit(1)
}
