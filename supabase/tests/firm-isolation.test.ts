import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMatter, getSessionFirm } from '@meetlou/records';
import { createFeeEarner, createFirm, createInboundEmailKey } from '@meetlou/records/admin';
import {
  FIXTURES_DIR,
  loadFixture,
  loadSendgridFixture,
  localEnv,
  newVars,
  replayFixture,
  replaySendgrid,
  seedArmstrong,
  seedVars,
  serveFunctions,
  serviceClient,
  signedInClient,
  stopFunctions,
} from '@meetlou/harness';
import type { SeedResult } from '@meetlou/harness';
import { ownsObject, transcribeRecording } from '@meetlou/pipeline';
import { renderUserMessage, SYSTEM_PROMPT } from '@meetlou/providers';
import type {
  AudioInput,
  Segment,
  SummariseInput,
  SummariseResult,
  Summariser,
  TranscribeResult,
  Transcriber,
} from '@meetlou/providers';
import { pool, run } from './db';
import { SUMMARY, depsFor, recordedCall } from './pipeline-helpers';

/**
 * Both sides of a transaction may use Meet Lou (non-negotiable 11). The buyer's firm and the
 * seller's firm each have a matter at the same address, and being on the same platform never
 * means sharing data. Two firms are built here, at one address, and everything below tries to make
 * one of them see or touch the other.
 */
const env = localEnv();
const owner = { role: 'owner' } as const;
const admin = serviceClient(env);
const PASSWORD = 'a-long-enough-password';
const ADDRESS = '14 Meadow Road, Sale M33 2QX';

let seed: SeedResult; // firm A: Armstrong & Co, MTR-1001
let firmB: { id: string; name: string; mailDomain: string };
/** Firm A's matter at the shared address. Its own, so the seeded MTR-1001 is left exactly as the seed made it. */
const aMatter = { id: '', slug: '', line: '', reference: '' };
let bMatterId = '';
let bSlug = '';
let bLine = '';
let bFeeEarnerPhone = '';
let bKey: { keyId: string; secret: string };
let aClient: Awaited<ReturnType<typeof signedInClient>>;
let bClient: Awaited<ReturnType<typeof signedInClient>>;
let bEmail = '';
let bMemberId = '';

/** One person who is a participant on BOTH matters: the estate agent, say, or a shared client. */
const SHARED = { phone: '+447700900555', email: 'sam.shared@example.org', name: 'Sam Shared' };
const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const eml = (name: string) => readFileSync(`${FIXTURES_DIR}sendgrid/messages/${name}.eml`, 'utf8');

const count = async (sql: string, params: unknown[] = []) =>
  Number((await run<{ n: string }>(owner, sql, params))[0]?.n ?? 0);
const aDomain = () => seed.firm.mail_domain ?? '';

beforeAll(async () => {
  seed = await seedArmstrong(env);

  // Firm B: a different firm, mail domain, fee earner, line and Inbound Parse key.
  const stamp = Date.now();
  const created = await createFirm(admin, {
    name: `Bickerstaff & Co ${stamp}`,
    mailDomain: `matters.bickerstaff${stamp}.example.org`,
  });
  if (!created.ok) throw new Error(created.error.message);
  firmB = {
    id: created.value.id,
    name: created.value.name,
    mailDomain: created.value.mail_domain ?? '',
  };
  bEmail = `fee.earner.b.${stamp}@example.org`;
  bFeeEarnerPhone = '+447700900124';
  const feeEarner = await createFeeEarner(admin, {
    firmId: firmB.id,
    email: bEmail,
    password: PASSWORD,
    phoneE164: bFeeEarnerPhone,
  });
  if (!feeEarner.ok) throw new Error(feeEarner.error.message);
  bMemberId = feeEarner.value.memberId;
  const key = await createInboundEmailKey(admin, firmB.id);
  if (!key.ok) throw new Error(key.error.message);
  bKey = { keyId: key.value.keyId, secret: key.value.secret };

  aClient = await signedInClient(env, seed.feeEarner.email, seed.feeEarner.password);
  bClient = await signedInClient(env, bEmail, PASSWORD);

  // Firm A's own matter at the very same address (the seeded MTR-1001 is left alone).
  const aLine = `+442079460${String(100 + Math.floor(Math.random() * 400))}`;
  const aCreated = await createMatter(aClient, {
    firmId: seed.firm.id,
    reference: `ISO-A-${stamp}`,
    kind: 'purchase',
    propertyAddress: ADDRESS,
    lineE164: aLine,
    responsibleFeeEarnerId: seed.feeEarner.memberId,
  });
  if (!aCreated.ok) throw new Error(aCreated.error.message);
  Object.assign(aMatter, {
    id: aCreated.value.matter.id,
    slug: aCreated.value.matter.inbound_slug,
    line: aLine,
    reference: aCreated.value.matter.reference,
  });

  // The same address, created second by a different firm.
  bLine = `+442079460${String(500 + Math.floor(Math.random() * 400))}`;
  const matter = await createMatter(bClient, {
    firmId: firmB.id,
    reference: 'MTR-2001',
    kind: 'sale',
    propertyAddress: ADDRESS,
    lineE164: bLine,
    responsibleFeeEarnerId: bMemberId,
  });
  if (!matter.ok) throw new Error(matter.error.message);
  bMatterId = matter.value.matter.id;
  bSlug = matter.value.matter.inbound_slug;

  // The shared person is a client participant on both matters.
  for (const [firmId, matterId] of [
    [seed.firm.id, aMatter.id],
    [firmB.id, bMatterId],
  ] as const) {
    await run(
      owner,
      `insert into participants (firm_id, matter_id, access, role, display_name, phone_e164, email)
       values ($1, $2, 'client', 'client', $3, $4, $5)`,
      [firmId, matterId, SHARED.name, SHARED.phone, SHARED.email],
      { commit: true },
    );
  }
  await serveFunctions(env);
}, 300_000);

