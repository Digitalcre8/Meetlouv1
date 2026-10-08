import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compareAudiences } from '@meetlou/domain';
import {
  addMatterEvent,
  approveOutput,
  getMatterEventReads,
  getMatterTimeline,
  getTimelinePreview,
  markEventRead,
  withdrawApproval,
} from '@meetlou/records';
import { localEnv, seedArmstrong, serviceClient, signedInClient } from '@meetlou/harness';
import type { SeedResult } from '@meetlou/harness';
import { transcribeRecording } from '@meetlou/pipeline';
import { pool, randomCallSid, run } from './db';
import { depsFor, recordedCall } from './pipeline-helpers';

/**
 * The shared timeline. Everything here that matters runs as three real people (a fee earner, a
 * client participant, a chain participant), each signed in over the real API, asking the same thing.
 */
function idOf(data: unknown): string {
  if (typeof data === 'object' && data !== null && 'id' in data && typeof data.id === 'string')
    return data.id;
  throw new Error('row has no id');
}

const env = localEnv();
const owner = { role: 'owner' } as const;
const admin = serviceClient(env);
const PASSWORD = 'a-long-enough-password';
const HOUR = 3_600_000;
let seed: SeedResult;

type Db = Awaited<ReturnType<typeof signedInClient>>;
let feeEarner: Db;
let client: Db;
let chain: Db;
let clientUserId = '';
let chainUserId = '';

interface Fixture {
  matterId: string;
  clientPhone: string;
  clientEmail: string;
  chainPhone: string;
  chainEmail: string;
  callClient: string;
  callChain: string;
  callStranger: string;
  recordingId: string;
  recordingSid: string;
  emailClientPass: string;
  emailClientFail: string;
  emailStranger: string;
  attachmentId: string;
  transcriptId: string;
  outputId: string;
  approvalId: string;
  clientNote: string;
  chainNote: string;
}
let m: Fixture;

async function login(label: string) {
  const email = `${label}-${randomUUID()}@example.org`;
  const created = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (created.error !== null) throw new Error(created.error.message);
  return { userId: created.data.user.id, db: await signedInClient(env, email, PASSWORD) };
}

const phone = () => `+4477009${String(Math.floor(Math.random() * 1e5)).padStart(5, '0')}`;
const count = async (sql: string, params: unknown[] = []) =>
  Number((await run<{ n: string }>(owner, sql, params))[0]?.n ?? 0);
const eventsOf = (subjectId: string, kind: string) =>
  run<{ visibility: string; actor_kind: string }>(
    owner,
    `select visibility, actor_kind from events where subject_id = $1 and kind = $2`,
    [subjectId, kind],
  );

async function insertCall(
  matterId: string,
  from: string,
  outcome: 'given' | 'declined' = 'given',
  hoursAgo = 5,
) {
  const at = new Date(Date.now() - hoursAgo * HOUR).toISOString();
  const row = await admin
    .from('calls')
    .insert({
      firm_id: seed.firm.id,
      matter_id: matterId,
      call_sid: randomCallSid(),
      from_e164: from,
      to_e164: '+442079460958',
      started_at: at,
      consent_announcement_version: 'test',
      consent_outcome: outcome,
      consent_given_at: outcome === 'given' ? at : null,
    })
    .select('id')
    .single();
  if (row.error !== null) throw new Error(row.error.message);
  return idOf(row.data);
}

const emailArgs = (
  matterId: string,
  messageId: string,
  from: string,
  spf: string,
  attachments: unknown[] = [],
) => ({
  p_matter_id: matterId,
  p_message_id: messageId,
  p_message_id_synthesised: false,
  p_in_reply_to: null,
  p_references: [],
  p_from_address: from,
  p_to_addresses: [],
  p_cc_addresses: [],
  p_subject: 'subject',
  p_sent_at: null,
  p_raw_storage_path: `${seed.firm.id}/${matterId}/raw`,
  p_raw_sha256: 'a'.repeat(64),
  p_body_text_storage_path: null,
  p_body_html_storage_path: null,
  p_spf_result: spf,
  p_dkim_result: spf === 'pass' ? '{@example.org : pass}' : '{@example.org : fail}',
  p_attachments: attachments,
});

async function ingestEmail(args: ReturnType<typeof emailArgs>): Promise<string> {
  const result = await admin.rpc('ingest_email', args);
  if (result.error !== null) throw new Error(result.error.message);
  return (result.data as { email_id: string }[])[0]?.email_id ?? '';
}

