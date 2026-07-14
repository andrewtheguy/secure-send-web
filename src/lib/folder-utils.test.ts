import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { archiveTimestamp, createZipTransferSource } from './folder-utils';

async function readAll(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

describe('createZipTransferSource', () => {
  it('streams files into a valid ZIP that round-trips', async () => {
    // Large enough to span multiple stream chunks.
    const big = new Uint8Array(300 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = (i * 7 + 3) % 256;
    const files = [
      new File(['hello world'], 'hello.txt', { type: 'text/plain' }),
      new File([big as BlobPart], 'big.bin'),
    ];

    const source = createZipTransferSource(files, 'bundle');
    expect(source.name).toBe('bundle.zip');
    expect(source.type).toBe('application/zip');
    expect(source.size).toBeNull();
    expect(source.estimatedSize).toBe(11 + big.length);

    const entries = unzipSync(await readAll(source.stream()));
    expect(Object.keys(entries).sort()).toEqual(['big.bin', 'hello.txt']);
    expect(new TextDecoder().decode(entries['hello.txt'])).toBe('hello world');
    expect(entries['big.bin']).toEqual(big);
  });

  it('emits ZIP bytes before later file data is available', async () => {
    const first = new File(['first'], 'first.txt');
    const second = new File(['second'], 'second.txt');
    let provideSecond!: () => void;
    const secondCanBeRead = new Promise<void>((resolve) => {
      provideSecond = resolve;
    });
    let secondReadStarted = false;
    Object.defineProperty(second, 'stream', {
      value: () =>
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            secondReadStarted = true;
            await secondCanBeRead;
            controller.enqueue(new TextEncoder().encode('second'));
            controller.close();
          },
        }),
    });

    const reader = createZipTransferSource([first, second], 'bundle')
      .stream()
      .getReader();
    const firstOutput = await reader.read();

    expect(firstOutput.done).toBe(false);
    expect(firstOutput.value?.length).toBeGreaterThan(0);
    expect(secondReadStarted).toBe(false);
    provideSecond();
    await reader.cancel();
  });

  it('keeps entry output intact when the consumer is backpressured', async () => {
    const expected: Record<string, Uint8Array> = {};
    const files = Array.from({ length: 80 }, (_, index) => {
      // Small, highly compressible entries exercise the final-output path that
      // runs immediately before the next entry is added.
      const data = new Uint8Array(4096 + (index % 17) * 37).fill(index & 0xff);
      const name = `small-${index}.bin`;
      expected[name] = data;
      return new File([data as BlobPart], name);
    });

    const reader = createZipTransferSource(files, 'many-small-files')
      .stream()
      .getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
      // Keep the writer backpressured across fflate callback turns.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const archive = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      archive.set(chunk, offset);
      offset += chunk.length;
    }
    const entries = unzipSync(archive);
    for (const [name, data] of Object.entries(expected)) {
      expect(entries[name]).toEqual(data);
    }
  });

  it('uses webkitRelativePath as the entry path when present', async () => {
    const file = new File(['nested'], 'a.txt');
    Object.defineProperty(file, 'webkitRelativePath', {
      value: 'folder/sub/a.txt',
    });

    const source = createZipTransferSource([file], 'folder');
    const entries = unzipSync(await readAll(source.stream()));
    expect(Object.keys(entries)).toEqual(['folder/sub/a.txt']);
  });

  it('produces a valid empty archive for no files', async () => {
    const source = createZipTransferSource([], 'empty');
    const entries = unzipSync(await readAll(source.stream()));
    expect(Object.keys(entries)).toEqual([]);
  });
});

describe('archiveTimestamp', () => {
  it('formats a local-time yyyymmddhhmmss stamp', () => {
    const stamp = archiveTimestamp(new Date(2026, 6, 13, 9, 5, 7));
    expect(stamp).toBe('20260713090507');
  });

  it('is 14 digits for the current time', () => {
    expect(archiveTimestamp()).toMatch(/^\d{14}$/);
  });
});
