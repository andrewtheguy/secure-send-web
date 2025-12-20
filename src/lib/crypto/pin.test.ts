import { expect, test, describe } from 'vitest'
import { generatePinForMethod, pinToWords, wordsToPin, isValidPinWord, computePinHint, detectSignalingMethod } from './pin'

describe('PIN Utilities', () => {
    test('detectSignalingMethod should identify method from PIN', () => {
        // Nostr (Uppercase)
        expect(detectSignalingMethod('A1234567890B')).toBe('nostr')
        // PeerJS (Lowercase)
        expect(detectSignalingMethod('a1234567890b')).toBe('peerjs')
        // QR/Manual ('2')
        expect(detectSignalingMethod('21234567890b')).toBe('manual')
        // Unknown/Empty
        expect(detectSignalingMethod('')).toBeNull()
        expect(detectSignalingMethod('!1234567890b')).toBeNull()
    })

    test('computePinHint should return 8 hex characters', async () => {
        const pin = 'A/B:C;D(E)F'
        const hint = await computePinHint(pin)
        expect(hint).toMatch(/^[0-9a-f]{8}$/)

        // Same PIN should give same hint
        const hint2 = await computePinHint(pin)
        expect(hint2).toBe(hint)

        // Different PIN should (most likely) give different hint
        const hint3 = await computePinHint('differentpin')
        expect(hint3).not.toBe(hint)
    })

})

describe('PIN Word Mapping', () => {
    test('pinToWords should result in 7 words', () => {
        const pin = 'A/B:C;D(E)F' // 11 chars + 1 for checksum
        const words = pinToWords(pin)
        expect(words.length).toBe(7)
        expect(words.every(w => w.length > 0)).toBe(true)
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
    })
})
