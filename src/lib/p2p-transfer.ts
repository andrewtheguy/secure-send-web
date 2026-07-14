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
 *   - A trailing control string `DONE:<totalChunks>:<totalBytes>`.
 *   - The receiver replies with the control string `ACK` once every chunk has
 *     authenticated and been written to its sink.
 *
 * Neither side materializes the whole file: the sender coalesces a lazy
 * `TransferSource` into `ENCRYPTION_CHUNK_SIZE` pieces, and the receiver writes
 * each decrypted chunk to scratch storage. Sources with unknown output size
 * (streamed ZIPs) are appended in order and finalized from the DONE byte count.
 */

import {
  AES_NONCE_LENGTH,
  AES_TAG_LENGTH,
  decryptChunk,
  ENCRYPTED_CHUNK_OVERHEAD,
  ENCRYPTION_CHUNK_SIZE,
  encryptChunk,
  MAX_MESSAGE_SIZE,
  parseChunkMessage,
} from '@/lib/crypto';
import { P2PConnectionError } from '@/lib/errors';
import type { AppendSink, ReceiveSink } from '@/lib/scratch-sink';
import type { TransferSource } from '@/lib/transfer-source';
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
 * Coerce a caller-supplied stall timeout to a safe value. A zero, negative,
 * NaN or non-finite window would arm a watchdog that fires immediately (or
 * never), so fall back to the default in those cases.
 */
function resolveStallTimeoutMs(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : STALL_TIMEOUT_MS;
}

/**
 * The chunk index is a 2-byte big-endian field on the wire, so a transfer can
 * span at most 65536 chunks (indices 0-65535). Totals beyond this cannot be
 * represented and are rejected before any allocation or processing.
 */
const MAX_CHUNKS = 0x10000; // 65536

/** Minimum spacing between intermediate onProgress emissions. */
const PROGRESS_MIN_INTERVAL_MS = 100;

/**
 * Pace an onProgress callback: intermediate updates are capped to one per
 * interval, and the final update (current === total) always fires. Raw
 * chunk-rate emissions (hundreds per second on a fast link) each restart the
 * progress bar's CSS transition, which flickers on iOS Safari and wastes
 * main-thread time on re-renders.
 */
function paceProgress(
  onProgress: ((current: number, total: number) => void) | undefined,
): (current: number, total: number) => void {
  if (!onProgress) return () => {};
  let lastEmit = -Infinity;
  return (current, total) => {
    const now = performance.now();
    if (current !== total && now - lastEmit < PROGRESS_MIN_INTERVAL_MS) return;
    lastEmit = now;
    onProgress(current, total);
  };
}

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
  /** Progress hint used only when the payload's final size is not yet known. */
  estimatedBytes?: number;
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
  /**
   * Resolves with the sealed plaintext payload from the sink (disk-backed
   * for an OPFS-backed sink), or rejects on any error.
   */
  done: Promise<Blob>;
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
 * Read a lazy payload, coalesce it into `ENCRYPTION_CHUNK_SIZE` chunks, and
 * encrypt/send each chunk immediately. ZIP sources therefore start sending
 * before their later entries have even been read.
 */