afterAll(async () => {
  if (process.env['KEEP_FUNCTIONS'] === undefined) stopFunctions();
  await pool.end();
});

/** A row of every kind on a matter, with file paths under its own matter's folder. */
async function populate(firmId: string, matterId: string, tag: string) {
  const call = (
    await run<{ id: string }>(
      owner,
      `insert into calls (firm_id, matter_id, call_sid, from_e164, to_e164, started_at,
                          consent_announcement_version, consent_outcome, consent_given_at)
       values ($1, $2, $3, '+447700900777', '+442079460900', now(), 'test', 'given', now())
       returning id`,
      [firmId, matterId, `CA${sha256(tag).slice(0, 32)}`],
      { commit: true },
    )
  )[0];
  const email = (
    await run<{ id: string }>(
      owner,
      `insert into emails (firm_id, matter_id, message_id, from_address, subject, raw_storage_path, raw_sha256)
       values ($1, $2, $3, 'someone@example.org', $4, $5, $6) returning id`,
      [
        firmId,
        matterId,
        `${tag}@populate.example.org`,
        tag,
        `${firmId}/${matterId}/${tag}/raw.eml`,
        'a'.repeat(64),
      ],
      { commit: true },
    )
  )[0];
  const attachment = (
    await run<{ id: string }>(
      owner,
      `insert into attachments (firm_id, matter_id, email_id, ordinal, filename, content_type,
                                byte_length, sha256, storage_path)
       values ($1, $2, $3, 0, 'TA6.pdf', 'application/pdf', 5, $4, $5) returning id`,
      [firmId, matterId, email?.id, 'b'.repeat(64), `${firmId}/${matterId}/${tag}-att`],
      { commit: true },
    )
  )[0];
  const upload = await admin.storage
    .from('emails')
    .upload(
      `${firmId}/${matterId}/${tag}/raw.eml`,
      new TextEncoder().encode(`Subject: ${tag}\r\n\r\nbody`),
      {
        contentType: 'message/rfc822',
      },
    );
  if (upload.error !== null) throw new Error(upload.error.message);
  const eventsRows = await run<{ id: string }>(
    owner,
    `select id from events where matter_id = $1`,
    [matterId],
  );
  return {
    callId: call?.id ?? '',
    emailId: email?.id ?? '',
    attachmentId: attachment?.id ?? '',
    eventIds: eventsRows.map((e) => e.id),
    objectPath: `${firmId}/${matterId}/${tag}/raw.eml`,
  };
}

