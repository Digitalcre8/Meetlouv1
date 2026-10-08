import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFeeEarner, createFirm } from '@meetlou/records/admin';
import {
  FIXTURES_DIR,
  FakeTwilio,
  loadFixture,
  localEnv,
  newVars,
  replayFixture,
  runScenario,
  seedArmstrong,
  serveFunctions,
  serviceClient,
  signedInClient,
  stopFunctions,
} from '@meetlou/harness';
import type { Behaviour, SeedResult } from '@meetlou/harness';
import { pool, randomCallSid, randomE164, run } from './db';

/**
 * Recording status callback, end to end and offline: the real Deno entrypoint, a fake Twilio
 * recordings API serving the WAV fixtures, the real Storage API and the real database.
 */
const env = localEnv();
const owner = { role: 'owner' } as const;
const service = { role: 'service_role' } as const;
const admin = serviceClient(env);
const fake = new FakeTwilio(env);
let seed: SeedResult;

const wavFixture = (name: string) => new Uint8Array(readFileSync(`${FIXTURES_DIR}audio/${name}`));
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const newRecordingSid = () => newVars()['recordingSid'] ?? '';

beforeAll(async () => {
  seed = await seedArmstrong(env);
  await fake.start();
  await serveFunctions(env);
}, 180_000);

afterAll(async () => {
  if (process.env['KEEP_FUNCTIONS'] === undefined) stopFunctions();
  await fake.stop();
  await pool.end();
});

/** A fresh matter, so guards that compare recordings on one matter see only this test's. */
async function freshMatter(): Promise<string> {
  const rows = await run<{ id: string }>(
    service,
    `insert into matters (firm_id, reference, kind, property_address)
     values ($1, $2, 'sale', '1 Test Street, Testville') returning id`,
    [seed.firm.id, `REC-${randomUUID()}`],
    { commit: true },
  );
  return rows[0]?.id ?? '';
}

async function freshCall(
  matterId: string,
  options: { startedAt?: string; consent?: 'given' | 'declined' } = {},
): Promise<{ callSid: string; callId: string }> {
  const callSid = randomCallSid();
  const consent = options.consent ?? 'given';
  const rows = await run<{ id: string }>(
    service,
    `insert into calls (firm_id, matter_id, call_sid, from_e164, to_e164, started_at,
                        consent_announcement_version, consent_outcome, consent_given_at)
     values ($1, $2, $3, $4, '+442079460958', $5, 'test', $6, $7) returning id`,
    [
      seed.firm.id,
      matterId,
      callSid,
      randomE164(),
      options.startedAt ?? new Date().toISOString(),
      consent,
      consent === 'given' ? (options.startedAt ?? new Date().toISOString()) : null,
    ],
    { commit: true },
  );
  return { callSid, callId: rows[0]?.id ?? '' };
}

async function deliver(
  callSid: string,
  options: {
    recordingSid?: string;
    duration?: number;
    behaviour?: Behaviour;
    tamper?: boolean;
  } = {},
) {
  const recordingSid = options.recordingSid ?? newRecordingSid();
  if (options.behaviour !== undefined) fake.register(recordingSid, options.behaviour);
  const result = await replayFixture(loadFixture('recording-status.armstrong'), {
    env,
    vars: newVars({ callSid, recordingSid, duration: String(options.duration ?? 125) }),
    ...(options.tamper === true ? { tamper: true } : {}),
  });
  return { recordingSid, result };
}

interface RecordingRow {
  id: string;
  firm_id: string;
  matter_id: string;
  call_id: string;
  storage_path: string;
  sha256: string;
  byte_length: string;
  duration_seconds: number;
  channels: number;
  requested_channels: number;
  is_dual_channel: boolean;
}
const recordingRows = (recordingSid: string) =>
  run<RecordingRow>(owner, `select * from call_recordings where twilio_recording_sid = $1`, [
    recordingSid,
  ]);
const suppressionsFor = async (recordingId: string) =>
  await run<{
    reason: string;
    duplicate_of_recording_id: string | null;
    duration_seconds: number | null;
  }>(
    owner,
    `select reason, duplicate_of_recording_id, duration_seconds from recording_suppressions
        where recording_id = $1 order by reason`,
    [recordingId],
  );
