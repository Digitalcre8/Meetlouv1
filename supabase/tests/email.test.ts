import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordUncapturedEmail } from '@meetlou/records';
import { createFeeEarner, createFirm, createInboundEmailKey } from '@meetlou/records/admin';
import {
  FIXTURES_DIR,
  functionLogs,
  loadSendgridFixture,
  localEnv,
  newVars,
  replaySendgrid,
  seedArmstrong,
  seedVars,
  serveFunctions,
  serviceClient,
  signedInClient,
  stopFunctions,
  toCrlf,
} from '@meetlou/harness';
import type { SeedResult } from '@meetlou/harness';
import { INBOUND_EMAIL_LIMITATION } from '@meetlou/domain';
import { pool, run } from './db';

/**
 * SendGrid Inbound Parse receiver, end to end and offline: the real Deno entrypoint, fixtures
 * replayed as Inbound Parse would POST them, the real Storage API and the real database.
 */
const env = localEnv();
const owner = { role: 'owner' } as const;
const admin = serviceClient(env);
let seed: SeedResult;

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const eml = (name: string) => readFileSync(`${FIXTURES_DIR}sendgrid/messages/${name}.eml`, 'utf8');

beforeAll(async () => {
  seed = await seedArmstrong(env);
  await serveFunctions(env);
}, 240_000);

afterAll(async () => {
  if (process.env['KEEP_FUNCTIONS'] === undefined) stopFunctions();
  await pool.end();
});

type Overrides = Record<string, string>;
const varsFor = (overrides: Overrides = {}) => ({ ...newVars(), ...seedVars(seed), ...overrides });

async function deliver(
  fixture: string,
  overrides: Overrides = {},
  options: Parameters<typeof replaySendgrid>[1] extends infer O
    ? Partial<Omit<Extract<O, object>, 'env' | 'vars'>>
    : never = {},
) {
  const vars = varsFor(overrides);
  const result = await replaySendgrid(loadSendgridFixture(fixture), { env, vars, ...options });
  return { vars, result };
}

interface EmailRow {
  id: string;
  firm_id: string;
  matter_id: string;
  message_id: string;
  message_id_synthesised: boolean;
  in_reply_to: string | null;
  references_ids: string[];
  from_address: string;
  to_addresses: string[];
  cc_addresses: string[];
  subject: string | null;
  sent_at: Date | null;
  raw_storage_path: string;
  raw_sha256: string;
  body_text_storage_path: string | null;
  body_html_storage_path: string | null;
  spf_result: string | null;
  dkim_result: string | null;
}
const emailByMessageId = async (messageId: string, matterId = seed.matter.id) =>
  (
    await run<EmailRow>(owner, `select * from emails where matter_id = $1 and message_id = $2`, [
      matterId,
      messageId,
    ])
  )[0];
const count = async (sql: string, params: unknown[] = []) =>
  Number((await run<{ n: string }>(owner, sql, params))[0]?.n ?? 0);
const totals = async () => ({
  emails: await count(`select count(*) n from emails`),
  attachments: await count(`select count(*) n from attachments`),
  events: await count(`select count(*) n from events`),
  audit: await count(`select count(*) n from audit_log`),
});
const objects = async (bucket: 'emails' | 'attachments') => {
  const root = `${seed.firm.id}/${seed.matter.id}`;
  if (bucket === 'attachments')
    return ((await admin.storage.from(bucket).list(root)).data ?? []).length;
  const dirs = (await admin.storage.from(bucket).list(root)).data ?? [];
  return dirs.length;
};
const threadKey = async (emailId: string) =>
  (
    await run<{ thread_key: string }>(
      owner,
      `select thread_key from email_threads where email_id = $1`,
      [emailId],
    )
  )[0]?.thread_key;
const eventKinds = async (subjectId: string) =>
  (
    await run<{ kind: string }>(
      owner,
      `select kind from events where subject_id = $1 order by kind`,
      [subjectId],
    )
  ).map((e) => e.kind);

