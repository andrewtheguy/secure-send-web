/**
 * Receive-side chunk sinks: where decrypted chunks land while a transfer is
 * in flight.
 *
 * The OPFS sink writes each chunk straight to a scratch file in the
 * origin-private file system, so receiving needs O(chunk) memory instead of
 * O(file) and the final download streams from disk. The memory sink is the
 * fallback for browsers without `FileSystemFileHandle.createWritable` and
 * keeps the previous preallocated-buffer behavior.
 *
 * Privacy note: an OPFS scratch file holds decrypted plaintext on disk for
 * the lifetime of the sink. Every path that abandons a transfer must call
 * `discard()`, and `sweepReceiveScratch` removes files that crashed or closed
 * sessions left behind.
 */

export interface ReceiveSink {
  /** 'opfs' when chunks go to disk, 'memory' for the in-RAM fallback. */
  readonly kind: 'opfs' | 'memory';
  /** Write plaintext bytes at a byte offset. Rejects on storage failure. */
  write(position: number, bytes: Uint8Array): Promise<void>;
  /**
   * Flush everything and seal the payload. The returned Blob is disk-backed
   * for the OPFS sink and stays readable until `discard()`. No writes are
   * accepted afterwards.
   */
  finish(): Promise<Blob>;
  /**
   * Release all storage backing this sink, including a finished payload's
   * scratch file (any Blob from `finish()` becomes unreadable). Safe to call
   * at any point and more than once.
   */
  discard(): Promise<void>;
}

// lib.dom does not yet declare FileSystemDirectoryHandle async iteration.
interface DirectoryHandleWithIteration extends FileSystemDirectoryHandle {
  keys(): AsyncIterableIterator<string>;
}

const SCRATCH_DIR_NAME = 'receive-scratch';

/** Scratch files owned by a live sink in this session; the sweeper skips them. */
const activeScratchNames = new Set<string>();

function opfsSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.storage?.getDirectory === 'function' &&
    typeof FileSystemFileHandle !== 'undefined' &&
    'createWritable' in FileSystemFileHandle.prototype
  );
}

async function openScratchDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(SCRATCH_DIR_NAME, { create: true });
}

/**
 * Best-effort removal of scratch files no live sink owns. Run on boot and
 * before each transfer so plaintext left behind by a crashed or closed
 * session never outlives the next visit.
 */
export async function sweepReceiveScratch(): Promise<void> {
  if (!opfsSupported()) return;
  try {
    const dir = (await openScratchDir()) as DirectoryHandleWithIteration;
    for await (const name of dir.keys()) {
      if (activeScratchNames.has(name)) continue;
      await dir.removeEntry(name).catch(() => {});
    }
  } catch {
    // Sweeping must never break receiving.
  }
}

async function createOpfsSink(totalBytes: number): Promise<ReceiveSink> {
  const dir = await openScratchDir();
  const name = `${crypto.randomUUID()}.part`;
  // Claim the name before the file exists so a concurrent sweep never deletes it.
  activeScratchNames.add(name);

  let handle: FileSystemFileHandle;
  let writable: FileSystemWritableFileStream;
  try {
    handle = await dir.getFileHandle(name, { create: true });
    writable = await handle.createWritable();
    // Size the file up front so an over-quota transfer fails before any data flows.
    await writable.truncate(totalBytes);
  } catch (error) {
    activeScratchNames.delete(name);
    await dir.removeEntry(name).catch(() => {});
    throw error;
  }

  // FileSystemWritableFileStream handles one operation at a time; serialize
  // all access so concurrent chunk decrypts cannot interleave stream calls.
  let chain: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(op: () => Promise<T>): Promise<T> => {
    const run = chain.then(op);
    chain = run.catch(() => {});
    return run;
  };

  let discarded = false;

  return {
    kind: 'opfs',
    write(position, bytes) {
      return enqueue(() =>
        writable.write({
          type: 'write',
          position,
          data: bytes as BufferSource,
        }),
      );
    },
    finish() {
      return enqueue(async () => {
        await writable.close();
        return handle.getFile();
      });
    },
    async discard() {
      if (discarded) return;
      discarded = true;
      // abort() rejects once the stream is already closed (after finish);
      // either way the scratch entry itself is removed below.
      await enqueue(() => writable.abort()).catch(() => {});
      await dir.removeEntry(name).catch(() => {});
      activeScratchNames.delete(name);
    },
  };
}

function createMemorySink(totalBytes: number): ReceiveSink {
  let buffer: Uint8Array | null = new Uint8Array(totalBytes);
  return {
    kind: 'memory',
    write(position, bytes) {
      if (!buffer) return Promise.reject(new Error('Receive sink discarded'));
      buffer.set(bytes, position);
      return Promise.resolve();
    },
    finish() {
      if (!buffer) return Promise.reject(new Error('Receive sink discarded'));
      const blob = new Blob([buffer as BlobPart]);
      buffer = null;
      return Promise.resolve(blob);
    },
    discard() {
      buffer = null;
      return Promise.resolve();
    },
  };
}

/**
 * Create the best available sink for a transfer of `totalBytes` plaintext
 * bytes. Prefers OPFS scratch storage; falls back to a preallocated in-memory
 * buffer when OPFS is unsupported or fails (e.g. over quota).
 */
export async function createReceiveSink(
  totalBytes: number,
): Promise<ReceiveSink> {
  if (opfsSupported()) {
    void sweepReceiveScratch();
    try {
      return await createOpfsSink(totalBytes);
    } catch (error) {
      console.warn(
        'OPFS scratch unavailable; falling back to in-memory receive buffer',
        error,
      );
    }
  }
  return createMemorySink(totalBytes);
}
