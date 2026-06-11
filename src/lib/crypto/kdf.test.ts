import { describe, expect, it } from 'vitest'
import { encrypt, decrypt } from './aes-gcm'
import {
  deriveNostrTransferKeysFromPinKey,
  generateSalt,
  importPinKey,
} from './kdf'

describe('PIN KDF', () => {
  it('derives non-extractable labeled Nostr keys that are not interchangeable', async () => {
    const keyMaterial = await importPinKey('A/B:C;D(E)F')
    const keys = await deriveNostrTransferKeysFromPinKey(keyMaterial, generateSalt())

    for (const key of [keys.metadata, keys.signals, keys.p2pContent, keys.cloudContent]) {
      expect(key.extractable).toBe(false)
      expect(key.algorithm.name).toBe('AES-GCM')
      expect(key.usages).toEqual(['encrypt', 'decrypt'])
    }

    const plaintext = new TextEncoder().encode('metadata payload')
    const encrypted = await encrypt(keys.metadata, plaintext)

    await expect(decrypt(keys.metadata, encrypted)).resolves.toEqual(plaintext)
    await expect(decrypt(keys.signals, encrypted)).rejects.toThrow()
    await expect(decrypt(keys.p2pContent, encrypted)).rejects.toThrow()
    await expect(decrypt(keys.cloudContent, encrypted)).rejects.toThrow()
  })
})
