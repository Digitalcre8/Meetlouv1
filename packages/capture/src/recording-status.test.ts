import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type {
  CallForRecording,
  DownloadResult,
  IngestRecordingInput,
  IngestRecordingResult,
  ObjectStorage,
  RecordingDownloader,
  RecordingIssue,
  RecordingStore,
} from './ports.ts';
import { createRecordingStatusHandler } from './recording-status.ts';

const TOKEN = 'unit-test-twilio-auth-token-0123456789';
const BASE = 'https://hooks.example.org/functions/v1/twilio-voice';
const ACCOUNT = 'AC00000000000000000000000000000000';
const CALL_SID = `CA${'1'.repeat(32)}`;
const CALL: CallForRecording = {
  callId: '33333333-3333-4333-8333-333333333333',
  firmId: '22222222-2222-4222-8222-222222222222',
  matterId: '11111111-1111-4111-8111-111111111111',
  consentGiven: true,
};

const audio = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../../fixtures/audio/${name}`, import.meta.url)));

class MemoryStore implements RecordingStore {
  recordings = new Map<string, IngestRecordingInput>();
  issues: { action: RecordingIssue; recordingSid: string; reason: string }[] = [];
  constructor(private readonly call: CallForRecording | null = CALL) {}
  findCall() {
    return Promise.resolve(this.call);
  }
  findRecording(sid: string) {
    return Promise.resolve(this.recordings.has(sid) ? { recordingId: `rec-${sid}` } : null);
  }
  ingest(input: IngestRecordingInput): Promise<IngestRecordingResult> {
    const created = !this.recordings.has(input.recordingSid);
    if (created) this.recordings.set(input.recordingSid, input);
    return Promise.resolve({
      recordingId: `rec-${input.recordingSid}`,
      created,
      suppressed: [],
    });
  }
  recordIssue(input: { action: RecordingIssue; recordingSid: string; reason: string }) {
    this.issues.push(input);
    return Promise.resolve();
  }
}

class MemoryStorage implements ObjectStorage {
  objects = new Map<string, Uint8Array>();
  put(path: string, bytes: Uint8Array<ArrayBuffer>) {
    const existed = this.objects.has(path);
    if (!existed) this.objects.set(path, bytes);
    return Promise.resolve(existed ? ('exists' as const) : ('created' as const));
  }
}

class FakeDownloader implements RecordingDownloader {
  downloads: string[] = [];
  constructor(private readonly result: DownloadResult) {}
  download(recordingSid: string) {
    this.downloads.push(recordingSid);
    return Promise.resolve(this.result);
  }
}

function sign(url: string, params: Record<string, string>): string {
  const signed = Object.keys(params)
    .sort()
    .reduce((acc, name) => acc + name + (params[name] ?? ''), url);
  return createHmac('sha1', TOKEN).update(signed).digest('base64');
}

function setup(options: { store?: MemoryStore; result?: DownloadResult } = {}) {
  const store = options.store ?? new MemoryStore();
  const storage = new MemoryStorage();
  const downloader = new FakeDownloader(
    options.result ?? { ok: true, bytes: audio('stereo-2s.wav') },
  );
  const handler = createRecordingStatusHandler({
    config: {
      authToken: TOKEN,
      baseUrl: BASE,
      accountSid: ACCOUNT,
      apiBaseUrl: 'https://api.example.org',
    },
    store,
    downloader,
    storage,
  });
  return { store, storage, downloader, handler };
}

const sid = (n: number) => `RE${String(n).padStart(32, '0')}`;
const params = (recordingSid: string, extra: Record<string, string> = {}) => ({
  AccountSid: ACCOUNT,
  CallSid: CALL_SID,
  RecordingSid: recordingSid,
  RecordingStatus: 'completed',
  RecordingDuration: '125',
  RecordingChannels: '2',
  RecordingUrl: 'https://evil.example/steal',
  ...extra,
});

function request(
  p: Record<string, string>,
  options: { signature?: string | null; body?: string } = {},
) {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  const signature =
    options.signature === undefined ? sign(`${BASE}/recording-status`, p) : options.signature;
  if (signature !== null) headers['x-twilio-signature'] = signature;
  return new Request('http://127.0.0.1:54326/twilio-voice/recording-status', {
    method: 'POST',
    headers,
    body: options.body ?? new URLSearchParams(p).toString(),
  });
}

describe('recording status callback', () => {
  it('stores a stereo recording with the channel count read from its header', async () => {
    const { handler, store, storage } = setup();
    const response = await handler(request(params(sid(1))));
    expect(response.status).toBe(200);
    expect(store.recordings.get(sid(1))).toMatchObject({
      callId: CALL.callId,
      channels: 2,
      durationSeconds: 125,
      storagePath: `${CALL.firmId}/${CALL.matterId}/${sid(1)}.wav`,
      byteLength: audio('stereo-2s.wav').byteLength,
    });
    expect(storage.objects.has(`${CALL.firmId}/${CALL.matterId}/${sid(1)}.wav`)).toBe(true);
  });

  it('stores a mono result as channels=1 even though the callback claimed two', async () => {
    const { handler, store } = setup({ result: { ok: true, bytes: audio('mono-2s.wav') } });
    // The callback says RecordingChannels=2. The bytes say otherwise, and the bytes win.
    expect((await handler(request(params(sid(2))))).status).toBe(200);
    expect(store.recordings.get(sid(2))?.channels).toBe(1);
  });

  it('records the SHA-256 of the bytes it stored', async () => {
    const { handler, store } = setup();
    await handler(request(params(sid(3))));
    expect(store.recordings.get(sid(3))?.sha256).toBe(
      createHash('sha256').update(audio('stereo-2s.wav')).digest('hex'),
    );
  });

  it('is idempotent: a second delivery downloads and stores nothing more', async () => {
    const { handler, store, storage, downloader } = setup();
    for (let i = 0; i < 3; i++) expect((await handler(request(params(sid(4))))).status).toBe(200);
    expect(downloader.downloads).toEqual([sid(4)]);
    expect(store.recordings.size).toBe(1);
    expect(storage.objects.size).toBe(1);
  });

  it('never fetches the RecordingUrl it was sent', async () => {
    const { handler, downloader } = setup();
    await handler(request(params(sid(5))));
    // The downloader is asked for the SID only; it builds the URL from configuration.
    expect(downloader.downloads).toEqual([sid(5)]);
  });

  it('refuses a callback that is not signed, or was altered, and does nothing', async () => {
    const { handler, store, storage, downloader } = setup();
    const p = params(sid(6));
    const tampered = new URLSearchParams({ ...p, RecordingDuration: '999' }).toString();
    expect((await handler(request(p, { body: tampered }))).status).toBe(403);
    expect((await handler(request(p, { signature: null }))).status).toBe(403);
    expect((await handler(request(p, { signature: 'forged' }))).status).toBe(403);
    expect(downloader.downloads).toEqual([]);
    expect(store.recordings.size + store.issues.length + storage.objects.size).toBe(0);
  });

  it('rejects a callback for another account', async () => {
    const { handler, downloader } = setup();
    const p = params(sid(7), { AccountSid: `AC${'f'.repeat(32)}` });
    expect((await handler(request(p))).status).toBe(400);
    expect(downloader.downloads).toEqual([]);
  });

  it('fetches no audio for a call with no consent on file, and audits it', async () => {
    for (const call of [null, { ...CALL, consentGiven: false }]) {
      const { handler, store, storage, downloader } = setup({ store: new MemoryStore(call) });
      expect((await handler(request(params(sid(8))))).status).toBe(200);
      expect(downloader.downloads).toEqual([]);
      expect(storage.objects.size).toBe(0);
      expect(store.recordings.size).toBe(0);
      expect(store.issues).toEqual([
        {
          action: 'recording.quarantined',
          recordingSid: sid(8),
          callSid: CALL_SID,
          firmId: call?.firmId ?? null,
          reason: 'no_consented_call',
        },
      ]);
    }
  });

  it('audits a recording that did not complete, and stores nothing', async () => {
    const { handler, store, downloader } = setup();
    expect((await handler(request(params(sid(9), { RecordingStatus: 'failed' })))).status).toBe(
      200,
    );
    expect(store.issues.map((i) => i.action)).toEqual(['recording.not_completed']);
    expect(downloader.downloads).toEqual([]);
  });

  it('rejects bytes that are not a WAV: audited, nothing stored, and Twilio is told to retry', async () => {
    const html = new TextEncoder().encode('<html>'.padEnd(80, ' '));
    const { handler, store, storage } = setup({ result: { ok: true, bytes: html } });
    expect((await handler(request(params(sid(10))))).status).toBe(502);
    expect(store.issues.map((i) => [i.action, i.reason])).toEqual([
      ['recording.rejected', 'not_riff'],
    ]);
    expect(store.recordings.size + storage.objects.size).toBe(0);
  });

  it('asks Twilio to retry when the media is not available yet, and audits it', async () => {
    const { handler, store } = setup({ result: { ok: false, reason: 'not_found' } });
    expect((await handler(request(params(sid(11))))).status).toBe(502);
    expect(store.issues.map((i) => i.action)).toEqual(['recording.download_failed']);
  });

  it('does not ask for a retry that can never succeed', async () => {
    const { handler } = setup({ result: { ok: false, reason: 'too_large' } });
    expect((await handler(request(params(sid(12))))).status).toBe(200);
  });

  it('never calls a transcriber: it stores and returns', async () => {
    // The handler has no transcription dependency at all; the hand-off is the database queue
    // (recordings_awaiting_transcription). This pins that the dependency list stays that way.
    const { handler } = setup();
    const source = readFileSync(new URL('./recording-status.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/transcri(be|ber)\(/i);
    expect((await handler(request(params(sid(13))))).status).toBe(200);
  });

  it('answers 500, not success, when the database fails', async () => {
    const failing = new MemoryStore();
    failing.ingest = () => Promise.reject(new Error('ingest: connection refused'));
    const { handler } = setup({ store: failing });
    expect((await handler(request(params(sid(14))))).status).toBe(500);
  });
});
