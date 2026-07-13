import { describe, expect, it } from 'vitest';
import {
  createHandshakeEvent,
  createRendezvousEvent,
  generateEphemeralKeys,
  generateHandshakeNonce,
  openHandshakePayload,
  parseHandshakeEvent,
  parseRendezvousEvent,
  sealHandshakePayload,
} from './events';

async function generateAesKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
}

describe('Nostr events', () => {
  it('round-trips rendezvous event tags and payload', () => {
    const { secretKey } = generateEphemeralKeys();
    const encryptedPayload = new Uint8Array([1, 2, 3, 4]);
    const salt = crypto.getRandomValues(new Uint8Array(16));

    const event = createRendezvousEvent(
      secretKey,
      encryptedPayload,
      salt,
      'transfer-id',
      'hint',
    );

    const parsed = parseRendezvousEvent(event);
    expect(parsed).not.toBeNull();
    expect(parsed?.hint).toBe('hint');
    expect(parsed?.transferId).toBe('transfer-id');
    expect(parsed?.salt).toEqual(salt);
    expect(parsed?.encryptedPayload).toEqual(encryptedPayload);

    // NIP-40 expiration tag is present and in the future
    const expiration = event.tags.find((t) => t[0] === 'expiration')?.[1];
    expect(Number(expiration)).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('seals and opens handshake payloads with the auth key', async () => {
    const { secretKey } = generateEphemeralKeys();
    const authKey = await generateAesKey();
    const payload = {
      type: 'claim',
      transferId: 'transfer-id',
      senderNonce: generateHandshakeNonce(),
      receiverNonce: generateHandshakeNonce(),
    };

    const event = createHandshakeEvent(
      secretKey,
      'sender-pubkey',
      'transfer-id',
      'claim',
      await sealHandshakePayload(authKey, payload),
    );

    const parsed = parseHandshakeEvent(event);
    expect(parsed).toMatchObject({
      recipientPubkey: 'sender-pubkey',
      transferId: 'transfer-id',
      type: 'claim',
    });

    const opened = await openHandshakePayload(
      authKey,
      parsed?.sealedPayload ?? new Uint8Array(),
    );
    expect(opened).toEqual(payload);
  });

  it('rejects handshake payloads sealed with a different PIN key', async () => {
    const { secretKey } = generateEphemeralKeys();
    const rightKey = await generateAesKey();
    const wrongKey = await generateAesKey();

    const event = createHandshakeEvent(
      secretKey,
      'sender-pubkey',
      'transfer-id',
      'confirm',
      await sealHandshakePayload(rightKey, { type: 'confirm' }),
    );
    const parsed = parseHandshakeEvent(event);
    expect(parsed?.type).toBe('confirm');

    await expect(
      openHandshakePayload(wrongKey, parsed?.sealedPayload ?? new Uint8Array()),
    ).rejects.toThrow();
  });

  it('does not parse signaling events as handshakes', () => {
    const { secretKey } = generateEphemeralKeys();
    const event = createHandshakeEvent(
      secretKey,
      'pk',
      'transfer-id',
      'claim',
      new Uint8Array([1]),
    );
    const tampered = {
      ...event,
      tags: event.tags.map((tag) =>
        tag[0] === 'type' ? ['type', 'signal'] : tag,
      ),
    };
    expect(parseHandshakeEvent(tampered)).toBeNull();
  });
});