const eventKinds = async (subjectId: string) =>
  (
    await run<{ kind: string }>(
      owner,
      `select kind from events where subject_id = $1 order by kind`,
      [subjectId],
    )
  ).map((e) => e.kind);
const awaiting = async (recordingId: string) =>
  (
    await run(
      service,
      `select recording_id from recordings_awaiting_transcription where recording_id = $1`,
      [recordingId],
    )
  ).length;
const count = async (sql: string, params: unknown[] = []) =>
  Number((await run<{ n: string }>(owner, sql, params))[0]?.n ?? 0);
const objectsIn = async (firmId: string, matterId: string) =>
  (await admin.storage.from('recordings').list(`${firmId}/${matterId}`)).data ?? [];

describe('recording-status: dual-channel, verified from the bytes', () => {
  it('asks for two channels and stores a stereo file with channels=2', async () => {
    const matterId = await freshMatter();
    const { callSid, callId } = await freshCall(matterId);
    const { recordingSid, result } = await deliver(callSid, { behaviour: 'stereo' });
    expect(result.status).toBe(200);

    const [row] = await recordingRows(recordingSid);
    expect(row).toMatchObject({
      call_id: callId,
      matter_id: matterId,
      firm_id: seed.firm.id,
      channels: 2,
      requested_channels: 2,
      is_dual_channel: true,
      duration_seconds: 125,
      sha256: sha256(wavFixture('stereo-2s.wav')),
      byte_length: String(wavFixture('stereo-2s.wav').byteLength),
    });

    // What was sent to "Twilio": asked for two channels, authenticated, once.
    expect(fake.fetchesFor(recordingSid)).toEqual([
      { recordingSid, requestedChannels: '2', authorised: true },
    ]);
    // The file is in the private bucket, scoped by firm and matter, byte for byte.
    expect(row?.storage_path).toBe(`${seed.firm.id}/${matterId}/${recordingSid}.wav`);
    const stored = await admin.storage.from('recordings').download(row?.storage_path ?? '');
    expect(stored.error).toBeNull();
    expect(new Uint8Array((await stored.data?.arrayBuffer()) ?? new ArrayBuffer(0))).toEqual(
      wavFixture('stereo-2s.wav'),
    );

    expect(await eventKinds(row?.id ?? '')).toEqual(['call.recording_stored']);
    expect(await eventKinds(callId)).toEqual(['call.received']); // the call's own capture event, and no mono flag
    expect(await suppressionsFor(row?.id ?? '')).toEqual([]);
    expect(await awaiting(row?.id ?? '')).toBe(1);
  });

  it('stores a mono result as channels=1, flags the call, and it can never be called diarised', async () => {
    const matterId = await freshMatter();
    const { callSid, callId } = await freshCall(matterId);
    const { recordingSid, result } = await deliver(callSid, { behaviour: 'mono' });
    expect(result.status).toBe(200);

    const [row] = await recordingRows(recordingSid);
    expect(row).toMatchObject({
      channels: 1,
      is_dual_channel: false,
      sha256: sha256(wavFixture('mono-2s.wav')),
    });
    // The callback said RecordingChannels=2. The bytes said 1. The bytes win, and the call is marked.
    expect(await eventKinds(callId)).toEqual(['call.received', 'call.recording_mono']);
    const mono = await run<{ summary: string }>(
      owner,
      `select summary from events where subject_id = $1 and kind = 'call.recording_mono'`,
      [callId],
    );
    expect(mono[0]?.summary).toContain('mono');

    // Nothing downstream can describe it as diarised: the database refuses.
    const transcript = (diarised: boolean) =>
      run(
        service,
        `insert into transcripts (firm_id, matter_id, call_recording_id, provider, provider_job_id,
                                  diarised, speaker_count, body_storage_path, sha256)
         values ($1, $2, $3, 'fake', $4, $5, 2, $7, $6)`,
        [
          seed.firm.id,
          matterId,
          row?.id,
          randomUUID(),
          diarised,
          'c'.repeat(64),
          `${seed.firm.id}/${matterId}/t.json`,
        ],
      );
    await expect(transcript(true)).rejects.toThrow(
      /mono recording cannot be described as diarised/,
    );
    await expect(transcript(false)).resolves.toBeDefined();
    // It is still transcribable, just not diarised.
    expect(await awaiting(row?.id ?? '')).toBe(1);
  });

  it('a stereo recording may be described as diarised', async () => {
    const matterId = await freshMatter();
    const { callSid } = await freshCall(matterId);
    const { recordingSid } = await deliver(callSid, { behaviour: 'stereo' });
    const [row] = await recordingRows(recordingSid);
    await expect(
      run(
        service,
        `insert into transcripts (firm_id, matter_id, call_recording_id, provider, provider_job_id,
                                  diarised, speaker_count, body_storage_path, sha256)
         values ($1, $2, $3, 'fake', 'job-1', true, 2, $5, $4)`,
        [seed.firm.id, matterId, row?.id, 'd'.repeat(64), `${seed.firm.id}/${matterId}/t.json`],
      ),
    ).resolves.toBeDefined();
  });

  it('the fixtures really are one and two channels (bytes 22 and 23)', () => {
    expect([wavFixture('stereo-2s.wav')[22], wavFixture('stereo-2s.wav')[23]]).toEqual([2, 0]);
    expect([wavFixture('mono-2s.wav')[22], wavFixture('mono-2s.wav')[23]]).toEqual([1, 0]);
  });
});

