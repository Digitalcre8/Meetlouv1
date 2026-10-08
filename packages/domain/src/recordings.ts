/** Shorter than this is a misdial, not a call. Mirrors ingest_recording() in migration 0010. */
export const MISDIAL_SECONDS = 15;
/** Two recordings on one matter on one UK day with durations this close are near-duplicates. */
export const NEAR_DUPLICATE_SECONDS = 90;

export type SuppressedReason = 'misdial' | 'near_duplicate' | 'single_speaker';

/** What the database says about a stored recording. `channels` was read from the WAV header. */
export interface RecordingFacts {
  channels: 1 | 2;
}

export type SpeakerLabelling = 'diarised_by_channel' | 'not_diarised';

/**
 * The only way to describe how a recording's speakers are labelled. A mono recording cannot
 * have speakers told apart by channel, so it is never 'diarised_by_channel'. The database
 * enforces the same rule (transcripts_guard); this is the application-side mirror, so UI and
 * summaries cannot claim more than the audio supports.
 */
export function speakerLabelling(recording: RecordingFacts): SpeakerLabelling {
  return recording.channels === 2 ? 'diarised_by_channel' : 'not_diarised';
}

/** A two-party call whose transcript contains only one speaker is not a conversation. */
export function isSingleSpeaker(speakerCount: number | null): boolean {
  return speakerCount === 1;
}
