import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serviceClient, localEnv, seedArmstrong } from '@meetlou/harness';
import type { SeedResult } from '@meetlou/harness';
import {
  createProcessingHandler,
  processPending,
  resummariseCall,
  retranscribeRecording,
  summariseTranscript,
  transcribeRecording,
} from '@meetlou/pipeline';
import {
  FakeSummariser,
  FakeTranscriber,
  ProviderError,
  RuleBasedSummariser,
} from '@meetlou/providers';
import type { Summary } from '@meetlou/providers';
import { pool, run } from './db';
import { CONVERSATION, SUMMARY, depsFor, recordedCall, scopedDepsFor } from './pipeline-helpers';

/**
 * Transcription and summarisation, end to end against the real database and Storage, with the
 * providers replaced by fakes: the pipeline code under test is the code that runs in production,
 * and nothing in it knows which model is behind the interfaces.
 */
const env = localEnv();
const owner = { role: 'owner' } as const;
const admin = serviceClient(env);
let seed: SeedResult;

beforeAll(async () => {
  seed = await seedArmstrong(env);
}, 60_000);

afterAll(async () => {
  await pool.end();
});

interface OutputRow {
  id: string;
  version: number;
  supersedes_id: string | null;
  provider: string;
  model: string;
  prompt_version: string;
  transcript_id: string;
  content: Summary;
  produced_at: Date;
}
interface TranscriptRow {
  id: string;
  version: number;
  supersedes_id: string | null;
  diarised: boolean;
  speaker_count: number | null;
  body_storage_path: string;
  provider: string;
}
const outputs = (callId: string) =>
  run<OutputRow>(owner, `select * from generated_outputs where call_id = $1 order by version`, [
    callId,
  ]);
const transcripts = (recordingId: string) =>
  run<TranscriptRow>(
    owner,
    `select * from transcripts where call_recording_id = $1 order by version`,
    [recordingId],
  );
const kinds = async (subjectId: string) =>
  (
    await run<{ kind: string }>(
      owner,
      `select kind from events where subject_id = $1 order by kind`,
      [subjectId],
    )
  ).map((e) => e.kind);
const inQueue = async (
  view: 'recordings_awaiting_transcription' | 'transcripts_awaiting_summary',
  id: string,
) =>
  (
    await run(
      owner,
      `select 1 from ${view} where ${view === 'recordings_awaiting_transcription' ? 'recording_id' : 'recording_id'} = $1`,
      [id],
    )
  ).length;