describe('recording-status: idempotent on recording_sid', () => {
  it('a second delivery stores nothing twice', async () => {
    const matterId = await freshMatter();
    const { callSid } = await freshCall(matterId);
    const recordingSid = newRecordingSid();
    for (let i = 0; i < 3; i++) {
      expect((await deliver(callSid, { recordingSid })).result.status).toBe(200);
    }
    const rows = await recordingRows(recordingSid);
    expect(rows).toHaveLength(1);
    expect(fake.fetchesFor(recordingSid)).toHaveLength(1); // not even downloaded again
    expect(await objectsIn(seed.firm.id, matterId)).toHaveLength(1);
    expect(await eventKinds(rows[0]?.id ?? '')).toEqual(['call.recording_stored']);
  });

  it('after a failed download, Twilio retries and the recording is stored once', async () => {
    const matterId = await freshMatter();
    const { callSid } = await freshCall(matterId);
    const recordingSid = newRecordingSid();
    fake.register(recordingSid, 'flaky');
    expect((await deliver(callSid, { recordingSid })).result.status).toBe(502); // media not ready
    expect(await recordingRows(recordingSid)).toHaveLength(0);
    expect((await deliver(callSid, { recordingSid })).result.status).toBe(200); // Twilio's retry
    expect(await recordingRows(recordingSid)).toHaveLength(1);
    expect(await objectsIn(seed.firm.id, matterId)).toHaveLength(1);
  });
});

