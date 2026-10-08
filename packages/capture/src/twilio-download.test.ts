import { describe, expect, it } from 'vitest';
import { TwilioRecordingDownloader } from './twilio-download.ts';

const CONFIG = {
  accountSid: 'AC00000000000000000000000000000000',
  authToken: 'unit-test-twilio-auth-token-0123456789',
  apiBaseUrl: 'https://api.example.org',
};
const SID = `RE${'a'.repeat(32)}`;

describe('Twilio recording download', () => {
  it('asks for two channels, always', () => {
    const url = new TwilioRecordingDownloader(CONFIG).mediaUrl(SID);
    expect(url).toBe(
      `https://api.example.org/2010-04-01/Accounts/${CONFIG.accountSid}/Recordings/${SID}.wav?RequestedChannels=2`,
    );
  });

  it('authenticates with the account SID and token, and sends nothing else secret', async () => {
    const seen: { url: string; headers: Headers }[] = [];
    const fetchImpl = ((url: string, init: RequestInit) => {
      seen.push({ url, headers: new Headers(init.headers) });
      return Promise.resolve(new Response(new Uint8Array([1, 2, 3])));
    }) as typeof fetch;
    const result = await new TwilioRecordingDownloader(CONFIG, fetchImpl).download(SID);
    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers.get('authorization')).toBe(
      `Basic ${Buffer.from(`${CONFIG.accountSid}:${CONFIG.authToken}`).toString('base64')}`,
    );
  });

  it('maps failures to reasons rather than throwing', async () => {
    const respond = (status: number, headers: Record<string, string> = {}) =>
      new TwilioRecordingDownloader(CONFIG, () =>
        Promise.resolve(new Response('x', { status, headers })),
      ).download(SID);
    expect(await respond(404)).toEqual({ ok: false, reason: 'not_found' });
    expect(await respond(401)).toEqual({ ok: false, reason: 'unauthorised' });
    expect(await respond(503)).toEqual({ ok: false, reason: 'unavailable' });
    expect(await respond(200, { 'content-length': String(10 ** 9) })).toEqual({
      ok: false,
      reason: 'too_large',
    });
    const refused = new TwilioRecordingDownloader(CONFIG, () =>
      Promise.reject(new Error('ECONNREFUSED')),
    );
    expect(await refused.download(SID)).toEqual({ ok: false, reason: 'unavailable' });
  });
});
