import { describe, expect, it } from 'vitest';
import { createLogger } from '@meetlou/domain';
import { sha256Hex } from './bytes.ts';
import { createInboundEmailHandler } from './inbound-email.ts';
import type {
  EmailIssue,
  InboundEmailStore,
  InboundKey,
  IngestEmailInput,
  ObjectStorage,
} from './ports.ts';

const FIRM = '22222222-2222-4222-8222-222222222222';
const OTHER_FIRM = '99999999-9999-4999-8999-999999999999';
const MATTER = '11111111-1111-4111-8111-111111111111';
const SLUG = '14meadowroad-0123456789abcdef01234567';
const DOMAIN = 'matters.example.org';
const KEY_ID = '44444444-4444-4444-8444-444444444444';
const SECRET = 'ab12'.repeat(16);

class MemoryStore implements InboundEmailStore {
  emails = new Map<string, IngestEmailInput>();
  issues: { action: EmailIssue; reason: string; emailSha256: string | null }[] = [];
  lookups = 0;
  failIngest = false;
  constructor(private readonly key: InboundKey | null) {}
  findKey(id: string) {
    this.lookups++;
    return Promise.resolve(id === KEY_ID ? this.key : null);
  }
  findMailDomain() {
    return Promise.resolve(DOMAIN);
  }
  findMatterBySlug(firmId: string, slug: string) {
    // The contract: only this firm's own matters are visible, so another firm's slug is "unknown".
    return Promise.resolve(firmId === FIRM && slug === SLUG ? { matterId: MATTER } : null);
  }
  findEmail(matterId: string, messageId: string) {
    const e = this.emails.get(`${matterId}/${messageId}`);
    return Promise.resolve(e === undefined ? null : { emailId: 'email-1', rawSha256: e.rawSha256 });
  }
  ingest(input: IngestEmailInput) {
    if (this.failIngest) return Promise.reject(new Error('ingest: connection refused'));
    this.emails.set(`${input.matterId}/${input.messageId}`, input);
    return Promise.resolve({ emailId: 'email-1', created: true });
  }
  recordIssue(i: { action: EmailIssue; reason: string; emailSha256: string | null }) {
    this.issues.push(i);
    return Promise.resolve();
  }
}
class MemoryStorage implements ObjectStorage {
  objects = new Map<string, Uint8Array>();
  put(path: string, bytes: Uint8Array<ArrayBuffer>) {
    const existed = this.objects.has(path);
    this.objects.set(path, bytes);
    return Promise.resolve(existed ? ('exists' as const) : ('created' as const));
  }
}

const MESSAGE = [
  'From: Sarah <sarah@example.org>',
  `To: someone-else@example.com`,
  'Subject: Hello',
  'Message-ID: <m1@mail.example.org>',
  'Date: Thu, 08 Oct 2026 09:15:00 +0100',
  '',
  'Body text',
  '',
].join('\r\n');

async function setup(options: { revoked?: boolean; key?: InboundKey | null } = {}) {
  const key: InboundKey | null =
    options.key === undefined
      ? { firmId: FIRM, secretSha256: await sha256Hex(SECRET), revoked: options.revoked ?? false }
      : options.key;
  const store = new MemoryStore(key);
  const emails = new MemoryStorage();
  const attachments = new MemoryStorage();
  const lines: string[] = [];
  const handler = createInboundEmailHandler({
    store,
    emails,
    attachments,
    logger: createLogger((l) => lines.push(l)),
  });
  return { store, emails, attachments, handler, lines };
}

function post(path: string, fields: Record<string, string | null> = {}, method = 'POST'): Request {
  const form = new FormData();
  const all: Record<string, string | null> = {
    email: MESSAGE,
    envelope: JSON.stringify({ to: [`${SLUG}@${DOMAIN}`], from: 'sarah@example.org' }),
    SPF: 'pass',
    dkim: '{@example.org : pass}',
    ...fields,
  };
  for (const [k, v] of Object.entries(all)) if (v !== null) form.append(k, v);
  return new Request(`http://127.0.0.1:54329/sendgrid-inbound${path}`, {
    method,
    ...(method === 'POST' ? { body: form } : {}),
  });
}
const GOOD = `/${KEY_ID}/${SECRET}`;