describe('two firms, one address', () => {
  it('the second matter at the same address is created without a uniqueness failure', async () => {
    expect(bMatterId).not.toBe('');
    const rows = await run<{
      id: string;
      firm_id: string;
      inbound_slug: string;
      line_e164: string | null;
    }>(
      owner,
      `select id, firm_id, inbound_slug, line_e164 from matters where property_address = $1 order by created_at`,
      [ADDRESS],
    );
    const firms = new Set(rows.map((r) => r.firm_id));
    expect(firms.has(seed.firm.id) && firms.has(firmB.id)).toBe(true);
    // Different matters, different addresses to write to, different numbers to ring.
    const a = rows.find((r) => r.id === aMatter.id);
    const b = rows.find((r) => r.id === bMatterId);
    expect(a?.inbound_slug).not.toBe(b?.inbound_slug);
    expect(a?.line_e164).not.toBe(b?.line_e164);
    // And nothing is unique on the address, the postcode or a name: the same text may recur.
    expect(
      await count(
        `select count(*) n
           from pg_index i
           join pg_class c on c.oid = i.indrelid
           join pg_attribute a on a.attrelid = c.oid and a.attnum = any (i.indkey)
          where i.indisunique and c.relnamespace = 'public'::regnamespace
            and a.attname in ('property_address', 'display_name', 'phone_e164', 'email',
                              'from_address', 'from_e164', 'to_e164', 'postcode', 'title_number')`,
      ),
    ).toBe(0);
  });

  it('neither firm’s users can read the other’s matter, calls, emails, attachments, events or objects', async () => {
    const a = await populate(seed.firm.id, aMatter.id, `iso-a-${randomUUID()}`);
    const b = await populate(firmB.id, bMatterId, `iso-b-${randomUUID()}`);

    const visible = async (db: typeof aClient, table: string) => {
      const result = await db.from(table).select('id');
      if (result.error !== null) throw new Error(`${table}: ${result.error.message}`);
      return (result.data as { id: string }[]).map((r) => r.id);
    };
    const mine = {
      a: {
        matters: aMatter.id,
        calls: a.callId,
        emails: a.emailId,
        attachments: a.attachmentId,
      },
      b: { matters: bMatterId, calls: b.callId, emails: b.emailId, attachments: b.attachmentId },
    };
    for (const table of ['matters', 'calls', 'emails', 'attachments'] as const) {
      const seenByA = await visible(aClient, table);
      const seenByB = await visible(bClient, table);
      expect(seenByA, `A reads ${table}`).toContain(mine.a[table]);
      expect(seenByA, `A reads B's ${table}`).not.toContain(mine.b[table]);
      expect(seenByB, `B reads ${table}`).toContain(mine.b[table]);
      expect(seenByB, `B reads A's ${table}`).not.toContain(mine.a[table]);
    }
    const eventsA = await visible(aClient, 'events');
    const eventsB = await visible(bClient, 'events');
    expect(eventsA.length).toBeGreaterThan(0);
    expect(eventsB.length).toBeGreaterThan(0);
    expect(eventsA.filter((id) => eventsB.includes(id))).toEqual([]);
    expect(b.eventIds.some((id) => eventsA.includes(id))).toBe(false);
    expect(a.eventIds.some((id) => eventsB.includes(id))).toBe(false);

    // The stored email: its own firm can read it, the other cannot.
    expect((await aClient.storage.from('emails').download(a.objectPath)).error).toBeNull();
    expect((await bClient.storage.from('emails').download(a.objectPath)).error).not.toBeNull();
    expect((await aClient.storage.from('emails').download(b.objectPath)).error).not.toBeNull();
  });

  it('a login that belongs to two firms is not silently given one of them', async () => {
    const both = `both-${Date.now()}@example.org`;
    const made = await createFeeEarner(admin, {
      firmId: seed.firm.id,
      email: both,
      password: PASSWORD,
    });
    if (!made.ok) throw new Error(made.error.message);
    await run(
      owner,
      `insert into firm_users (firm_id, user_id, role) values ($1, $2, 'fee_earner')`,
      [firmB.id, made.value.userId],
      { commit: true },
    );
    const session = await getSessionFirm(await signedInClient(env, both, PASSWORD));
    expect(session.ok).toBe(false);
    expect(!session.ok && session.error.code).toBe('ambiguous_firm');
    const single = await getSessionFirm(bClient);
    expect(single.ok && single.value?.firm.id).toBe(firmB.id);
  });
});

