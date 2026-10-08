import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type {
  BlobStore,
  PipelineIssue,
  PipelineStore,
  RecordingJob,
  StoreOutputInput,
  StoreTranscriptInput,
  TranscriptRef,
} from './ports.ts';

const jobRow = z.object({
  id: z.uuid(),
  twilio_recording_sid: z.string(),
  firm_id: z.uuid(),
  matter_id: z.uuid(),
  call_id: z.uuid(),
  storage_path: z.string(),
  channels: z.union([z.literal(1), z.literal(2)]),
  duration_seconds: z.number().int(),
  calls: z.object({ call_sid: z.string(), started_at: z.string() }),
});
const JOB_COLUMNS =
  'id, twilio_recording_sid, firm_id, matter_id, call_id, storage_path, channels, duration_seconds, calls(call_sid, started_at)';
const toJob = (row: unknown): RecordingJob => {
  const r = jobRow.parse(row);
  return {
    recordingId: r.id,
    recordingSid: r.twilio_recording_sid,
    firmId: r.firm_id,
    matterId: r.matter_id,
    callId: r.call_id,
    callSid: r.calls.call_sid,
    storagePath: r.storage_path,
    channels: r.channels,
    durationSeconds: r.duration_seconds,
    callStartedAt: new Date(r.calls.started_at),
  };
};

const transcriptRow = z.object({
  id: z.uuid(),
  version: z.number().int(),
  body_storage_path: z.string(),
  call_recording_id: z.uuid(),
});
const toRef = (row: unknown): TranscriptRef => {
  const r = transcriptRow.parse(row);
  return {
    transcriptId: r.id,
    version: r.version,
    bodyStoragePath: r.body_storage_path,
    recordingId: r.call_recording_id,
  };
};

function fail(what: string, error: { message: string }): never {
  throw new Error(`${what}: ${error.message}`);
}

/** Service-role implementation of PipelineStore. */
export class SupabasePipelineStore implements PipelineStore {
  constructor(private readonly db: SupabaseClient) {}

  async listAwaitingTranscription(limit: number): Promise<RecordingJob[]> {
    const queue = await this.db
      .from('recordings_awaiting_transcription')
      .select('recording_id')
      .limit(limit);
    if (queue.error !== null) fail('listAwaitingTranscription', queue.error);
    const ids = z
      .array(z.object({ recording_id: z.uuid() }))
      .parse(queue.data)
      .map((r) => r.recording_id);
    if (ids.length === 0) return [];
    const rows = await this.db.from('call_recordings').select(JOB_COLUMNS).in('id', ids);
    if (rows.error !== null) fail('listAwaitingTranscription', rows.error);
    return rows.data.map(toJob);
  }

  async listAwaitingSummary(limit: number): Promise<TranscriptRef[]> {
    const queue = await this.db
      .from('transcripts_awaiting_summary')
      .select('transcript_id')
      .limit(limit);
    if (queue.error !== null) fail('listAwaitingSummary', queue.error);
    const ids = z
      .array(z.object({ transcript_id: z.uuid() }))
      .parse(queue.data)
      .map((r) => r.transcript_id);
    if (ids.length === 0) return [];
    const rows = await this.db
      .from('transcripts')
      .select('id, version, body_storage_path, call_recording_id')
      .in('id', ids);
    if (rows.error !== null) fail('listAwaitingSummary', rows.error);
    return rows.data.map(toRef);
  }

  async getRecording(recordingId: string): Promise<RecordingJob | null> {
    const row = await this.db
      .from('call_recordings')
      .select(JOB_COLUMNS)
      .eq('id', recordingId)
      .maybeSingle();
    if (row.error !== null) fail('getRecording', row.error);
    return row.data === null ? null : toJob(row.data);
  }

  async getTranscript(transcriptId: string): Promise<TranscriptRef | null> {
    const row = await this.db
      .from('transcripts')
      .select('id, version, body_storage_path, call_recording_id')
      .eq('id', transcriptId)
      .maybeSingle();
    if (row.error !== null) fail('getTranscript', row.error);
    return row.data === null ? null : toRef(row.data);
  }

