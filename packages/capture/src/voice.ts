import { silentLogger } from '@meetlou/domain';
import type { Logger } from '@meetlou/domain';
import { z } from 'zod';
import { CONSENT_ANNOUNCEMENT_VERSION, consentAnnouncement } from './consent.ts';
import type { VoiceConfig } from './config.ts';
import type { Clock, VoiceStore } from './ports.ts';
import { parseForm, validateTwilioSignature } from './twilio-signature.ts';
import type { FormParams } from './twilio-signature.ts';
import { announceTwiml, dialAndRecordTwiml, noOneAvailableTwiml, unroutedTwiml } from './twiml.ts';

export interface VoiceDeps {
  config: VoiceConfig;
  store: VoiceStore;
  clock: Clock;
  logger?: Logger;
}

const E164 = /^\+[1-9][0-9]{6,14}$/;
const MAX_BODY_BYTES = 16 * 1024;
/** A caller cannot be kept in the announcement for anything like this long. */
const MAX_ANNOUNCEMENT_SECONDS = 15 * 60;

const callParams = z.object({
  CallSid: z.string().regex(/^CA[0-9a-f]{32}$/),
  To: z.string().regex(E164),
  From: z.string().optional(),
});

const TWIML = { 'content-type': 'text/xml; charset=utf-8' } as const;
const twiml = (body: string) => new Response(body, { status: 200, headers: TWIML });
const plain = (status: number, body: string) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });

type Route = 'incoming' | 'announced' | 'recording-status';

function routeOf(pathname: string): Route {
  const last = pathname.replace(/\/+$/, '').split('/').pop() ?? '';
  if (last === 'announced') return 'announced';
  if (last === 'recording-status') return 'recording-status';
  return 'incoming';
}

/**
 * The inbound voice webhook, in two steps that Twilio drives:
 *
 *   POST <base>            announce the recording and name the property, then <Redirect>
 *   POST <base>/announced  Twilio calls back ONLY after the announcement has played and the
 *                          caller is still on the line. Now, and not before, the call row is
 *                          written with consent given at this moment, and the recording
 *                          instruction is returned.
 *
 * Every request is authenticated by X-Twilio-Signature against a URL built from
 * configuration. Nothing is written for a request that fails authentication.
 */
export function createTwilioVoiceHandler(deps: VoiceDeps): (request: Request) => Promise<Response> {
  const { config, store, clock } = deps;
  const logger = deps.logger ?? silentLogger;

  return async (request) => {
    const route = routeOf(new URL(request.url).pathname);
    if (request.method !== 'POST') return plain(405, 'Method Not Allowed');
    if (route === 'recording-status') {
      // Arrives with the recording milestone. Say so rather than acknowledge and drop it.
      logger.error('recording_status_not_implemented', { route, status: 501 });
      return plain(501, 'Not Implemented');
    }

    const declared = Number(request.headers.get('content-length') ?? '0');
    if (declared > MAX_BODY_BYTES) return plain(413, 'Payload Too Large');
    const body = await request.text();
    if (body.length > MAX_BODY_BYTES) return plain(413, 'Payload Too Large');
    const params = parseForm(body);

    // The query string is part of what Twilio signs. Only our own `started` value is accepted,
    // and it is re-rendered canonically, so the signed URL is built entirely from configuration
    // plus a validated integer.
    let startedSeconds: number | null = null;
    let expectedUrl = config.baseUrl;
    if (route === 'announced') {
      const raw = new URL(request.url).searchParams.get('started');
      const parsed = z.coerce.number().int().positive().safeParse(raw);
      if (!parsed.success) return reject(logger, route, 'rejected_signature');
      startedSeconds = parsed.data;
      expectedUrl = `${config.baseUrl}/announced?started=${startedSeconds}`;
    }

    const authentic = await validateTwilioSignature(
      config.authToken,
      expectedUrl,
      params,
      request.headers.get('x-twilio-signature'),
    );
    if (!authentic) return reject(logger, route, 'rejected_signature');

    const call = callParams.safeParse(firstValues(params));
    if (!call.success) {
      logger.info('webhook', { route, outcome: 'rejected_invalid', status: 400 });
      return plain(400, 'Bad Request');
    }
    const { CallSid: callSid, To: toE164 } = call.data;
    const fromE164 =
      call.data.From !== undefined && E164.test(call.data.From) ? call.data.From : null;

    try {
      const line = await store.findLine(toE164);
      if (line === null) {
        await store.recordUnroutedCall({ callSid, toE164, reason: 'no_matter_for_line' });
        logger.info('webhook', { route, outcome: 'unrouted', status: 200, callSid });
        return twiml(unroutedTwiml());
      }

      if (route === 'incoming') {
        const started = Math.floor(clock.now().getTime() / 1000);
        const continueUrl = `${config.baseUrl}/announced?started=${started}`;
        logger.info('webhook', {
          route,
          outcome: 'announced',
          status: 200,
          callSid,
          matterId: line.matterId,
        });
        return twiml(
          announceTwiml(consentAnnouncement(line.firmName, line.propertyAddress), continueUrl),
        );
      }

      // route === 'announced': the announcement has played.
      const now = clock.now();
      const started = new Date((startedSeconds ?? 0) * 1000);
      if (
        started.getTime() > now.getTime() + 60_000 ||
        now.getTime() - started.getTime() > MAX_ANNOUNCEMENT_SECONDS * 1000
      ) {
        logger.info('webhook', { route, outcome: 'rejected_invalid', status: 400, callSid });
        return plain(400, 'Bad Request');
      }
      const recorded = await store.recordCall({
        firmId: line.firmId,
        matterId: line.matterId,
        callSid,
        fromE164,
        toE164,
        startedAt: started,
        consentAnnouncementVersion: CONSENT_ANNOUNCEMENT_VERSION,
        consentGivenAt: now,
      });

      if (line.feeEarnerPhoneE164 === null) {
        await store.recordUnroutedCall({ callSid, toE164, reason: 'no_fee_earner_number' });
        logger.info('webhook', {
          route,
          outcome: 'no_fee_earner_number',
          status: 200,
          callSid,
          callId: recorded.callId,
        });
        return twiml(noOneAvailableTwiml());
      }

      logger.info('webhook', {
        route,
        outcome: recorded.created ? 'call_recorded' : 'duplicate',
        status: 200,
        callSid,
        callId: recorded.callId,
        matterId: line.matterId,
        created: recorded.created,
      });
      return twiml(
        dialAndRecordTwiml(line.feeEarnerPhoneE164, `${config.baseUrl}/recording-status`),
      );
    } catch (error) {
      // Infrastructure failure: loud, never a silent success. Twilio plays its error message.
      const failure = error instanceof Error ? error.message.slice(0, 200) : 'unknown';
      logger.error('webhook', { route, outcome: 'error', status: 500, callSid, failure });
      return plain(500, 'Internal Server Error');
    }
  };
}

function reject(logger: Logger, route: string, outcome: string): Response {
  logger.info('webhook', { route, outcome, status: 403 });
  return plain(403, 'Forbidden');
}

function firstValues(params: FormParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, values] of Object.entries(params)) {
    const first = values[0];
    if (first !== undefined) out[name] = first;
  }
  return out;
}