describe('inbound routing follows the number dialled and the slug addressed, never who is calling or writing', () => {
  const callFixture = (name: string, to: string, from: string) => {
    const f = loadFixture(name);
    return {
      ...f,
      request: {
        ...f.request,
        params: { ...f.request.params, To: to, Called: to, From: from, Caller: from },
      },
    };
  };
  const callTo = async (line: string, from: string) => {
    const vars = newVars();
    const first = await replayFixture(callFixture('voice-incoming.armstrong', line, from), {
      env,
      vars,
    });
    const second = await replayFixture(callFixture('voice-announced.armstrong', line, from), {
      env,
      vars,
    });
    return { vars, first, second };
  };

  it('a call to firm A’s line from someone who is also a participant on firm B’s matter lands on A only', async () => {
    const before = await count(`select count(*) n from calls where matter_id = $1`, [bMatterId]);
    const { vars, first, second } = await callTo(aMatter.line, SHARED.phone);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // It rings A's fee earner, not B's.
    expect(second.body).toContain(`<Number>${seed.feeEarner.phoneE164}</Number>`);
    expect(second.body).not.toContain(bFeeEarnerPhone);

    const rows = await run<{ firm_id: string; matter_id: string }>(
      owner,
      `select firm_id, matter_id from calls where call_sid = $1`,
      [vars['callSid']],
    );
    expect(rows).toEqual([{ firm_id: seed.firm.id, matter_id: aMatter.id }]);
    expect(await count(`select count(*) n from calls where matter_id = $1`, [bMatterId])).toBe(
      before,
    );
    expect(
      await count(
        `select count(*) n from events where matter_id = $1 and subject_id in (select id from calls where call_sid = $2)`,
        [bMatterId, vars['callSid']],
      ),
    ).toBe(0);
  });

  it('and a call to firm B’s line from the same person lands on B only', async () => {
    const before = await count(`select count(*) n from calls where matter_id = $1`, [aMatter.id]);
    const { vars, second } = await callTo(bLine, SHARED.phone);
    expect(second.body).toContain(`<Number>${bFeeEarnerPhone}</Number>`);
    const rows = await run<{ matter_id: string }>(
      owner,
      `select matter_id from calls where call_sid = $1`,
      [vars['callSid']],
    );
    expect(rows).toEqual([{ matter_id: bMatterId }]);
    expect(await count(`select count(*) n from calls where matter_id = $1`, [aMatter.id])).toBe(
      before,
    );
  });

  const message = (from: string, to: string, messageId: string, extra = '') =>
    `From: Sam Shared <${from}>\nTo: ${to}\nSubject: Re: 14 Meadow Road\nMessage-ID: <${messageId}>\nDate: Thu, 08 Oct 2026 09:00:00 +0100\nMIME-Version: 1.0\nContent-Type: text/plain; charset=utf-8\n${extra}\nPlease confirm the exchange date.\n`;
  const deliverTo = async (
    target: 'a' | 'b',
    envelopeTo: string[],
    raw: string,
    from = SHARED.email,
  ) => {
    const vars =
      target === 'a'
        ? { ...newVars(), ...seedVars(seed), slug: aMatter.slug }
        : {
            ...newVars(),
            slug: bSlug,
            mailDomain: firmB.mailDomain,
            inboundKeyId: bKey.keyId,
            inboundSecret: bKey.secret,
          };
    return replaySendgrid(loadSendgridFixture('inbound-email.client-first'), {
      env,
      vars,
      fields: { envelope: JSON.stringify({ to: envelopeTo, from }) },
      email: raw,
    });
  };
  const emailsOn = (matterId: string, messageId: string) =>
    count(`select count(*) n from emails where matter_id = $1 and message_id = $2`, [
      matterId,
      messageId,
    ]);

  it('an email to firm A’s slug from someone who is also a participant on firm B’s matter lands on A only', async () => {
    const messageId = `${randomUUID()}@shared.example.org`;
    const result = await deliverTo(
      'a',
      [`${aMatter.slug}@${aDomain()}`],
      message(SHARED.email, `${aMatter.slug}@${aDomain()}`, messageId),
    );
    expect(result.status).toBe(200);
    expect(await emailsOn(aMatter.id, messageId)).toBe(1);
    expect(await emailsOn(bMatterId, messageId)).toBe(0);
    expect(
      await count(`select count(*) n from emails where firm_id = $1 and message_id = $2`, [
        firmB.id,
        messageId,
      ]),
    ).toBe(0);
  });

  it('firm A’s credential cannot file onto firm B’s matter, and neither can B’s onto A’s', async () => {
    const aAddress = `${aMatter.slug}@${aDomain()}`;
    const bAddress = `${bSlug}@${firmB.mailDomain}`;
    // Through A's endpoint, addressed to both: only A's matter is filed on.
    const viaA = `${randomUUID()}@both.example.org`;
    await deliverTo('a', [aAddress, bAddress], message(SHARED.email, aAddress, viaA));
    expect(await emailsOn(aMatter.id, viaA)).toBe(1);
    expect(await emailsOn(bMatterId, viaA)).toBe(0);
    // Through B's endpoint, the same: only B's.
    const viaB = `${randomUUID()}@both.example.org`;
    await deliverTo('b', [aAddress, bAddress], message(SHARED.email, bAddress, viaB));
    expect(await emailsOn(bMatterId, viaB)).toBe(1);
    expect(await emailsOn(aMatter.id, viaB)).toBe(0);
  });
});

describe('another firm’s real slug is just an unknown address', () => {
  it('sent under the right firm’s own domain through its own credential, it files nothing and names no one', async () => {
    const messageId = `${randomUUID()}@probe.example.org`;
    const raw = `From: Probe <probe@example.org>\nTo: x@example.org\nSubject: probe\nMessage-ID: <${messageId}>\nDate: Thu, 08 Oct 2026 09:00:00 +0100\nMIME-Version: 1.0\nContent-Type: text/plain; charset=utf-8\n\nprobe\n`;
    const before = await count(`select count(*) n from audit_log where action = 'email.unrouted'`);
    const result = await replaySendgrid(loadSendgridFixture('inbound-email.client-first'), {
      env,
      vars: { ...newVars(), ...seedVars(seed), slug: aMatter.slug },
      // B's REAL slug, at A's mail domain, through A's credential.
      fields: {
        envelope: JSON.stringify({ to: [`${bSlug}@${aDomain()}`], from: 'probe@example.org' }),
      },
      email: raw,
    });
    expect(result.status).toBe(200);
    expect(await count(`select count(*) n from emails where message_id = $1`, [messageId])).toBe(0);
    expect(await count(`select count(*) n from audit_log where action = 'email.unrouted'`)).toBe(
      before + 1,
    );
    const audit = await run(owner, `select detail from audit_log order by id desc limit 1`);
    expect(JSON.stringify(audit)).not.toContain(bSlug);
  });
});

