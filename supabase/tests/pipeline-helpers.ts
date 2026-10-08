import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { FIXTURES_DIR, serviceClient } from '@meetlou/harness';
import type { LocalEnv } from '@meetlou/harness';
import { SupabaseBlobStore, SupabasePipelineStore } from '@meetlou/pipeline';
import type { PipelineDeps, RecordingJob, TranscriptRef } from '@meetlou/pipeline';
import { FakeSummariser, FakeTranscriber } from '@meetlou/providers';
import type { Segment, Summariser, Summary, Transcriber } from '@meetlou/providers';
import { randomCallSid, randomE164, run } from './db';

const service = { role: 'service_role' } as const;

export const SUMMARY: Summary = {
  summary: 'The client asked about the searches. The firm will chase the provider.',
  actions: [{ description: 'Chase the search provider', owner: 'fee_earner', due: '2026-10-14' }],
  keyDates: [{ date: '2026-10-16', description: 'Search results due' }],
};

export const CONVERSATION: Segment[] = [
  { startSeconds: 0, channel: 0, text: 'Hello, how are the searches going?' },
  {
    startSeconds: 3.5,
    channel: 1,
    text: 'They should be back by Friday. I will chase the provider on Wednesday.',
  },
];

export interface RecordedCall {
  firmId: string;
  matterId: string;
  callId: string;
  recordingId: string;
  recordingSid: string;
  job: RecordingJob;
}

/** A fresh matter with a consented call and a stored recording (and its audio in the bucket). */
export async function recordedCall(
  env: LocalEnv,
  seed: { firm: { id: string } },
  options: { channels?: 1 | 2; duration?: number } = {},
): Promise<RecordedCall> {
  const channels = options.channels ?? 2;
  const admin = serviceClient(env);
  const matter = await run<{ id: string }>(
    service,
    `insert into matters (firm_id, reference, kind, property_address)
     values ($1, $2, 'purchase', '1 Test Street, Testville') returning id`,
    [seed.firm.id, `PIPE-${randomUUID()}`],
    { commit: true },
  );
  const matterId = matter[0]?.id ?? '';
  const call = await run<{ id: string }>(
    service,
    `insert into calls (firm_id, matter_id, call_sid, from_e164, to_e164, started_at,
                        consent_announcement_version, consent_outcome, consent_given_at)
     values ($1, $2, $3, $4, '+442079460958', '2026-10-08T09:30:00Z', 'test', 'given', '2026-10-08T09:30:00Z')
     returning id`,
    [seed.firm.id, matterId, randomCallSid(), randomE164()],
    { commit: true },
  );
  const callId = call[0]?.id ?? '';
  const recordingSid = `RE${randomUUID().replaceAll('-', '')}`;
  const path = `${seed.firm.id}/${matterId}/${recordingSid}.wav`;
  const audio = new Uint8Array(
    readFileSync(`${FIXTURES_DIR}audio/${channels === 2 ? 'stereo' : 'mono'}-2s.wav`),
  );
  const uploaded = await admin.storage
    .from('recordings')
    .upload(path, audio, { contentType: 'audio/wav' });
  if (uploaded.error !== null) throw new Error(uploaded.error.message);
  const ingested = await run<{ recording_id: string }>(
    service,
    `select * from ingest_recording($1, $2, $3, $4, $5, $6, $7::smallint)`,
    [
      callId,
      recordingSid,
      path,
      'a'.repeat(64),
      audio.byteLength,
      options.duration ?? 300,
      channels,
    ],
    { commit: true },
  );
  const recordingId = ingested[0]?.recording_id ?? '';
  const job = await new SupabasePipelineStore(admin).getRecording(recordingId);
  if (job === null) throw new Error('recording not found');
  return { firmId: seed.firm.id, matterId, callId, recordingId, recordingSid, job };
}

export function depsFor(
  env: LocalEnv,
  options: { transcriber?: Transcriber; summariser?: Summariser } = {},
): PipelineDeps & { transcriber: Transcriber; summariser: Summariser } {
  const admin = serviceClient(env);
  return {
    store: new SupabasePipelineStore(admin),
    blobs: new SupabaseBlobStore(admin),
    transcriber: options.transcriber ?? new FakeTranscriber(CONVERSATION),
    summariser: options.summariser ?? new FakeSummariser(SUMMARY),
  };
}

/**
 * A store whose work queues only show the given recordings. Other test files leave unfinished
 * recordings in the shared database; a sweep over everything would be slow and would touch them.
 */
export class ScopedStore extends SupabasePipelineStore {
  constructor(
    db: ReturnType<typeof serviceClient>,
    private readonly recordingIds: ReadonlySet<string>,
  ) {
    super(db);
  }
  override async listAwaitingTranscription(limit: number): Promise<RecordingJob[]> {
    return (await super.listAwaitingTranscription(500))
      .filter((j) => this.recordingIds.has(j.recordingId))
      .slice(0, limit);
  }
  override async listAwaitingSummary(limit: number): Promise<TranscriptRef[]> {
    return (await super.listAwaitingSummary(500))
      .filter((t) => this.recordingIds.has(t.recordingId))
      .slice(0, limit);
  }
}

export function scopedDepsFor(
  env: LocalEnv,
  recordingIds: string[],
  options: { transcriber?: Transcriber; summariser?: Summariser } = {},
): ReturnType<typeof depsFor> {
  return {
    ...depsFor(env, options),
    store: new ScopedStore(serviceClient(env), new Set(recordingIds)),
  };
}