describe('recording-status: guards set a reason and delete nothing', () => {
  it('a recording under 15 seconds is suppressed as a misdial, and kept', async () => {
    const matterId = await freshMatter();
    const { callSid } = await freshCall(matterId);
    const { recordingSid, result } = await deliver(callSid, { duration: 7 });
    expect(result.status).toBe(200);

    const [row] = await recordingRows(recordingSid);
    expect(await suppressionsFor(row?.id ?? '')).toEqual([
      { reason: 'misdial', duplicate_of_recording_id: null, duration_seconds: 7 },
    ]);
    // Kept: the row, the audio, and an event that says why it is set aside.
    expect(row?.channels).toBe(2);
    expect(await objectsIn(seed.firm.id, matterId)).toHaveLength(1);
    expect(await eventKinds(row?.id ?? '')).toEqual([
      'call.recording_stored',
      'recording.suppressed',
    ]);
    // And it is not offered for transcription as if it were a real conversation.
    expect(await awaiting(row?.id ?? '')).toBe(0);
  });

  it('the misdial threshold is exactly 15 seconds', async () => {
    const matterId = await freshMatter();
    const reasonFor = async (duration: number) => {
      const { callSid } = await freshCall(matterId, {
        startedAt: `2026-01-0${(duration % 9) + 1}T10:00:00Z`,
      });
      const { recordingSid } = await deliver(callSid, { duration });
      const [row] = await recordingRows(recordingSid);
      return (await suppressionsFor(row?.id ?? '')).map((s) => s.reason);
    };
    expect(await reasonFor(14)).toEqual(['misdial']);
    expect(await reasonFor(15)).toEqual([]);
  });

  it('suppresses a near-duplicate: same matter, same UK day, within 90 seconds', async () => {
    const matterId = await freshMatter();
    const record = async (startedAt: string, duration: number) => {
      const { callSid } = await freshCall(matterId, { startedAt });
      const { recordingSid, result } = await deliver(callSid, { duration });
      expect(result.status).toBe(200);
      const [row] = await recordingRows(recordingSid);
      return { id: row?.id ?? '', suppressions: await suppressionsFor(row?.id ?? '') };
    };

    const first = await record('2026-03-10T10:00:00Z', 300);
    expect(first.suppressions).toEqual([]);

    // Same day, 80s apart: a duplicate of the first. Nothing deleted, and it names the original.
    const second = await record('2026-03-10T15:00:00Z', 380);
    expect(second.suppressions).toEqual([
      { reason: 'near_duplicate', duplicate_of_recording_id: first.id, duration_seconds: 380 },
    ]);
    expect(await objectsIn(seed.firm.id, matterId)).toHaveLength(2);

    // Exactly 90s apart still counts; 91s does not.
    expect((await record('2026-03-10T16:00:00Z', 390)).suppressions.map((s) => s.reason)).toEqual([
      'near_duplicate',
    ]);
    expect((await record('2026-03-10T17:00:00Z', 391)).suppressions).toEqual([]);

    // A different day is a different call.
    expect((await record('2026-03-11T10:00:00Z', 300)).suppressions).toEqual([]);
  });

  it('uses the UK calendar day, not the UTC one', async () => {
    const matterId = await freshMatter();
    const record = async (startedAt: string, duration: number) => {
      const { callSid } = await freshCall(matterId, { startedAt });
      const { recordingSid } = await deliver(callSid, { duration });
      const [row] = await recordingRows(recordingSid);
      return (await suppressionsFor(row?.id ?? '')).map((s) => s.reason);
    };
    expect(await record('2026-06-10T10:00:00Z', 300)).toEqual([]);
    // 23:30 UTC on the 10th is 00:30 BST on the 11th: a different UK day, though the same UTC day.
    expect(await record('2026-06-10T23:30:00Z', 300)).toEqual([]);
    // 22:30 UTC on the 10th is 23:30 BST on the 10th: the same UK day as the first.
    expect(await record('2026-06-10T22:30:00Z', 300)).toEqual(['near_duplicate']);
  });

  it('a misdial is not "another recorded call" for the duplicate guard', async () => {
    const matterId = await freshMatter();
    const record = async (duration: number) => {
      const { callSid } = await freshCall(matterId, { startedAt: '2026-04-10T10:00:00Z' });
      const { recordingSid } = await deliver(callSid, { duration });
      const [row] = await recordingRows(recordingSid);
      return (await suppressionsFor(row?.id ?? '')).map((s) => s.reason);
    };
    expect(await record(10)).toEqual(['misdial']);
    expect(await record(50)).toEqual([]); // within 90s of the misdial, but the misdial is set aside
  });

  it('a transcript with a single speaker suppresses the recording', async () => {
    const matterId = await freshMatter();
    const { callSid } = await freshCall(matterId);
    const { recordingSid } = await deliver(callSid);
    const [row] = await recordingRows(recordingSid);
    const insert = (speakers: number, job: string, version: number) =>
      run(
        service,
        `insert into transcripts (firm_id, matter_id, call_recording_id, provider, provider_job_id,
                                  diarised, speaker_count, body_storage_path, sha256, version)
         values ($1, $2, $3, 'fake', $4, true, $5, $8, $6, $7)`,
        [
          seed.firm.id,
          matterId,
          row?.id,
          job,
          speakers,
          'e'.repeat(64),
          version,
          `${seed.firm.id}/${matterId}/t.json`,
        ],
        { commit: true },
      );

    await insert(2, 'two-speakers', 1);
    expect(await suppressionsFor(row?.id ?? '')).toEqual([]);
    await insert(1, 'one-speaker', 2);
    expect((await suppressionsFor(row?.id ?? '')).map((s) => s.reason)).toEqual(['single_speaker']);
    expect(await eventKinds(row?.id ?? '')).toContain('recording.suppressed');
    // Still stored and still on the file.
    expect(await objectsIn(seed.firm.id, matterId)).toHaveLength(1);
  });

  it('suppressions, recordings and transcripts are append-only', async () => {
    const matterId = await freshMatter();
    const { callSid } = await freshCall(matterId);
    const { recordingSid } = await deliver(callSid, { duration: 5 });
    const [row] = await recordingRows(recordingSid);
    expect(row).toBeDefined();
    for (const [table, update] of [
      ['call_recordings', `update call_recordings set duration_seconds = 99`],
      ['recording_suppressions', `update recording_suppressions set reason = 'near_duplicate'`],
    ] as const) {
      await expect(run(owner, update)).rejects.toThrow(/append-only/);
      await expect(run(owner, `delete from ${table}`)).rejects.toThrow(/append-only/);
    }
  });
});

