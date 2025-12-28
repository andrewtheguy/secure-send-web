import { expect, test, describe } from 'vitest'
import { credentialIdToFingerprint } from './passkey'

describe('Passkey Utilities', () => {
  describe('credentialIdToFingerprint', () => {
    test('should generate deterministic 11-character uppercase fingerprint', async () => {
      const credentialId = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
      const fingerprint = await credentialIdToFingerprint(credentialId)

      expect(fingerprint.length).toBe(11)
      expect(fingerprint).toMatch(/^[0-9A-Z]+$/)
    })

    test('should generate same fingerprint for same credential ID', async () => {
      const credentialId = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
      const fingerprint1 = await credentialIdToFingerprint(credentialId)
      const fingerprint2 = await credentialIdToFingerprint(credentialId)

      expect(fingerprint1).toBe(fingerprint2)
    })

    test('should generate different fingerprints for different credential IDs', async () => {
      const credentialId1 = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
      const credentialId2 = new Uint8Array([10, 9, 8, 7, 6, 5, 4, 3, 2, 1])

      const fingerprint1 = await credentialIdToFingerprint(credentialId1)
      const fingerprint2 = await credentialIdToFingerprint(credentialId2)

      expect(fingerprint1).not.toBe(fingerprint2)
    })

    test('should handle empty credential ID', async () => {
      const credentialId = new Uint8Array([])
      const fingerprint = await credentialIdToFingerprint(credentialId)

      expect(fingerprint.length).toBe(11)
      expect(fingerprint).toMatch(/^[0-9A-Z]+$/)
    })

    test('should handle large credential ID', async () => {
      const credentialId = new Uint8Array(256).fill(0xff)
      const fingerprint = await credentialIdToFingerprint(credentialId)

      expect(fingerprint.length).toBe(11)
      expect(fingerprint).toMatch(/^[0-9A-Z]+$/)
    })
  })
})