describe('an email from one firm’s matter address to the other’s is captured once on each side', () => {
  it('each copy belongs to its own firm, with its own objects, threads and audit', async () => {
    const aAddress = `${aMatter.slug}@${aDomain()}`;
    const bAddress = `${bSlug}@${firmB.mailDomain}`;
    const messageId = `${randomUUID()}@crossing.example.org`;
    // Sent from A's matter address, to B's, copying A's: the same bytes reach both firms' receivers.
    const base = eml('with-attachments')
      .replace(/^From:.*$/m, `From: Armstrong & Co <${aAddress}>`)
      .replace(/^To:.*$/m, `To: ${bAddress}`)
      .replace(/^Message-ID:.*$/m, `Message-ID: <${messageId}>\nCc: ${aAddress}`);
    const viaA = {
      ...newVars(),
      ...seedVars(seed),
      slug: aMatter.slug,
    };
    const viaB = {
      ...newVars(),
      slug: bSlug,
      mailDomain: firmB.mailDomain,
      inboundKeyId: bKey.keyId,
      inboundSecret: bKey.secret,
    };
    const fixture = loadSendgridFixture('inbound-email.with-attachments');
    const deliver = (vars: Record<string, string>, to: string) =>
      replaySendgrid(fixture, {
        env,
        vars,
        fields: { envelope: JSON.stringify({ to: [to], from: aAddress }) },
        email: base,
      });

    expect((await deliver(viaA, aAddress)).status).toBe(200);
    expect((await deliver(viaB, bAddress)).status).toBe(200);
    // Each side redelivers: still once.
    expect((await deliver(viaA, aAddress)).status).toBe(200);
    expect((await deliver(viaB, bAddress)).status).toBe(200);

    const rows = await run<{
      id: string;
      firm_id: string;
      matter_id: string;
      raw_storage_path: string;
    }>(
      owner,
      `select id, firm_id, matter_id, raw_storage_path from emails where message_id = $1 order by firm_id`,
      [messageId],
    );
    expect(rows).toHaveLength(2);
    const a = rows.find((r) => r.firm_id === seed.firm.id);
    const b = rows.find((r) => r.firm_id === firmB.id);
    expect(a?.matter_id).toBe(aMatter.id);
    expect(b?.matter_id).toBe(bMatterId);
    expect(a?.id).not.toBe(b?.id);
    expect(a?.raw_storage_path.startsWith(`${seed.firm.id}/${aMatter.id}/`)).toBe(true);
    expect(b?.raw_storage_path.startsWith(`${firmB.id}/${bMatterId}/`)).toBe(true);

    // The attachments are two rows and two objects. Identical bytes are not deduplicated across firms.
    const attachments = await run<{
      firm_id: string;
      email_id: string;
      storage_path: string;
      sha256: string;
    }>(
      owner,
      `select firm_id, email_id, storage_path, sha256 from attachments where email_id = any($1)`,
      [rows.map((r) => r.id)],
    );
    const ofA = attachments.filter((x) => x.email_id === a?.id);
    const ofB = attachments.filter((x) => x.email_id === b?.id);
    expect(ofA.length).toBeGreaterThan(0);
    expect(ofA.length).toBe(ofB.length);
    expect(
      ofA.every(
        (x) =>
          x.firm_id === seed.firm.id && x.storage_path.startsWith(`${seed.firm.id}/${aMatter.id}/`),
      ),
    ).toBe(true);
    expect(
      ofB.every(
        (x) => x.firm_id === firmB.id && x.storage_path.startsWith(`${firmB.id}/${bMatterId}/`),
      ),
    ).toBe(true);
    expect(ofA.map((x) => x.storage_path).some((p) => ofB.some((y) => y.storage_path === p))).toBe(
      false,
    );
    for (const x of ofA) {
      expect((await aClient.storage.from('attachments').download(x.storage_path)).error).toBeNull();
      expect(
        (await bClient.storage.from('attachments').download(x.storage_path)).error,
      ).not.toBeNull();
    }

    // One event for each capture, each in its own firm.
    expect(
      await count(
        `select count(*) n from events where kind = 'email.received' and subject_id = $1 and firm_id = $2`,
        [a?.id, seed.firm.id],
      ),
    ).toBe(1);
    expect(
      await count(
        `select count(*) n from events where kind = 'email.received' and subject_id = $1 and firm_id = $2`,
        [b?.id, firmB.id],
      ),
    ).toBe(1);
    expect(
      await count(`select count(*) n from events where subject_id = $1 and firm_id <> $2`, [
        a?.id,
        seed.firm.id,
      ]),
    ).toBe(0);
  });

  it('a reply on one side that names a message held only by the other side is not threaded onto it', async () => {
    const aAddress = `${aMatter.slug}@${aDomain()}`;
    const bAddress = `${bSlug}@${firmB.mailDomain}`;
    const root = `${randomUUID()}@thread.example.org`;
    const childOfA = `${randomUUID()}@thread.example.org`;
    const reply = `${randomUUID()}@thread.example.org`;
    const withHeaders = (id: string, to: string, inReplyTo?: string, references?: string) =>
      `From: Sam Shared <${SHARED.email}>\nTo: ${to}\nSubject: thread\nMessage-ID: <${id}>\n${
        inReplyTo === undefined ? '' : `In-Reply-To: <${inReplyTo}>\n`
      }${references === undefined ? '' : `References: ${references}\n`}Date: Thu, 08 Oct 2026 10:00:00 +0100\nMIME-Version: 1.0\nContent-Type: text/plain; charset=utf-8\n\nbody\n`;
    const fixture = loadSendgridFixture('inbound-email.client-first');
    const to = (target: 'a' | 'b', raw: string) =>
      replaySendgrid(fixture, {
        env,
        vars:
          target === 'a'
            ? { ...newVars(), ...seedVars(seed), slug: aMatter.slug }
            : {
                ...newVars(),
                slug: bSlug,
                mailDomain: firmB.mailDomain,
                inboundKeyId: bKey.keyId,
                inboundSecret: bKey.secret,
              },
        fields: {
          envelope: JSON.stringify({
            to: [target === 'a' ? aAddress : bAddress],
            from: SHARED.email,
          }),
        },
        email: raw,
      });
    await to('a', withHeaders(root, aAddress));
    await to('a', withHeaders(childOfA, aAddress, root, `<${root}>`));
    // On B, a reply to A's child message: B holds neither it nor its root.
    await to('b', withHeaders(reply, bAddress, childOfA));

    const thread = await run<{ thread_key: string; matter_id: string }>(
      owner,
      `select t.thread_key, t.matter_id from email_threads t join emails e on e.id = t.email_id
        where e.message_id = $1`,
      [reply],
    );
    // Its thread is what its own headers say. Had the walk crossed into A's matter it would have
    // climbed to A's root.
    expect(thread).toEqual([{ thread_key: childOfA, matter_id: bMatterId }]);
    // And each firm's view of threads holds only its own firm's matters.
    const mattersOf = async (firmId: string) =>
      (await run<{ id: string }>(owner, `select id from matters where firm_id = $1`, [firmId])).map(
        (m) => m.id,
      );
    const [aMatters, bMatters] = [await mattersOf(seed.firm.id), await mattersOf(firmB.id)];
    const seenByB = await bClient.from('email_threads').select('matter_id');
    const seenByA = await aClient.from('email_threads').select('matter_id');
    const idsB = (seenByB.data as { matter_id: string }[]).map((r) => r.matter_id);
    const idsA = (seenByA.data as { matter_id: string }[]).map((r) => r.matter_id);
    expect(idsB.length).toBeGreaterThan(0);
    expect(idsA.length).toBeGreaterThan(0);
    expect(idsB.every((id) => bMatters.includes(id))).toBe(true);
    expect(idsA.every((id) => aMatters.includes(id))).toBe(true);
  });

  it('the audit entry for the same unroutable bytes is written for each firm that received them', async () => {
    const raw = message2(`${randomUUID()}@unrouted.example.org`);
    const before = await count(`select count(*) n from audit_log where action = 'email.unrouted'`);
    const fixture = loadSendgridFixture('inbound-email.client-first');
    const send = (vars: Record<string, string>) =>
      replaySendgrid(fixture, {
        env,
        vars,
        fields: {
          envelope: JSON.stringify({ to: ['nobody@elsewhere.example.org'], from: SHARED.email }),
        },
        email: raw,
      });
    await send({ ...newVars(), ...seedVars(seed), slug: aMatter.slug });
    await send({
      ...newVars(),
      slug: bSlug,
      mailDomain: firmB.mailDomain,
      inboundKeyId: bKey.keyId,
      inboundSecret: bKey.secret,
    });
    expect(await count(`select count(*) n from audit_log where action = 'email.unrouted'`)).toBe(
      before + 2,
    );
    const firms = await run<{ firm_id: string }>(
      owner,
      `select firm_id from audit_log where action = 'email.unrouted' order by id desc limit 2`,
    );
    expect(new Set(firms.map((f) => f.firm_id))).toEqual(new Set([seed.firm.id, firmB.id]));
  });
});