describe('inbound email: authentication by URL path', () => {
  it('accepts the right path', async () => {
    const { handler, store } = await setup();
    expect((await handler(post(GOOD))).status).toBe(200);
    expect(store.emails.size).toBe(1);
  });

  it('answers every wrong path with the same bare 404 and writes nothing', async () => {
    const wrong = [
      `/${KEY_ID}/${SECRET.slice(0, -1)}0`,
      `/${KEY_ID}/${SECRET.slice(0, -1)}`,
      `/${KEY_ID}/${SECRET}0`,
      `/${KEY_ID}/${SECRET.toUpperCase()}`,
      `/55555555-5555-4555-8555-555555555555/${SECRET}`,
      `/${KEY_ID}`,
      `/${SECRET}`,
      '/',
      '',
    ];
    for (const path of wrong) {
      const { handler, store, emails, lines } = await setup();
      const response = await handler(post(path));
      expect(response.status, path).toBe(404);
      expect(await response.text()).toBe('Not Found');
      expect(store.emails.size + store.issues.length + emails.objects.size, path).toBe(0);
      expect(lines.join('\n').includes(SECRET)).toBe(false);
    }
  });

  it('404s a revoked key and an unknown key, indistinguishably', async () => {
    for (const options of [{ revoked: true }, { key: null }]) {
      const { handler, store } = await setup(options);
      const response = await handler(post(GOOD));
      expect(response.status).toBe(404);
      expect(await response.text()).toBe('Not Found');
      expect(store.emails.size + store.issues.length).toBe(0);
    }
  });

  it('never puts the secret in a log line or a response, even when the database fails', async () => {
    const { handler, store, lines } = await setup();
    store.failIngest = true;
    const response = await handler(post(GOOD));
    expect(response.status).toBe(500);
    const everything = lines.join('\n') + (await response.text());
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain(KEY_ID);
  });

  it('refuses other methods once authenticated, and 404s them when not', async () => {
    const { handler } = await setup();
    expect((await handler(post(GOOD, {}, 'GET'))).status).toBe(405);
    expect((await handler(post(`/${KEY_ID}/${'0'.repeat(64)}`, {}, 'GET'))).status).toBe(404);
  });
});

describe('inbound email: routing and status codes', () => {
  it('routes on the envelope recipient, not the To header', async () => {
    const { handler, store } = await setup();
    await handler(post(GOOD));
    const stored = [...store.emails.values()][0];
    expect(stored?.matterId).toBe(MATTER);
    expect(stored?.to).toEqual(['someone-else@example.com']);
  });

  it("an unknown recipient, another firm's slug or the wrong domain: 200, one audit row, nothing filed, no local part kept", async () => {
    for (const to of [
      `typo-0123456789abcdef01234567@${DOMAIN}`,
      `${SLUG}@elsewhere.example.org`,
      SLUG,
    ]) {
      const { handler, store, emails } = await setup();
      const response = await handler(post(GOOD, { envelope: JSON.stringify({ to: [to] }) }));
      expect(response.status, to).toBe(200);
      expect(store.emails.size + emails.objects.size).toBe(0);
      expect(store.issues).toHaveLength(1);
      expect(store.issues[0]).toMatchObject({
        action: 'email.unrouted',
        reason: 'unknown_recipient',
      });
      expect(JSON.stringify(store.issues)).not.toContain('typo');
    }
    // A key belonging to another firm cannot see this firm's matter at all.
    const { handler, store } = await setup({
      key: { firmId: OTHER_FIRM, secretSha256: await sha256Hex(SECRET), revoked: false },
    });
    expect((await handler(post(GOOD))).status).toBe(200);
    expect(store.emails.size).toBe(0);
    expect(store.issues[0]?.action).toBe('email.unrouted');
  });

  it('answers 200 and audits what can never be filed, so SendGrid does not retry for days', async () => {
    const cases: [Record<string, string | null>, string][] = [
      [{ email: null }, 'not_raw_mime'],
      [{ envelope: null }, 'no_envelope'],
      [{ envelope: 'not json' }, 'no_envelope'],
    ];
    for (const [fields, reason] of cases) {
      const { handler, store } = await setup();
      expect((await handler(post(GOOD, fields))).status, reason).toBe(200);
      expect(store.issues[0]).toMatchObject({ action: 'email.rejected', reason });
      expect(store.emails.size).toBe(0);
    }
  });

  it('answers 5xx for a failure that might clear, so SendGrid does retry', async () => {
    const { handler, store } = await setup();
    store.failIngest = true;
    expect((await handler(post(GOOD))).status).toBe(500);
  });

  it('stores the provider verdicts verbatim and a second delivery files nothing more', async () => {
    const { handler, store } = await setup();
    await handler(post(GOOD, { SPF: 'softfail', dkim: '{@example.org : fail}' }));
    await handler(post(GOOD, { SPF: 'softfail', dkim: '{@example.org : fail}' }));
    expect(store.emails.size).toBe(1);
    expect([...store.emails.values()][0]).toMatchObject({
      spfResult: 'softfail',
      dkimResult: '{@example.org : fail}',
    });
    expect(store.issues).toEqual([]);
  });

  it('stores bodies as text/plain, the raw message as message/rfc822', async () => {
    const { handler, emails } = await setup();
    await handler(post(GOOD));
    const paths = [...emails.objects.keys()];
    expect(paths.some((p) => p.endsWith('/raw.eml'))).toBe(true);
    expect(paths.some((p) => p.endsWith('/body.txt'))).toBe(true);
    expect(paths.every((p) => p.startsWith(`${FIRM}/${MATTER}/`))).toBe(true);
  });
});
