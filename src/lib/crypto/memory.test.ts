import { describe, expect, it } from 'vitest';
import { wipeBufferSource } from './memory';

describe('wipeBufferSource', () => {
  it('wipes an entire ArrayBuffer', () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);

    wipeBufferSource(bytes.buffer);

    expect(Array.from(bytes)).toEqual([0, 0, 0, 0]);
  });

  it('wipes only the supplied view range', () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);

    wipeBufferSource(bytes.subarray(1, 3));

    expect(Array.from(bytes)).toEqual([1, 0, 0, 4]);
  });

  it('wipes DataView bytes', () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const view = new DataView(bytes.buffer, 1, 2);

    wipeBufferSource(view);

    expect(Array.from(bytes)).toEqual([1, 0, 0, 4]);
  });
});