beforeAll(async () => {
  seed = await seedArmstrong(env);
  feeEarner = await signedInClient(env, seed.feeEarner.email, seed.feeEarner.password);

  // A fresh matter with two real participants: the client, and an estate agent in the chain.
  const base = await recordedCall(env, seed); // supplies a matter, a call, a recording (with audio)
  const clientLogin = await login('timeline-client');
  const chainLogin = await login('timeline-chain');
  client = clientLogin.db;
  chain = chainLogin.db;
  clientUserId = clientLogin.userId;
  chainUserId = chainLogin.userId;
  const clientPhone = phone();
  const chainPhone = phone();
  const clientEmail = `client-${randomUUID()}@example.org`;
  const chainEmail = `agent-${randomUUID()}@example.org`;
  await run(
    { role: 'service_role' },
    `insert into participants (firm_id, matter_id, user_id, access, role, display_name, phone_e164, email)
     values ($1, $2, $3, 'client', 'client', 'Test Client', $4, $5),
            ($1, $2, $6, 'chain', 'estate_agent', 'Test Agent', $7, $8)`,
    [
      seed.firm.id,
      base.matterId,
      clientLogin.userId,
      clientPhone,
      clientEmail,
      chainLogin.userId,
      chainPhone,
      chainEmail,
    ],
    { commit: true },
  );

  // Captures. The recorded call from recordedCall() came from a random number: a stranger's.
  const callClient = await insertCall(base.matterId, clientPhone, 'given', 6);
  const callChain = await insertCall(base.matterId, chainPhone, 'given', 4);
  const callStranger = base.callId;

  // The client's call is recorded, transcribed, summarised and approved.
  const audio = await admin.storage.from('recordings').download(base.job.storagePath);
  const sid = `RE${randomUUID().replaceAll('-', '')}`;
  const path = `${seed.firm.id}/${base.matterId}/${sid}.wav`;
  await admin.storage
    .from('recordings')
    .upload(path, audio.data as Blob, { contentType: 'audio/wav' });
  const ingested = await admin.rpc('ingest_recording', {
    p_call_id: callClient,
    p_recording_sid: sid,
    p_storage_path: path,
    p_sha256: 'b'.repeat(64),
    p_byte_length: 64044,
    p_duration_seconds: 600,
    p_channels: 2,
  });
  if (ingested.error !== null) throw new Error(ingested.error.message);
  const recordingId = (ingested.data as { recording_id: string }[])[0]?.recording_id ?? '';
  const store = depsFor(env).store;
  const job = await store.getRecording(recordingId);
  if (job === null) throw new Error('no recording job');
  const outcome = await transcribeRecording(depsFor(env), job);
  if (outcome.status !== 'summarised') throw new Error(JSON.stringify(outcome));
  const approved = await approveOutput(feeEarner, outcome.outputId);
  if (!approved.ok) throw new Error(approved.error.message);

  const attach = [
    {
      ordinal: 0,
      filename: 'x.pdf',
      content_type: 'application/pdf',
      sniffed_content_type: 'application/pdf',
      byte_length: 10,
      sha256: randomBytes(32).toString('hex'),
      storage_path: `${seed.firm.id}/${base.matterId}/att`,
    },
  ];
  const emailClientPass = await ingestEmail(
    emailArgs(base.matterId, `${randomUUID()}@x.example.org`, clientEmail, 'pass', attach),
  );
  const emailClientFail = await ingestEmail(
    emailArgs(base.matterId, `${randomUUID()}@x.example.org`, clientEmail, 'fail'),
  );
  const emailStranger = await ingestEmail(
    emailArgs(base.matterId, `${randomUUID()}@x.example.org`, 'stranger@example.org', 'pass'),
  );
  const attachment = await run<{ id: string }>(
    owner,
    `select id from attachments where email_id = $1`,
    [emailClientPass],
  );

  const clientNote = await addMatterEvent(
    feeEarner,
    {
      firmId: seed.firm.id,
      matterId: base.matterId,
      kind: 'matter.client_update',
      visibility: 'client',
      summary: 'your TA6 has been sent',
      occurredAt: new Date(),
    },
    seed.feeEarner.userId,
  );
  const chainNote = await addMatterEvent(
    feeEarner,
    {
      firmId: seed.firm.id,
      matterId: base.matterId,
      kind: 'matter.exchange_date_agreed',
      visibility: 'chain',
      summary: 'exchange agreed',
      occurredAt: new Date(),
    },
    seed.feeEarner.userId,
  );
  if (!clientNote.ok || !chainNote.ok) throw new Error('manual events failed');

  const transcript = await run<{ id: string }>(
    owner,
    `select id from transcripts where call_recording_id = $1`,
    [recordingId],
  );
  const approval = await run<{ id: string }>(
    owner,
    `select id from approvals where generated_output_id = $1`,
    [outcome.outputId],
  );
  m = {
    matterId: base.matterId,
    clientPhone,
    clientEmail,
    chainPhone,
    chainEmail,
    callClient,
    callChain,
    callStranger,
    recordingId,
    recordingSid: sid,
    emailClientPass,
    emailClientFail,
    emailStranger,
    attachmentId: attachment[0]?.id ?? '',
    transcriptId: transcript[0]?.id ?? '',
    outputId: outcome.outputId,
    approvalId: approval[0]?.id ?? '',
    clientNote: clientNote.value.eventId,
    chainNote: chainNote.value.eventId,
  };
}, 180_000);

