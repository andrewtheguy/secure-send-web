import { describe, expect, it } from 'vitest';
import { decrypt, encrypt } from './aes-gcm';
import { deriveSharedSecretKey, generateECDHKeyPair } from './ecdh';
import { deriveNostrSessionKeys, generateSalt } from './kdf';

describe('Nostr session KDF', () => {
  it('derives non-extractable session keys that are not interchangeable', async () => {
    const alice = await generateECDHKeyPair();
    const bob = await generateECDHKeyPair();
    const shared = await deriveSharedSecretKey(
      alice.privateKey,
      bob.publicKeyBytes,
    );
    const keys = await deriveNostrSessionKeys(shared, generateSalt());

    for (const key of [keys.signals, keys.content]) {
      expect(key.extractable).toBe(false);
      expect(key.algorithm.name).toBe('AES-GCM');
      expect(key.usages).toEqual(['encrypt', 'decrypt']);
    }

    const plaintext = new TextEncoder().encode('signal payload');
    const encrypted = await encrypt(keys.signals, plaintext);

    await expect(decrypt(keys.signals, encrypted)).resolves.toEqual(plaintext);
    await expect(decrypt(keys.content, encrypted)).rejects.toThrow();
  });

  it('both ECDH peers derive the same session keys', async () => {
    const alice = await generateECDHKeyPair();
    const bob = await generateECDHKeyPair();
    const salt = generateSalt();

    const aliceKeys = await deriveNostrSessionKeys(
      await deriveSharedSecretKey(alice.privateKey, bob.publicKeyBytes),
      salt,
    );
    const bobKeys = await deriveNostrSessionKeys(
      await deriveSharedSecretKey(bob.privateKey, alice.publicKeyBytes),
      salt,
    );

    const plaintext = new TextEncoder().encode('cross-peer check');
    const encrypted = await encrypt(aliceKeys.content, plaintext);
    await expect(decrypt(bobKeys.content, encrypted)).resolves.toEqual(
      plaintext,
    );
  });
});