const message2 = (id: string) =>
  `From: Sam Shared <${SHARED.email}>\nTo: nobody@elsewhere.example.org\nSubject: lost\nMessage-ID: <${id}>\nDate: Thu, 08 Oct 2026 09:00:00 +0100\nMIME-Version: 1.0\nContent-Type: text/plain; charset=utf-8\n\nlost\n`;

/** Records exactly what the pipeline hands to the provider interfaces. */
class SpyTranscriber implements Transcriber {
  readonly name = 'spy';
  readonly inputs: AudioInput[] = [];
  segments: Segment[] = [];
  transcribe(audio: AudioInput): Promise<TranscribeResult> {
    this.inputs.push(audio);
    return Promise.resolve({
      segments: this.segments,
      language: 'en',
      provider: 'spy',
      model: 'spy-1',
      providerJobId: randomUUID(),
    });
  }
}
class SpySummariser implements Summariser {
  readonly name = 'spy';
  readonly promptVersion = 'spy-1';
  readonly inputs: SummariseInput[] = [];
  summarise(input: SummariseInput): Promise<SummariseResult> {
    this.inputs.push(structuredClone(input));
    return Promise.resolve({
      summary: SUMMARY,
      provider: 'spy',
      model: 'spy-1',
      promptVersion: this.promptVersion,
    });
  }
}