afterAll(async () => {
  await pool.end();
});

describe('every capture writes exactly one event, with the right visibility', () => {
  it('one event per captured thing, and the visibility follows who the client is a party to', async () => {
    const expected: [string, string, string, string][] = [
      // [what, subject id, kind, visibility]
      ['the client’s own call', m.callClient, 'call.received', 'client'],
      ['an estate agent’s call', m.callChain, 'call.received', 'firm'],
      ['a stranger’s call', m.callStranger, 'call.received', 'firm'],
      ['a recording', m.recordingId, 'call.recording_stored', 'firm'],
      ['the client’s authenticated email', m.emailClientPass, 'email.received', 'client'],
      [
        'an email claiming to be the client but failing SPF and DKIM',
        m.emailClientFail,
        'email.received',
        'firm',
      ],
      ['a stranger’s email', m.emailStranger, 'email.received', 'firm'],
      ['an attachment', m.attachmentId, 'email.attachment_stored', 'firm'],
      ['a transcript', m.transcriptId, 'call.transcribed', 'firm'],
      ['a generated summary', m.outputId, 'call.summarised', 'firm'],
    ];
    for (const [what, subjectId, kind, visibility] of expected) {
      const events = await eventsOf(subjectId, kind);
      expect(events, `${what}: exactly one ${kind}`).toHaveLength(1);
      expect(events[0], what).toMatchObject({ visibility, actor_kind: 'system' });
    }
    // The approval is on the client's timeline (they can be told, and open it); it names the approver.
    const approval = await run<{ visibility: string; actor_kind: string; actor_id: string }>(
      owner,
      `select visibility, actor_kind, actor_id from events where subject_id = $1 and kind = 'output.approved'`,
      [m.outputId],
    );
    expect(approval).toEqual([
      { visibility: 'client', actor_kind: 'fee_earner', actor_id: seed.feeEarner.userId },
    ]);
  });

  it('a declined consent is on the file, and on the client’s timeline if the client made the call', async () => {
    const declined = await insertCall(m.matterId, m.clientPhone, 'declined', 1);
    expect(await eventsOf(declined, 'call.consent_not_given')).toEqual([
      { visibility: 'client', actor_kind: 'system' },
    ]);
    expect(await eventsOf(declined, 'call.received')).toHaveLength(0);
  });

  it('a redelivery writes no second event, or audit row', async () => {
    const before = {
      events: await count(`select count(*) n from events where matter_id = $1`, [m.matterId]),
      audit: await count(`select count(*) n from audit_log where firm_id = $1`, [seed.firm.id]),
    };
    // The same recording, email and transcription job, delivered again.
    const sid = m.recordingSid;
    const again = await admin.rpc('ingest_recording', {
      p_call_id: m.callClient,
      p_recording_sid: sid,
      p_storage_path: 'x',
      p_sha256: 'b'.repeat(64),
      p_byte_length: 1,
      p_duration_seconds: 600,
      p_channels: 2,
    });
    expect((again.data as { created: boolean }[])[0]?.created).toBe(false);
    const messageId =
      (
        await run<{ message_id: string }>(owner, `select message_id from emails where id = $1`, [
          m.emailClientPass,
        ])
      )[0]?.message_id ?? '';
    await admin.rpc('ingest_email', emailArgs(m.matterId, messageId, m.clientEmail, 'pass'));
    const t = (
      await run<{ provider: string; provider_job_id: string }>(
        owner,
        `select provider, provider_job_id from transcripts where id = $1`,
        [m.transcriptId],
      )
    )[0];
    await admin.rpc('store_transcript', {
      p_recording_id: m.recordingId,
      p_provider: t?.provider,
      p_provider_job_id: t?.provider_job_id,
      p_model: 'm',
      p_diarised: true,
      p_speaker_count: 2,
      p_language: null,
      p_body_storage_path: 'x',
      p_sha256: 'c'.repeat(64),
    });
    expect(await count(`select count(*) n from events where matter_id = $1`, [m.matterId])).toBe(
      before.events,
    );
    expect(await count(`select count(*) n from audit_log where firm_id = $1`, [seed.firm.id])).toBe(
      before.audit,
    );
  });
});

