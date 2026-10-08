import { z } from 'zod';
import type { AudioInput, TranscribeResult } from './types.ts';

const segmentSchema = z.object({
  startSeconds: z.number().min(0),
  endSeconds: z.number().min(0).optional(),
  channel: z.union([z.literal(0), z.literal(1)]),
  text: z.string().trim().min(1).max(5000),
});

export const transcribeResultSchema = z.object({
  segments: z.array(segmentSchema).max(20000),
  language: z.string().nullable(),
  provider: z.string().min(1),
  model: z.string().min(1),
  providerJobId: z.string().min(1).max(200),
  providerSpeakerCount: z.number().int().min(0).optional(),
});

/** The stored form of a transcript (the text lives in Storage, not in a column). */
export const storedTranscriptSchema = z.object({
  provider: z.string(),
  model: z.string(),
  providerJobId: z.string(),
  language: z.string().nullable(),
  recordingChannels: z.union([z.literal(1), z.literal(2)]),
  segments: z.array(segmentSchema),
});
export type StoredTranscript = z.infer<typeof storedTranscriptSchema>;

/**
 * Check what a transcriber returned against the audio it was given, whatever the provider
 * promised: channels that do not exist, times outside the call, or unsorted segments mean the
 * result cannot be trusted as a record.
 */
export function validateTranscribeResult(
  raw: unknown,
  audio: AudioInput,
): { ok: true; value: TranscribeResult } | { ok: false; reason: string } {
  const parsed = transcribeResultSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `invalid: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`,
    };
  }
  const result = parsed.data;
  let previous = -1;
  for (const s of result.segments) {
    if (s.channel >= audio.channels)
      return { ok: false, reason: 'segment on a channel the audio does not have' };
    if (s.startSeconds < previous) return { ok: false, reason: 'segments are not in time order' };
    if (s.startSeconds > audio.durationSeconds + 5)
      return { ok: false, reason: 'segment starts after the call ended' };
    previous = s.startSeconds;
  }
  return { ok: true, value: result };
}
