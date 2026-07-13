import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { compressFilesToZip } from './folder-utils';

async function unzipArchive(file: File): Promise<Record<string, Uint8Array>> {
  return unzipSync(new Uint8Array(await file.arrayBuffer()));
}

describe('compressFilesToZip', () => {
  it('streams files into a valid ZIP that round-trips', async () => {
    // Large enough to span multiple stream chunks.
    const big = new Uint8Array(300 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = (i * 7 + 3) % 256;
    const files = [
      new File(['hello world'], 'hello.txt', { type: 'text/plain' }),
      new File([big as BlobPart], 'big.bin'),
    ];

    const archive = await compressFilesToZip(files, 'bundle');
    expect(archive.file.name).toBe('bundle.zip');
    expect(archive.file.type).toBe('application/zip');

    const entries = await unzipArchive(archive.file);
    expect(Object.keys(entries).sort()).toEqual(['big.bin', 'hello.txt']);
    expect(new TextDecoder().decode(entries['hello.txt'])).toBe('hello world');
    expect(entries['big.bin']).toEqual(big);

    await archive.discard();
  });

  it('uses webkitRelativePath as the entry path when present', async () => {
    const file = new File(['nested'], 'a.txt');
    Object.defineProperty(file, 'webkitRelativePath', {
      value: 'folder/sub/a.txt',
    });

    const archive = await compressFilesToZip([file], 'folder');
    const entries = await unzipArchive(archive.file);
    expect(Object.keys(entries)).toEqual(['folder/sub/a.txt']);

    await archive.discard();
  });

  it('produces a valid empty archive for no files', async () => {
    const archive = await compressFilesToZip([], 'empty');
    const entries = await unzipArchive(archive.file);
    expect(Object.keys(entries)).toEqual([]);

    await archive.discard();
  });
});