describe('summarising a call on one firm’s matter passes nothing from another firm to the provider', () => {
  const B_WORDS = 'Hollybush Close, the Bickerstaff retention, and Mr Quillfeather-B';
  const A_WORDS = 'the Armstrong searches and Mrs Whitfield-A';

  it('the input to the transcriber and the summariser is this call and nothing else', async () => {
    // One long-lived pair of providers, as a job runner has, used for firm B and then firm A.
    const transcriber = new SpyTranscriber();
    const summariser = new SpySummariser();
    const deps = depsFor(env, { transcriber, summariser });

    const bCall = await recordedCall(env, { firm: { id: firmB.id } });
    transcriber.segments = [
      { startSeconds: 0, channel: 0, text: `Hello, it is about ${B_WORDS}.` },
      { startSeconds: 3, channel: 1, text: 'Noted. I will write to the other side on Friday.' },
    ];
    expect((await transcribeRecording(deps, bCall.job)).status).toBe('summarised');

    const aCall = await recordedCall(env, seed);
    transcriber.segments = [
      { startSeconds: 0, channel: 0, text: `Hello, it is about ${A_WORDS}.` },
      { startSeconds: 3, channel: 1, text: 'Understood. I will chase them on Wednesday.' },
    ];
    const outcome = await transcribeRecording(deps, aCall.job);
    expect(outcome.status).toBe('summarised');

    // Assert on what went IN. A is the second call through the same providers.
    const audioA = transcriber.inputs[1];
    const inputA = summariser.inputs[1];
    expect(audioA).toBeDefined();
    expect(inputA).toBeDefined();
    if (audioA === undefined || inputA === undefined) return;

    // The audio is this recording's bytes, nothing else.
    const stored = await admin.storage.from('recordings').download(aCall.job.storagePath);
    const storedBytes = new Uint8Array(await (stored.data as Blob).arrayBuffer());
    expect(sha256(audioA.bytes)).toBe(sha256(storedBytes));
    expect(Object.keys(audioA).sort()).toEqual([
      'bytes',
      'channels',
      'durationSeconds',
      'mimeType',
    ]);

    // The summariser's input is exactly the call date, the channels and this call's words.
    expect(Object.keys(inputA).sort()).toEqual(['callDate', 'recordingChannels', 'segments']);
    expect(inputA.segments.map((s) => Object.keys(s).sort())).toEqual([
      ['speaker', 'startSeconds', 'text'],
      ['speaker', 'startSeconds', 'text'],
    ]);
    expect(inputA.segments.map((s) => s.text)).toEqual([
      `Hello, it is about ${A_WORDS}.`,
      'Understood. I will chase them on Wednesday.',
    ]);

    // Nothing that originated with firm B is in it, nor in the exact text the model would be sent.
    const toProvider = `${SYSTEM_PROMPT}\n${renderUserMessage(inputA)}\n${JSON.stringify(inputA)}`;
    for (const fromB of [
      'Hollybush',
      'Bickerstaff',
      'Quillfeather-B',
      'other side on Friday',
      firmB.name,
      firmB.mailDomain,
      bSlug,
      bLine,
      bFeeEarnerPhone,
      'MTR-2001',
      firmB.id,
      bMatterId,
    ]) {
      expect(toProvider, `B's ${fromB} reached the provider`).not.toContain(fromB);
    }
    // And no identifier of anyone, A's included, travels with it: the model sees words and dates.
    for (const identifier of [
      seed.firm.id,
      aMatter.id,
      aMatter.reference,
      seed.firm.name,
      aCall.callId,
    ]) {
      if (identifier !== '') expect(toProvider).not.toContain(identifier);
    }
    // The stored summary is A's own and is on A's matter.
    const out = await run<{ firm_id: string; matter_id: string }>(
      owner,
      `select firm_id, matter_id from generated_outputs where call_id = $1`,
      [aCall.callId],
    );
    expect(out).toEqual([{ firm_id: seed.firm.id, matter_id: aCall.matterId }]);
  });

  it('a recording row that points at another firm’s audio is refused before any provider sees it', async () => {
    const transcriber = new SpyTranscriber();
    const summariser = new SpySummariser();
    const aCall = await recordedCall(env, seed);
    const bCall = await recordedCall(env, { firm: { id: firmB.id } });
    expect(ownsObject(aCall.job, aCall.job.storagePath)).toBe(true);
    expect(ownsObject(aCall.job, bCall.job.storagePath)).toBe(false);

    const outcome = await transcribeRecording(depsFor(env, { transcriber, summariser }), {
      ...aCall.job,
      storagePath: bCall.job.storagePath,
    });
    expect(outcome.status).toBe('failed');
    expect(transcriber.inputs).toEqual([]);
    expect(summariser.inputs).toEqual([]);
  });
});

