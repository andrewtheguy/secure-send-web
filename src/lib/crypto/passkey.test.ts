import { expect, test, describe } from 'vitest'
import { publicKeyToFingerprint } from './ecdh'

describe('Passkey Utilities', () => {
  describe('publicKeyToFingerprint', () => {
    test('should generate deterministic 11-character uppercase fingerprint', async () => {
      // 65-byte P-256 uncompressed public key (0x04 prefix + X + Y)
      const publicKey = new Uint8Array(65)
      publicKey[0] = 0x04
      publicKey.fill(0x01, 1, 33) // X coordinate
      publicKey.fill(0x02, 33, 65) // Y coordinate
      const fingerprint = await publicKeyToFingerprint(publicKey)

      expect(fingerprint.length).toBe(11)
      expect(fingerprint).toMatch(/^[0-9A-Z]+$/)
    })

    test('should generate same fingerprint for same public key', async () => {
      const publicKey = new Uint8Array(65)
      publicKey[0] = 0x04
      publicKey.fill(0x01, 1, 33)
      publicKey.fill(0x02, 33, 65)
      const fingerprint1 = await publicKeyToFingerprint(publicKey)
      const fingerprint2 = await publicKeyToFingerprint(publicKey)

      expect(fingerprint1).toBe(fingerprint2)
    })

    test('should generate different fingerprints for different public keys', async () => {
      const publicKey1 = new Uint8Array(65)
      publicKey1[0] = 0x04
      publicKey1.fill(0x01, 1, 33)
      publicKey1.fill(0x02, 33, 65)

      const publicKey2 = new Uint8Array(65)
      publicKey2[0] = 0x04
      publicKey2.fill(0x03, 1, 33)
      publicKey2.fill(0x04, 33, 65)

      const fingerprint1 = await publicKeyToFingerprint(publicKey1)
      const fingerprint2 = await publicKeyToFingerprint(publicKey2)

      expect(fingerprint1).not.toBe(fingerprint2)
    })

    test('should handle arbitrary input (not validation)', async () => {
      // The function hashes any input, so even non-P256 data will produce a fingerprint
      const data = new Uint8Array([1, 2, 3, 4, 5])
      const fingerprint = await publicKeyToFingerprint(data)

      expect(fingerprint.length).toBe(11)
      expect(fingerprint).toMatch(/^[0-9A-Z]+$/)
    })
  })
})
