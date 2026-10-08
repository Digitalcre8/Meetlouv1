import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { NewCall, RoutedLine, UnroutedReason, VoiceStore } from './ports.ts';
import { createTwilioVoiceHandler } from './voice.ts';

const TOKEN = 'unit-test-twilio-auth-token-0123456789';
const BASE = 'https://hooks.example.org/functions/v1/twilio-voice';
const LINE = '+442079460958';
const NOW = new Date('2026-10-08T10:00:30.000Z');
const STARTED_SECONDS = Math.floor(new Date('2026-10-08T10:00:00.000Z').getTime() / 1000);

const ROUTED: RoutedLine = {
  matterId: '11111111-1111-4111-8111-111111111111',
  firmId: '22222222-2222-4222-8222-222222222222',
  firmName: 'Armstrong & Co',
  propertyAddress: '14 Meadow Road, Sale M33 2QX',
  feeEarnerPhoneE164: '+447700900123',
};

class MemoryStore implements VoiceStore {
  calls = new Map<string, NewCall>();
  unrouted: { callSid: string; toE164: string; reason: UnroutedReason }[] = [];
  lookups = 0;
  constructor(private readonly lines: Record<string, RoutedLine> = { [LINE]: ROUTED }) {}

  findLine(toE164: string) {
    this.lookups++;
    return Promise.resolve(this.lines[toE164] ?? null);
  }
  recordCall(call: NewCall) {
    const existing = this.calls.has(call.callSid);
    if (!existing) this.calls.set(call.callSid, call);
    return Promise.resolve({ callId: `call-${call.callSid}`, created: !existing });
  }
  recordUnroutedCall(input: { callSid: string; toE164: string; reason: UnroutedReason }) {
    if (!this.unrouted.some((u) => u.callSid === input.callSid)) this.unrouted.push(input);
    return Promise.resolve();
  }
  get writes() {
    return this.calls.size + this.unrouted.length;
  }
}

// Written separately from the implementation under test.
function sign(url: string, params: Record<string, string>): string {
  const signed = Object.keys(params)
    .sort()
    .reduce((acc, name) => acc + name + (params[name] ?? ''), url);
  return createHmac('sha1', TOKEN).update(signed).digest('base64');
}

const sid = (n: number) => `CA${String(n).padStart(32, '0')}`;
const paramsFor = (callSid: string, to = LINE, from = '+447700900301') => ({
  CallSid: callSid,
  To: to,
  From: from,
  CallStatus: 'ringing',
});

function request(
  path: string,
  params: Record<string, string>,
  options: { signedUrl?: string; signature?: string | null; host?: string; body?: string } = {},
): Request {
  const body = options.body ?? new URLSearchParams(params).toString();
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  const signature =
    options.signature === undefined
      ? sign(options.signedUrl ?? `${BASE}${path}`, params)
      : options.signature;
  if (signature !== null) headers['x-twilio-signature'] = signature;
  return new Request(`${options.host ?? 'http://127.0.0.1:54326'}/twilio-voice${path}`, {
    method: 'POST',
    headers,
    body,
  });
}

function setup(store = new MemoryStore()) {
  const handler = createTwilioVoiceHandler({
    config: {
      authToken: TOKEN,
      baseUrl: BASE,
      accountSid: 'AC00000000000000000000000000000000',
      apiBaseUrl: 'https://api.twilio.com',
    },
    store,
    clock: { now: () => NOW },
  });
  return { store, handler };
}

const announced = `/announced?started=${STARTED_SECONDS}`;

