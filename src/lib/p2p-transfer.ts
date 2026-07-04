/**
 * Shared WebRTC data-channel file-transfer protocol.
 *
 * This module is the single source of truth for the data payload sent from
 * sender to receiver over an already-open WebRTC data channel. Both signaling
 * modes (manual/QR and auto/nostr) use it, so the wire protocol and every
 * per-chunk validation live in exactly one place.
 *
 * Wire protocol:
 *   - Binary chunk messages, each produced by `encryptChunk`:
 *       [2-byte chunk index (big-endian)][12-byte nonce][ciphertext][16-byte tag]
 *     The chunk index is also the AES-GCM additional authenticated data.
 *   - A trailing control string `DONE:<totalChunks>`.
 *   - The receiver replies with the control string `ACK` once the whole file
 *     has authenticated and reassembled.
 */

import {
  AES_NONCE_LENGTH,
  AES_TAG_LENGTH,
  decryptChunk,
  ENCRYPTED_CHUNK_OVERHEAD,
  ENCRYPTION_CHUNK_SIZE,
  encryptChunk,
  parseChunkMessage,
} from '@/lib/crypto';
import { P2PConnectionError } from '@/lib/errors';
import type { WebRTCConnection } from '@/lib/webrtc';

/** Control-message tokens exchanged over the data channel. */
const DONE_PREFIX = 'DONE:';
/** Canonical acknowledgement token; receive hooks send this exact value. */
export const ACK = 'ACK';

/** Maximum time the sender waits for the receiver's ACK. */
export const ACK_TIMEOUT_MS = 30000;

/**
 * Idle/stall timeout for an in-flight transfer. This is a per-activity window,
 * not an overall deadline: each chunk sent (sender) or message received
 * (receiver) resets it, so an arbitrarily large but steadily-progressing
 * transfer never trips it, while a peer that goes quiet mid-stream aborts after
 * this span instead of hanging.
 */
export const STALL_TIMEOUT_MS = 60000;

/**
 * The chunk index is a 2-byte big-endian field on the wire, so a transfer can
 * span at most 65536 chunks (indices 0-65535). Totals beyond this cannot be
 * represented and are rejected before any allocation or processing.
 */
const MAX_CHUNKS = 0x10000; // 65536

export interface SendOptions {
  /** Called after each chunk with cumulative bytes sent and the total. */
  onProgress?: (current: number, total: number) => void;
  /** Return true to abort the transfer between chunks. */
  isCancelled?: () => boolean;
  /**
   * Idle window in ms for a single chunk send. If the receiver stops draining
   * the channel and one chunk cannot be handed off within this span, the
   * transfer aborts. Defaults to STALL_TIMEOUT_MS.
   */
  stallTimeoutMs?: number;
}

export interface ReceiverOptions {
  /** Called after each chunk with cumulative decrypted bytes and the total. */
  onProgress?: (current: number, total: number) => void;
  /**
   * Idle window in ms: once `start()` is called, the transfer aborts if no
   * data-channel message arrives within this span. Every message resets it.
   * Defaults to STALL_TIMEOUT_MS.
   */
  stallTimeoutMs?: number;
}

export interface DataChannelReceiver {
  /** Feed every data-channel message here. */
  onMessage: (data: string | ArrayBuffer) => void;
  /** Resolves with the fully reassembled plaintext, or rejects on any error. */
  done: Promise<Uint8Array>;
  /**
   * Arm the stall watchdog. Call once the data channel is open and data should
   * begin flowing; every subsequent message resets the idle window.
   */
  start: () => void;
  /**
   * Stop the stall watchdog and make the receiver inert. Call from a hook's own
   * cancel path so the timer does not outlive an abandoned transfer.
   */
  dispose: () => void;
}

/**
 * Encrypt `contentBytes` in `ENCRYPTION_CHUNK_SIZE` chunks and stream them over
 * the data channel, followed by a `DONE:<n>` control message.
 */
