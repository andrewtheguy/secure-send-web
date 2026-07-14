import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installOpfsMock, type OpfsMock } from '../test/opfs-mock';
import { ENCRYPTION_CHUNK_SIZE, encryptChunk } from './crypto';
import {
  ACK,
  createDataChannelReceiver,
  sendFileOverDataChannel,
} from './p2p-transfer';
import { createAdaptiveAppendSink, createReceiveSink } from './scratch-sink';
import type { TransferSource } from './transfer-source';
import type { WebRTCConnection } from './webrtc';

let opfs: OpfsMock;

beforeAll(() => {
  opfs = installOpfsMock();
});

afterAll(() => {
  opfs.uninstall();
});

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

describe('sendFileOverDataChannel', () => {
  it('sends a full chunk before an unknown-size source has finished producing', async () => {
    const key = await makeKey();
    let releaseRemainder!: () => void;
    let remainderReleased = false;
    const remainderReady = new Promise<void>((resolve) => {
      releaseRemainder = () => {
        remainderReleased = true;
        resolve();
      };
    });
    const source: TransferSource = {
      name: 'stream.zip',
      type: 'application/zip',
      size: null,
      estimatedSize: ENCRYPTION_CHUNK_SIZE + 3,
      stream: () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(ENCRYPTION_CHUNK_SIZE));
          },
          async pull(controller) {
            await remainderReady;
            controller.enqueue(new Uint8Array([1, 2, 3]));
            controller.close();
          },
        }),
    };

    const channel = Object.assign(new EventTarget(), {
      readyState: 'open' as RTCDataChannelState,
    }) as unknown as RTCDataChannel;
    let firstChunkSent!: () => void;
    const firstChunk = new Promise<void>((resolve) => {
      firstChunkSent = resolve;
    });
    const controls: string[] = [];
    const rtc = {
      async sendWithBackpressure() {
        firstChunkSent();
      },
      send(data: string) {
        controls.push(data);
        queueMicrotask(() => {
          channel.dispatchEvent(new MessageEvent('message', { data: ACK }));
        });
      },
      getDataChannel() {
        return channel;
      },
    } as unknown as WebRTCConnection;

    const sending = sendFileOverDataChannel(rtc, key, source);
    await firstChunk;
    expect(remainderReleased).toBe(false);
    releaseRemainder();

    await expect(sending).resolves.toBe(ENCRYPTION_CHUNK_SIZE + 3);
    expect(controls).toEqual([`DONE:2:${ENCRYPTION_CHUNK_SIZE + 3}`]);
  });
});

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
    receiver.onMessage(`DONE:${messages.length}:${totalBytes}`);

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
    receiver.onMessage('DONE:0:0');
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

  it('rejects a DONE count that disagrees with received chunks', async () => {
    const key = await makeKey();
    const plaintext = makePlaintext(100);
    const [message] = await encryptAll(key, plaintext);

    const sink = await createReceiveSink(100);
    const receiver = createDataChannelReceiver(key, 100, sink);
    receiver.start();
    receiver.onMessage(message);
    receiver.onMessage('DONE:2:100');

    await expect(receiver.done).rejects.toThrow('Invalid DONE message');
  });

  it('appends an unknown-size streamed payload and trusts only the final byte count', async () => {
    const key = await makeKey();
    const totalBytes = ENCRYPTION_CHUNK_SIZE + 1234;
    const plaintext = makePlaintext(totalBytes);
    const messages = await encryptAll(key, plaintext);
    const sink = await createAdaptiveAppendSink(totalBytes);
    const receiver = createDataChannelReceiver(key, null, sink, {
      estimatedBytes: totalBytes,
    });
    receiver.start();

    for (const message of messages) receiver.onMessage(message);
    receiver.onMessage(`DONE:${messages.length}:${totalBytes}`);

    const blob = await receiver.done;
    expect(blob.size).toBe(totalBytes);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(plaintext);
    await sink.discard();
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