describe('inbound voice webhook: authentication', () => {
  it('accepts a valid signature and answers with TwiML', async () => {
    const { handler } = setup();
    const response = await handler(request('', paramsFor(sid(1))));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/xml');
  });

  it('rejects a tampered body with 403 and writes nothing', async () => {
    const { handler, store } = setup();
    const params = paramsFor(sid(2));
    const tampered = new URLSearchParams({ ...params, To: '+442079460999' }).toString();
    const response = await handler(request('', params, { body: tampered }));
    expect(response.status).toBe(403);
    expect(store.writes).toBe(0);
    expect(store.lookups).toBe(0);
  });

  it('rejects a missing, empty or wrong signature', async () => {
    const { handler, store } = setup();
    for (const signature of [null, '', 'AAAA', sign(BASE, paramsFor(sid(99)))]) {
      const response = await handler(request('', paramsFor(sid(3)), { signature }));
      expect(response.status).toBe(403);
    }
    expect(store.writes).toBe(0);
  });

  it('builds the signed URL from configuration, never from the request host', async () => {
    const { handler } = setup();
    const params = paramsFor(sid(4));
    // Genuine: signed for the configured URL, delivered via any host (a proxy, a rewrite).
    const viaProxy = await handler(
      request('', params, { host: 'http://internal-proxy.local:9000' }),
    );
    expect(viaProxy.status).toBe(200);
    // Forged: signed for the URL it was actually requested at, as it would be if the host were trusted.
    const hostSigned = await handler(
      request('', params, {
        host: 'http://evil.example',
        signedUrl: 'http://evil.example/twilio-voice',
      }),
    );
    expect(hostSigned.status).toBe(403);
  });

  it('rejects an announced callback whose started value was changed', async () => {
    const { handler, store } = setup();
    const params = paramsFor(sid(5));
    const signedForOriginal = sign(`${BASE}/announced?started=${STARTED_SECONDS}`, params);
    const response = await handler(
      request(`/announced?started=${STARTED_SECONDS + 1}`, params, {
        signature: signedForOriginal,
      }),
    );
    expect(response.status).toBe(403);
    expect(store.writes).toBe(0);
  });

  it('rejects an announced callback with no started value', async () => {
    const { handler, store } = setup();
    const response = await handler(request('/announced', paramsFor(sid(6))));
    expect(response.status).toBe(403);
    expect(store.writes).toBe(0);
  });

  it('refuses other methods and oversize bodies', async () => {
    const { handler } = setup();
    expect(
      (await handler(new Request('http://x.example/twilio-voice', { method: 'GET' }))).status,
    ).toBe(405);
    const huge = 'a=' + 'x'.repeat(20_000);
    const response = await handler(request('', {}, { body: huge, signature: 'x' }));
    expect(response.status).toBe(413);
  });
});

