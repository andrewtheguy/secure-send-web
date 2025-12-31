import { expect, test, describe } from 'vitest'
import {
  isPairingKeyFormat,
  isPairingRequestFormat,
  confirmPairingRequest,
  createPairingRequest,
  verifyOwnSignature,
  INVITE_CODE_TTL_SECONDS,
} from './pairing-key'

/**
 * Tests for pairing-key.ts HMAC key usage.
 *
 * IMPORTANT: These tests validate the key ownership semantics.
 * The hmacKey parameter in verifyOwnSignature, createPairingRequest,
 * and confirmPairingRequest is YOUR OWN signing key (derived from your
 * passkey), NOT the peer's key. This distinction is critical for security.
 *
 * Key ownership:
 * - hmacKey: Your own non-extractable HMAC key (from getPasskeyIdentity().hmacKey)
 * - This key is used to sign/verify YOUR OWN signatures on pairing keys
 * - The peer has their own separate hmacKey derived from their passkey
 * - Neither party can verify the other's signature (HMAC requires the signer's key)
 */

/** Sample issued-at timestamp for test fixtures (from Invite Code) */
const TEST_IAT = 1234567890

/**
 * Helper functions for HMAC integration tests
 */

// Create a mock HMAC key for testing
async function createTestHmacKey(seed: Uint8Array = new Uint8Array(32)): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    seed as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false, // non-extractable like real passkey-derived keys
    ['sign', 'verify']
  )
}

// Create valid 32-byte test IDs (a < b lexicographically)
function createTestIds(): { aId: Uint8Array; bId: Uint8Array; aIdBase64: string; bIdBase64: string } {
  const aId = new Uint8Array(32).fill(65) // 'AAA...'
  const bId = new Uint8Array(32).fill(66) // 'BBB...'
  return {
    aId,
    bId,
    aIdBase64: btoa(String.fromCharCode(...aId)),
    bIdBase64: btoa(String.fromCharCode(...bId)),
  }
}

// Create a 32-byte peer public key
function createTestPeerKey(fillValue = 0x42): Uint8Array {
  return new Uint8Array(32).fill(fillValue)
}

