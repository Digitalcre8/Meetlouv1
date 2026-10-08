import { describe, expect, it } from 'vitest';
import { labelSegments, speakerCount, speakerOf } from './speakers.ts';
import { validateTranscribeResult } from './transcript.ts';
import type { AudioInput, Segment } from './types.ts';

const seg = (startSeconds: number, channel: 0 | 1, text = 'words'): Segment => ({
  startSeconds,
  channel,
  text,
});
const audio = (channels: 1 | 2): AudioInput => ({
  bytes: new Uint8Array(0),
  mimeType: 'audio/wav',
  channels,
  durationSeconds: 60,
});
const result = (segments: Segment[]) => ({
  segments,
  language: 'en-GB',
  provider: 'p',
  model: 'm',
  providerJobId: 'j',
});

describe('channel to speaker', () => {
  it('maps channel to speaker only when there are two channels', () => {
    expect(speakerOf(0, 2)).toBe('caller');
    expect(speakerOf(1, 2)).toBe('fee_earner');
    expect(speakerOf(0, 1)).toBeNull();
  });

  it('never labels a mono transcript', () => {
    expect(labelSegments([seg(0, 0), seg(5, 0)], 1).map((s) => s.speaker)).toEqual([null, null]);
    expect(labelSegments([seg(0, 0), seg(5, 1)], 2).map((s) => s.speaker)).toEqual([
      'caller',
      'fee_earner',
    ]);
  });

  it('counts the channels that carry words in stereo, and trusts only the provider in mono', () => {
    expect(speakerCount([seg(0, 0), seg(5, 1)], 2, undefined)).toBe(2);
    expect(speakerCount([seg(0, 0), seg(5, 0)], 2, undefined)).toBe(1);
    expect(speakerCount([seg(0, 0), seg(5, 0)], 1, undefined)).toBeNull();
    expect(speakerCount([seg(0, 0)], 1, 2)).toBe(2);
  });
});

describe('transcriber output is checked against the audio', () => {
  it('accepts a sound transcript', () => {
    expect(validateTranscribeResult(result([seg(0, 0), seg(4, 1)]), audio(2)).ok).toBe(true);
  });
  it('rejects a channel the audio does not have', () => {
    expect(validateTranscribeResult(result([seg(0, 1)]), audio(1))).toEqual({
      ok: false,
      reason: 'segment on a channel the audio does not have',
    });
  });
  it('rejects segments out of order, after the call, or empty', () => {
    expect(validateTranscribeResult(result([seg(9, 0), seg(3, 0)]), audio(2))).toMatchObject({
      ok: false,
    });
    expect(validateTranscribeResult(result([seg(500, 0)]), audio(2))).toMatchObject({ ok: false });
    expect(validateTranscribeResult(result([seg(0, 0, '   ')]), audio(2))).toMatchObject({
      ok: false,
    });
    expect(validateTranscribeResult({ nope: true }, audio(2))).toMatchObject({ ok: false });
  });
});
