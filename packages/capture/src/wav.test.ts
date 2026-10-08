import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseWavHeader } from './wav.ts';

const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../../fixtures/audio/${name}`, import.meta.url)));

describe('WAV header', () => {
  it('reads two channels from bytes 22 and 23 of a stereo file', () => {
    const bytes = fixture('stereo-2s.wav');
    expect([bytes[22], bytes[23]]).toEqual([2, 0]);
    expect(parseWavHeader(bytes)).toEqual({
      ok: true,
      header: { channels: 2, sampleRate: 8000, bitsPerSample: 16 },
    });
  });

  it('reads one channel from a mono file', () => {
    const bytes = fixture('mono-2s.wav');
    expect([bytes[22], bytes[23]]).toEqual([1, 0]);
    const parsed = parseWavHeader(bytes);
    expect(parsed.ok && parsed.header.channels).toBe(1);
  });

  it('reads the channel count little-endian from exactly those two bytes', () => {
    const bytes = fixture('stereo-2s.wav').slice();
    bytes[22] = 1;
    bytes[23] = 0;
    const parsed = parseWavHeader(bytes);
    expect(parsed.ok && parsed.header.channels).toBe(1);
  });

  it('rejects anything that is not a WAV, or is cut short', () => {
    const stereo = fixture('stereo-2s.wav');
    expect(parseWavHeader(stereo.subarray(0, 20))).toEqual({ ok: false, error: 'too_short' });
    expect(parseWavHeader(new TextEncoder().encode('<html>'.padEnd(64, ' ')))).toEqual({
      ok: false,
      error: 'not_riff',
    });
    const notWave = stereo.slice();
    notWave.set(new TextEncoder().encode('AVI '), 8);
    expect(parseWavHeader(notWave)).toEqual({ ok: false, error: 'not_wave' });
    const noFmt = stereo.slice();
    noFmt.set(new TextEncoder().encode('JUNK'), 12);
    expect(parseWavHeader(noFmt)).toEqual({ ok: false, error: 'no_fmt_chunk' });
  });

  it('rejects a channel count we cannot reason about', () => {
    const six = fixture('stereo-2s.wav').slice();
    six[22] = 6;
    expect(parseWavHeader(six)).toEqual({ ok: false, error: 'unsupported_channels' });
  });
});