describe('inbound email: a well-formed message', () => {
  it('lands on the right matter, with the provider verdicts and the raw message kept', async () => {
    const { vars, result } = await deliver('inbound-email.client-first');
    expect(result.status).toBe(200);

    const row = await emailByMessageId(vars['messageId'] ?? '');
    expect(row).toMatchObject({
      firm_id: seed.firm.id,
      matter_id: seed.matter.id,
      message_id_synthesised: false,
      in_reply_to: null,
      references_ids: [],
      from_address: 'sarah.whitfield@example.org',
      to_addresses: [seed.inboundAddress],
      subject: 'Mortgage offer and deposit for 14 Meadow Road',
      // SPF and DKIM are evidence on the row, exactly as the provider reported them.
      spf_result: 'pass',
      dkim_result: '{@example.org : pass}',
    });
    expect(row?.sent_at?.toISOString()).toBe('2026-10-08T08:15:00.000Z');

    // The unmodified message is in the private bucket, byte for byte, and its hash is on the row.
    const rawBytes = toCrlf(
      eml('client-first')
        .replaceAll('{{messageId}}', vars['messageId'] ?? '')
        .replaceAll('{{slug}}', vars['slug'] ?? '')
        .replaceAll('{{mailDomain}}', vars['mailDomain'] ?? ''),
    );
    expect(row?.raw_sha256).toBe(sha256(rawBytes));
    expect(row?.raw_storage_path).toBe(
      `${seed.firm.id}/${seed.matter.id}/${sha256(vars['messageId'] ?? '')}/raw.eml`,
    );
    const stored = await admin.storage.from('emails').download(row?.raw_storage_path ?? '');
    expect(stored.error).toBeNull();
    expect(await stored.data?.text()).toBe(rawBytes);

    // Bodies are stored as plain text, never as a page, even the HTML one (which contains a script).
    expect(row?.body_text_storage_path).toMatch(/\/body\.txt$/);
    expect(row?.body_html_storage_path).toMatch(/\/body\.html$/);
    const listing =
      (
        await admin.storage
          .from('emails')
          .list(`${seed.firm.id}/${seed.matter.id}/${sha256(vars['messageId'] ?? '')}`)
      ).data ?? [];
    expect(
      listing.map((o) => [o.name, (o.metadata as { mimetype: string }).mimetype]).sort(),
    ).toEqual([
      ['body.html', 'text/plain'],
      ['body.txt', 'text/plain'],
      ['raw.eml', 'message/rfc822'],
    ]);

    expect(await eventKinds(row?.id ?? '')).toEqual(['email.received']);
  });

  it('stores failing SPF and DKIM verdicts verbatim: they are evidence, not log lines', async () => {
    const { vars } = await deliver('inbound-email.forwarded');
    const row = await emailByMessageId(vars['messageId'] ?? '');
    expect(row).toMatchObject({ spf_result: 'softfail', dkim_result: '{@example.org : fail}' });
  });

  it('routes on the envelope recipient, not the To header', async () => {
    const { vars, result } = await deliver('inbound-email.forwarded');
    expect(result.status).toBe(200);
    const row = await emailByMessageId(vars['messageId'] ?? '');
    expect(row?.to_addresses).toEqual(['somebody.else@example.com']); // what the header said
    expect(row?.matter_id).toBe(seed.matter.id); // where the envelope said it went
  });

  it('files a message addressed to two matters on both', async () => {
    const other = await run<{ id: string; inbound_slug: string }>(
      { role: 'service_role' },
      `insert into matters (firm_id, reference, kind, property_address)
       values ($1, $2, 'sale', '9 Second Street, Testville') returning id, inbound_slug`,
      [seed.firm.id, `EMAIL-${randomUUID()}`],
      { commit: true },
    );
    const second = other[0];
    const envelope = JSON.stringify({
      to: [
        `${seed.matter.inbound_slug}@${seed.firm.mail_domain}`,
        `${second?.inbound_slug}@${seed.firm.mail_domain}`,
      ],
      from: 'sarah.whitfield@example.org',
    });
    const { vars, result } = await deliver(
      'inbound-email.client-first',
      {},
      { fields: { envelope } },
    );
    expect(result.status).toBe(200);
    expect(await emailByMessageId(vars['messageId'] ?? '')).toBeDefined();
    expect(await emailByMessageId(vars['messageId'] ?? '', second?.id ?? '')).toBeDefined();
  });

  it('flags and synthesises a Message-ID when there is none, and stays idempotent', async () => {
    const { vars } = await deliver('inbound-email.no-message-id');
    await deliver('inbound-email.no-message-id', { messageId: vars['messageId'] ?? '' });
    const rows = await run<EmailRow>(
      owner,
      `select * from emails where matter_id = $1 and message_id_synthesised and raw_sha256 = $2`,
      [
        seed.matter.id,
        sha256(
          toCrlf(
            eml('no-message-id')
              .replaceAll('{{messageId}}', vars['messageId'] ?? '')
              .replaceAll('{{slug}}', vars['slug'] ?? '')
              .replaceAll('{{mailDomain}}', vars['mailDomain'] ?? ''),
          ),
        ),
      ],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.message_id).toMatch(/^[0-9a-f]{64}@meetlou\.invalid$/);
  });
});