describe('Pairing Key HMAC Key Ownership', () => {
  test.skip('getPasskeyIdentity returns hmacKey (not peerHmacKey) for user\'s own signing key', () => {
    // This test documents the expected interface.
    // The actual WebAuthn/PRF functionality requires a browser environment.
    //
    // Expected interface from getPasskeyIdentity():
    // {
    //   publicIdBytes: Uint8Array,
    //   publicIdFingerprint: string,
    //   prfSupported: boolean,
    //   credentialId: string,
    //   peerPublicKey: Uint8Array,   // 32 bytes for invite code
    //   hmacKey: CryptoKey,          // YOUR OWN signing key (NOT the peer's!)
    // }
    //
    // The hmacKey is explicitly named to indicate it's the user's own key,
    // avoiding confusion with the peer's key.
  })

  test('createPairingRequest signs with caller\'s HMAC key', async () => {
    const { aIdBase64, bIdBase64 } = createTestIds()
    const hmacKey = await createTestHmacKey()
    const peerKey = createTestPeerKey()
    const peerPpkBase64 = btoa(String.fromCharCode(...createTestPeerKey(0x43)))
    const validIat = Math.floor(Date.now() / 1000)

    // Create pairing request - should sign with provided HMAC key
    const request = await createPairingRequest({
      hmacKey,
      peerPublicKey: peerKey,
      publicId: aIdBase64,
      inviteId: bIdBase64,
      invitePpk: peerPpkBase64,
      inviteIat: validIat,
    })

    // Verify it's valid JSON with signature
    const parsed = JSON.parse(request)
    expect(parsed.init_sig).toBeDefined()
    expect(typeof parsed.init_sig).toBe('string')
    expect(parsed.init_vs).toBeDefined()
  })

  test('confirmPairingRequest adds countersignature with caller\'s HMAC key', async () => {
    const { aIdBase64, bIdBase64 } = createTestIds()
    const initiatorHmacKey = await createTestHmacKey(new Uint8Array(32).fill(1))
    const signerHmacKey = await createTestHmacKey(new Uint8Array(32).fill(2))
    const initiatorPeerKey = createTestPeerKey(0x42)
    const signerPeerKey = createTestPeerKey(0x43)
    const signerPpkBase64 = btoa(String.fromCharCode(...signerPeerKey))
    const validIat = Math.floor(Date.now() / 1000)

    // Initiator creates request
    const request = await createPairingRequest({
      hmacKey: initiatorHmacKey,
      peerPublicKey: initiatorPeerKey,
      publicId: aIdBase64,
      inviteId: bIdBase64,
      invitePpk: signerPpkBase64,
      inviteIat: validIat,
    })

    // Signer confirms request - adds their signature
    const pairingKey = await confirmPairingRequest(
      request,
      signerHmacKey,
      signerPeerKey,
      bIdBase64
    )

    // Verify it has both signatures
    const parsed = JSON.parse(pairingKey)
    expect(parsed.init_sig).toBeDefined()
    expect(parsed.counter_sig).toBeDefined()
    expect(parsed.init_vs).toBeDefined()
    expect(parsed.counter_vs).toBeDefined()
  })

  test('verifyOwnSignature verifies caller\'s signature on pairing key', async () => {
    const { aIdBase64, bIdBase64 } = createTestIds()
    const initiatorHmacKey = await createTestHmacKey(new Uint8Array(32).fill(1))
    const signerHmacKey = await createTestHmacKey(new Uint8Array(32).fill(2))
    const initiatorPeerKey = createTestPeerKey(0x42)
    const signerPeerKey = createTestPeerKey(0x43)
    const signerPpkBase64 = btoa(String.fromCharCode(...signerPeerKey))
    const aIdBytes = new Uint8Array(32).fill(65)
    const bIdBytes = new Uint8Array(32).fill(66)
    const validIat = Math.floor(Date.now() / 1000)

    // Create complete pairing flow
    const request = await createPairingRequest({
      hmacKey: initiatorHmacKey,
      peerPublicKey: initiatorPeerKey,
      publicId: aIdBase64,
      inviteId: bIdBase64,
      invitePpk: signerPpkBase64,
      inviteIat: validIat,
    })
    const pairingKey = await confirmPairingRequest(
      request,
      signerHmacKey,
      signerPeerKey,
      bIdBase64
    )

    // Initiator can verify their own signature
    const initiatorResult = await verifyOwnSignature(pairingKey, initiatorHmacKey, aIdBytes)
    expect(initiatorResult.myRole).toBe('A')

    // Signer can verify their own signature
    const signerResult = await verifyOwnSignature(pairingKey, signerHmacKey, bIdBytes)
    expect(signerResult.myRole).toBe('B')
  })

  test('verifyOwnSignature fails with wrong HMAC key', async () => {
    const { aIdBase64, bIdBase64 } = createTestIds()
    const initiatorHmacKey = await createTestHmacKey(new Uint8Array(32).fill(1))
    const signerHmacKey = await createTestHmacKey(new Uint8Array(32).fill(2))
    const wrongHmacKey = await createTestHmacKey(new Uint8Array(32).fill(99)) // Different key
    const initiatorPeerKey = createTestPeerKey(0x42)
    const signerPeerKey = createTestPeerKey(0x43)
    const signerPpkBase64 = btoa(String.fromCharCode(...signerPeerKey))
    const aIdBytes = new Uint8Array(32).fill(65)
    const validIat = Math.floor(Date.now() / 1000)

    // Create complete pairing flow
    const request = await createPairingRequest({
      hmacKey: initiatorHmacKey,
      peerPublicKey: initiatorPeerKey,
      publicId: aIdBase64,
      inviteId: bIdBase64,
      invitePpk: signerPpkBase64,
      inviteIat: validIat,
    })
    const pairingKey = await confirmPairingRequest(
      request,
      signerHmacKey,
      signerPeerKey,
      bIdBase64
    )

    // Wrong HMAC key should fail verification
    await expect(
      verifyOwnSignature(pairingKey, wrongHmacKey, aIdBytes)
    ).rejects.toThrow('signature verification failed')
  })
})