export async function sendFileOverDataChannel(
  rtc: WebRTCConnection,
  key: CryptoKey,
  source: TransferSource,
  opts: SendOptions = {},
): Promise<number> {
  const { isCancelled } = opts;
  const reportProgress = paceProgress(opts.onProgress);
  const stallTimeoutMs = resolveStallTimeoutMs(opts.stallTimeoutMs);
  const progressTotal = source.size ?? source.estimatedSize;
  const reader = source.stream().getReader();
  const plainChunk = new Uint8Array(ENCRYPTION_CHUNK_SIZE);
  let plainChunkLength = 0;
  let totalBytes = 0;
  let chunkIndex = 0;

  const sendChunk = async (chunk: Uint8Array) => {
    if (isCancelled?.()) throw new Error('Cancelled');
    if (chunkIndex >= MAX_CHUNKS) {
      throw new Error('File too large for the transfer chunk-index range');
    }
    if (totalBytes + chunk.length > MAX_MESSAGE_SIZE) {
      throw new Error('Generated payload exceeds the transfer size limit');
    }

    const encryptedChunk = await encryptChunk(key, chunk, chunkIndex);
    // A single chunk that cannot be handed off within the idle window means the
    // receiver has stopped draining the channel; abort rather than block here.
    await withStallTimeout(
      rtc.sendWithBackpressure(encryptedChunk),
      stallTimeoutMs,
      `Transfer stalled: receiver stopped accepting data within ${Math.round(stallTimeoutMs / 1000)}s`,
    );
    chunkIndex++;
    totalBytes += chunk.length;
    reportProgress(totalBytes, progressTotal);
  };

  let completed = false;
  try {
    while (true) {
      if (isCancelled?.()) throw new Error('Cancelled');
      const { done, value } = await reader.read();
      if (done) break;

      let offset = 0;
      while (offset < value.length) {
        const copied = Math.min(
          ENCRYPTION_CHUNK_SIZE - plainChunkLength,
          value.length - offset,
        );
        plainChunk.set(
          value.subarray(offset, offset + copied),
          plainChunkLength,
        );
        plainChunkLength += copied;
        offset += copied;
        if (plainChunkLength === ENCRYPTION_CHUNK_SIZE) {
          await sendChunk(plainChunk);
          plainChunkLength = 0;
        }
      }
    }

    if (plainChunkLength > 0) {
      await sendChunk(plainChunk.slice(0, plainChunkLength));
    }
    if (source.size !== null && totalBytes !== source.size) {
      throw new Error(
        `Transfer source size changed: expected ${source.size} bytes, got ${totalBytes}`,
      );
    }
    completed = true;
  } finally {
    if (!completed) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }

  // The byte count authenticates the final length for sources whose compressed
  // output was not knowable during signaling.
  rtc.send(`${DONE_PREFIX}${chunkIndex}:${totalBytes}`);
  reportProgress(totalBytes, totalBytes);

  await waitForAckMessage(rtc);
  return totalBytes;
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

type DataChannelSink = ReceiveSink | AppendSink;

function isAppendSink(sink: DataChannelSink): sink is AppendSink {
  return 'append' in sink;
}

/**
 * Create a streaming receiver. `totalBytes` is null when the sender is
 * producing a ZIP whose final compressed length is not known during signaling.
 *
 * Exact-size payloads retain positional writes and may arrive out of order.
 * Unknown-size payloads use the data channel's reliable ordering and append to
 * an adaptive sink. In both modes DONE supplies a final authenticated chunk
 * count and byte count before the sink is sealed.
 */
export function createDataChannelReceiver(
  key: CryptoKey,
  totalBytes: number | null,
  sink: DataChannelSink,
  opts: ReceiverOptions = {},
): DataChannelReceiver {
  const reportProgress = paceProgress(opts.onProgress);
  const stallTimeoutMs = resolveStallTimeoutMs(opts.stallTimeoutMs);
  const sizeKnown = totalBytes !== null;
  const progressTotal = sizeKnown ? totalBytes : (opts.estimatedBytes ?? 0);

  if (
    totalBytes !== null &&
    (!Number.isInteger(totalBytes) ||
      totalBytes < 0 ||
      totalBytes > MAX_MESSAGE_SIZE)
  ) {
    throw new Error('Invalid transfer size');
  }
  if (sizeKnown && isAppendSink(sink)) {
    throw new Error('Exact-size transfers require a positional receive sink');
  }
  if (!sizeKnown && !isAppendSink(sink)) {
    throw new Error('Unknown-size transfers require an append sink');
  }

  const expectedChunks = sizeKnown
    ? Math.ceil(totalBytes / ENCRYPTION_CHUNK_SIZE)
    : null;
  if (expectedChunks !== null && expectedChunks > MAX_CHUNKS) {
    throw new Error('Transfer size exceeds the supported chunk-index range');
  }

  const expectedEncryptedBytes = sizeKnown
    ? totalBytes + expectedChunks! * ENCRYPTED_CHUNK_OVERHEAD
    : null;

  const receivedIndices = new Set<number>();
  const pending = new Set<Promise<void>>();
  let receivedEncryptedBytes = 0;
  let claimedPlaintextBytes = 0;
  let totalDecryptedBytes = 0;
  let previousUnknownChunkLength: number | null = null;
  let appendChain = Promise.resolve();
  let settled = false;

  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  const clearStallTimer = () => {
    if (stallTimer !== null) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
  };

  let resolveDone!: (value: Blob) => void;
  let rejectDone!: (error: Error) => void;
  const done = new Promise<Blob>((resolve, reject) => {
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
    let chunkIndex: number;
    let encryptedData: Uint8Array;
    let expectedPlaintextLength: number;
    let writePosition: number | null = null;

    try {
      ({ chunkIndex, encryptedData } = parseChunkMessage(data));
      if (receivedIndices.has(chunkIndex)) {
        throw new Error(`Duplicate chunk index: ${chunkIndex}`);
      }

      if (sizeKnown) {
        if (chunkIndex >= expectedChunks!) {
          throw new Error(`Chunk index out of range: ${chunkIndex}`);
        }
        writePosition = chunkIndex * ENCRYPTION_CHUNK_SIZE;
        expectedPlaintextLength =
          chunkIndex === expectedChunks! - 1
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
        if (receivedEncryptedBytes > expectedEncryptedBytes!) {
          throw new Error('Transfer exceeds advertised size');
        }
      } else {
        // RTCDataChannel is reliable and ordered by default. Requiring that
        // order lets the receiver append without holding or seeking chunks.
        if (chunkIndex !== receivedIndices.size || chunkIndex >= MAX_CHUNKS) {
          throw new Error(`Unexpected streamed chunk index: ${chunkIndex}`);
        }
        expectedPlaintextLength =
          encryptedData.length - AES_NONCE_LENGTH - AES_TAG_LENGTH;
        if (
          expectedPlaintextLength <= 0 ||
          expectedPlaintextLength > ENCRYPTION_CHUNK_SIZE
        ) {
          throw new Error(`Invalid streamed chunk ${chunkIndex} length`);
        }
        if (
          previousUnknownChunkLength !== null &&
          previousUnknownChunkLength !== ENCRYPTION_CHUNK_SIZE
        ) {
          throw new Error('Only the final streamed chunk may be short');
        }
        if (
          claimedPlaintextBytes + expectedPlaintextLength >
          MAX_MESSAGE_SIZE
        ) {
          throw new Error('Transfer exceeds the supported size limit');
        }
        previousUnknownChunkLength = expectedPlaintextLength;
        claimedPlaintextBytes += expectedPlaintextLength;
      }

      // Claim the index before decrypting so duplicates and an in-order DONE
      // cannot race the asynchronous crypto operation.
      receivedIndices.add(chunkIndex);
    } catch (error) {
      fail(error instanceof Error ? error : new Error('Invalid data chunk'));
      return;
    }

    const processChunk = async () => {
      const decryptedChunk = await decryptChunk(key, encryptedData, chunkIndex);
      if (settled) return;
      if (decryptedChunk.length !== expectedPlaintextLength) {
        throw new Error(
          `Invalid chunk ${chunkIndex} length: expected ${expectedPlaintextLength}, got ${decryptedChunk.length}`,
        );
      }

      if (sizeKnown) {
        if (writePosition! + decryptedChunk.length > totalBytes) {
          throw new Error(`Chunk ${chunkIndex} exceeds expected file size`);
        }
        await (sink as ReceiveSink).write(writePosition!, decryptedChunk);
      } else {
        await (sink as AppendSink).append(decryptedChunk);
      }
      if (settled) return;
      totalDecryptedBytes += decryptedChunk.length;

      reportProgress(totalDecryptedBytes, progressTotal);
    };

    // Appends must follow wire order even if Web Crypto resolves operations at
    // different times. Exact-size positional writes remain parallel.
    let work: Promise<void>;
    if (sizeKnown) {
      work = processChunk();
    } else {
      appendChain = appendChain.then(processChunk);
      work = appendChain;
    }
    const promise = work.catch((error: unknown) => {
      fail(
        error instanceof Error ? error : new Error('Failed to receive chunk'),
      );
    });

    pending.add(promise);
    void promise.finally(() => pending.delete(promise));
  };

  const handleDone = async (count: number, finalBytes: number) => {
    if (count !== receivedIndices.size) {
      fail(
        new Error(
          `Invalid DONE message: received ${receivedIndices.size} chunks, got ${count}`,
        ),
      );
      return;
    }
    if (sizeKnown && (count !== expectedChunks || finalBytes !== totalBytes)) {
      fail(
        new Error('Invalid DONE message: final size does not match metadata'),
      );
      return;
    }
    if (!sizeKnown && finalBytes !== claimedPlaintextBytes) {
      fail(new Error('Invalid DONE message: final size does not match chunks'));
      return;
    }

    if (pending.size > 0) {
      await Promise.allSettled(Array.from(pending));
    }
    if (settled) return;

    if (receivedIndices.size !== count || totalDecryptedBytes !== finalBytes) {
      fail(
        new Error(
          `Incomplete transfer: got ${totalDecryptedBytes} bytes, expected ${finalBytes}`,
        ),
      );
      return;
    }

    let payload: Blob;
    try {
      payload = await sink.finish();
    } catch (error) {
      fail(
        error instanceof Error
          ? error
          : new Error('Failed to finalize received file'),
      );
      return;
    }
    // A stall timeout or dispose() during the flush already settled `done`.
    if (settled) return;

    settled = true;
    clearStallTimer();
    reportProgress(finalBytes, finalBytes);
    resolveDone(payload);
  };

  const onMessage = (data: string | ArrayBuffer) => {
    if (settled) return;

    // Any message is activity; reset the idle watchdog before dispatching.
    armStallTimer();

    if (typeof data === 'string') {
      if (data.startsWith(DONE_PREFIX)) {
        const match = /^DONE:(\d+):(\d+)$/.exec(data);
        if (!match) {
          fail(new Error('Invalid DONE message'));
          return;
        }
        const count = Number(match[1]);
        const finalBytes = Number(match[2]);
        if (
          !Number.isSafeInteger(count) ||
          count < 0 ||
          count > MAX_CHUNKS ||
          !Number.isSafeInteger(finalBytes) ||
          finalBytes < 0 ||
          finalBytes > MAX_MESSAGE_SIZE
        ) {
          fail(new Error('Invalid DONE message values'));
          return;
        }
        void handleDone(count, finalBytes);
      }
      return;
    }

    if (data instanceof ArrayBuffer) {
      handleChunk(data);
    }
  };

  return { onMessage, done, start: armStallTimer, dispose };
}