export async function sendFileOverDataChannel(
  rtc: WebRTCConnection,
  key: CryptoKey,
  contentBytes: Uint8Array,
  opts: SendOptions = {},
): Promise<void> {
  const { onProgress, isCancelled } = opts;
  const stallTimeoutMs = opts.stallTimeoutMs ?? STALL_TIMEOUT_MS;
  const total = contentBytes.length;
  const totalChunks = Math.ceil(total / ENCRYPTION_CHUNK_SIZE);
  if (totalChunks > MAX_CHUNKS) {
    throw new Error('File too large for the transfer chunk-index range');
  }

  let chunkIndex = 0;
  for (let i = 0; i < total; i += ENCRYPTION_CHUNK_SIZE) {
    if (isCancelled?.()) throw new Error('Cancelled');

    const end = Math.min(i + ENCRYPTION_CHUNK_SIZE, total);
    // subarray is a zero-copy view; encryptChunk reads it synchronously.
    const plainChunk = contentBytes.subarray(i, end);
    const encryptedChunk = await encryptChunk(key, plainChunk, chunkIndex);
    // A single chunk that cannot be handed off within the idle window means the
    // receiver has stopped draining the channel; abort rather than block here.
    await withStallTimeout(
      rtc.sendWithBackpressure(encryptedChunk),
      stallTimeoutMs,
      `Transfer stalled: receiver stopped accepting data within ${Math.round(stallTimeoutMs / 1000)}s`,
    );
    chunkIndex++;

    onProgress?.(end, total);
  }

  rtc.send(`${DONE_PREFIX}${totalChunks}`);

  await waitForAckMessage(rtc);
}

/**
 * Reject with a P2PConnectionError if `promise` has not settled within `ms`.
 *
 * The pending `promise` is left to settle on its own after a timeout; its
 * outcome is still consumed here (so it never surfaces as an unhandled
 * rejection) but is ignored once the stall has already been reported.
 */
function withStallTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new P2PConnectionError(message));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function waitForAckMessage(rtc: WebRTCConnection): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const dc = rtc.getDataChannel();
    if (!dc) {
      reject(new Error('Data channel unavailable'));
      return;
    }
    if (dc.readyState !== 'open') {
      reject(new Error('Data channel closed before acknowledgment'));
      return;
    }

    let settled = false;
    const cleanup = () => {
      dc.removeEventListener('message', onMessage);
      dc.removeEventListener('close', onClose);
      dc.removeEventListener('error', onError);
      clearTimeout(timeout);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.data === ACK) {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      }
    };
    // A close/error means the ACK can never arrive, so fail immediately instead
    // of waiting out ACK_TIMEOUT_MS.
    const onClose = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Data channel closed before acknowledgment'));
    };
    const onError = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Data channel error while waiting for acknowledgment'));
    };
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Timeout waiting for acknowledgment'));
    }, ACK_TIMEOUT_MS);

    // addEventListener (not .onmessage) so this coexists with the connection's
    // own message handler.
    dc.addEventListener('message', onMessage);
    dc.addEventListener('close', onClose);
    dc.addEventListener('error', onError);
  });
}

/**
 * Create a streaming receiver for a transfer of a known `totalBytes`.
 *
 * Decrypts each chunk as it arrives into a single preallocated buffer (size is
 * known up front from signaling), so peak memory is ~1x the file size. Feed
 * every data-channel message to `onMessage`; `done` resolves with the
 * reassembled plaintext once `DONE:<n>` arrives and all chunks authenticate.
 */