describe('Pairing Key Format Validation', () => {
  describe('isPairingKeyFormat', () => {
    test('rejects invalid JSON', () => {
      expect(isPairingKeyFormat('not json')).toBe(false)
      expect(isPairingKeyFormat('{invalid}')).toBe(false)
    })

    test('rejects empty string', () => {
      expect(isPairingKeyFormat('')).toBe(false)
    })

    test('rejects null and undefined', () => {
      expect(isPairingKeyFormat(null as unknown as string)).toBe(false)
      expect(isPairingKeyFormat(undefined as unknown as string)).toBe(false)
    })

    test('rejects non-string inputs', () => {
      expect(isPairingKeyFormat(123 as unknown as string)).toBe(false)
      expect(isPairingKeyFormat({} as unknown as string)).toBe(false)
      expect(isPairingKeyFormat([] as unknown as string)).toBe(false)
      expect(isPairingKeyFormat(true as unknown as string)).toBe(false)
    })

    test('rejects incomplete pairing key (missing counter_sig)', () => {
      const incomplete = JSON.stringify({
        a_id: 'AAAA',
        a_ppk: 'BBBB',
        b_id: 'CCCC',
        b_ppk: 'DDDD',
        iat: TEST_IAT,
        init_party: 'a',
        init_sig: 'EEEE',
        init_vs: 'FFFF',
        // missing counter_sig and counter_vs
      })
      expect(isPairingKeyFormat(incomplete)).toBe(false)
    })

    test('rejects object with missing required fields', () => {
      // Missing a_id
      expect(isPairingKeyFormat(JSON.stringify({
        a_ppk: 'BBBB',
        b_id: 'CCCC',
        b_ppk: 'DDDD',
        iat: TEST_IAT,
        init_party: 'a',
        init_sig: 'EEEE',
        init_vs: 'FFFF',
        counter_sig: 'GGGG',
        counter_vs: 'HHHH',
      }))).toBe(false)

      // Missing iat
      expect(isPairingKeyFormat(JSON.stringify({
        a_id: 'AAAA',
        a_ppk: 'BBBB',
        b_id: 'CCCC',
        b_ppk: 'DDDD',
        init_party: 'a',
        init_sig: 'EEEE',
        init_vs: 'FFFF',
        counter_sig: 'GGGG',
        counter_vs: 'HHHH',
      }))).toBe(false)
    })

    test('rejects object with wrong field types', () => {
      // iat should be number, not string
      expect(isPairingKeyFormat(JSON.stringify({
        a_id: 'AAAA',
        a_ppk: 'BBBB',
        b_id: 'CCCC',
        b_ppk: 'DDDD',
        iat: 'not-a-number',
        init_party: 'a',
        init_sig: 'EEEE',
        init_vs: 'FFFF',
        counter_sig: 'GGGG',
        counter_vs: 'HHHH',
      }))).toBe(false)
    })

    test('accepts complete pairing key structure', () => {
      const complete = JSON.stringify({
        a_id: 'AAAA',
        a_ppk: 'BBBB',
        b_id: 'CCCC',
        b_ppk: 'DDDD',
        iat: TEST_IAT,
        init_party: 'a',
        init_sig: 'EEEE',
        init_vs: 'FFFF',
        counter_sig: 'GGGG',
        counter_vs: 'HHHH',
      })
      expect(isPairingKeyFormat(complete)).toBe(true)
    })
  })

  describe('isPairingRequestFormat', () => {
    test('rejects empty string', () => {
      expect(isPairingRequestFormat('')).toBe(false)
    })

    test('rejects null and undefined', () => {
      expect(isPairingRequestFormat(null as unknown as string)).toBe(false)
      expect(isPairingRequestFormat(undefined as unknown as string)).toBe(false)
    })

    test('rejects non-string inputs', () => {
      expect(isPairingRequestFormat(123 as unknown as string)).toBe(false)
      expect(isPairingRequestFormat({} as unknown as string)).toBe(false)
    })

    test('rejects object with missing required fields', () => {
      // Missing init_sig (required for request)
      expect(isPairingRequestFormat(JSON.stringify({
        a_id: 'AAAA',
        a_ppk: 'BBBB',
        b_id: 'CCCC',
        b_ppk: 'DDDD',
        iat: TEST_IAT,
        init_party: 'a',
        init_vs: 'FFFF',
      }))).toBe(false)
    })

    test('accepts pending request (no counter_sig)', () => {
      const request = JSON.stringify({
        a_id: 'AAAA',
        a_ppk: 'BBBB',
        b_id: 'CCCC',
        b_ppk: 'DDDD',
        iat: TEST_IAT,
        init_party: 'a',
        init_sig: 'EEEE',
        init_vs: 'FFFF',
      })
      expect(isPairingRequestFormat(request)).toBe(true)
    })
  })
})

