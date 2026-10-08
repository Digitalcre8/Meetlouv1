import type { Summary } from './summary.ts';

/** Which side of a two-party call spoke. */
export type Speaker = 'caller' | 'fee_earner';

/**
 * In a two-channel recording of a Dial, channel 0 carries the caller (the parent call leg) and
 * channel 1 the person rung (the child leg). This is Twilio's convention for
 * record-from-answer-dual; verify it against a real recording before relying on it, because
 * every attribution below follows from it.
 */
export const CHANNEL_SPEAKERS: readonly [Speaker, Speaker] = ['caller', 'fee_earner'];

export interface AudioInput {
  bytes: Uint8Array<ArrayBuffer>;
  mimeType: 'audio/wav';
  /** Read from the WAV header of the stored recording, not from any provider. */
  channels: 1 | 2;
  durationSeconds: number;
}

export interface Segment {
  startSeconds: number;
  endSeconds?: number | undefined;
  /** 0-based audio channel the words came from. Always 0 for a mono recording. */
  channel: 0 | 1;
  text: string;
}

export interface TranscribeResult {
  segments: Segment[];
  language: string | null;
  provider: string;
  model: string;
  /** Unique per run. A retry of the same run reuses it. */
  providerJobId: string;
  /** Distinct speakers the provider itself reports, if it does (used for mono audio). */
  providerSpeakerCount?: number | undefined;
}

/** Turn audio into timed text. Everything vendor-specific stays behind this. */
export interface Transcriber {
  readonly name: string;
  transcribe(audio: AudioInput): Promise<TranscribeResult>;
}

export interface LabelledSegment {
  startSeconds: number;
  /** Null when the recording is mono: speakers cannot be told apart by channel. */
  speaker: Speaker | null;
  text: string;
}

export interface SummariseInput {
  /** The UK calendar date of the call, YYYY-MM-DD, so "next Friday" has something to resolve against. */
  callDate: string;
  recordingChannels: 1 | 2;
  segments: LabelledSegment[];
}

export interface SummariseResult {
  summary: Summary;
  provider: string;
  model: string;
  promptVersion: string;
}

/** Turn a transcript into a validated summary. Everything vendor-specific stays behind this. */
export interface Summariser {
  readonly name: string;
  readonly promptVersion: string;
  summarise(input: SummariseInput): Promise<SummariseResult>;
}

export class ProviderError extends Error {
  constructor(
    readonly code: 'refused' | 'truncated' | 'invalid_output' | 'unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
