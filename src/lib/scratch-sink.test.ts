import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installOpfsMock, type OpfsMock } from '../test/opfs-mock';
import {
  createAppendSink,
  createReceiveSink,
  sweepTransferScratch,
} from './scratch-sink';

let opfs: OpfsMock;

beforeAll(() => {
  opfs = installOpfsMock();
});

afterAll(() => {
  opfs.uninstall();
});

async function scratchDirNames(): Promise<string[]> {
  const dir = await opfs.root.getDirectoryHandle('transfer-scratch', {
    create: true,
  });
  const names: string[] = [];
  for await (const name of dir.keys()) names.push(name);
  return names;
}

describe('createReceiveSink', () => {
  it('assembles out-of-order positional writes into the payload', async () => {
    const sink = await createReceiveSink(8);
    await sink.write(4, new Uint8Array([5, 6, 7, 8]));
    await sink.write(0, new Uint8Array([1, 2, 3, 4]));
    const blob = await sink.finish();
    expect(blob.size).toBe(8);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    );
    await sink.discard();
  });

  it('produces an empty payload for a zero-byte transfer', async () => {
    const sink = await createReceiveSink(0);
    const blob = await sink.finish();
    expect(blob.size).toBe(0);
    await sink.discard();
  });

  it('preallocates the advertised size', async () => {
    const sink = await createReceiveSink(6);
    await sink.write(0, new Uint8Array([1, 2]));
    const blob = await sink.finish();
    // Unwritten tail stays zero-filled at the advertised length.
    expect(blob.size).toBe(6);
    await sink.discard();
  });

  it('rejects writes and finish after discard', async () => {
    const sink = await createReceiveSink(4);
    await sink.discard();
    await expect(sink.write(0, new Uint8Array([1]))).rejects.toThrow();
    await expect(sink.finish()).rejects.toThrow();
  });

  it('rejects writes after finish', async () => {
    const sink = await createReceiveSink(1);
    await sink.write(0, new Uint8Array([9]));
    await sink.finish();
    await expect(sink.write(0, new Uint8Array([1]))).rejects.toThrow();
    await sink.discard();
  });

  it('tolerates repeated discard calls and removes the scratch entry', async () => {
    const sink = await createReceiveSink(4);
    expect(await scratchDirNames()).toHaveLength(1);
    await sink.discard();
    await expect(sink.discard()).resolves.toBeUndefined();
    expect(await scratchDirNames()).toHaveLength(0);
  });

  it('rejects when OPFS is unavailable', async () => {
    opfs.uninstall();
    try {
      await expect(createReceiveSink(4)).rejects.toThrow('OPFS');
      await expect(createAppendSink()).rejects.toThrow('OPFS');
    } finally {
      opfs = installOpfsMock();
    }
  });
});

describe('createAppendSink', () => {
  it('concatenates appended chunks into the payload', async () => {
    const sink = await createAppendSink();
    await sink.append(new Uint8Array([1, 2, 3]));
    await sink.append(new Uint8Array([4, 5]));
    const blob = await sink.finish();
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3, 4, 5]),
    );
    await sink.discard();
  });

  it('does not retain a reference to the caller buffer', async () => {
    const sink = await createAppendSink();
    const chunk = new Uint8Array([9, 9]);
    await sink.append(chunk);
    chunk.fill(0);
    const blob = await sink.finish();
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(
      new Uint8Array([9, 9]),
    );
    await sink.discard();
  });

  it('rejects appends and finish after discard', async () => {
    const sink = await createAppendSink();
    await sink.discard();
    await expect(sink.append(new Uint8Array([1]))).rejects.toThrow();
    await expect(sink.finish()).rejects.toThrow();
  });
});

describe('sweepTransferScratch', () => {
  it('removes entries no live sink owns and keeps owned ones', async () => {
    const sink = await createAppendSink();
    const dir = await opfs.root.getDirectoryHandle('transfer-scratch', {
      create: true,
    });
    await dir.getFileHandle('stale-from-crashed-session.part', {
      create: true,
    });

    await sweepTransferScratch();

    const names = await scratchDirNames();
    expect(names).toHaveLength(1);
    expect(names[0]).not.toBe('stale-from-crashed-session.part');
    await sink.discard();
  });
});