describe('the database refuses a link across firms, or across matters', () => {
  it('a correction cannot supersede a row on another matter, in another firm or in the same firm', async () => {
    const a = await populate(seed.firm.id, aMatter.id, `sup-a-${randomUUID()}`);
    const b = await populate(firmB.id, bMatterId, `sup-b-${randomUUID()}`);
    const sameFirmOtherMatter = (
      await run<{ id: string }>(
        owner,
        `insert into matters (firm_id, reference, kind, property_address)
         values ($1, $2, 'sale', $3) returning id`,
        [seed.firm.id, `ISO-${randomUUID()}`, ADDRESS],
        { commit: true },
      )
    )[0]?.id;
    const insertEmail = (firmId: string, matterId: string, supersedes: string) =>
      run(
        owner,
        `insert into emails (firm_id, matter_id, message_id, from_address, raw_storage_path, raw_sha256, supersedes_id)
         values ($1, $2, $3, 'x@example.org', $4, $5, $6)`,
        [
          firmId,
          matterId,
          `${randomUUID()}@sup.example.org`,
          `${firmId}/${matterId}/raw`,
          'c'.repeat(64),
          supersedes,
        ],
      );
    await expect(insertEmail(seed.firm.id, aMatter.id, b.emailId)).rejects.toThrow(/foreign key/);
    await expect(insertEmail(firmB.id, bMatterId, a.emailId)).rejects.toThrow(/foreign key/);
    await expect(insertEmail(seed.firm.id, sameFirmOtherMatter ?? '', a.emailId)).rejects.toThrow(
      /foreign key/,
    );
    // Its own matter is fine.
    await expect(insertEmail(seed.firm.id, aMatter.id, a.emailId)).resolves.toBeDefined();
  });

  it('a row cannot name one firm and another firm’s matter, in the evidence or the retention tables', async () => {
    await expect(
      run(
        owner,
        `insert into legal_holds (firm_id, matter_id, reason_code, placed_by)
         values ($1, $2, 'complaint', (select user_id from firm_users where firm_id = $1 limit 1))`,
        [seed.firm.id, bMatterId],
      ),
    ).rejects.toThrow(/foreign key/);
    await expect(
      run(
        owner,
        `insert into erasure_requests (firm_id, matter_id, requested_by)
         values ($1, $2, (select user_id from firm_users where firm_id = $1 limit 1))`,
        [firmB.id, aMatter.id],
      ),
    ).rejects.toThrow(/foreign key/);
    await expect(
      run(
        owner,
        `insert into calls (firm_id, matter_id, call_sid, from_e164, to_e164, started_at,
                            consent_announcement_version, consent_outcome, consent_given_at)
         values ($1, $2, $3, '+447700900778', '+442079460900', now(), 't', 'given', now())`,
        [firmB.id, aMatter.id, `CA${randomUUID().replaceAll('-', '')}`],
      ),
    ).rejects.toThrow(/foreign key/);
  });

  it('a row cannot point at an object outside its own matter’s folder', async () => {
    const call = await recordedCall(env, seed);
    const other = await recordedCall(env, { firm: { id: firmB.id } });
    await expect(
      run(
        owner,
        `insert into call_recordings (firm_id, matter_id, call_id, twilio_recording_sid, storage_path, sha256,
                                      byte_length, duration_seconds, channels)
         values ($1, $2, $3, $4, $5, $6, 10, 100, 2)`,
        [
          call.firmId,
          call.matterId,
          call.callId,
          `RE${randomUUID().replaceAll('-', '')}`,
          other.job.storagePath,
          'd'.repeat(64),
        ],
      ),
    ).rejects.toThrow(/check constraint/);
  });
});
