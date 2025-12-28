import { describe, it, expect } from 'vitest'
import { generateNonce, encrypt, decrypt, encryptMessage, decryptMessage } from './aes-gcm'
import { generateECDHKeyPair, deriveSharedSecretKey, deriveAESKeyFromSecretKey } from './ecdh'
import { encryptChunk, decryptChunk, parseChunkMessage, calculateEncryptionOverhead, ENCRYPTED_CHUNK_OVERHEAD } from './stream-crypto'
import { AES_KEY_LENGTH } from './constants'

describe('AES-GCM Utils', () => {
    it('should generate unique nonces', () => {
        const nonce1 = generateNonce()
        const nonce2 = generateNonce()
        expect(nonce1).not.toEqual(nonce2)
        expect(nonce1.length).toBe(12)
    })

    it('should encrypt and decrypt data correctly', async () => {
        const key = await crypto.subtle.generateKey(
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        )
        const plaintext = new TextEncoder().encode('Hello World')

        const encrypted = await encrypt(key, plaintext)
        expect(encrypted.length).toBeGreaterThan(plaintext.length)

        const decrypted = await decrypt(key, encrypted)
        expect(decrypted).toEqual(plaintext)
    })

    it('should encrypt and decrypt string messages', async () => {
        const key = await crypto.subtle.generateKey(
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        )
        const message = "Secret Message 🚀"

        const encrypted = await encryptMessage(key, message)
        const decrypted = await decryptMessage(key, encrypted)

        expect(decrypted).toBe(message)
    })

    it('should fail to decrypt with wrong key', async () => {
        const key1 = await crypto.subtle.generateKey(
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        )
        const key2 = await crypto.subtle.generateKey(
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        )

        const plaintext = new TextEncoder().encode('Secret')
        const encrypted = await encrypt(key1, plaintext)

        await expect(decrypt(key2, encrypted)).rejects.toThrow()
    })
})

describe('ECDH Utils', () => {
    it('should generate valid key pairs', async () => {
        const keyPair = await generateECDHKeyPair()
        expect(keyPair.publicKey).toBeDefined()
        expect(keyPair.privateKey).toBeDefined()
        expect(keyPair.publicKeyBytes).toBeInstanceOf(Uint8Array)
        expect(keyPair.publicKeyBytes.length).toBe(65)
        expect(keyPair.publicKeyBytes[0]).toBe(0x04)
    })

    // Helper to generate ECDH key pair with deriveKey usage for testing deriveSharedSecretKey
    async function generateTestECDHKeyPair() {
        const keyPair = await crypto.subtle.generateKey(
            { name: 'ECDH', namedCurve: 'P-256' },
            false,
            ['deriveKey', 'deriveBits']
        )
        const publicKeyBytes = new Uint8Array(
            await crypto.subtle.exportKey('raw', keyPair.publicKey)
        )
        return { ...keyPair, publicKeyBytes }
    }

    it('should derive equivalent shared secrets for two peers (non-extractable)', async () => {
        const alice = await generateTestECDHKeyPair()
        const bob = await generateTestECDHKeyPair()
        const salt = crypto.getRandomValues(new Uint8Array(16))

        // Both parties derive shared secret keys (non-extractable CryptoKeys)
        const aliceSharedKey = await deriveSharedSecretKey(alice.privateKey, bob.publicKeyBytes)
        const bobSharedKey = await deriveSharedSecretKey(bob.privateKey, alice.publicKeyBytes)

        // Derive AES keys from both shared secrets
        const aliceAesKey = await deriveAESKeyFromSecretKey(aliceSharedKey, salt)
        const bobAesKey = await deriveAESKeyFromSecretKey(bobSharedKey, salt)

        // Verify both parties can encrypt/decrypt to each other (proves same shared secret)
        const testMessage = new TextEncoder().encode('ECDH test message')
        const encrypted = await encrypt(aliceAesKey, testMessage)
        const decrypted = await decrypt(bobAesKey, encrypted)
        expect(decrypted).toEqual(testMessage)
    })

    it('should derive working AES keys from shared secret key', async () => {
        const alice = await generateTestECDHKeyPair()
        const bob = await generateTestECDHKeyPair()

        const sharedSecretKey = await deriveSharedSecretKey(alice.privateKey, bob.publicKeyBytes)
        const salt = crypto.getRandomValues(new Uint8Array(16))

        const aesKey = await deriveAESKeyFromSecretKey(sharedSecretKey, salt)

        expect(aesKey.algorithm.name).toBe('AES-GCM')
        // @ts-expect-error length property exists on AesKeyAlgorithm
        expect(aesKey.algorithm.length).toBe(AES_KEY_LENGTH)
        expect(aesKey.usages).toContain('encrypt')
        expect(aesKey.usages).toContain('decrypt')
    })
})

describe('Stream Crypto', () => {
    it('should encrypt and decrypt chunks', async () => {
        const key = await crypto.subtle.generateKey(
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        )
        const chunkData = new Uint8Array([1, 2, 3, 4, 5])
        const chunkIndex = 42

        // Encrypt
        const encryptedChunk = await encryptChunk(key, chunkData, chunkIndex)

        // Parse
        const parsed = parseChunkMessage(encryptedChunk)
        expect(parsed.chunkIndex).toBe(chunkIndex)
        expect(parsed.encryptedData).toBeInstanceOf(Uint8Array)

        // Decrypt
        const decryptedData = await decryptChunk(key, parsed.encryptedData)
        expect(decryptedData).toEqual(chunkData)
    })

    it('should calculate overhead correctly', () => {
        const overhead = calculateEncryptionOverhead(10)
        expect(overhead).toBe(10 * ENCRYPTED_CHUNK_OVERHEAD)
    })

    it('should throw on invalid chunk index', async () => {
        const key = await crypto.subtle.generateKey(
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        )
        const chunkData = new Uint8Array([1])

        await expect(encryptChunk(key, chunkData, -1)).rejects.toThrow()
        await expect(encryptChunk(key, chunkData, 70000)).rejects.toThrow()
    })

    it('should throw on short message in parseChunkMessage', () => {
        const shortData = new Uint8Array(5)
        expect(() => parseChunkMessage(shortData)).toThrow()
    })
})
