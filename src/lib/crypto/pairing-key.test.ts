import { expect, test, describe } from 'vitest'
import { isPairingKeyFormat, isPairingRequestFormat } from './pairing-key'

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

/** Sample issued-at timestamp for test fixtures */
const TEST_IAT = 1234567890

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
    //   peerPublicKey: Uint8Array,   // 32 bytes for identity card
    //   hmacKey: CryptoKey,          // YOUR OWN signing key (NOT the peer's!)
    // }
    //
    // The hmacKey is explicitly named to indicate it's the user's own key,
    // avoiding confusion with the peer's key.
  })

  test.skip('verifyOwnSignature uses caller\'s own HMAC key to verify their signature', () => {
    // verifyOwnSignature(pairingKey, hmacKey, myPublicId) should:
    // 1. Take hmacKey as YOUR OWN HMAC key (from getPasskeyIdentity)
    // 2. Verify that YOU signed the pairing key
    // 3. NOT attempt to verify the peer's signature (impossible without their key)
    //
    // This test documents the contract - actual verification requires browser.
  })

  test.skip('createPairingRequest uses caller\'s own HMAC key to sign', () => {
    // createPairingRequest(hmacKey, ...) should:
    // 1. Take hmacKey as YOUR OWN HMAC key
    // 2. Sign the pairing request with YOUR key
    // 3. The signature can only be verified by YOU later (using same hmacKey)
  })

  test.skip('confirmPairingRequest uses caller\'s own HMAC key to countersign', () => {
    // confirmPairingRequest(request, hmacKey, ...) should:
    // 1. Take hmacKey as YOUR OWN HMAC key
    // 2. Add YOUR signature to complete the pairing key
    // 3. Cannot verify initiator's signature (we don't have their key)
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
