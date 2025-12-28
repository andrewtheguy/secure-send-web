import { expect, test, describe } from 'vitest'
import {
  generatePasskeyPin,
  isPasskeyPin,
  extractPasskeyFingerprint,
  credentialIdToFingerprint,
} from './passkey'

describe('Passkey PIN Utilities', () => {
  describe('generatePasskeyPin', () => {
    test('should generate a 12-character PIN starting with P', () => {
      const fingerprint = 'ABCDEFGHIJK'
      const pin = generatePasskeyPin(fingerprint)
      expect(pin).toBe('PABCDEFGHIJK')
      expect(pin.length).toBe(12)
      expect(pin.startsWith('P')).toBe(true)
    })

    test('should truncate fingerprint longer than 11 characters', () => {
      const fingerprint = 'ABCDEFGHIJKLMNOP'
      const pin = generatePasskeyPin(fingerprint)
      expect(pin).toBe('PABCDEFGHIJK')
      expect(pin.length).toBe(12)
    })

    test('should throw error for fingerprint shorter than 11 characters', () => {
      const shortFingerprint = 'ABCDEFGHIJ' // 10 chars
      expect(() => generatePasskeyPin(shortFingerprint)).toThrow(
        'Passkey fingerprint must be at least 11 characters'
      )
    })

    test('should throw error for empty fingerprint', () => {
      expect(() => generatePasskeyPin('')).toThrow(
        'Passkey fingerprint must be at least 11 characters'
      )
    })
  })

  describe('isPasskeyPin', () => {
    test('should return true for PINs starting with P', () => {
      expect(isPasskeyPin('PABCDEFGHIJK')).toBe(true)
      expect(isPasskeyPin('P12345678901')).toBe(true)
      expect(isPasskeyPin('Pxxxxxxxxxxx')).toBe(true)
    })

    test('should return false for regular PINs', () => {
      // Nostr PINs (uppercase first char)
      expect(isPasskeyPin('AABCDEFGHIJK')).toBe(false)
      expect(isPasskeyPin('ZABCDEFGHIJK')).toBe(false)

      // Manual PINs (start with 2)
      expect(isPasskeyPin('2ABCDEFGHIJK')).toBe(false)

      // Other characters
      expect(isPasskeyPin('1ABCDEFGHIJK')).toBe(false)
      expect(isPasskeyPin('aABCDEFGHIJK')).toBe(false)
    })

    test('should return false for empty string', () => {
      expect(isPasskeyPin('')).toBe(false)
    })
  })

  describe('extractPasskeyFingerprint', () => {
    test('should extract fingerprint from passkey PIN', () => {
      expect(extractPasskeyFingerprint('PABCDEFGHIJK')).toBe('ABCDEFGHIJK')
      expect(extractPasskeyFingerprint('P12345678901')).toBe('12345678901')
    })

    test('should return everything after first character', () => {
      expect(extractPasskeyFingerprint('PXYZ')).toBe('XYZ')
      expect(extractPasskeyFingerprint('P')).toBe('')
    })
  })

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

  describe('Integration: passkey PIN round-trip', () => {
    test('should correctly detect passkey PIN and extract fingerprint', async () => {
      const credentialId = new Uint8Array([42, 43, 44, 45, 46, 47, 48, 49, 50, 51])
      const fingerprint = await credentialIdToFingerprint(credentialId)
      const pin = generatePasskeyPin(fingerprint)

      expect(isPasskeyPin(pin)).toBe(true)
      expect(extractPasskeyFingerprint(pin)).toBe(fingerprint.slice(0, 11))
    })
  })
})