describe('inbound email: threading never uses the subject', () => {
  it('a reply with a changed subject line threads onto the same matter and thread', async () => {
    const root = await deliver('inbound-email.client-first');
    const rootId = root.vars['messageId'] ?? '';
    const reply = await deliver('inbound-email.agent-reply', {
      parentMessageId: rootId,
      rootMessageId: rootId,
    });
    expect(reply.result.status).toBe(200);

    const first = await emailByMessageId(rootId);
    const second = await emailByMessageId(reply.vars['messageId'] ?? '');
    expect(second?.subject).not.toBe(first?.subject); // the subject really did change
    expect(second?.matter_id).toBe(first?.matter_id);
    expect(second?.matter_id).toBe(seed.matter.id);
    expect(second?.in_reply_to).toBe(rootId);
    expect(second?.references_ids).toEqual([rootId, rootId].slice(0, 1));
    expect(await threadKey(second?.id ?? '')).toBe(await threadKey(first?.id ?? ''));
    expect(await threadKey(first?.id ?? '')).toBe(rootId);
  });

  it('an unrelated message with the identical subject is a different thread', async () => {
    const root = await deliver('inbound-email.client-first');
    const stranger = await deliver('inbound-email.unrelated-same-subject');
    const a = await emailByMessageId(root.vars['messageId'] ?? '');
    const b = await emailByMessageId(stranger.vars['messageId'] ?? '');
    expect(a?.subject).toBe(b?.subject);
    expect(await threadKey(a?.id ?? '')).not.toBe(await threadKey(b?.id ?? ''));
  });

  it('a reply that arrives before its parent still threads with it once the parent lands', async () => {
    const rootId = `${randomUUID()}@mail.example.org`;
    const reply = await deliver('inbound-email.agent-reply', {
      parentMessageId: rootId,
      rootMessageId: rootId,
    });
    const replyRow = await emailByMessageId(reply.vars['messageId'] ?? '');
    expect(await threadKey(replyRow?.id ?? '')).toBe(rootId); // names its thread before the parent exists

    const parent = await deliver('inbound-email.client-first', { messageId: rootId });
    expect(parent.result.status).toBe(200);
    const parentRow = await emailByMessageId(rootId);
    expect(await threadKey(parentRow?.id ?? '')).toBe(await threadKey(replyRow?.id ?? ''));
  });

  it('a reply carrying only In-Reply-To joins the root once the message it answers arrives', async () => {
    const a = `${randomUUID()}@mail.example.org`;
    const b = `${randomUUID()}@mail.example.org`;
    const c = `${randomUUID()}@mail.example.org`;
    const onlyInReplyTo = eml('agent-reply')
      .replace(/^References:.*\n/m, '')
      .replace('{{parentMessageId}}', b);

    // C answers B but carries no References; B is not here yet.
    await deliver('inbound-email.agent-reply', { messageId: c }, { email: onlyInReplyTo });
    const cRow = await emailByMessageId(c);
    expect(await threadKey(cRow?.id ?? '')).toBe(b);

    // B (a reply in A's thread) and A arrive afterwards: C now belongs to A's thread, no row updated.
    await deliver('inbound-email.agent-reply', {
      messageId: b,
      parentMessageId: a,
      rootMessageId: a,
    });
    await deliver('inbound-email.client-first', { messageId: a });
    expect(await threadKey(cRow?.id ?? '')).toBe(a);
  });
});