describe('the same query as three different users returns three different sets of rows', () => {
  const ids = async (db: Db) => {
    const timeline = await getMatterTimeline(db, m.matterId);
    if (!timeline.ok) throw new Error(timeline.error.message);
    return timeline.value;
  };

  it('is one request, answered by row-level security alone', async () => {
    // The identical PostgREST request, with nothing about role in it.
    const ask = (db: Db) =>
      db
        .from('matter_timeline')
        .select('event_id, kind, visibility')
        .eq('matter_id', m.matterId)
        .order('occurred_at', { ascending: true });
    const [asFirm, asClient, asChain] = await Promise.all([
      ask(feeEarner),
      ask(client),
      ask(chain),
    ]);
    for (const r of [asFirm, asClient, asChain]) expect(r.error).toBeNull();

    const set = (r: typeof asFirm) =>
      new Set((r.data ?? []).map((e) => (e as { event_id: string }).event_id));
    const [firmSet, clientSet, chainSet] = [set(asFirm), set(asClient), set(asChain)];

    // Three different sets, nested the right way round.
    expect(chainSet.size).toBeLessThan(clientSet.size);
    expect(clientSet.size).toBeLessThan(firmSet.size);
    expect([...chainSet].every((id) => clientSet.has(id))).toBe(true);
    expect([...clientSet].every((id) => firmSet.has(id))).toBe(true);
    expect(new Set([firmSet.size, clientSet.size, chainSet.size]).size).toBe(3);

    const kindsOf = (r: typeof asFirm) =>
      (r.data ?? [])
        .map((e) => `${(e as { visibility: string }).visibility}:${(e as { kind: string }).kind}`)
        .sort();
    // The chain participant sees exactly the one chain-wide fact.
    expect(kindsOf(asChain)).toEqual(['chain:matter.exchange_date_agreed']);
    // The client sees what they were party to, the approved summary, and the chain-wide fact.
    expect(kindsOf(asClient)).toEqual([
      'chain:matter.exchange_date_agreed',
      'client:call.consent_not_given', // the declined call made earlier in this file
      'client:call.received',
      'client:email.received',
      'client:matter.client_update',
      'client:output.approved',
    ]);
    // The firm sees all of it, including everything internal.
    expect(kindsOf(asFirm)).toEqual(
      expect.arrayContaining([
        'firm:call.recording_stored',
        'firm:call.summarised',
        'firm:call.transcribed',
        'firm:email.attachment_stored',
        'firm:email.received',
        'firm:call.received',
      ]),
    );
  });

  it('passes every check the verification page makes', async () => {
    const [asFirm, asClient, asChain] = [await ids(feeEarner), await ids(client), await ids(chain)];
    const checks = compareAudiences(asFirm, asClient, asChain);
    expect(checks.filter((c) => !c.ok)).toEqual([]);
  });

  it('never shows a participant which firm user wrote an event; the firm sees it', async () => {
    expect((await ids(client)).every((e) => e.actor_id === null)).toBe(true);
    expect((await ids(chain)).every((e) => e.actor_id === null)).toBe(true);
    const note = (await ids(feeEarner)).find((e) => e.event_id === m.clientNote);
    expect(note?.actor_id).toBe(seed.feeEarner.userId);
  });

  it('a fee earner of another firm and an anonymous caller get nothing', async () => {
    const other = await login('timeline-outsider'); // no firm, no participant record
    expect(await ids(other.db)).toEqual([]);
    const { anonClient } = await import('@meetlou/harness');
    expect((await anonClient(env).from('matter_timeline').select('event_id')).error).not.toBeNull();
  });

  it('the preview a fee earner sees for each audience is exactly what that audience gets from the API', async () => {
    const real = { firm: await ids(feeEarner), client: await ids(client), chain: await ids(chain) };
    for (const audience of ['firm', 'client', 'chain'] as const) {
      const preview = await getTimelinePreview(feeEarner, m.matterId, audience);
      if (!preview.ok) throw new Error(preview.error.message);
      expect(preview.value.map((e) => e.event_id).sort(), audience).toEqual(
        real[audience].map((e) => e.event_id).sort(),
      );
    }
    // A participant asking for a wider audience than their own still gets only their own.
    const sneaky = await getTimelinePreview(chain, m.matterId, 'firm');
    expect(sneaky.ok && sneaky.value.map((e) => e.event_id)).toEqual(
      (await ids(chain)).map((e) => e.event_id),
    );
    // And an audience that does not exist returns nothing.
    const nonsense = await feeEarner.rpc('matter_timeline_as', {
      p_matter_id: m.matterId,
      p_audience: 'public',
    });
    expect(nonsense.data).toEqual([]);
  });

  it('participants cannot write to the timeline', async () => {
    for (const db of [client, chain]) {
      const attempt = await db.from('events').insert({
        firm_id: seed.firm.id,
        matter_id: m.matterId,
        kind: 'matter.forged',
        visibility: 'chain',
        occurred_at: new Date().toISOString(),
        actor_kind: 'participant',
        actor_id: clientUserId,
        summary: 'x',
      });
      expect(attempt.error).not.toBeNull();
    }
  });
});

