import { sha256Hex, silentLogger, utf8 } from '@meetlou/domain';
import type { Logger } from '@meetlou/domain';
import {
  ProviderError,
  labelSegments,
  speakerCount,
  storedTranscriptSchema,
  summarySchema,
  validateTranscribeResult,
} from '@meetlou/providers';
import type { StoredTranscript, Summariser, Transcriber } from '@meetlou/providers';
import type { BlobStore, PipelineStore, RecordingJob, TranscriptRef } from './ports.ts';

export interface PipelineDeps {
  store: PipelineStore;
  blobs: BlobStore;
  transcriber: Transcriber;
  summariser: Summariser;
  logger?: Logger;
}

export type Outcome =
  | { status: 'summarised'; transcriptId: string; outputId: string; version: number }
  | { status: 'transcribed_not_summarised'; transcriptId: string; reason: 'single_speaker' }
  | { status: 'failed'; stage: 'transcription' | 'summary'; reason: string; parked: boolean };

/** The UK calendar date of a moment, which is the date a caller means by "tomorrow". */
export function ukDate(moment: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(moment);
}

const TRANSIENT = new Set(['unavailable']);

/** Permanent failures are parked with an audit row; transient ones are simply tried again. */
/**
 * Non-negotiable 11: a job reads only objects under its own matter's folder, whatever a row says.
 * A path outside it is never retried (it cannot become right) and nothing is sent to a provider.
 */
export function ownsObject(job: { firmId: string; matterId: string }, path: string): boolean {
  return path.startsWith(`${job.firmId}/${job.matterId}/`);
}

function assertOwnObject(job: { firmId: string; matterId: string }, path: string): void {
  if (!ownsObject(job, path)) {
    throw new ProviderError('invalid_output', 'object is outside this matter');
  }
}

function classify(error: unknown): { reason: string; parked: boolean } {
  if (error instanceof ProviderError)
    return { reason: error.code, parked: !TRANSIENT.has(error.code) };
  return { reason: 'error', parked: false };
}

/**
 * Transcribe one stored recording, store the transcript as the next version, and summarise it.
 * Nothing is overwritten: a second run writes version 2 and version 2 says which row it replaces.
 */
export async function transcribeRecording(
  deps: PipelineDeps,
  job: RecordingJob,
  runId = crypto.randomUUID(),
): Promise<Outcome> {
  const { store, blobs, transcriber } = deps;
  const logger = deps.logger ?? silentLogger;

  let transcript: TranscriptRef;
  let count: number | null;
  try {
    assertOwnObject(job, job.storagePath);
    const audio = await blobs.get('recordings', job.storagePath);
    if (audio === null) throw new ProviderError('unavailable', 'recording audio is not in storage');

    const raw = await transcriber.transcribe({
      bytes: audio,
      mimeType: 'audio/wav',
      channels: job.channels,
      durationSeconds: job.durationSeconds,
    });
    const checked = validateTranscribeResult(raw, {
      bytes: audio,
      mimeType: 'audio/wav',
      channels: job.channels,
      durationSeconds: job.durationSeconds,
    });
    if (!checked.ok) throw new ProviderError('invalid_output', checked.reason);
    const result = checked.value;

    const stored: StoredTranscript = {
      provider: result.provider,
      model: result.model,
      providerJobId: result.providerJobId,
      language: result.language,
      recordingChannels: job.channels,
      segments: result.segments,
    };
    const body = utf8(JSON.stringify(stored));
    const bodyStoragePath = `${job.firmId}/${job.matterId}/${job.recordingId}/${await sha256Hex(result.providerJobId)}.json`;
    await blobs.put('transcripts', bodyStoragePath, body, 'application/json');

    count = speakerCount(result.segments, job.channels, result.providerSpeakerCount);
    const saved = await store.storeTranscript({
      recordingId: job.recordingId,
      provider: result.provider,
      providerJobId: result.providerJobId,
      model: result.model,
      // Speakers were told apart by channel only if there were two.
      diarised: job.channels === 2,
      speakerCount: count,
      language: result.language,
      bodyStoragePath,
      sha256: await sha256Hex(body),
    });
    transcript = {
      transcriptId: saved.transcriptId,
      version: saved.version,
      bodyStoragePath,
      recordingId: job.recordingId,
    };
  } catch (error) {
    const { reason, parked } = classify(error);
    if (parked) await store.recordIssue({ action: 'recording.transcription_failed', job, reason });
    logger.error('pipeline', {
      outcome: `transcription_${reason}`,
      recordingSid: job.recordingSid,
      callId: job.callId,
    });
    return { status: 'failed', stage: 'transcription', reason, parked };
  }

  // A two-party call with one voice on it is not a conversation. The database has already
  // suppressed the recording (transcripts_single_speaker); a summary of it would mislead.
  if (count === 1) {
    logger.info('pipeline', {
      outcome: 'single_speaker',
      recordingSid: job.recordingSid,
      callId: job.callId,
    });
    return {
      status: 'transcribed_not_summarised',
      transcriptId: transcript.transcriptId,
      reason: 'single_speaker',
    };
  }

  return summariseTranscript(deps, job, transcript, runId);
}

