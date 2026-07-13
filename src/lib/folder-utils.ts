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
   * The generated ZIP, backed by an OPFS scratch file, so neither archiving
   * nor sending materializes it in memory.
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
 * OPFS-backed append sink, so peak memory stays O(chunk) regardless of
 * archive size.
 *
 * @param files - Selected files; `webkitRelativePath` (when set) becomes the
 *   entry path, preserving folder structure
 * @param archiveName - Name for the ZIP file (without .zip extension)
 */
export async function compressFilesToZip(
  files: readonly File[],
  archiveName: string,
): Promise<CompressedArchive> {
  const sink = await createAppendSink();
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
 * Extract folder name from FileList (for folder selection)
 */
export function getFolderName(files: FileList): string {
  if (files.length === 0) return 'archive';
  // webkitRelativePath is "folderName/subfolder/file.txt"
  const firstPath = files[0].webkitRelativePath;
  if (firstPath) {
    return firstPath.split('/')[0];
  }
  return 'archive';
}

/**
 * Calculate total size of all files
 */
export function getTotalSize(files: FileList): number {
  let total = 0;
  for (let i = 0; i < files.length; i++) {
    total += files[i].size;
  }
  return total;
}