/**
 * Invite Code TTL Validation Tests
 *
 * These tests ensure that confirmPairingRequest (Step 3) validates the TTL
 * even if the initiator (Step 2) bypassed or tampered with the validation.
 * This protects the Signer from confirming expired invite codes.
 */
describe('Invite Code TTL Validation', () => {
  // Helper to create a valid 32-byte base64 string
  const validBase64_32bytes = btoa(String.fromCharCode(...new Array(32).fill(65))) // 32 'A' bytes

  test('INVITE_CODE_TTL_SECONDS is 24 hours', () => {
    expect(INVITE_CODE_TTL_SECONDS).toBe(24 * 60 * 60)
  })

  test('confirmPairingRequest rejects expired iat even if initiator bypassed check', async () => {
    // Simulate a malicious initiator who bypassed client-side TTL validation
    // and created a pairing request with an expired invite code timestamp
    const expiredIat = Math.floor(Date.now() / 1000) - (25 * 60 * 60) // 25 hours ago

    const expiredRequest = JSON.stringify({
      a_id: validBase64_32bytes,
      a_ppk: validBase64_32bytes,
      b_id: validBase64_32bytes.replace('A', 'B'), // Different to avoid "same ID" error
      b_ppk: validBase64_32bytes,
      iat: expiredIat, // Expired!
      init_party: 'a',
      init_sig: validBase64_32bytes,
      init_vs: validBase64_32bytes,
    })

    const hmacKey = await createTestHmacKey()
    const signerPeerKey = new Uint8Array(32) // Mock 32-byte peer key

    // This should fail because the iat is expired
    await expect(
      confirmPairingRequest(expiredRequest, hmacKey, signerPeerKey, validBase64_32bytes)
    ).rejects.toThrow('Invite code has expired (valid for 24 hours)')
  })

  test('confirmPairingRequest rejects iat exactly at TTL boundary', async () => {
    // Edge case: iat is exactly 24 hours + 1 second ago
    const boundaryIat = Math.floor(Date.now() / 1000) - INVITE_CODE_TTL_SECONDS - 1

    const boundaryRequest = JSON.stringify({
      a_id: validBase64_32bytes,
      a_ppk: validBase64_32bytes,
      b_id: validBase64_32bytes.replace('A', 'B'),
      b_ppk: validBase64_32bytes,
      iat: boundaryIat,
      init_party: 'a',
      init_sig: validBase64_32bytes,
      init_vs: validBase64_32bytes,
    })

    const hmacKey = await createTestHmacKey()
    const signerPeerKey = new Uint8Array(32)

    await expect(
      confirmPairingRequest(boundaryRequest, hmacKey, signerPeerKey, validBase64_32bytes)
    ).rejects.toThrow('Invite code has expired (valid for 24 hours)')
  })

  test('confirmPairingRequest accepts valid iat within 24 hours', async () => {
    // Valid iat: 12 hours ago (well within the 24-hour window)
    const validIat = Math.floor(Date.now() / 1000) - (12 * 60 * 60)

    // Create two different 32-byte IDs (a_id must be < b_id lexicographically)
    const aIdBytes = new Uint8Array(32).fill(65) // 'AAA...'
    const bIdBytes = new Uint8Array(32).fill(66) // 'BBB...'
    const aId = btoa(String.fromCharCode(...aIdBytes))
    const bId = btoa(String.fromCharCode(...bIdBytes))

    const validRequest = JSON.stringify({
      a_id: aId,
      a_ppk: validBase64_32bytes,
      b_id: bId,
      b_ppk: validBase64_32bytes,
      iat: validIat,
      init_party: 'a',
      init_sig: validBase64_32bytes,
      init_vs: validBase64_32bytes,
    })

    const hmacKey = await createTestHmacKey()
    // Signer is party B, so signerPeerKey should match b_ppk
    const signerPeerKey = new Uint8Array(32).fill(65) // Matches validBase64_32bytes

    // TTL validation passes, confirm returns a completed pairing key with counter_sig
    const result = await confirmPairingRequest(validRequest, hmacKey, signerPeerKey, bId)
    const parsed = JSON.parse(result)
    expect(parsed.counter_sig).toBeDefined()
    expect(typeof parsed.counter_sig).toBe('string')
  })

  test('confirmPairingRequest accepts fresh iat (just created)', async () => {
    const freshIat = Math.floor(Date.now() / 1000) // Just now

    const aIdBytes = new Uint8Array(32).fill(65)
    const bIdBytes = new Uint8Array(32).fill(66)
    const aId = btoa(String.fromCharCode(...aIdBytes))
    const bId = btoa(String.fromCharCode(...bIdBytes))

    const freshRequest = JSON.stringify({
      a_id: aId,
      a_ppk: validBase64_32bytes,
      b_id: bId,
      b_ppk: validBase64_32bytes,
      iat: freshIat,
      init_party: 'a',
      init_sig: validBase64_32bytes,
      init_vs: validBase64_32bytes,
    })

    const hmacKey = await createTestHmacKey()
    const signerPeerKey = new Uint8Array(32).fill(65)

    // TTL validation passes, confirm returns a completed pairing key with counter_sig
    const result = await confirmPairingRequest(freshRequest, hmacKey, signerPeerKey, bId)
    const parsed = JSON.parse(result)
    expect(parsed.counter_sig).toBeDefined()
    expect(typeof parsed.counter_sig).toBe('string')
  })
})

