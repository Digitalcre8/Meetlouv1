import { CHANNEL_SPEAKERS } from './types.ts';
import type { LabelledSegment, Segment, Speaker } from './types.ts';

/**
 * Channel maps to speaker ONLY when the recording has two channels. In a mono mixdown the words
 * of both people are on channel 0, so there is no honest speaker to give them.
 */
export function speakerOf(channel: 0 | 1, recordingChannels: 1 | 2): Speaker | null {
  return recordingChannels === 2 ? CHANNEL_SPEAKERS[channel] : null;
}

export function labelSegments(segments: Segment[], recordingChannels: 1 | 2): LabelledSegment[] {
  return segments.map((s) => ({
    startSeconds: s.startSeconds,
    speaker: speakerOf(s.channel, recordingChannels),
    text: s.text,
  }));
}

/**
 * How many people spoke. For stereo audio, the number of channels that carry any words. For mono
 * audio only the provider can say; null if it does not.
 */
export function speakerCount(
  segments: Segment[],
  recordingChannels: 1 | 2,
  providerSpeakerCount: number | undefined,
): number | null {
  if (recordingChannels === 2) {
    return new Set(segments.filter((s) => s.text.trim().length > 0).map((s) => s.channel)).size;
  }
  return providerSpeakerCount ?? null;
}