describe('inbound voice webhook: routing and consent', () => {
  it('announces the recording in plain English and names the property, before anything is recorded', async () => {
    const { handler, store } = setup();
    const response = await handler(request('', paramsFor(sid(10))));
    const body = await response.text();
    expect(body).toContain('Armstrong &amp; Co');
    expect(body).toContain('14 Meadow Road, Sale M33 2QX');
    expect(body).toContain('This call will be recorded');
    expect(body).toContain(`<Redirect method="POST">${BASE}/announced?started=`);
    expect(body).not.toContain('record=');
    expect(body).not.toContain('<Dial');
    // No call row, and so no consent claim, until the announcement has actually played.
    expect(store.calls.size).toBe(0);
  });

  it('writes the call, with consent given at that moment, only when the announcement has played', async () => {
    const { handler, store } = setup();
    const response = await handler(request(announced, paramsFor(sid(11))));
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain('record="record-from-answer-dual"');
    expect(body).toContain(
      'recordingStatusCallback="https://hooks.example.org/functions/v1/twilio-voice/recording-status"',
    );
    expect(body).toContain('<Number>+447700900123</Number>');
    const call = store.calls.get(sid(11));
    expect(call).toMatchObject({
      matterId: ROUTED.matterId,
      firmId: ROUTED.firmId,
      toE164: LINE,
      fromE164: '+447700900301',
      consentAnnouncementVersion: '2026-10-08.1',
    });
    expect(call?.consentGivenAt).toEqual(NOW);
    expect(call?.startedAt).toEqual(new Date('2026-10-08T10:00:00.000Z'));
  });

  it('records a withheld caller number as unknown, not as made-up data', async () => {
    const { handler, store } = setup();
    await handler(request(announced, paramsFor(sid(12), LINE, 'anonymous')));
    expect(store.calls.get(sid(12))?.fromE164).toBeNull();
  });

  it('the same CallSid delivered repeatedly yields one call and identical answers', async () => {
    const { handler, store } = setup();
    const bodies: string[] = [];
    for (let i = 0; i < 3; i++) {
      bodies.push(await (await handler(request(announced, paramsFor(sid(13))))).text());
    }
    expect(store.calls.size).toBe(1);
    expect(new Set(bodies).size).toBe(1);
  });

  it('answers an unknown number politely, audits it, and never records or dials', async () => {
    const { handler, store } = setup();
    const params = paramsFor(sid(14), '+442079460999');
    for (const path of ['', announced]) {
      const response = await handler(request(path, params));
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(body).toContain('cannot connect this number');
      expect(body).toContain('<Hangup/>');
      expect(body).not.toContain('record');
      expect(body).not.toContain('<Dial');
    }
    expect(store.calls.size).toBe(0);
    expect(store.unrouted).toEqual([
      { callSid: sid(14), toE164: '+442079460999', reason: 'no_matter_for_line' },
    ]);
  });

  it('a matter with nobody to ring is audited and not put through', async () => {
    const store = new MemoryStore({ [LINE]: { ...ROUTED, feeEarnerPhoneE164: null } });
    const { handler } = setup(store);
    const body = await (await handler(request(announced, paramsFor(sid(15))))).text();
    expect(body).toContain('nobody is available');
    expect(body).not.toContain('record=');
    expect(store.unrouted).toEqual([
      { callSid: sid(15), toE164: LINE, reason: 'no_fee_earner_number' },
    ]);
  });

  it('rejects a started value from the future or from long ago', async () => {
    const { handler, store } = setup();
    for (const started of [STARTED_SECONDS + 3600, STARTED_SECONDS - 3600]) {
      const response = await handler(request(`/announced?started=${started}`, paramsFor(sid(16))));
      expect(response.status).toBe(400);
    }
    expect(store.writes).toBe(0);
  });

  it('answers 500, not success, when the database fails', async () => {
    const failing: VoiceStore = {
      findLine: () => Promise.reject(new Error('findLine: connection refused')),
      recordCall: () => Promise.reject(new Error('unreachable')),
      recordUnroutedCall: () => Promise.reject(new Error('unreachable')),
    };
    const { handler } = setup(failing as MemoryStore);
    expect((await handler(request('', paramsFor(sid(17))))).status).toBe(500);
  });
});

describe('non-negotiable 1: consent precedes capture', () => {
  it('no response in any scenario carries a recording instruction unless a consented call row exists', async () => {
    const { handler, store } = setup(
      new MemoryStore({
        [LINE]: ROUTED,
        '+442079460777': { ...ROUTED, feeEarnerPhoneE164: null },
      }),
    );
    const scenarios: {
      path: string;
      params: Record<string, string>;
      opts?: Parameters<typeof request>[2];
    }[] = [
      { path: '', params: paramsFor(sid(20)) },
      { path: announced, params: paramsFor(sid(21)) },
      { path: announced, params: paramsFor(sid(21)) },
      { path: '', params: paramsFor(sid(22), '+442079460999') },
      { path: announced, params: paramsFor(sid(23), '+442079460999') },
      { path: announced, params: paramsFor(sid(24), '+442079460777') },
      { path: '', params: paramsFor(sid(25)), opts: { signature: 'forged' } },
      { path: announced, params: paramsFor(sid(26)), opts: { signature: null } },
      { path: '/announced', params: paramsFor(sid(27)) },
    ];
    for (const { path, params, opts } of scenarios) {
      const response = await handler(request(path, params, opts));
      const body = await response.text();
      if (/\brecord=|recordingStatusCallback|<Record\b/.test(body)) {
        const call = store.calls.get(params['CallSid'] ?? '');
        expect(
          call,
          `recording instruction for ${params['CallSid']} with no call row`,
        ).toBeDefined();
        expect(call?.consentGivenAt).toBeInstanceOf(Date);
      }
    }
    // And the converse: the only calls on file are those whose announcement played.
    expect([...store.calls.keys()].sort()).toEqual([sid(21), sid(24)].sort());
  });
});