describe('transcribe and summarise', () => {
  it('stores timed, channelled segments and a validated summary, as versions 1', async () => {
    const call = await recordedCall(env, seed);
    expect(await inQueue('recordings_awaiting_transcription', call.recordingId)).toBe(1);

    const deps = depsFor(env);
    const outcome = await transcribeRecording(deps, call.job);
    expect(outcome.status).toBe('summarised');

    const [transcript] = await transcripts(call.recordingId);
    expect(transcript).toMatchObject({
      version: 1,
      supersedes_id: null,
      diarised: true,
      speaker_count: 2,
      provider: 'fake',
    });

    // The text is in the private bucket, not a column: segments with a start time, a channel and text.
    const body = await admin.storage
      .from('transcripts')
      .download(transcript?.body_storage_path ?? '');
    const stored = JSON.parse((await body.data?.text()) ?? '{}') as {
      recordingChannels: number;
      segments: unknown[];
    };
    expect(stored.recordingChannels).toBe(2);
    expect(stored.segments).toEqual(CONVERSATION);

    const [output] = await outputs(call.callId);
    expect(output).toMatchObject({
      version: 1,
      supersedes_id: null,
      provider: 'fake',
      prompt_version: 'fake-v1',
    });
    expect(output?.content).toEqual(SUMMARY);
    expect(output?.transcript_id).toBe(transcript?.id);

    expect(await kinds(transcript?.id ?? '')).toEqual(['call.transcribed']);
    expect(await kinds(output?.id ?? '')).toEqual(['call.summarised']);
    // Off both queues, and awaiting a fee earner's approval.
    expect(await inQueue('recordings_awaiting_transcription', call.recordingId)).toBe(0);
    expect(await inQueue('transcripts_awaiting_summary', call.recordingId)).toBe(0);
    const status = await run<{ approval_status: string }>(
      owner,
      `select approval_status from call_summaries_current where call_id = $1`,
      [call.callId],
    );
    expect(status[0]?.approval_status).toBe('awaiting_approval');
  });

  it('labels speakers by channel only for a two-channel recording', async () => {
    const stereo = await recordedCall(env, seed, { channels: 2 });
    const stereoSummariser = new FakeSummariser(SUMMARY);
    await transcribeRecording(depsFor(env, { summariser: stereoSummariser }), stereo.job);
    expect(stereoSummariser.inputs[0]?.segments.map((s) => s.speaker)).toEqual([
      'caller',
      'fee_earner',
    ]);
    expect(stereoSummariser.inputs[0]?.callDate).toBe('2026-10-08');

    const mono = await recordedCall(env, seed, { channels: 1 });
    const monoSummariser = new FakeSummariser(SUMMARY);
    const monoOutcome = await transcribeRecording(
      depsFor(env, {
        transcriber: new FakeTranscriber(
          [
            { startSeconds: 0, channel: 0, text: 'Hello, how are the searches going?' },
            { startSeconds: 3.5, channel: 0, text: 'They should be back by Friday.' },
          ],
          { providerSpeakerCount: 2 },
        ),
        summariser: monoSummariser,
      }),
      mono.job,
    );
    expect(monoOutcome.status).toBe('summarised');
    expect(monoSummariser.inputs[0]?.recordingChannels).toBe(1);
    expect(monoSummariser.inputs[0]?.segments.map((s) => s.speaker)).toEqual([null, null]); // no honest speaker to give
    const [t] = await transcripts(mono.recordingId);
    expect(t).toMatchObject({ diarised: false, speaker_count: 2 });
  });

  it('a transcriber result that does not fit the audio is rejected, parked and stored nowhere', async () => {
    const mono = await recordedCall(env, seed, { channels: 1 });
    const lying = new FakeTranscriber([
      { startSeconds: 0, channel: 1, text: 'a channel a mono file does not have' },
    ]);
    const outcome = await transcribeRecording(depsFor(env, { transcriber: lying }), mono.job);
    expect(outcome).toMatchObject({
      status: 'failed',
      stage: 'transcription',
      reason: 'invalid_output',
      parked: true,
    });
    expect(await transcripts(mono.recordingId)).toHaveLength(0);
    const audit = await run<{ action: string }>(
      owner,
      `select action from audit_log where detail ->> 'recording_sid' = $1`,
      [mono.recordingSid],
    );
    expect(audit.map((a) => a.action)).toEqual(['recording.transcription_failed']);
    expect(await inQueue('recordings_awaiting_transcription', mono.recordingId)).toBe(0); // parked, not retried forever
  });

  it('a call with one voice on it is suppressed and not summarised', async () => {
    const call = await recordedCall(env, seed);
    const monologue = new FakeTranscriber([
      {
        startSeconds: 0,
        channel: 0,
        text: 'Hello? Is anybody there? I wanted to ask about my searches.',
      },
      { startSeconds: 9, channel: 0, text: 'I will try again later.' },
    ]);
    const summariser = new FakeSummariser(SUMMARY);
    const outcome = await transcribeRecording(
      depsFor(env, { transcriber: monologue, summariser }),
      call.job,
    );
    expect(outcome).toMatchObject({
      status: 'transcribed_not_summarised',
      reason: 'single_speaker',
    });
    expect(summariser.inputs).toHaveLength(0);
    expect(await outputs(call.callId)).toHaveLength(0);
    const suppressions = await run<{ reason: string }>(
      owner,
      `select reason from recording_suppressions where recording_id = $1`,
      [call.recordingId],
    );
    expect(suppressions.map((s) => s.reason)).toEqual(['single_speaker']);
    expect((await transcripts(call.recordingId))[0]?.speaker_count).toBe(1);
  });
});

describe('versions: nothing is overwritten', () => {
  it('a re-run writes a new version that supersedes the old one, and leaves the old one untouched', async () => {
    const call = await recordedCall(env, seed);
    await transcribeRecording(depsFor(env), call.job);
    const [first] = await outputs(call.callId);

    // A different model reads the same words: no change to the pipeline, only to what is passed in.
    const second = await resummariseCall(
      depsFor(env, { summariser: new RuleBasedSummariser() }),
      call.callId,
    );
    expect(second).toMatchObject({ status: 'summarised', version: 2 });

    const all = await outputs(call.callId);
    expect(all.map((o) => [o.version, o.provider])).toEqual([
      [1, 'fake'],
      [2, 'rule-based'],
    ]);
    expect(all[1]?.supersedes_id).toBe(first?.id);
    // Version 1 is byte-for-byte what it was.
    expect(all[0]).toEqual(first);

    // Only the newest is current.
    const current = await run<{ version: number }>(
      owner,
      `select version from call_summaries_current where call_id = $1`,
      [call.callId],
    );
    expect(current.map((c) => c.version)).toEqual([2]);

    await expect(
      run(owner, `update generated_outputs set content = '{}'::jsonb where id = $1`, [first?.id]),
    ).rejects.toThrow(/append-only/);
    await expect(
      run(owner, `delete from generated_outputs where id = $1`, [first?.id]),
    ).rejects.toThrow(/append-only/);
  });

  it('re-transcribing writes transcript version 2 and a new summary on it; both old versions remain', async () => {
    const call = await recordedCall(env, seed);
    await transcribeRecording(depsFor(env), call.job);
    const outcome = await retranscribeRecording(
      depsFor(env, { transcriber: new FakeTranscriber(CONVERSATION, { model: 'fake-2' }) }),
      call.recordingId,
    );
    expect(outcome).toMatchObject({ status: 'summarised', version: 2 });

    const [t1, t2] = await transcripts(call.recordingId);
    expect([t1?.version, t2?.version]).toEqual([1, 2]);
    expect(t2?.supersedes_id).toBe(t1?.id);
    const [o1, o2] = await outputs(call.callId);
    expect(o1?.transcript_id).toBe(t1?.id);
    expect(o2?.transcript_id).toBe(t2?.id);
    expect(o2?.supersedes_id).toBe(o1?.id);
    for (const t of [t1, t2]) {
      expect(
        (await admin.storage.from('transcripts').download(t?.body_storage_path ?? '')).error,
      ).toBeNull();
    }
    const current = await run<{ version: number }>(
      owner,
      `select version from current_transcripts where call_recording_id = $1`,
      [call.recordingId],
    );
    expect(current.map((c) => c.version)).toEqual([2]);
  });

  it('a retry of the same run stores nothing twice; a deliberate re-run does', async () => {
    const call = await recordedCall(env, seed);
    const deps = depsFor(env);
    await transcribeRecording(deps, call.job);
    const transcript = await deps.store.getCurrentTranscript(call.recordingId);
    if (transcript === null) throw new Error('no transcript');
    const runId = crypto.randomUUID();
    await summariseTranscript(deps, call.job, transcript, runId);
    await summariseTranscript(deps, call.job, transcript, runId);
    expect(await outputs(call.callId)).toHaveLength(2); // the pipeline's own run, and this one (twice = once)
    await summariseTranscript(deps, call.job, transcript, crypto.randomUUID());
    expect(await outputs(call.callId)).toHaveLength(3);
  });
});

