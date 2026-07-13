import { Zip, ZipDeflate } from 'fflate';
import { type AppendSink, createAppendSink } from './scratch-sink';

/**
 * Check if folder selection is supported by the browser
 */
export const supportsFolderSelection =
  typeof HTMLInputElement !== 'undefined' &&
  'webkitdirectory' in HTMLInputElement.prototype;

export interface CompressedArchive {
  /**
   * The generated ZIP. When the selected files total more than
   * `MEMORY_SINK_MAX_BYTES` it is backed by an OPFS scratch file, so neither
   * archiving nor sending materializes it in memory; smaller selections are
   * buffered in memory.
   */
  file: File;
  /** Release the scratch storage backing `file`; it is unreadable afterwards. */
  discard: () => Promise<void>;
}

/**
 * Stream files into a ZIP archive without materializing inputs or output.
 * Works with both folder selection (webkitdirectory) and multi-file selection.
 *
 * Each input file is read as a stream and deflated chunk by chunk into an
 * append sink (OPFS-backed for selections over 100MB), so peak memory for
 * large archives stays O(chunk).
 *
 * @param files - Selected files; `webkitRelativePath` (when set) becomes the
 *   entry path, preserving folder structure
 * @param archiveName - Name for the ZIP file (without .zip extension)
 */
export async function compressFilesToZip(
  files: readonly File[],
  archiveName: string,
): Promise<CompressedArchive> {
  // The input total is a heuristic stand-in for the unknown archive size, not
  // a cap on it: deflate output exceeds incompressible input only marginally,
  // so a selection at or below the memory-sink threshold cannot produce an
  // archive large enough to cause memory pressure, and the memory sink accepts
  // whatever the archive ends up being.
  const totalInputBytes = files.reduce((total, file) => total + file.size, 0);
  const sink = await createAppendSink(totalInputBytes);
  try {
    await streamZipToSink(files, sink);
    const payload = await sink.finish();
    return {
      // Wrapping the (possibly disk-backed) payload in a File is a zero-copy
      // relabel: BlobParts are referenced, not duplicated.
      file: new File([payload], `${archiveName}.zip`, {
        type: 'application/zip',
      }),
      discard: () => sink.discard(),
    };
  } catch (error) {
    await sink.discard();
    throw error;
  }
}

async function streamZipToSink(
  files: readonly File[],
  sink: AppendSink,
): Promise<void> {
  let failure: Error | null = null;
  let pending: Promise<void> = Promise.resolve();

  const ended = new Promise<void>((resolve, reject) => {
    const zip = new Zip((err, chunk, final) => {
      if (failure) return;
      if (err) {
        failure = err;
        reject(err);
        return;
      }
      pending = pending
        .then(() => sink.append(chunk))
        .catch((appendError: unknown) => {
          if (failure) return;
          failure =
            appendError instanceof Error
              ? appendError
              : new Error('Failed to write archive data');
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
        try {
          while (true) {
            if (failure) return;
            const { done, value } = await reader.read();
            if (done) {
              entry.push(new Uint8Array(0), true);
              break;
            }
            entry.push(value);
            // Backpressure: let queued archive output reach the sink before
            // producing more, so memory stays bounded by in-flight chunks.
            await pending;
          }
        } finally {
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