export function createDataChannelReceiver(
  key: CryptoKey,
  totalBytes: number,
  opts: ReceiverOptions = {},
): DataChannelReceiver {
  const { onProgress } = opts;
  const stallTimeoutMs = opts.stallTimeoutMs ?? STALL_TIMEOUT_MS;

  // Validate the untrusted advertised size before allocating or processing.
  if (!Number.isInteger(totalBytes) || totalBytes < 0) {
    throw new Error('Invalid transfer size');
  }
  const expectedChunks = Math.ceil(totalBytes / ENCRYPTION_CHUNK_SIZE);
  if (expectedChunks > MAX_CHUNKS) {
    throw new Error('Transfer size exceeds the supported chunk-index range');
  }

  const buffer = new Uint8Array(totalBytes);
  const expectedEncryptedBytes =
    totalBytes + expectedChunks * ENCRYPTED_CHUNK_OVERHEAD;

  const receivedIndices = new Set<number>();
  const pending = new Set<Promise<void>>();
  let receivedEncryptedBytes = 0;
  let totalDecryptedBytes = 0;
  let settled = false;

  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  const clearStallTimer = () => {
    if (stallTimer !== null) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
  };

  let resolveDone!: (value: Uint8Array) => void;
  let rejectDone!: (error: Error) => void;
  const done = new Promise<Uint8Array>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const fail = (error: Error) => {
    if (settled) return;
    settled = true;
    clearStallTimer();
    rejectDone(error);
  };

  // Arm (or reset) the idle watchdog: no message within the window aborts the
  // transfer. `start()` and every incoming message call this.
  const armStallTimer = () => {
    if (settled) return;
    clearStallTimer();
    stallTimer = setTimeout(() => {
      fail(
        new P2PConnectionError(
          `Transfer stalled: no data received within ${Math.round(stallTimeoutMs / 1000)}s`,
        ),
      );
    }, stallTimeoutMs);
  };

  const dispose = () => {
    // Make the receiver inert so a late message cannot re-arm the timer.
    settled = true;
    clearStallTimer();
  };

  const handleChunk = (data: ArrayBuffer) => {
    const messageLength = data.byteLength;
    // Register the decrypt promise synchronously so an in-order DONE always
    // observes it in `pending`.
    const promise = (async () => {
      const { chunkIndex, encryptedData } = parseChunkMessage(data);

      if (receivedIndices.has(chunkIndex)) {
        throw new Error(`Duplicate chunk index: ${chunkIndex}`);
      }
      if (chunkIndex >= expectedChunks) {
        throw new Error(`Chunk index out of range: ${chunkIndex}`);
      }

      const writePosition = chunkIndex * ENCRYPTION_CHUNK_SIZE;
      const expectedPlaintextLength =
        chunkIndex === expectedChunks - 1
          ? totalBytes - writePosition
          : ENCRYPTION_CHUNK_SIZE;
      const expectedEncryptedLength =
        expectedPlaintextLength + AES_NONCE_LENGTH + AES_TAG_LENGTH;
      if (encryptedData.length !== expectedEncryptedLength) {
        throw new Error(
          `Invalid encrypted chunk ${chunkIndex} length: expected ${expectedEncryptedLength}, got ${encryptedData.length}`,
        );
      }

      receivedEncryptedBytes += messageLength;
      if (receivedEncryptedBytes > expectedEncryptedBytes) {
        throw new Error('Transfer exceeds advertised size');
      }

      // Claim the index now, before the async decrypt, so a duplicate arriving
      // while decryptChunk is still pending is rejected by the check above.
      receivedIndices.add(chunkIndex);

      const decryptedChunk = await decryptChunk(key, encryptedData, chunkIndex);
      if (decryptedChunk.length !== expectedPlaintextLength) {
        throw new Error(
          `Invalid chunk ${chunkIndex} length: expected ${expectedPlaintextLength}, got ${decryptedChunk.length}`,
        );
      }
      if (writePosition + decryptedChunk.length > totalBytes) {
        throw new Error(`Chunk ${chunkIndex} exceeds expected file size`);
      }

      buffer.set(decryptedChunk, writePosition);
      totalDecryptedBytes += decryptedChunk.length;

      onProgress?.(totalDecryptedBytes, totalBytes);
    })().catch(fail);

    pending.add(promise);
    void promise.finally(() => pending.delete(promise));
  };

  const handleDone = async (count: number) => {
    if (!Number.isInteger(count) || count < 0) {
      fail(new Error('Invalid DONE message: missing chunk count'));
      return;
    }
    if (count !== expectedChunks) {
      fail(
        new Error(
          `Invalid DONE message: expected ${expectedChunks} chunks, got ${count}`,
        ),
      );
      return;
    }

    if (pending.size > 0) {
      await Promise.allSettled(Array.from(pending));
    }
    if (settled) return;

    if (
      receivedIndices.size !== expectedChunks ||
      totalDecryptedBytes !== totalBytes
    ) {
      fail(
        new Error(
          `Incomplete transfer: got ${totalDecryptedBytes} bytes, expected ${totalBytes}`,
        ),
      );
      return;
    }

    settled = true;
    clearStallTimer();
    resolveDone(buffer);
  };

  const onMessage = (data: string | ArrayBuffer) => {
    if (settled) return;

    // Any message is activity; reset the idle watchdog before dispatching.
    armStallTimer();

    if (typeof data === 'string') {
      if (data.startsWith(DONE_PREFIX)) {
        const countStr = data.slice(DONE_PREFIX.length);
        // Only accept a pure-digit count; parseInt would silently accept
        // trailing junk (e.g. "5x") and truncate to a valid-looking number.
        if (!/^\d+$/.test(countStr)) {
          fail(new Error('Invalid DONE message: non-numeric chunk count'));
          return;
        }
        void handleDone(parseInt(countStr, 10));
      } else if (data === 'DONE') {
        fail(
          new Error(
            'Unsupported sender: missing chunk count. Ask sender to update and retry.',
          ),
        );
      }
      return;
    }

    if (data instanceof ArrayBuffer) {
      handleChunk(data);
    }
  };

  return { onMessage, done, start: armStallTimer, dispose };
}