describe('recording-status: consent and authentication', () => {
  it('a recording for a call with no row is never downloaded or stored, and is audited once', async () => {
    const unknownCallSid = randomCallSid();
    const recordingSid = newRecordingSid();
    const before = await count(`select count(*) n from call_recordings`);
    for (let i = 0; i < 2; i++) {
      expect((await deliver(unknownCallSid, { recordingSid })).result.status).toBe(200);
    }
    expect(fake.fetchesFor(recordingSid)).toHaveLength(0);
    expect(await count(`select count(*) n from call_recordings`)).toBe(before);
    const audit = await run<{ action: string; detail: Record<string, string> }>(
      owner,
      `select action, detail from audit_log where detail ->> 'recording_sid' = $1`,
      [recordingSid],
    );
    expect(audit).toEqual([
      {
        action: 'recording.quarantined',
        detail: {
          recording_sid: recordingSid,
          call_sid: unknownCallSid,
          reason: 'no_consented_call',
        },
      },
    ]);
  });

  it('refuses a recording for a call where consent was declined, even through the database', async () => {
    const matterId = await freshMatter();
    const { callSid, callId } = await freshCall(matterId, { consent: 'declined' });
    const recordingSid = newRecordingSid();
    expect((await deliver(callSid, { recordingSid })).result.status).toBe(200);
    expect(fake.fetchesFor(recordingSid)).toHaveLength(0);
    expect(await recordingRows(recordingSid)).toHaveLength(0);

    // The database refuses too, whatever calls it.
    await expect(
      run(service, `select * from ingest_recording($1, $2, 'x/y/z.wav', $3, 10, 60, 2::smallint)`, [
        callId,
        newRecordingSid(),
        'f'.repeat(64),
      ]),
    ).rejects.toThrow(/consent given/);
  });

  it('a tampered callback is refused with 403 and writes and fetches nothing', async () => {
    const matterId = await freshMatter();
    const { callSid } = await freshCall(matterId);
    const recordingSid = newRecordingSid();
    const before = {
      recordings: await count(`select count(*) n from call_recordings`),
      audit: await count(`select count(*) n from audit_log`),
    };
    const { result } = await deliver(callSid, { recordingSid, tamper: true });
    expect(result.status).toBe(403);
    expect(fake.fetchesFor(recordingSid)).toHaveLength(0);
    expect(await count(`select count(*) n from call_recordings`)).toBe(before.recordings);
    expect(await count(`select count(*) n from audit_log`)).toBe(before.audit);
    expect(await objectsIn(seed.firm.id, matterId)).toHaveLength(0);
  });

  it('bytes that are not a usable WAV are audited, not stored, and Twilio is told to retry', async () => {
    for (const behaviour of ['truncated', 'not-wav'] as const) {
      const matterId = await freshMatter();
      const { callSid } = await freshCall(matterId);
      const recordingSid = newRecordingSid();
      expect((await deliver(callSid, { recordingSid, behaviour })).result.status).toBe(502);
      expect((await deliver(callSid, { recordingSid, behaviour })).result.status).toBe(502);
      expect(await recordingRows(recordingSid)).toHaveLength(0);
      expect(await objectsIn(seed.firm.id, matterId)).toHaveLength(0);
      const audit = await run<{ action: string }>(
        owner,
        `select action from audit_log where detail ->> 'recording_sid' = $1`,
        [recordingSid],
      );
      expect(audit.map((a) => a.action)).toEqual(['recording.rejected']);
    }
  });

  it('a recording that did not complete is audited and not fetched', async () => {
    const matterId = await freshMatter();
    const { callSid } = await freshCall(matterId);
    const recordingSid = newRecordingSid();
    const vars = newVars({ callSid, recordingSid });
    const fixture = loadFixture('recording-status.armstrong');
    const failed = {
      ...fixture,
      request: {
        ...fixture.request,
        params: { ...fixture.request.params, RecordingStatus: 'failed' },
      },
    };
    expect((await replayFixture(failed, { env, vars })).status).toBe(200);
    expect(fake.fetchesFor(recordingSid)).toHaveLength(0);
    const audit = await run<{ action: string }>(
      owner,
      `select action from audit_log where detail ->> 'recording_sid' = $1`,
      [recordingSid],
    );
    expect(audit.map((a) => a.action)).toEqual(['recording.not_completed']);
  });
});