  async getCurrentTranscript(recordingId: string): Promise<TranscriptRef | null> {
    const row = await this.db
      .from('current_transcripts')
      .select('id, version, body_storage_path, call_recording_id')
      .eq('call_recording_id', recordingId)
      .maybeSingle();
    if (row.error !== null) fail('getCurrentTranscript', row.error);
    return row.data === null ? null : toRef(row.data);
  }

  async getRecordingForCall(callId: string): Promise<RecordingJob | null> {
    const rows = await this.db
      .from('call_recordings')
      .select(JOB_COLUMNS)
      .eq('call_id', callId)
      .order('recorded_at', { ascending: false })
      .limit(1);
    if (rows.error !== null) fail('getRecordingForCall', rows.error);
    const first = rows.data[0];
    return first === undefined ? null : toJob(first);
  }

  async storeTranscript(input: StoreTranscriptInput) {
    const result = await this.db.rpc('store_transcript', {
      p_recording_id: input.recordingId,
      p_provider: input.provider,
      p_provider_job_id: input.providerJobId,
      p_model: input.model,
      p_diarised: input.diarised,
      p_speaker_count: input.speakerCount,
      p_language: input.language,
      p_body_storage_path: input.bodyStoragePath,
      p_sha256: input.sha256,
    });
    if (result.error !== null) fail('storeTranscript', result.error);
    const row = z
      .array(z.object({ transcript_id: z.uuid(), version: z.number().int(), created: z.boolean() }))
      .length(1)
      .parse(result.data)[0];
    if (row === undefined) throw new Error('storeTranscript: no result');
    return { transcriptId: row.transcript_id, version: row.version, created: row.created };
  }

  async storeOutput(input: StoreOutputInput) {
    const result = await this.db.rpc('store_generated_output', {
      p_call_id: input.callId,
      p_transcript_id: input.transcriptId,
      p_kind: 'call_summary',
      p_provider: input.provider,
      p_model: input.model,
      p_prompt_version: input.promptVersion,
      p_run_id: input.runId,
      p_content: input.content,
      p_content_sha256: input.contentSha256,
    });
    if (result.error !== null) fail('storeOutput', result.error);
    const row = z
      .array(z.object({ output_id: z.uuid(), version: z.number().int(), created: z.boolean() }))
      .length(1)
      .parse(result.data)[0];
    if (row === undefined) throw new Error('storeOutput: no result');
    return { outputId: row.output_id, version: row.version, created: row.created };
  }

  async recordIssue(input: {
    action: PipelineIssue;
    job: RecordingJob;
    reason: string;
  }): Promise<void> {
    const result = await this.db.rpc('record_recording_issue', {
      p_action: input.action,
      p_recording_sid: input.job.recordingSid,
      p_call_sid: input.job.callSid,
      p_firm_id: input.job.firmId,
      p_reason: input.reason,
    });
    if (result.error !== null) fail('recordIssue', result.error);
  }
}

/** Private Storage buckets, service role. */
export class SupabaseBlobStore implements BlobStore {
  constructor(private readonly db: SupabaseClient) {}

  async get(bucket: string, path: string): Promise<Uint8Array<ArrayBuffer> | null> {
    const downloaded = await this.db.storage.from(bucket).download(path);
    if (downloaded.error !== null) return null;
    return new Uint8Array(await downloaded.data.arrayBuffer());
  }

  async put(bucket: string, path: string, bytes: Uint8Array<ArrayBuffer>, contentType: string) {
    const uploaded = await this.db.storage
      .from(bucket)
      .upload(path, bytes, { contentType, upsert: false });
    if (uploaded.error === null) return 'created' as const;
    const status = (uploaded.error as { statusCode?: string }).statusCode;
    if (status === '409' || /already exists|duplicate/i.test(uploaded.error.message))
      return 'exists' as const;
    throw new Error(`storage put: ${uploaded.error.message}`);
  }
}
