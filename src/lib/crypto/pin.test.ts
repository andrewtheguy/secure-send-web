import { describe, expect, test } from 'vitest'
import { PIN_FINGERPRINT_LENGTH, PIN_HINT_LENGTH } from './constants'
import { importPinKey } from './kdf'
import {
  computePinFingerprint,
  computePinHint,
  computePinHintFromKey,
  detectSignalingMethod,
  generatePinForMethod,
  isValidPinWord,
  pinToWords,
  wordsToPin,
} from './pin'

describe('PIN Utilities', () => {
  test('detectSignalingMethod should identify method from PIN', () => {
    // Nostr (Uppercase)
    expect(detectSignalingMethod('A1234567890B')).toBe('nostr')
    // QR/Manual ('2')
    expect(detectSignalingMethod('21234567890b')).toBe('manual')
    // Unknown/Empty
    expect(detectSignalingMethod('')).toBeNull()
    expect(detectSignalingMethod('!1234567890b')).toBeNull()
  })

  test('computePinHint should return PIN_HINT_LENGTH hex characters', async () => {
    const pin = 'A/B:C;D(E)F'
    const hint = await computePinHint(pin)
    expect(hint).toMatch(new RegExp(`^[0-9a-f]{${PIN_HINT_LENGTH}}$`))

    // Same PIN should give same hint
    const hint2 = await computePinHint(pin)
    expect(hint2).toBe(hint)

    // Different PIN should (most likely) give different hint
    const hint3 = await computePinHint('differentpin')
    expect(hint3).not.toBe(hint)
  })

  test('previous time bucket (look-back) yields a different valid hint', async () => {
    const pin = 'A/B:C;D(E)F'
    const current = await computePinHint(pin, 0)
    const previous = await computePinHint(pin, 1)
    expect(previous).toMatch(new RegExp(`^[0-9a-f]{${PIN_HINT_LENGTH}}$`))
    // A different time bucket changes the salt, so the hint differs
    expect(previous).not.toBe(current)
  })

  test('fingerprint is deterministic and domain-separated from the wire hint', async () => {
    const pin = 'A/B:C;D(E)F'
    const fp = await computePinFingerprint(pin)
    expect(fp).toMatch(new RegExp(`^[0-9a-f]{${PIN_FINGERPRINT_LENGTH}}$`))
    // Stable across calls (no time bucket in the salt)
    expect(await computePinFingerprint(pin)).toBe(fp)
    // Different salt than any time-bucketed wire hint
    expect(fp).not.toBe(await computePinHint(pin, 0))
    expect(fp).not.toBe(await computePinHint(pin, 1))
  })

  test('computePinHintFromKey matches computePinHint for the same PIN and bucket', async () => {
    const pin = 'A/B:C;D(E)F'
    const keyMaterial = await importPinKey(pin)
    for (const offset of [0, 1]) {
      const fromKey = await computePinHintFromKey(keyMaterial, offset)
      const fromPin = await computePinHint(pin, offset)
      expect(fromKey).toBe(fromPin)
    }
  })
})

describe('PIN Word Mapping', () => {
  test('pinToWords should result in 7 words', () => {
    const pin = 'A/B:C;D(E)F' // 11 chars + 1 for checksum
    const words = pinToWords(pin)
    expect(words.length).toBe(7)
    expect(words.every((w) => w.length > 0)).toBe(true)
  })

  test('wordsToPin should be the inverse of pinToWords', () => {
    // Let's use a real PIN
    const pin = generatePinForMethod('nostr')
    const words = pinToWords(pin)
    const recoveredPin = wordsToPin(words)
    expect(recoveredPin).toBe(pin)
  })

  test('isValidPinWord should work correctly', () => {
    expect(isValidPinWord('abandon')).toBe(true)
    expect(isValidPinWord('ABANDON')).toBe(true)
    expect(isValidPinWord('invalidword')).toBe(false)
    expect(isValidPinWord('')).toBe(false)
    expect(isValidPinWord('a')).toBe(false)
    expect(isValidPinWord('abandon1')).toBe(false)
    expect(isValidPinWord('abandon!')).toBe(false)
    expect(isValidPinWord('   ')).toBe(false)
  })
})
