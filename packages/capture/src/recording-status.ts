import { silentLogger } from '@meetlou/domain';
import type { Logger } from '@meetlou/domain';
import { z } from 'zod';
import { sha256Hex } from './bytes.ts';
import type { VoiceConfig } from './config.ts';
import type { ObjectStorage, RecordingDownloader, RecordingStore } from './ports.ts';
import { firstValues, plain, readSignedTwilioRequest } from './twilio-request.ts';
import { parseWavHeader } from './wav.ts';

export interface RecordingDeps {
  config: VoiceConfig;
  store: RecordingStore;
  downloader: RecordingDownloader;
  storage: ObjectStorage;
  logger?: Logger;
}

const recordingParams = z.object({
  AccountSid: z.string(),
  CallSid: z.string().regex(/^CA[0-9a-f]{32}$/),
  RecordingSid: z.string().regex(/^RE[0-9a-f]{32}$/),
  RecordingStatus: z.string(),
  RecordingDuration: z.coerce.number().int().min(0).optional(),
});

const ok = () => new Response('OK', { status: 200, headers: { 'content-type': 'text/plain' } });

/**
 * POST <base>/recording-status: Twilio says a recording is ready.
 *
 *   authenticate -> find the (consented) call -> skip if already stored -> download asking for
 *   TWO channels -> read the channel count from the WAV header -> store in the private bucket
 *   -> one database transaction records the row, its events and the guards.
 *
 * It never transcribes. Transcription reads recordings_awaiting_transcription later, so this
 * webhook does only bounded work (a download, an upload, one SQL call) and Twilio's 15 second
 * limit, and the retry it triggers, is not an invitation to duplicate summaries.
 *
 * Status codes: 200 = dealt with (including: audited and set aside); 5xx = please retry.
 */
export function createRecordingStatusHandler(
  deps: RecordingDeps,
): (request: Request) => Promise<Response> {
  const { config, store, downloader, storage } = deps;
  const logger = deps.logger ?? silentLogger;
  const route = 'recording-status';

  return async (request) => {
    if (request.method !== 'POST') return plain(405, 'Method Not Allowed');

    const read = await readSignedTwilioRequest(
      request,
      config.authToken,
      `${config.baseUrl}/recording-status`,
    );
    if (!read.ok) {
      logger.info('webhook', { route, outcome: read.outcome, status: read.response.status });
      return read.response;
    }

    const parsed = recordingParams.safeParse(firstValues(read.params));
    if (!parsed.success || parsed.data.AccountSid !== config.accountSid) {
      logger.info('webhook', { route, outcome: 'rejected_invalid', status: 400 });
      return plain(400, 'Bad Request');
    }
    const { CallSid: callSid, RecordingSid: recordingSid } = parsed.data;

    try {
      const call = await store.findCall(callSid);

      if (parsed.data.RecordingStatus !== 'completed') {
        await store.recordIssue({
          action: 'recording.not_completed',
          recordingSid,
          callSid,
          firmId: call?.firmId ?? null,
          reason: parsed.data.RecordingStatus.slice(0, 40),
        });
        logger.info('webhook', {
          route,
          outcome: 'not_completed',
          status: 200,
          callSid,
          recordingSid,
        });
        return ok();
      }

      // Non-negotiable 1: no consented call row, no audio. We do not even fetch it; it stays at
      // Twilio, and the audit row below is the file's record that it exists.
      if (call === null || !call.consentGiven) {
        await store.recordIssue({
          action: 'recording.quarantined',
          recordingSid,
          callSid,
          firmId: call?.firmId ?? null,
          reason: 'no_consented_call',
        });
        logger.error('webhook', {
          route,
          outcome: 'quarantined',
          status: 200,
          callSid,
          recordingSid,
        });
        return ok();
      }

      const duration = parsed.data.RecordingDuration;
      if (duration === undefined) {
        logger.info('webhook', { route, outcome: 'rejected_invalid', status: 400, callSid });
        return plain(400, 'Bad Request');
      }

      // Idempotent: a redelivery stores, uploads and fetches nothing.
      if ((await store.findRecording(recordingSid)) !== null) {
        logger.info('webhook', {
          route,
          outcome: 'duplicate',
          status: 200,
          callSid,
          recordingSid,
          created: false,
        });
        return ok();
      }

      const downloaded = await downloader.download(recordingSid);
      if (!downloaded.ok) {
        await store.recordIssue({
          action: 'recording.download_failed',
          recordingSid,
          callSid,
          firmId: call.firmId,
          reason: downloaded.reason,
        });
        // too_large will never succeed on retry; everything else might.
        const status = downloaded.reason === 'too_large' ? 200 : 502;
        logger.error('webhook', {
          route,
          outcome: `download_${downloaded.reason}`,
          status,
          callSid,
          recordingSid,
        });
        return status === 200 ? ok() : plain(502, 'Bad Gateway');
      }

      // Non-negotiable 5: the channel count comes from the bytes we hold.
      const wav = parseWavHeader(downloaded.bytes);
      if (!wav.ok) {
        await store.recordIssue({
          action: 'recording.rejected',
          recordingSid,
          callSid,
          firmId: call.firmId,
          reason: wav.error,
        });
        logger.error('webhook', {
          route,
          outcome: `rejected_${wav.error}`,
          status: 502,
          callSid,
          recordingSid,
        });
        return plain(502, 'Bad Gateway');
      }
      const channels = wav.header.channels === 2 ? 2 : 1;

      const storagePath = `${call.firmId}/${call.matterId}/${recordingSid}.wav`;
      await storage.put(storagePath, downloaded.bytes, 'audio/wav');

      const result = await store.ingest({
        callId: call.callId,
        recordingSid,
        storagePath,
        sha256: await sha256Hex(downloaded.bytes),
        byteLength: downloaded.bytes.byteLength,
        durationSeconds: duration,
        channels,
      });

      logger.info('webhook', {
        route,
        outcome: result.created ? 'recording_stored' : 'duplicate',
        status: 200,
        callSid,
        recordingSid,
        callId: call.callId,
        matterId: call.matterId,
        channels,
        created: result.created,
        suppressed: result.suppressed.join(','),
      });
      return ok();
    } catch (error) {
      const failure = error instanceof Error ? error.message.slice(0, 200) : 'unknown';
      logger.error('webhook', {
        route,
        outcome: 'error',
        status: 500,
        callSid,
        recordingSid,
        failure,
      });
      return plain(500, 'Internal Server Error');
    }
  };
}
