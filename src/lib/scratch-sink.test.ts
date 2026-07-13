import { describe, expect, it } from 'vitest';
import { createAppendSink, createReceiveSink } from './scratch-sink';

// Node has no OPFS, so these exercise the memory fallbacks; the OPFS sinks
// share the same contract and are covered by the same assertions when run in
// a browser.
describe('createReceiveSink (memory fallback)', () => {
  it('falls back to the memory sink without OPFS', async () => {
    const sink = await createReceiveSink(16);
    expect(sink.kind).toBe('memory');
  });

  it('assembles out-of-order positional writes into the payload', async () => {
    const sink = await createReceiveSink(8);
    await sink.write(4, new Uint8Array([5, 6, 7, 8]));
    await sink.write(0, new Uint8Array([1, 2, 3, 4]));
    const blob = await sink.finish();
    expect(blob.size).toBe(8);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    );
  });

  it('produces an empty payload for a zero-byte transfer', async () => {
    const sink = await createReceiveSink(0);
    const blob = await sink.finish();
    expect(blob.size).toBe(0);
  });

  it('rejects writes and finish after discard', async () => {
    const sink = await createReceiveSink(4);
    await sink.discard();
    await expect(sink.write(0, new Uint8Array([1]))).rejects.toThrow(
      'discarded',
    );
    await expect(sink.finish()).rejects.toThrow('discarded');
  });

  it('rejects writes after finish', async () => {
    const sink = await createReceiveSink(1);
    await sink.write(0, new Uint8Array([9]));
    await sink.finish();
    await expect(sink.write(0, new Uint8Array([1]))).rejects.toThrow();
  });

  it('tolerates repeated discard calls', async () => {
    const sink = await createReceiveSink(4);
    await sink.discard();
    await expect(sink.discard()).resolves.toBeUndefined();
  });
});

describe('createAppendSink (memory fallback)', () => {
  it('falls back to the memory sink without OPFS', async () => {
    const sink = await createAppendSink();
    expect(sink.kind).toBe('memory');
  });

  it('concatenates appended chunks into the payload', async () => {
    const sink = await createAppendSink();
    await sink.append(new Uint8Array([1, 2, 3]));
    await sink.append(new Uint8Array([4, 5]));
    const blob = await sink.finish();
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3, 4, 5]),
    );
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
  });

  it('rejects appends and finish after discard', async () => {
    const sink = await createAppendSink();
    await sink.discard();
    await expect(sink.append(new Uint8Array([1]))).rejects.toThrow('discarded');
    await expect(sink.finish()).rejects.toThrow('discarded');
  });
});