describe('recordings bucket', () => {
  it('is private: the public URL serves nothing', async () => {
    const buckets = await run<{ public: boolean; allowed_mime_types: string[] }>(
      owner,
      `select public, allowed_mime_types from storage.buckets where id = 'recordings'`,
    );
    expect(buckets[0]?.public).toBe(false);

    const matterId = await freshMatter();
    const { callSid } = await freshCall(matterId);
    const { recordingSid } = await deliver(callSid);
    const [row] = await recordingRows(recordingSid);
    const publicUrl = `${env.apiUrl}/storage/v1/object/public/recordings/${row?.storage_path}`;
    expect((await fetch(publicUrl)).status).not.toBe(200);
  });

  it('cannot be read directly by anyone: the audio is reached only through the audited route', async () => {
    const matterId = await freshMatter();
    const { callSid } = await freshCall(matterId);
    const { recordingSid } = await deliver(callSid);
    const [row] = await recordingRows(recordingSid);
    const path = row?.storage_path ?? '';

    const own = await signedInClient(env, seed.feeEarner.email, seed.feeEarner.password);
    // Not even the owning firm's fee earner: a direct download is an access nobody writes down.
    // (recording-access is the route that audits; see access.test.ts.)
    expect((await own.storage.from('recordings').download(path)).error).not.toBeNull();

    const otherFirm = await createFirm(admin, {
      name: `Other ${Date.now()}`,
      mailDomain: `other${Date.now()}.example.org`,
    });
    if (!otherFirm.ok) throw new Error(otherFirm.error.message);
    const email = `rec-other-${Date.now()}@example.org`;
    const earner = await createFeeEarner(admin, {
      firmId: otherFirm.value.id,
      email,
      password: 'a-long-enough-password',
    });
    expect(earner.ok).toBe(true);
    const other = await signedInClient(env, email, 'a-long-enough-password');
    expect((await other.storage.from('recordings').download(path)).error).not.toBeNull();

    // Nor may anyone write or remove through the user API.
    expect((await own.storage.from('recordings').remove([path])).data ?? []).toHaveLength(0);
    expect(
      (
        await own.storage
          .from('recordings')
          .upload(`${seed.firm.id}/${matterId}/x.wav`, wavFixture('stereo-2s.wav'))
      ).error,
    ).not.toBeNull();
  });

  it('keeps the whole flow working end to end on the seeded matter', async () => {
    const scenario = await runScenario('recorded-call', env, newVars({ duration: '900' }));
    expect(scenario.steps.flatMap((s) => s.failures)).toEqual([]);
    const rows = await recordingRows(scenario.vars['recordingSid'] ?? '');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.matter_id).toBe(seed.matter.id);
    expect(rows[0]?.channels).toBe(2);
  });
});