describe('read receipts record who opened which event, and when', () => {
  it('the client opening a summary notice is recorded, with their capacity and the server’s time', async () => {
    const summaryEvent =
      (
        await run<{ id: string }>(
          owner,
          `select id from events where subject_id = $1 and kind = 'output.approved'`,
          [m.outputId],
        )
      )[0]?.id ?? '';
    const before = Date.now();
    const opened = await markEventRead(client, summaryEvent);
    expect(opened).toEqual({ ok: true, value: { opened: true } });

    const receipt = await run<{ user_id: string; reader_role: string; read_at: Date }>(
      owner,
      `select user_id, reader_role, read_at from receipts where event_id = $1`,
      [summaryEvent],
    );
    expect(receipt).toHaveLength(1);
    expect(receipt[0]).toMatchObject({ user_id: clientUserId, reader_role: 'client' });
    expect(Math.abs((receipt[0]?.read_at.getTime() ?? 0) - before)).toBeLessThan(10_000);

    // The first opening stands.
    const again = await markEventRead(client, summaryEvent);
    expect(again).toEqual({ ok: true, value: { opened: false } });
    expect(
      await run(owner, `select 1 from receipts where event_id = $1`, [summaryEvent]),
    ).toHaveLength(1);
    await expect(
      run(owner, `update receipts set read_at = now() where event_id = $1`, [summaryEvent]),
    ).rejects.toThrow(/append-only/);

    // It answers "I was never told": the firm can show who opened it, as whom, and when.
    const reads = await getMatterEventReads(feeEarner, m.matterId);
    expect(reads.ok && reads.value.filter((r) => r.eventId === summaryEvent)).toEqual([
      {
        eventId: summaryEvent,
        readerRole: 'client',
        readAt: expect.stringMatching(/^\d{4}-/) as string,
        displayName: 'Test Client',
      },
    ]);
    // The client's own timeline shows that they opened it; the chain participant's shows nothing read.
    const own = await getMatterTimeline(client, m.matterId);
    expect(own.ok && own.value.find((e) => e.event_id === summaryEvent)?.read_at).not.toBeNull();
    const theirs = await getMatterTimeline(chain, m.matterId);
    expect(theirs.ok && theirs.value.every((e) => e.read_at === null)).toBe(true);
  });

  it('nobody can mark an event they cannot see, or read anyone else’s receipts', async () => {
    const firmOnly =
      (
        await run<{ id: string }>(
          owner,
          `select id from events where subject_id = $1 and kind = 'call.recording_stored'`,
          [m.recordingId],
        )
      )[0]?.id ?? '';
    for (const db of [client, chain]) {
      expect((await markEventRead(db, firmOnly)).ok).toBe(false);
    }
    const clientOnly =
      (await run<{ id: string }>(owner, `select id from events where id = $1`, [m.clientNote]))[0]
        ?.id ?? '';
    expect((await markEventRead(chain, clientOnly)).ok).toBe(false); // visible to the client, not the chain
    expect((await markEventRead(client, clientOnly)).ok).toBe(true);

    // The chain participant cannot see the client's receipts, nor the client the chain's.
    expect((await chain.from('receipts').select('id')).data ?? []).toEqual([]);
    const chainEvent = m.chainNote;
    expect((await markEventRead(chain, chainEvent)).ok).toBe(true);
    const clientView = (await client.from('receipts').select('user_id')).data as {
      user_id: string;
    }[];
    expect(clientView.every((r) => r.user_id === clientUserId)).toBe(true);
    // They cannot be forged: a receipt in someone else's name is refused.
    const forged = await client.from('receipts').insert({
      firm_id: seed.firm.id,
      matter_id: m.matterId,
      event_id: chainEvent,
      user_id: chainUserId,
    });
    expect(forged.error).not.toBeNull();
  });

  it('the firm’s own reading is recorded too, as a fee earner', async () => {
    const event =
      (
        await run<{ id: string }>(
          owner,
          `select id from events where subject_id = $1 and kind = 'call.summarised'`,
          [m.outputId],
        )
      )[0]?.id ?? '';
    expect((await markEventRead(feeEarner, event)).ok).toBe(true);
    const role = await run<{ reader_role: string }>(
      owner,
      `select reader_role from receipts where event_id = $1 and user_id = $2`,
      [event, seed.feeEarner.userId],
    );
    expect(role).toEqual([{ reader_role: 'fee_earner' }]);
  });
});

