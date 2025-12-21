import { describe, it, expect } from 'vitest'
import {
    generateMutualOfferBinary,
    generateMutualAnswerBinary,
    parseMutualPayload,
    isMutualPayload,
    generateMutualClipboardData,
    parseClipboardPayload,
    isValidSignalingPayload,
    estimatePayloadSize
} from './manual-signaling'

describe('Manual Signaling Utils', () => {
    const mockOffer: RTCSessionDescriptionInit = {
        type: 'offer',
        sdp: 'v=0\r\no=- 123 456 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 1 RTP/AVP 111\r\nc=IN IP4 127.0.0.1'
    }
    const mockCandidates: RTCIceCandidate[] = [
        { candidate: 'candidate:1 1 UDP 123 127.0.0.1 12345 typ host', sdpMid: '0', sdpMLineIndex: 0 } as RTCIceCandidate
    ]
    const mockPublicKey = new Uint8Array(65).fill(1)
    mockPublicKey[0] = 4; // Uncompressed point prefix
    const mockSalt = new Uint8Array(16).fill(2)

    it('should generate and parse mutual offer binary correctly', () => {
        const metadata = {
            createdAt: Date.now(),
            totalBytes: 1024,
            fileName: 'test.txt',
            fileSize: 1024,
            mimeType: 'text/plain',
            publicKey: mockPublicKey,
            salt: mockSalt
        }

        const binary = generateMutualOfferBinary(mockOffer, mockCandidates, metadata)

        expect(isMutualPayload(binary)).toBe(true)
        expect(binary.length).toBeGreaterThan(8) // Header + something

        const parsed = parseMutualPayload(binary)

        expect(parsed).toBeDefined()
        expect(parsed?.type).toBe('offer')
        expect(parsed?.sdp).toBe(mockOffer.sdp)
        expect(parsed?.candidates).toHaveLength(1)
        expect(parsed?.candidates[0]).toBe(mockCandidates[0].candidate)
        expect(parsed?.fileName).toBe(metadata.fileName)
        expect(parsed?.publicKey).toEqual(Array.from(mockPublicKey))
    })

    it('should generate and parse mutual answer binary correctly', () => {
        const createdAt = Date.now()
        const binary = generateMutualAnswerBinary(
            { type: 'answer', sdp: mockOffer.sdp },
            mockCandidates,
            mockPublicKey,
            createdAt
        )

        expect(isMutualPayload(binary)).toBe(true)

        const parsed = parseMutualPayload(binary)
        expect(parsed).toBeDefined()
        expect(parsed?.type).toBe('answer')
        expect(parsed?.sdp).toBe(mockOffer.sdp)
        expect(parsed?.publicKey).toEqual(Array.from(mockPublicKey))
    })

    it('should obfuscate data (output should not contain cleartext JSON)', () => {
        const metadata = {
            createdAt: Date.now(),
            totalBytes: 100,
            publicKey: mockPublicKey,
            salt: mockSalt,
            fileName: 'secret-file-name.txt'
        }

        const binary = generateMutualOfferBinary(mockOffer, [], metadata)
        const decoder = new TextDecoder()
        const binaryString = decoder.decode(binary)

        // The filename should NOT be visible in the binary string because of compression + obfuscation
        expect(binaryString).not.toContain('secret-file-name.txt')
    })

    it('should validate signaling payload structure', () => {
        const validPayload = {
            type: 'offer',
            sdp: 'sdp',
            candidates: ['cand1'],
            createdAt: 123456,
            publicKey: Array.from(mockPublicKey) // array of numbers
        }
        expect(isValidSignalingPayload(validPayload)).toBe(true)

        const invalidPayload = { ...validPayload, type: 'invalid' }
        expect(isValidSignalingPayload(invalidPayload)).toBe(false)

        const missingKey = { ...validPayload, publicKey: undefined }
        expect(isValidSignalingPayload(missingKey)).toBe(false)
    })

    it('should handle clipboard base64 conversions', () => {
        const binary = new Uint8Array([1, 2, 3, 4, 5])
        const base64 = generateMutualClipboardData(binary)

        expect(typeof base64).toBe('string')

        const parsed = parseClipboardPayload(base64)
        expect(parsed).toEqual(binary)
    })

    it('should return null for invalid binary payload', () => {
        const invalidBinary = new Uint8Array([0, 0, 0, 0, 1, 2, 3])
        expect(isMutualPayload(invalidBinary)).toBe(false)
        expect(parseMutualPayload(invalidBinary)).toBeNull()
    })

    it('should estimate payload size', () => {
        const payload: any = {
            type: 'offer',
            sdp: 'sdp',
            candidates: [],
            createdAt: Date.now(),
            publicKey: Array.from(mockPublicKey)
        }
        const size = estimatePayloadSize(payload)
        expect(size).toBeGreaterThan(0)
    })
})
