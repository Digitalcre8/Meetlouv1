import { silentLogger } from '@meetlou/domain';
import type { Logger } from '@meetlou/domain';
import { z } from 'zod';

/** What the audited route needs. Kept behind an interface so the rules can be tested without a network. */
export interface AccessStore {
  /** The user a bearer token belongs to, or null if it is not a valid session. */
  authenticate(jwt: string): Promise<string | null>;
  /** Can this user, acting under their own token and so under RLS, see this recording? */
  canSeeRecording(jwt: string, recordingId: string): Promise<boolean>;
  /** Write the audit row for this access and return where the audio is. */
  recordAccess(recordingId: string, userId: string): Promise<string>;
  /** A short-lived URL for the audio. */
  sign(storagePath: string, seconds: number): Promise<string | null>;
}

const body = z.object({ recordingId: z.uuid() });

/**
 * The only way to the audio of a call. Every access is a row in the audit log, written before
 * the link is handed out; there is no other route, because direct reads of the recordings bucket
 * are closed (an access nobody writes down is the thing this exists to prevent).
 *
 *   POST { recordingId }   Authorization: Bearer <the caller's own session token>
 *   200 { url, expiresInSeconds }   401 not signed in   404 not found or not yours (the same answer)
 *
 * The URL and the token are never logged.
 */
export function createRecordingAccessHandler(options: {
  store: AccessStore;
  ttlSeconds?: number;
  logger?: Logger;
}): (request: Request) => Promise<Response> {
  const { store } = options;
  const ttl = options.ttlSeconds ?? 60;
  const logger = options.logger ?? silentLogger;
  const route = 'recording-access';

  return async (request) => {
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    const header = request.headers.get('authorization') ?? '';
    const jwt = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const userId = jwt === '' ? null : await store.authenticate(jwt);
    if (userId === null) {
      logger.info('access', { route, outcome: 'unauthenticated', status: 401 });
      return new Response('Unauthorized', { status: 401 });
    }

    const parsed = body.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      logger.info('access', { route, outcome: 'rejected_invalid', status: 400 });
      return new Response('Bad Request', { status: 400 });
    }
    const { recordingId } = parsed.data;

    try {
      if (!(await store.canSeeRecording(jwt, recordingId))) {
        // Same answer for "no such recording" and "not yours", and nothing written.
        logger.info('access', { route, outcome: 'not_found', status: 404 });
        return new Response('Not Found', { status: 404 });
      }
      const path = await store.recordAccess(recordingId, userId);
      const url = await store.sign(path, ttl);
      if (url === null) {
        logger.error('access', { route, outcome: 'sign_failed', status: 502 });
        return new Response('Bad Gateway', { status: 502 });
      }
      logger.info('access', { route, outcome: 'granted', status: 200 });
      return Response.json({ url, expiresInSeconds: ttl });
    } catch (error) {
      const failure = error instanceof Error ? error.message.slice(0, 200) : 'unknown';
      logger.error('access', { route, outcome: 'error', status: 500, failure });
      return new Response('Internal Server Error', { status: 500 });
    }
  };
}