/** Summarise a stored transcript and store the result as the next version of the call's summary. */
export async function summariseTranscript(
  deps: PipelineDeps,
  job: RecordingJob,
  transcript: TranscriptRef,
  runId = crypto.randomUUID(),
): Promise<Outcome> {
  const { store, blobs, summariser } = deps;
  const logger = deps.logger ?? silentLogger;
  try {
    assertOwnObject(job, transcript.bodyStoragePath);
    const body = await blobs.get('transcripts', transcript.bodyStoragePath);
    if (body === null) throw new ProviderError('unavailable', 'transcript is not in storage');
    const stored = storedTranscriptSchema.parse(JSON.parse(new TextDecoder().decode(body)));

    const result = await summariser.summarise({
      callDate: ukDate(job.callStartedAt),
      recordingChannels: stored.recordingChannels,
      segments: labelSegments(stored.segments, stored.recordingChannels),
    });
    // Whatever the provider promised, nothing is stored that does not satisfy the schema.
    const summary = summarySchema.safeParse(result.summary);
    if (!summary.success) throw new ProviderError('invalid_output', 'summary failed validation');

    const content = JSON.stringify(summary.data);
    const saved = await store.storeOutput({
      callId: job.callId,
      transcriptId: transcript.transcriptId,
      provider: result.provider,
      model: result.model,
      promptVersion: result.promptVersion,
      runId,
      content: summary.data,
      contentSha256: await sha256Hex(content),
    });
    logger.info('pipeline', {
      outcome: saved.created ? 'summarised' : 'duplicate',
      callId: job.callId,
      recordingSid: job.recordingSid,
      created: saved.created,
    });
    return {
      status: 'summarised',
      transcriptId: transcript.transcriptId,
      outputId: saved.outputId,
      version: saved.version,
    };
  } catch (error) {
    const { reason, parked } = classify(error);
    if (parked) await store.recordIssue({ action: 'recording.summary_failed', job, reason });
    logger.error('pipeline', {
      outcome: `summary_${reason}`,
      recordingSid: job.recordingSid,
      callId: job.callId,
    });
    return { status: 'failed', stage: 'summary', reason, parked };
  }
}

/** Re-run only the summary on a call's current transcript: a new prompt or model, same words. */
export async function resummariseCall(deps: PipelineDeps, callId: string): Promise<Outcome | null> {
  const job = await deps.store.getRecordingForCall(callId);
  if (job === null) return null;
  const transcript = await deps.store.getCurrentTranscript(job.recordingId);
  if (transcript === null) return null;
  return summariseTranscript(deps, job, transcript);
}

/** Re-run transcription (and so the summary) of a recording: a new transcript version, then a new summary. */
export async function retranscribeRecording(
  deps: PipelineDeps,
  recordingId: string,
): Promise<Outcome | null> {
  const job = await deps.store.getRecording(recordingId);
  return job === null ? null : transcribeRecording(deps, job);
}

export interface SweepResult {
  summarised: number;
  singleSpeaker: number;
  failed: number;
  parked: number;
}

/** One pass over the work queues: unsummarised transcripts first (cheaper), then untranscribed recordings. */
export async function processPending(deps: PipelineDeps, limit: number): Promise<SweepResult> {
  const result: SweepResult = { summarised: 0, singleSpeaker: 0, failed: 0, parked: 0 };
  const tally = (o: Outcome) => {
    if (o.status === 'summarised') result.summarised++;
    else if (o.status === 'transcribed_not_summarised') result.singleSpeaker++;
    else {
      result.failed++;
      if (o.parked) result.parked++;
    }
  };

  for (const transcript of await deps.store.listAwaitingSummary(limit)) {
    const job = await deps.store.getRecording(transcript.recordingId);
    if (job !== null) tally(await summariseTranscript(deps, job, transcript));
  }
  for (const job of await deps.store.listAwaitingTranscription(limit)) {
    tally(await transcribeRecording(deps, job));
  }
  return result;
}
