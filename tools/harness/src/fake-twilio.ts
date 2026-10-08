import { readFileSync } from 'node:fs';
import http from 'node:http';
import { FIXTURES_DIR } from './fixtures';
import type { LocalEnv } from './local-env';

/**
 * How a fake recording behaves when downloaded:
 *  stereo     honest: stereo if RequestedChannels=2 is asked for, a mono mixdown if it is not
 *             (what the real API does, and the trap this test suite exists to catch)
 *  mono       Twilio ignores the request and returns a mono mixdown regardless
 *  truncated  the first bytes only, so the header is cut off
 *  not-wav    200 with an HTML error page
 *  missing    404
 *  flaky      404 the first time, stereo after (the media is not ready yet)
 */
export type Behaviour = 'stereo' | 'mono' | 'truncated' | 'not-wav' | 'missing' | 'flaky';

export interface FakeRequest {
  recordingSid: string;
  requestedChannels: string | null;
  authorised: boolean;
}

const audio = (name: 'stereo-2s' | 'mono-2s') =>
  new Uint8Array(readFileSync(`${FIXTURES_DIR}audio/${name}.wav`));

/** A stand-in for Twilio's recordings API, for download tests. Local use only. */
export class FakeTwilio {
  readonly requests: FakeRequest[] = [];
  private readonly behaviours = new Map<string, Behaviour>();
  private readonly fetched = new Set<string>();
  private server: http.Server | undefined;

  constructor(private readonly env: LocalEnv) {}

  register(recordingSid: string, behaviour: Behaviour): void {
    this.behaviours.set(recordingSid, behaviour);
  }

  fetchesFor(recordingSid: string): FakeRequest[] {
    return this.requests.filter((r) => r.recordingSid === recordingSid);
  }

  async start(): Promise<void> {
    const { accountSid, authToken, apiBaseUrl } = this.env.twilio;
    const expectedAuth = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`;
    const prefix = `/2010-04-01/Accounts/${accountSid}/Recordings/`;

    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://fake-twilio.local');
      const match = new RegExp(`^${prefix}(RE[0-9a-f]{32})\\.wav$`).exec(url.pathname);
      if (match === null) {
        res.writeHead(404).end();
        return;
      }
      const recordingSid = match[1] ?? '';
      const authorised = req.headers.authorization === expectedAuth;
      this.requests.push({
        recordingSid,
        requestedChannels: url.searchParams.get('RequestedChannels'),
        authorised,
      });
      if (!authorised) {
        res.writeHead(401).end();
        return;
      }

      const behaviour = this.behaviours.get(recordingSid) ?? 'stereo';
      const firstFetch = !this.fetched.has(recordingSid);
      this.fetched.add(recordingSid);
      const reply = (status: number, body: Uint8Array | string, type = 'audio/wav') => {
        res.writeHead(status, { 'content-type': type }).end(body);
      };

      switch (behaviour) {
        case 'stereo':
          reply(
            200,
            audio(url.searchParams.get('RequestedChannels') === '2' ? 'stereo-2s' : 'mono-2s'),
          );
          break;
        case 'mono':
          reply(200, audio('mono-2s'));
          break;
        case 'truncated':
          reply(200, audio('stereo-2s').subarray(0, 20));
          break;
        case 'not-wav':
          reply(200, '<html><body>Service unavailable</body></html>', 'text/html');
          break;
        case 'missing':
          reply(404, '');
          break;
        case 'flaky':
          if (firstFetch) reply(404, '');
          else reply(200, audio('stereo-2s'));
          break;
      }
    });
    const port = Number(new URL(apiBaseUrl).port);
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (this.server === undefined) {
        resolve();
        return;
      }
      this.server.close(() => {
        resolve();
      });
    });
  }
}
