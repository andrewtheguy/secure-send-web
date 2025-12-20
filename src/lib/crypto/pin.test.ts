import { expect, test, describe } from 'vitest'
import { generatePin, pinToWords, wordsToPin, isValidPinWord } from './pin'

describe('PIN Word Mapping', () => {
    test('pinToWords should map all characters in charset', () => {
        const pin = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789-/:;()$&@?!.,"'
        const words = pinToWords(pin)
        expect(words.length).toBe(pin.length)
        expect(words.every(w => w.length > 0)).toBe(true)
    })

    test('wordsToPin should be the inverse of pinToWords', () => {
        // Let's use a real PIN
        const pin = generatePin()
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
