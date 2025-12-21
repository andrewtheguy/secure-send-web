import { describe, it, expect } from 'vitest'
import { generateNonce, encrypt, decrypt, encryptMessage, decryptMessage } from './aes-gcm'
import { generateECDHKeyPair, importECDHPublicKey, deriveSharedSecret, deriveAESKeyFromSecret } from './ecdh'
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
            true,
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
            true,
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
            true,
            ['encrypt', 'decrypt']
        )
        const key2 = await crypto.subtle.generateKey(
            { name: 'AES-GCM', length: 256 },
            true,
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

    it('should derive the same shared secret for two peers', async () => {
        const alice = await generateECDHKeyPair()
        const bob = await generateECDHKeyPair()

        const aliceShared = await deriveSharedSecret(alice.privateKey, bob.publicKeyBytes)
        const bobShared = await deriveSharedSecret(bob.privateKey, alice.publicKeyBytes)

        expect(aliceShared).toEqual(bobShared)
        expect(aliceShared.length).toBe(32)
    })

    it('should derive working AES keys from shared secret', async () => {
        const alice = await generateECDHKeyPair()
        const bob = await generateECDHKeyPair()

        const sharedSecret = await deriveSharedSecret(alice.privateKey, bob.publicKeyBytes)
        const salt = crypto.getRandomValues(new Uint8Array(16))

        const aesKey = await deriveAESKeyFromSecret(sharedSecret, salt)

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
            true,
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
            true,
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