describe('failure handling', () => {
  it('an output that fails the schema is never stored', async () => {
    const call = await recordedCall(env, seed);
    const bad = new FakeSummariser({
      ...SUMMARY,
      keyDates: [{ date: '2026-02-30', description: 'not a real day' }],
    });
    const outcome = await transcribeRecording(depsFor(env, { summariser: bad }), call.job);
    expect(outcome).toMatchObject({
      status: 'failed',
      stage: 'summary',
      reason: 'invalid_output',
      parked: true,
    });
    expect(await outputs(call.callId)).toHaveLength(0);
    expect(await transcripts(call.recordingId)).toHaveLength(1); // the transcript is kept
    expect(await inQueue('transcripts_awaiting_summary', call.recordingId)).toBe(0); // parked
    const audit = await run<{ action: string }>(
      owner,
      `select action from audit_log where detail ->> 'recording_sid' = $1`,
      [call.recordingSid],
    );
    expect(audit.map((a) => a.action)).toEqual(['recording.summary_failed']);
  });

  it('a refusal is parked; an outage is retried', async () => {
    const refused = await recordedCall(env, seed);
    const refuses = new FakeSummariser(() => {
      throw new ProviderError('refused', 'the model declined to summarise');
    });
    expect(
      await transcribeRecording(depsFor(env, { summariser: refuses }), refused.job),
    ).toMatchObject({ reason: 'refused', parked: true });

    const down = await recordedCall(env, seed);
    const outage = new FakeSummariser(() => {
      throw new ProviderError('unavailable', 'anthropic request failed (529)');
    });
    expect(await transcribeRecording(depsFor(env, { summariser: outage }), down.job)).toMatchObject(
      { reason: 'unavailable', parked: false },
    );
    expect(await inQueue('transcripts_awaiting_summary', down.recordingId)).toBe(1); // still queued
    // The next sweep, with the provider back, completes it.
    const swept = await processPending(scopedDepsFor(env, [down.recordingId]), 50);
    expect(swept.summarised).toBe(1);
    expect(await outputs(down.callId)).toHaveLength(1);
  });

  it('a sweep works the queues once, and has nothing left to do', async () => {
    const a = await recordedCall(env, seed);
    const b = await recordedCall(env, seed);
    const scoped = scopedDepsFor(env, [a.recordingId, b.recordingId]);
    const first = await processPending(scoped, 500);
    expect(first.summarised).toBe(2);
    expect((await outputs(a.callId)).length + (await outputs(b.callId)).length).toBe(2);
    const second = await processPending(scoped, 500);
    expect(second).toMatchObject({ summarised: 0, failed: 0 });
  });
});

describe('the job runner endpoint', () => {
  it('only answers a caller holding the service role key', async () => {
    const handler = createProcessingHandler({
      deps: scopedDepsFor(env, []),
      serviceRoleKey: env.serviceRoleKey,
      batchSize: 1,
    });
    const post = (authorization?: string) =>
      handler(
        new Request('http://127.0.0.1/process', {
          method: 'POST',
          ...(authorization === undefined ? {} : { headers: { authorization } }),
        }),
      );
    expect((await post()).status).toBe(401);
    expect((await post('Bearer wrong')).status).toBe(401);
    expect((await post(`Bearer ${env.anonKey}`)).status).toBe(401);
    const ok = await post(`Bearer ${env.serviceRoleKey}`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toHaveProperty('summarised');
    expect((await handler(new Request('http://127.0.0.1/process'))).status).toBe(405);
  });
});
