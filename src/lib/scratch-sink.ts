/**
 * OPFS-backed scratch storage for in-flight transfers.
 *
 * Two sink shapes are built on the same scratch machinery:
 * - `ReceiveSink`: positional writes into a preallocated file. Decrypted
 *   chunks land at their byte offset while a transfer is received, so
 *   receiving needs O(chunk) memory and the download streams from disk.
 * - `AppendSink`: sequential writes. The streaming ZIP writer appends archive
 *   output while a multi-file/folder send is packaged, so archiving needs
 *   O(chunk) memory and the send streams from disk.
 *
 * OPFS (`FileSystemFileHandle.createWritable`) is required — every current
 * major browser ships it (Chrome/Edge 86+, Firefox 111+, Safari 26+). Sink
 * creation rejects with a user-facing error on anything older.
 *
 * Privacy note: a scratch file holds plaintext on disk for the lifetime of
 * the sink. Every path that abandons a transfer must call `discard()`, and
 * `sweepTransferScratch` removes files that crashed or closed sessions left
 * behind.
 */

export interface ReceiveSink {
  /** Write plaintext bytes at a byte offset. Rejects on storage failure. */
  write(position: number, bytes: Uint8Array): Promise<void>;
  /**
   * Flush everything and seal the payload. The returned Blob is disk-backed
   * and stays readable until `discard()`. No writes are accepted afterwards.
   */
  finish(): Promise<Blob>;
  /**
   * Release all storage backing this sink, including a finished payload's
   * scratch file (any Blob from `finish()` becomes unreadable). Safe to call
   * at any point and more than once.
   */
  discard(): Promise<void>;
}

/** Sequential variant of `ReceiveSink` for output of unknown final size. */
export interface AppendSink {
  /** Append bytes at the end of the payload. Rejects on storage failure. */
  append(bytes: Uint8Array): Promise<void>;
  /** Same contract as `ReceiveSink.finish`. */
  finish(): Promise<Blob>;
  /** Same contract as `ReceiveSink.discard`. */
  discard(): Promise<void>;
}

// lib.dom does not yet declare FileSystemDirectoryHandle async iteration.
interface DirectoryHandleWithIteration extends FileSystemDirectoryHandle {
  keys(): AsyncIterableIterator<string>;
}

const SCRATCH_DIR_NAME = 'transfer-scratch';

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

function requireOpfs(): void {
  if (!opfsSupported()) {
    throw new Error(
      'This browser cannot store transfers on disk (no OPFS support). Update to a current version of Chrome, Edge, Firefox, or Safari.',
    );
  }
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
export async function sweepTransferScratch(): Promise<void> {
  if (!opfsSupported()) return;
  try {
    const dir = (await openScratchDir()) as DirectoryHandleWithIteration;
    for await (const name of dir.keys()) {
      if (activeScratchNames.has(name)) continue;
      await dir.removeEntry(name).catch(() => {});
    }
  } catch {
    // Sweeping must never break transfers.
  }
}

interface ScratchFile {
  handle: FileSystemFileHandle;
  writable: FileSystemWritableFileStream;
  /** Remove the scratch entry and release its name. */
  remove(): Promise<void>;
}

async function createScratchFile(): Promise<ScratchFile> {
  const dir = await openScratchDir();
  const name = `${crypto.randomUUID()}.part`;
  // Claim the name before the file exists so a concurrent sweep never deletes it.
  activeScratchNames.add(name);
  const remove = async () => {
    await dir.removeEntry(name).catch(() => {});
    activeScratchNames.delete(name);
  };
  try {
    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    return { handle, writable, remove };
  } catch (error) {
    await remove();
    throw error;
  }
}

type OpQueue = <T>(op: () => Promise<T>) => Promise<T>;

// FileSystemWritableFileStream handles one operation at a time; serialize
// all access so concurrent callers cannot interleave stream calls.
function createOpQueue(): OpQueue {
  let chain: Promise<unknown> = Promise.resolve();
  return (op) => {
    const run = chain.then(op);
    chain = run.catch(() => {});
    return run;
  };
}

function scratchLifecycle(scratch: ScratchFile, enqueue: OpQueue) {
  let discarded = false;
  return {
    finish(): Promise<Blob> {
      return enqueue(async () => {
        await scratch.writable.close();
        return scratch.handle.getFile();
      });
    },
    async discard(): Promise<void> {
      if (discarded) return;
      discarded = true;
      // abort() rejects once the stream is already closed (after finish);
      // either way the scratch entry itself is removed below.
      await enqueue(() => scratch.writable.abort()).catch(() => {});
      await scratch.remove();
    },
  };
}

/**
 * Create the positional sink for a transfer of `totalBytes` plaintext bytes.
 * Rejects when OPFS is unsupported or fails (e.g. over quota).
 */
export async function createReceiveSink(
  totalBytes: number,
): Promise<ReceiveSink> {
  requireOpfs();
  void sweepTransferScratch();
  const scratch = await createScratchFile();
  try {
    // Size the file up front so an over-quota transfer fails before any data flows.
    await scratch.writable.truncate(totalBytes);
  } catch (error) {
    await scratch.writable.abort().catch(() => {});
    await scratch.remove();
    throw error;
  }
  const enqueue = createOpQueue();
  return {
    write(position, bytes) {
      return enqueue(() =>
        scratch.writable.write({
          type: 'write',
          position,
          data: bytes as BufferSource,
        }),
      );
    },
    ...scratchLifecycle(scratch, enqueue),
  };
}

/**
 * Create the sequential sink for output of unknown final size. Rejects when
 * OPFS is unsupported or fails.
 */
export async function createAppendSink(): Promise<AppendSink> {
  requireOpfs();
  void sweepTransferScratch();
  const scratch = await createScratchFile();
  const enqueue = createOpQueue();
  return {
    append(bytes) {
      // Copy before queueing: the write may run after the producer has moved
      // on, and the sink must not depend on the caller's buffer staying put.
      const data = bytes.slice();
      return enqueue(() => scratch.writable.write(data as BufferSource));
    },
    ...scratchLifecycle(scratch, enqueue),
  };
}