describe('inbound email: idempotent on Message-ID', () => {
  it('the same Message-ID twice produces one row, one set of objects, one event', async () => {
    const vars = varsFor();
    const before = await totals();
    for (let i = 0; i < 3; i++) {
      const result = await replaySendgrid(loadSendgridFixture('inbound-email.client-first'), {
        env,
        vars,
      });
      expect(result.status).toBe(200);
    }
    const after = await totals();
    expect(after.emails).toBe(before.emails + 1);
    expect(after.events).toBe(before.events + 1);
    expect(after.audit).toBe(before.audit + 1); // one capture, one audit row; identical bytes are not worth a flag

    const row = await emailByMessageId(vars['messageId'] ?? '');
    const listing =
      (
        await admin.storage
          .from('emails')
          .list(`${seed.firm.id}/${seed.matter.id}/${sha256(vars['messageId'] ?? '')}`)
      ).data ?? [];
    expect(listing).toHaveLength(3); // raw, text, html: once each
    expect(await eventKinds(row?.id ?? '')).toEqual(['email.received']);
  });

  it('flags, once, a Message-ID that comes back with different bytes, and keeps the first', async () => {
    const first = await deliver('inbound-email.client-first');
    const messageId = first.vars['messageId'] ?? '';
    const original = await emailByMessageId(messageId);
    const altered = eml('client-first').replace(
      'Please confirm the deposit amount.',
      'Please send the deposit to this new account.',
    );
    for (let i = 0; i < 2; i++) {
      const result = await replaySendgrid(loadSendgridFixture('inbound-email.client-first'), {
        env,
        vars: first.vars,
        email: altered,
      });
      expect(result.status).toBe(200);
    }
    const rows = await run<{ id: string; raw_sha256: string }>(
      owner,
      `select id, raw_sha256 from emails where matter_id = $1 and message_id = $2`,
      [seed.matter.id, messageId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.raw_sha256).toBe(original?.raw_sha256);
    const audit = await run<{ detail: Record<string, string> }>(
      owner,
      `select detail from audit_log where action = 'email.duplicate_mismatch' and firm_id = $1 order by id desc limit 5`,
      [seed.firm.id],
    );
    expect(
      audit.filter((a) => a.detail['reason'] === 'same_message_id_different_bytes').length,
    ).toBeGreaterThanOrEqual(1);
    expect(new Set(audit.map((a) => a.detail['email_sha256'])).size).toBe(audit.length); // one per distinct message
  });
});

describe('inbound email: the URL path is the credential', () => {
  const flip = (s: string) => `${s.slice(0, -1)}${s.endsWith('0') ? '1' : '0'}`;

  it('one wrong character in the secret returns 404 and writes nothing', async () => {
    const before = await totals();
    const objectsBefore = {
      emails: await objects('emails'),
      attachments: await objects('attachments'),
    };
    const wrongPaths = [
      `/${seed.inboundEmail.keyId}/${flip(seed.inboundEmail.secret)}`, // last character
      `/${seed.inboundEmail.keyId}/${seed.inboundEmail.secret.replace(/^./, (c) => (c === 'a' ? 'b' : 'a'))}`, // first
      `/${seed.inboundEmail.keyId}/${seed.inboundEmail.secret.slice(0, -1)}`, // one short
      `/${seed.inboundEmail.keyId}/${seed.inboundEmail.secret}0`, // one long
      `/${seed.inboundEmail.keyId}/${seed.inboundEmail.secret.toUpperCase()}`, // case
      `/${randomUUID()}/${seed.inboundEmail.secret}`, // right secret, unknown key id
      `/${seed.inboundEmail.keyId}/`, // no secret
      `/${seed.inboundEmail.secret}`, // no key id
    ];
    for (const path of wrongPaths) {
      const { result } = await deliver('inbound-email.client-first', {}, { path });
      expect(result.status, path).toBe(404);
      expect(result.body).toBe('Not Found');
    }
    expect(await totals()).toEqual(before);
    expect({ emails: await objects('emails'), attachments: await objects('attachments') }).toEqual(
      objectsBefore,
    );
  });

  it('a revoked key stops working at once, and the old one can coexist while it is live', async () => {
    const fresh = await createInboundEmailKey(admin, seed.firm.id);
    if (!fresh.ok) throw new Error(fresh.error.message);
    const asPath = fresh.value.urlPath;
    const live = await deliver('inbound-email.client-first', {}, { path: asPath });
    expect(live.result.status).toBe(200);
    const original = await deliver('inbound-email.client-first');
    expect(original.result.status).toBe(200); // rotation has no gap

    await run(
      { role: 'service_role' },
      `update inbound_email_keys set revoked_at = now() where id = $1`,
      [fresh.value.keyId],
      { commit: true },
    );
    const before = await totals();
    const revoked = await deliver('inbound-email.client-first', {}, { path: asPath });
    expect(revoked.result.status).toBe(404);
    expect(await totals()).toEqual(before);
  });

  it('answers a GET at the right URL with 405 and at a wrong one with 404', async () => {
    const good = await deliver('inbound-email.client-first', {}, { method: 'GET' });
    expect(good.result.status).toBe(405);
    const bad = await deliver(
      'inbound-email.client-first',
      {},
      { method: 'GET', path: `/${randomUUID()}/${'0'.repeat(64)}` },
    );
    expect(bad.result.status).toBe(404);
  });

  it('never logs the secret, the key id, or anything from the message', async () => {
    await deliver('inbound-email.client-first');
    await deliver(
      'inbound-email.client-first',
      {},
      { path: `/${seed.inboundEmail.keyId}/${flip(seed.inboundEmail.secret)}` },
    );
    await deliver('inbound-email.unknown-slug');
    const logs = functionLogs('sendgrid-inbound');
    expect(logs).toContain('email_stored');
    for (const secretish of [
      seed.inboundEmail.secret,
      seed.inboundEmail.secret.slice(0, 16),
      seed.inboundEmail.keyId,
      sha256(seed.inboundEmail.secret),
      'sarah.whitfield@example.org',
      'Mortgage offer',
      'deposit',
      seed.matter.inbound_slug,
    ]) {
      expect(logs.includes(secretish), `log contains ${secretish.slice(0, 12)}...`).toBe(false);
    }
  });

  it('mints a secret once and keeps only its hash; the COLP cannot read even that', async () => {
    const created = await createInboundEmailKey(admin, seed.firm.id);
    if (!created.ok) throw new Error(created.error.message);
    const { keyId, secret } = created.value;
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    const row = await run<{ secret_sha256: string }>(
      owner,
      `select secret_sha256 from inbound_email_keys where id = $1`,
      [keyId],
    );
    expect(row[0]?.secret_sha256).toBe(sha256(secret));
    const whole = await run<{ n: string }>(
      owner,
      `select count(*) n from inbound_email_keys k where k::text like '%' || $1 || '%'`,
      [secret],
    );
    expect(Number(whole[0]?.n)).toBe(0); // the secret itself is nowhere in the row
    const audit = await run<{ detail: unknown }>(
      owner,
      `select detail from audit_log where object_id = $1`,
      [keyId],
    );
    expect(JSON.stringify(audit)).not.toContain(secret);

    const email = `colp-${Date.now()}@example.org`;
    const colp = await createFeeEarner(admin, {
      firmId: seed.firm.id,
      email,
      password: 'a-long-enough-password',
      role: 'colp',
    });
    expect(colp.ok).toBe(true);
    const db = await signedInClient(env, email, 'a-long-enough-password');
    const visible = await db.from('inbound_email_keys').select('id, revoked_at');
    expect(visible.error).toBeNull();
    expect(visible.data?.length).toBeGreaterThan(0);
    const hash = await db.from('inbound_email_keys').select('secret_sha256');
    expect(hash.error).not.toBeNull();
  });
});

describe('inbound email: an unknown recipient', () => {
  it('returns 200 with an audit row and writes nothing else', async () => {
    const before = await totals();
    const objectsBefore = {
      emails: await objects('emails'),
      attachments: await objects('attachments'),
    };
    const { vars, result } = await deliver('inbound-email.unknown-slug');
    expect(result.status).toBe(200);

    const after = await totals();
    expect(after).toEqual({ ...before, audit: before.audit + 1 }); // no email, attachment or event
    expect({ emails: await objects('emails'), attachments: await objects('attachments') }).toEqual(
      objectsBefore,
    );
    expect(await emailByMessageId(vars['messageId'] ?? '')).toBeUndefined();

    const audit = await run<{ action: string; firm_id: string; detail: Record<string, string> }>(
      owner,
      `select action, firm_id, detail from audit_log order by id desc limit 1`,
    );
    expect(audit[0]).toMatchObject({
      action: 'email.unrouted',
      firm_id: seed.firm.id,
      detail: { reason: 'unknown_recipient', recipient_domain: seed.firm.mail_domain },
    });
    expect(audit[0]?.detail['email_sha256']).toMatch(/^[0-9a-f]{64}$/);
    // The mistyped local part is not recorded.
    expect(JSON.stringify(audit[0])).not.toContain('000000000000000000000000');
  });

  it('is audited once however often SendGrid redelivers it', async () => {
    const vars = varsFor();
    const before = await totals();
    for (let i = 0; i < 3; i++) {
      expect(
        (await replaySendgrid(loadSendgridFixture('inbound-email.unknown-slug'), { env, vars }))
          .status,
      ).toBe(200);
    }
    expect((await totals()).audit).toBe(before.audit + 1);
  });

  it("treats another firm's real slug exactly like a mistyped one, and does not record it", async () => {
    const otherFirm = await createFirm(admin, {
      name: `Other ${Date.now()}`,
      mailDomain: `other${Date.now()}.example.org`,
    });
    if (!otherFirm.ok) throw new Error(otherFirm.error.message);
    const matter = await run<{ inbound_slug: string }>(
      { role: 'service_role' },
      `insert into matters (firm_id, reference, kind, property_address) values ($1, 'X-1', 'sale', '5 Other Road, Elsewhere') returning inbound_slug`,
      [otherFirm.value.id],
      { commit: true },
    );
    const foreignSlug = matter[0]?.inbound_slug ?? '';
    const before = await totals();
    const envelope = JSON.stringify({
      to: [`${foreignSlug}@${seed.firm.mail_domain}`],
      from: 'probe@example.org',
    });
    const { result } = await deliver('inbound-email.client-first', {}, { fields: { envelope } });
    expect(result.status).toBe(200);
    expect(await totals()).toEqual({ ...before, audit: before.audit + 1 });
    const audit = await run(owner, `select detail from audit_log order by id desc limit 1`);
    expect(JSON.stringify(audit)).not.toContain(foreignSlug);
    expect(JSON.stringify(audit)).not.toContain(foreignSlug.slice(0, -4));

    // And the right slug at the wrong domain is just as unknown.
    const wrongDomain = JSON.stringify({
      to: [`${seed.matter.inbound_slug}@elsewhere.example.org`],
      from: 'x@example.org',
    });
    const again = await deliver(
      'inbound-email.client-first',
      {},
      { fields: { envelope: wrongDomain } },
    );
    expect(again.result.status).toBe(200);
    expect(await emailByMessageId(again.vars['messageId'] ?? '')).toBeUndefined();
  });
});

describe('inbound email: attachments', () => {
  it('go to a private bucket, once each, with an event each and what they really are recorded', async () => {
    const { vars, result } = await deliver('inbound-email.with-attachments');
    expect(result.status).toBe(200);
    const email = await emailByMessageId(vars['messageId'] ?? '');

    const rows = await run<{
      id: string;
      ordinal: number;
      filename: string;
      content_type: string;
      sniffed_content_type: string;
      sha256: string;
      storage_path: string;
      byte_length: string;
    }>(owner, `select * from attachments where email_id = $1 order by ordinal`, [email?.id]);
    expect(rows.map((r) => [r.filename, r.content_type, r.sniffed_content_type])).toEqual([
      ['TA6-property-information.pdf', 'application/pdf', 'application/pdf'],
      // Claims to be a PDF; the bytes are a Windows executable. Both facts are kept.
      ['surveyor-invoice.pdf', 'application/pdf', 'application/x-msdownload'],
    ]);

    for (const row of rows) {
      expect(row.storage_path).toBe(`${seed.firm.id}/${seed.matter.id}/${row.sha256}`);
      const object = await admin.storage.from('attachments').download(row.storage_path);
      expect(object.error).toBeNull();
      const bytes = new Uint8Array((await object.data?.arrayBuffer()) ?? new ArrayBuffer(0));
      expect(sha256(bytes)).toBe(row.sha256);
      expect(bytes.byteLength).toBe(Number(row.byte_length));
      // One event per attachment, on the timeline.
      expect(await eventKinds(row.id)).toEqual(['email.attachment_stored']);
    }
    const names = (
      (await admin.storage.from('attachments').list(`${seed.firm.id}/${seed.matter.id}`)).data ?? []
    ).filter((o) => rows.some((r) => r.sha256 === o.name));
    expect(
      names.every(
        (o) => (o.metadata as { mimetype: string }).mimetype === 'application/octet-stream',
      ),
    ).toBe(true);

    // Redelivery adds no attachments and no events.
    const before = await totals();
    await replaySendgrid(loadSendgridFixture('inbound-email.with-attachments'), { env, vars });
    expect(await totals()).toEqual(before);
  });

  it("are readable by the owning firm's fee earner and by nobody else, and not publicly", async () => {
    const { vars } = await deliver('inbound-email.with-attachments');
    const email = await emailByMessageId(vars['messageId'] ?? '');
    const row = (
      await run<{ storage_path: string }>(
        owner,
        `select storage_path from attachments where email_id = $1 limit 1`,
        [email?.id],
      )
    )[0];
    const path = row?.storage_path ?? '';

    expect(
      (await fetch(`${env.apiUrl}/storage/v1/object/public/attachments/${path}`)).status,
    ).not.toBe(200);
    const own = await signedInClient(env, seed.feeEarner.email, seed.feeEarner.password);
    expect((await own.storage.from('attachments').download(path)).error).toBeNull();

    const otherFirm = await createFirm(admin, {
      name: `Other ${Date.now()}`,
      mailDomain: `o${Date.now()}.example.org`,
    });
    if (!otherFirm.ok) throw new Error(otherFirm.error.message);
    const address = `att-other-${Date.now()}@example.org`;
    await createFeeEarner(admin, {
      firmId: otherFirm.value.id,
      email: address,
      password: 'a-long-enough-password',
    });
    const other = await signedInClient(env, address, 'a-long-enough-password');
    expect((await other.storage.from('attachments').download(path)).error).not.toBeNull();
  });
});

describe('inbound email: what never arrives, and what cannot be filed', () => {
  it('a request that is not the raw message is answered 200, audited, and files nothing', async () => {
    const before = await totals();
    const { result } = await deliver('inbound-email.client-first', {}, { email: null });
    expect(result.status).toBe(200);
    expect(await totals()).toEqual({ ...before, audit: before.audit + 1 });
    const audit = await run<{ action: string; detail: Record<string, string> }>(
      owner,
      `select action, detail from audit_log order by id desc limit 1`,
    );
    expect(audit[0]).toMatchObject({
      action: 'email.rejected',
      detail: { reason: 'not_raw_mime' },
    });
  });

  it('an oversize request is refused with 200 and an audit row, never half-filed', async () => {
    // Declared larger than the 32 MB we will read. The receiver decides from the header and
    // answers at once, without reading a byte of it.
    const before = await totals();
    const status = await new Promise<number>((resolve, reject) => {
      const url = new URL(`${env.sendgridUrl}${seed.inboundEmail.urlPath}`);
      const req = http.request(
        url,
        {
          method: 'POST',
          headers: {
            'content-type': 'multipart/form-data; boundary=x',
            'content-length': String(40 * 1024 * 1024),
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
          req.destroy();
        },
      );
      req.on('error', reject);
      req.flushHeaders();
    });
    expect(status).toBe(200);
    expect(await totals()).toEqual({ ...before, audit: before.audit + 1 });
    const audit = await run<{ action: string; detail: Record<string, string> }>(
      owner,
      `select action, detail from audit_log order by id desc limit 1`,
    );
    expect(audit[0]).toMatchObject({ action: 'email.rejected', detail: { reason: 'too_large' } });
  });

  it('a fee earner can put the gap on the file: a message the provider dropped is a fact, not a silence', async () => {
    const db = await signedInClient(env, seed.feeEarner.email, seed.feeEarner.password);
    const recorded = await recordUncapturedEmail(
      db,
      {
        firmId: seed.firm.id,
        matterId: seed.matter.id,
        reason: 'over_provider_limit',
        occurredAt: new Date('2026-10-08T16:00:00Z'),
      },
      seed.feeEarner.userId,
    );
    expect(recorded.ok).toBe(true);
    const events = await run<{
      kind: string;
      visibility: string;
      summary: string;
      actor_kind: string;
    }>(
      owner,
      `select kind, visibility, summary, actor_kind from events where kind = 'email.not_captured' and matter_id = $1`,
      [seed.matter.id],
    );
    expect(events[0]).toMatchObject({
      visibility: 'firm',
      actor_kind: 'fee_earner',
      summary: 'email not captured: over_provider_limit',
    });
    expect(INBOUND_EMAIL_LIMITATION).toContain('30 MB');
  });
});