describe('the audit log carries every capture and every approval', () => {
  const audit = (object: string, id: string) =>
    run<{ action: string; actor_id: string | null; firm_id: string }>(
      owner,
      `select action, actor_id, firm_id from audit_log where object_kind = $1 and object_id = $2 and action not like '%.update' order by id`,
      [object, id],
    );

  it('one audit row for each captured thing', async () => {
    const expected: [string, string, string][] = [
      ['call', m.callClient, 'call.captured'],
      ['call', m.callChain, 'call.captured'],
      ['recording', m.recordingId, 'recording.captured'],
      ['email', m.emailClientPass, 'email.captured'],
      ['attachment', m.attachmentId, 'attachment.captured'],
      ['transcript', m.transcriptId, 'transcript.created'],
      ['output', m.outputId, 'output.generated'],
    ];
    for (const [object, id, action] of expected) {
      const rows = await audit(object, id);
      expect(rows, action).toHaveLength(1);
      expect(rows[0], action).toMatchObject({ action, firm_id: seed.firm.id, actor_id: null });
    }
  });

  it('an approval and its withdrawal are in the audit log, naming the fee earner', async () => {
    expect(await audit('approval', m.approvalId)).toEqual([
      { action: 'approval.recorded', actor_id: seed.feeEarner.userId, firm_id: seed.firm.id },
    ]);
    const withdrawn = await withdrawApproval(feeEarner, m.approvalId);
    expect(withdrawn.ok).toBe(true);
    const rows = await audit('approval', m.approvalId);
    expect(rows.map((r) => r.action)).toEqual(['approval.recorded', 'approval.withdrawn']);
    expect(rows[1]?.actor_id).toBe(seed.feeEarner.userId);
  });

  it('a call where consent was declined is a capture too, with the reason', async () => {
    const declined = await insertCall(m.matterId, phone(), 'declined', 1);
    const rows = await run<{ detail: Record<string, string> }>(
      owner,
      `select detail from audit_log where object_id = $1`,
      [declined],
    );
    expect(rows).toEqual([{ detail: { reason: 'consent_declined' } }]);
  });

  it('only the COLP and admins can read the audit log; the capture rows carry no content', async () => {
    expect((await feeEarner.from('audit_log').select('id')).data ?? []).toEqual([]);
    const everything = await run<{ detail: unknown; action: string }>(
      owner,
      `select action, detail from audit_log where action like '%.captured'`,
    );
    expect(JSON.stringify(everything)).not.toContain('@');
  });
});

describe('the timeline answers in the order things happened', () => {
  it('is ordered by when each thing happened, with the firm’s clock as the tie-break', async () => {
    const t = await getMatterTimeline(feeEarner, m.matterId);
    if (!t.ok) throw new Error(t.error.message);
    const times = t.value.map((e) => e.occurred_at);
    expect([...times].sort()).toEqual(times);
    // occurred_at (when it happened) and recorded_at (when we learned) are both there and distinct fields.
    expect(t.value.every((e) => e.recorded_at.length > 0)).toBe(true);
    // The two calls the test staged hours ago come before the manual notes written now.
    const kinds = t.value.map((e) => e.kind);
    expect(kinds.indexOf('call.received')).toBeLessThan(kinds.indexOf('matter.client_update'));
  });
});