/**
 * Tampering Protection Tests
 *
 * These tests verify that tampering with any field in the pairing request/key
 * is detected through signature verification failure. The iat field is included
 * in the challenge hash, so modifying it invalidates the signature.
 */
describe('Tampering Protection', () => {
  test('tampering with iat invalidates initiator signature', async () => {
    const { aIdBase64, bIdBase64 } = createTestIds()
    const initiatorHmacKey = await createTestHmacKey(new Uint8Array(32).fill(1))
    const initiatorPeerKey = createTestPeerKey(0x42)
    const signerPeerKey = createTestPeerKey(0x43)
    const signerPpkBase64 = btoa(String.fromCharCode(...signerPeerKey))
    const aIdBytes = new Uint8Array(32).fill(65)
    const validIat = Math.floor(Date.now() / 1000)

    // Create legitimate pairing request
    const request = await createPairingRequest({
      hmacKey: initiatorHmacKey,
      peerPublicKey: initiatorPeerKey,
      publicId: aIdBase64,
      inviteId: bIdBase64,
      invitePpk: signerPpkBase64,
      inviteIat: validIat,
    })

    // Tamper with iat (make it look fresh even though original was different)
    const parsed = JSON.parse(request)
    parsed.iat = validIat + 100 // Modify iat
    const tamperedRequest = JSON.stringify(parsed)

    // The initiator's own verification should fail because the signature
    // was computed over the original iat, not the tampered one
    // First, we need to complete the pairing to get a full key
    const signerHmacKey = await createTestHmacKey(new Uint8Array(32).fill(2))

    // Signer confirms the tampered request (signer doesn't verify initiator's sig)
    const pairingKey = await confirmPairingRequest(
      tamperedRequest,
      signerHmacKey,
      signerPeerKey,
      bIdBase64
    )

    // Now when initiator tries to verify their signature, it should fail
    // because the challenge was computed with tampered iat
    await expect(
      verifyOwnSignature(pairingKey, initiatorHmacKey, aIdBytes)
    ).rejects.toThrow('signature verification failed')
  })

  test('tampering with a_id invalidates signatures', async () => {
    const { aIdBase64, bIdBase64 } = createTestIds()
    const initiatorHmacKey = await createTestHmacKey(new Uint8Array(32).fill(1))
    const signerHmacKey = await createTestHmacKey(new Uint8Array(32).fill(2))
    const initiatorPeerKey = createTestPeerKey(0x42)
    const signerPeerKey = createTestPeerKey(0x43)
    const signerPpkBase64 = btoa(String.fromCharCode(...signerPeerKey))
    const aIdBytes = new Uint8Array(32).fill(65)
    const validIat = Math.floor(Date.now() / 1000)

    // Create complete pairing
    const request = await createPairingRequest({
      hmacKey: initiatorHmacKey,
      peerPublicKey: initiatorPeerKey,
      publicId: aIdBase64,
      inviteId: bIdBase64,
      invitePpk: signerPpkBase64,
      inviteIat: validIat,
    })
    const pairingKey = await confirmPairingRequest(
      request,
      signerHmacKey,
      signerPeerKey,
      bIdBase64
    )

    // Tamper with a_id in the completed pairing key
    const parsed = JSON.parse(pairingKey)
    const tamperedAId = new Uint8Array(32).fill(64) // Different ID
    parsed.a_id = btoa(String.fromCharCode(...tamperedAId))
    const tamperedKey = JSON.stringify(parsed)

    // Verification should fail
    await expect(
      verifyOwnSignature(tamperedKey, initiatorHmacKey, aIdBytes)
    ).rejects.toThrow() // Either "not a party" or "signature verification failed"
  })

  test('tampering with comment invalidates signatures', async () => {
    const { aIdBase64, bIdBase64 } = createTestIds()
    const initiatorHmacKey = await createTestHmacKey(new Uint8Array(32).fill(1))
    const signerHmacKey = await createTestHmacKey(new Uint8Array(32).fill(2))
    const initiatorPeerKey = createTestPeerKey(0x42)
    const signerPeerKey = createTestPeerKey(0x43)
    const signerPpkBase64 = btoa(String.fromCharCode(...signerPeerKey))
    const aIdBytes = new Uint8Array(32).fill(65)
    const validIat = Math.floor(Date.now() / 1000)

    // Create pairing with comment
    const request = await createPairingRequest({
      hmacKey: initiatorHmacKey,
      peerPublicKey: initiatorPeerKey,
      publicId: aIdBase64,
      inviteId: bIdBase64,
      invitePpk: signerPpkBase64,
      inviteIat: validIat,
      comment: 'Original comment',
    })
    const pairingKey = await confirmPairingRequest(
      request,
      signerHmacKey,
      signerPeerKey,
      bIdBase64
    )

    // Verify original works
    const originalResult = await verifyOwnSignature(pairingKey, initiatorHmacKey, aIdBytes)
    expect(originalResult.comment).toBe('Original comment')

    // Tamper with comment
    const parsed = JSON.parse(pairingKey)
    parsed.comment = 'Tampered comment'
    const tamperedKey = JSON.stringify(parsed)

    // Verification should fail
    await expect(
      verifyOwnSignature(tamperedKey, initiatorHmacKey, aIdBytes)
    ).rejects.toThrow('signature verification failed')
  })

  test('iat is included in signed challenge (tampering detected)', async () => {
    // This test verifies that iat is part of the cryptographic challenge
    // by creating two requests with different iats and verifying they produce
    // different signatures
    const { aIdBase64, bIdBase64 } = createTestIds()
    const hmacKey = await createTestHmacKey()
    const peerKey = createTestPeerKey()
    const peerPpkBase64 = btoa(String.fromCharCode(...createTestPeerKey(0x43)))
    const now = Math.floor(Date.now() / 1000)

    // Create two requests with different iats
    const request1 = await createPairingRequest({
      hmacKey,
      peerPublicKey: peerKey,
      publicId: aIdBase64,
      inviteId: bIdBase64,
      invitePpk: peerPpkBase64,
      inviteIat: now,
    })
    const request2 = await createPairingRequest({
      hmacKey,
      peerPublicKey: peerKey,
      publicId: aIdBase64,
      inviteId: bIdBase64,
      invitePpk: peerPpkBase64,
      inviteIat: now - 1000, // Different iat
    })

    // Parse and compare signatures - they should be different
    const parsed1 = JSON.parse(request1)
    const parsed2 = JSON.parse(request2)

    expect(parsed1.init_sig).not.toBe(parsed2.init_sig)
    expect(parsed1.iat).not.toBe(parsed2.iat)
  })
})
