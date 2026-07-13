import { describe, expect, it } from 'vitest';
import { ENCRYPTION_CHUNK_SIZE, encryptChunk } from './crypto';
import { createDataChannelReceiver } from './p2p-transfer';
import { createReceiveSink } from './receive-sink';

async function makeKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
}

function makePlaintext(totalBytes: number): Uint8Array {
  const data = new Uint8Array(totalBytes);
  for (let i = 0; i < totalBytes; i++) data[i] = (i * 31 + 7) % 256;
  return data;
}

async function encryptAll(
  key: CryptoKey,
  plaintext: Uint8Array,
): Promise<ArrayBuffer[]> {
  const messages: ArrayBuffer[] = [];
  for (let i = 0; i * ENCRYPTION_CHUNK_SIZE < plaintext.length; i++) {
    const chunk = plaintext.subarray(
      i * ENCRYPTION_CHUNK_SIZE,
      Math.min((i + 1) * ENCRYPTION_CHUNK_SIZE, plaintext.length),
    );
    const message = await encryptChunk(key, chunk, i);
    messages.push(message.buffer as ArrayBuffer);
  }
  return messages;
}

describe('createDataChannelReceiver', () => {
  it('decrypts out-of-order chunks into the sink and resolves the payload', async () => {
    const key = await makeKey();
    const totalBytes = ENCRYPTION_CHUNK_SIZE + 1234;
    const plaintext = makePlaintext(totalBytes);
    const messages = await encryptAll(key, plaintext);

    const sink = await createReceiveSink(totalBytes);
    const progress: number[] = [];
    const receiver = createDataChannelReceiver(key, totalBytes, sink, {
      onProgress: (current) => progress.push(current),
    });
    receiver.start();

    // Deliver the second chunk first: positional sink writes must reassemble.
    receiver.onMessage(messages[1]);
    receiver.onMessage(messages[0]);
    receiver.onMessage(`DONE:${messages.length}`);

    const blob = await receiver.done;
    expect(blob.size).toBe(totalBytes);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(plaintext);
    expect(progress.at(-1)).toBe(totalBytes);
  });

  it('resolves an empty payload for a zero-byte transfer', async () => {
    const key = await makeKey();
    const sink = await createReceiveSink(0);
    const receiver = createDataChannelReceiver(key, 0, sink);
    receiver.start();
    receiver.onMessage('DONE:0');
    const blob = await receiver.done;
    expect(blob.size).toBe(0);
  });

  it('rejects a duplicate chunk index', async () => {
    const key = await makeKey();
    const plaintext = makePlaintext(100);
    const [message] = await encryptAll(key, plaintext);

    const sink = await createReceiveSink(100);
    const receiver = createDataChannelReceiver(key, 100, sink);
    receiver.start();
    receiver.onMessage(message);
    receiver.onMessage(message.slice(0));

    await expect(receiver.done).rejects.toThrow('Duplicate chunk index');
  });

  it('rejects a tampered chunk', async () => {
    const key = await makeKey();
    const plaintext = makePlaintext(100);
    const [message] = await encryptAll(key, plaintext);
    const tampered = new Uint8Array(message.slice(0));
    tampered[tampered.length - 1] ^= 0xff;

    const sink = await createReceiveSink(100);
    const receiver = createDataChannelReceiver(key, 100, sink);
    receiver.start();
    receiver.onMessage(tampered.buffer as ArrayBuffer);

    await expect(receiver.done).rejects.toThrow();
  });

  it('rejects a DONE count that disagrees with the advertised size', async () => {
    const key = await makeKey();
    const plaintext = makePlaintext(100);
    const [message] = await encryptAll(key, plaintext);

    const sink = await createReceiveSink(100);
    const receiver = createDataChannelReceiver(key, 100, sink);
    receiver.start();
    receiver.onMessage(message);
    receiver.onMessage('DONE:2');

    await expect(receiver.done).rejects.toThrow('Invalid DONE message');
  });

  it('aborts an idle transfer via the stall watchdog', async () => {
    const key = await makeKey();
    const sink = await createReceiveSink(100);
    const receiver = createDataChannelReceiver(key, 100, sink, {
      stallTimeoutMs: 20,
    });
    receiver.start();

    await expect(receiver.done).rejects.toThrow('Transfer stalled');
  });
});
