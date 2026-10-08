import { describe, expect, it } from 'vitest';
import {
  MISDIAL_SECONDS,
  NEAR_DUPLICATE_SECONDS,
  isSingleSpeaker,
  speakerLabelling,
} from './recordings.ts';

describe('recordings', () => {
  it('only a dual-channel recording can have its speakers told apart by channel', () => {
    expect(speakerLabelling({ channels: 2 })).toBe('diarised_by_channel');
    expect(speakerLabelling({ channels: 1 })).toBe('not_diarised');
  });

  it('a transcript with one speaker is not a two-party conversation', () => {
    expect(isSingleSpeaker(1)).toBe(true);
    expect(isSingleSpeaker(2)).toBe(false);
    expect(isSingleSpeaker(null)).toBe(false);
  });

  it('keeps the guard thresholds the database applies', () => {
    expect(MISDIAL_SECONDS).toBe(15);
    expect(NEAR_DUPLICATE_SECONDS).toBe(90);
  });
});
