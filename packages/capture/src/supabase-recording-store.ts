import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type {
  CallForRecording,
  IngestRecordingInput,
  IngestRecordingResult,
  ObjectStorage,
  RecordingIssue,
  RecordingStore,
} from './ports.ts';

/** Service-role implementation of RecordingStore. */
export class SupabaseRecordingStore implements RecordingStore {
  constructor(private readonly db: SupabaseClient) {}

  async findCall(callSid: string): Promise<CallForRecording | null> {
    const found = await this.db
      .from('calls')
      .select('id, firm_id, matter_id, consent_outcome')
      .eq('call_sid', callSid)
      .maybeSingle();
    if (found.error !== null) throw new Error(`findCall: ${found.error.message}`);
    if (found.data === null) return null;
    const row = z
      .object({
        id: z.uuid(),
        firm_id: z.uuid(),
        matter_id: z.uuid(),
        consent_outcome: z.string(),
      })
      .parse(found.data);
    return {
      callId: row.id,
      firmId: row.firm_id,
      matterId: row.matter_id,
      consentGiven: row.consent_outcome === 'given',
    };
  }

  async findRecording(recordingSid: string): Promise<{ recordingId: string } | null> {
    const found = await this.db
      .from('call_recordings')
      .select('id')
      .eq('twilio_recording_sid', recordingSid)
      .maybeSingle();
    if (found.error !== null) throw new Error(`findRecording: ${found.error.message}`);
    if (found.data === null) return null;
    return { recordingId: z.object({ id: z.uuid() }).parse(found.data).id };
  }

  async ingest(input: IngestRecordingInput): Promise<IngestRecordingResult> {
    const result = await this.db.rpc('ingest_recording', {
      p_call_id: input.callId,
      p_recording_sid: input.recordingSid,
      p_storage_path: input.storagePath,
      p_sha256: input.sha256,
      p_byte_length: input.byteLength,
      p_duration_seconds: input.durationSeconds,
      p_channels: input.channels,
    });
    if (result.error !== null) throw new Error(`ingest: ${result.error.message}`);
    const row = z
      .array(
        z.object({ recording_id: z.uuid(), created: z.boolean(), suppressed: z.array(z.string()) }),
      )
      .length(1)
      .parse(result.data)[0];
    if (row === undefined) throw new Error('ingest: no result');
    return { recordingId: row.recording_id, created: row.created, suppressed: row.suppressed };
  }

  async recordIssue(input: {
    action: RecordingIssue;
    recordingSid: string;
    callSid: string;
    firmId: string | null;
    reason: string;
  }): Promise<void> {
    const result = await this.db.rpc('record_recording_issue', {
      p_action: input.action,
      p_recording_sid: input.recordingSid,
      p_call_sid: input.callSid,
      p_firm_id: input.firmId,
      p_reason: input.reason,
    });
    if (result.error !== null) throw new Error(`recordIssue: ${result.error.message}`);
  }
}

/** Uploads into the private 'recordings' bucket with the service role. */
export class SupabaseObjectStorage implements ObjectStorage {
  constructor(
    private readonly db: SupabaseClient,
    private readonly bucket = 'recordings',
  ) {}

  async put(
    path: string,
    bytes: Uint8Array<ArrayBuffer>,
    contentType: string,
  ): Promise<'created' | 'exists'> {
    // upsert:false - an object already at this path is never overwritten.
    const uploaded = await this.db.storage.from(this.bucket).upload(path, bytes, {
      contentType,
      upsert: false,
    });
    if (uploaded.error === null) return 'created';
    const status = (uploaded.error as { statusCode?: string }).statusCode;
    if (status === '409' || /already exists|duplicate/i.test(uploaded.error.message)) {
      return 'exists';
    }
    throw new Error(`storage put: ${uploaded.error.message}`);
  }
}
