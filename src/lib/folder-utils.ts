import { Zip, ZipDeflate } from 'fflate';
import type { TransferSource } from './transfer-source';

/**
 * Check if folder selection is supported by the browser
 */
export const supportsFolderSelection =
  typeof HTMLInputElement !== 'undefined' &&
  'webkitdirectory' in HTMLInputElement.prototype;

/**
 * Create a ZIP transfer source without generating the archive up front.
 * Works with both folder selection (webkitdirectory) and multi-file selection.
 *
 * Opening the source starts fflate and each ZIP output chunk is handed directly
 * to the transfer consumer. The TransformStream writer supplies backpressure,
 * so neither the selected files nor the generated archive are materialized.
 *
 * @param files - Selected files; `webkitRelativePath` (when set) becomes the
 *   entry path, preserving folder structure
 * @param archiveName - Name for the ZIP file (without .zip extension)
 */
export function createZipTransferSource(
  files: readonly File[],
  archiveName: string,
): TransferSource {
  const totalInputBytes = files.reduce((total, file) => total + file.size, 0);
  return {
    name: `${archiveName}.zip`,
    type: 'application/zip',
    // Deflate output length is not known until fflate emits the central
    // directory. The input total remains useful as a progress/storage hint.
    size: null,
    estimatedSize: totalInputBytes,
    stream: () => createZipStream(files),
  };
}

function createZipStream(files: readonly File[]): ReadableStream<Uint8Array> {
  const transform = new TransformStream<Uint8Array, Uint8Array>();
  const writer = transform.writable.getWriter();

  void writeZip(files, writer).then(
    () => writer.close(),
    (error: unknown) => writer.abort(error).catch(() => {}),
  );

  return transform.readable;
}

async function writeZip(
  files: readonly File[],
  writer: WritableStreamDefaultWriter<Uint8Array>,
): Promise<void> {
  let failure: Error | null = null;
  let pending: Promise<void> = Promise.resolve();
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  const ended = new Promise<void>((resolve, reject) => {
    // Cancelling the transfer's reader errors the TransformStream writable.
    // Propagate that cancellation into whichever picker file is currently
    // being read so ZIP production cannot remain blocked on file I/O.
    void writer.closed.catch((streamError: unknown) => {
      if (failure) return;
      failure =
        streamError instanceof Error
          ? streamError
          : new Error('Archive stream cancelled');
      void activeReader?.cancel(failure).catch(() => {});
      reject(failure);
    });

    const zip = new Zip((err, chunk, final) => {
      if (failure) return;
      if (err) {
        failure = err;
        reject(err);
        return;
      }
      pending = pending
        // Do not retain a buffer owned by fflate after its callback returns.
        .then(() => writer.write(chunk.slice()))
        .catch((appendError: unknown) => {
          if (failure) return;
          failure =
            appendError instanceof Error
              ? appendError
              : new Error('Failed to stream archive data');
          reject(failure);
        });
      if (final) {
        void pending.then(() => {
          if (!failure) resolve();
        });
      }
    });

    void (async () => {
      for (const file of files) {
        // webkitRelativePath is set for folder selection, empty for multi-file
        const path = file.webkitRelativePath || file.name;
        const entry = new ZipDeflate(path);
        entry.mtime = file.lastModified;
        zip.add(entry);

        const reader = file.stream().getReader();
        activeReader = reader;
        try {
          while (true) {
            if (failure) return;
            const { done, value } = await reader.read();
            if (done) {
              entry.push(new Uint8Array(0), true);
              break;
            }
            entry.push(value);
            // Backpressure: let queued archive output reach the consumer before
            // producing more, so memory stays bounded by in-flight chunks.
            await pending;
          }
        } finally {
          activeReader = null;
          reader.releaseLock();
        }
      }
      zip.end();
    })().catch((readError: unknown) => {
      if (failure) return;
      failure =
        readError instanceof Error
          ? readError
          : new Error('Failed to read file for archiving');
      reject(failure);
    });
  });

  await ended;
}

/**
 * Local-time `yyyymmddhhmmss` stamp appended to archive names, so repeated
 * sends of the same selection don't all arrive under one file name.
 */
export function archiveTimestamp(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/**
 * Base name for the ZIP of a mixed selection: the folder name when every file
 * came from the same selected folder (webkitRelativePath is
 * "folderName/subfolder/file.txt"), otherwise 'files'.
 */
export function getArchiveBaseName(files: readonly File[]): string {
  if (files.length === 0) return 'files';
  const topFolder = files[0].webkitRelativePath.split('/')[0];
  if (
    topFolder &&
    files.every((f) => f.webkitRelativePath.split('/')[0] === topFolder)
  ) {
    return topFolder;
  }
  return 'files';
}
