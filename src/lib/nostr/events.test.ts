import { describe, expect, it } from 'vitest';
import {
  createAuthenticatedAckEvent,
  generateEphemeralKeys,
  parseAckEvent,
  verifyAuthenticatedAckEvent,
} from './events';

async function generateAesKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
}

describe('Nostr events', () => {
  it('authenticates ACK content with the session key', async () => {
    const { secretKey } = generateEphemeralKeys();
    const key = await generateAesKey();

    const event = await createAuthenticatedAckEvent(
      secretKey,
      'sender-pubkey',
      'transfer-id',
      0,
      key,
      'hint',
    );

    expect(parseAckEvent(event)).toMatchObject({
      senderPubkey: 'sender-pubkey',
      transferId: 'transfer-id',
      seq: 0,
      hint: 'hint',
    });
    await expect(
      verifyAuthenticatedAckEvent(event, key, 'transfer-id', 0),
    ).resolves.toBe(true);
  });

  it('rejects ACKs whose encrypted body does not match the routing tags', async () => {
    const { secretKey } = generateEphemeralKeys();
    const key = await generateAesKey();

    const event = await createAuthenticatedAckEvent(
      secretKey,
      'sender-pubkey',
      'transfer-id',
      1,
      key,
    );
    const tampered = {
      ...event,
      tags: event.tags.map((tag) => (tag[0] === 'seq' ? ['seq', '2'] : tag)),
    };

    await expect(
      verifyAuthenticatedAckEvent(tampered, key, 'transfer-id', 2),
    ).resolves.toBe(false);
  });

  it('rejects plaintext legacy-style ACKs', async () => {
    const { secretKey } = generateEphemeralKeys();
    const key = await generateAesKey();
    const event = await createAuthenticatedAckEvent(
      secretKey,
      'sender-pubkey',
      'transfer-id',
      -1,
      key,
    );

    const plaintextAck = { ...event, content: '' };

    await expect(
      verifyAuthenticatedAckEvent(plaintextAck, key, 'transfer-id', -1),
    ).resolves.toBe(false);
  });
});
