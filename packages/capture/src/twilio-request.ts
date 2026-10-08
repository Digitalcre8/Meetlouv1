import { parseForm, validateTwilioSignature } from './twilio-signature.ts';
import type { FormParams } from './twilio-signature.ts';

export const MAX_BODY_BYTES = 16 * 1024;

export const plain = (status: number, body: string) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });

export type ReadResult =
  | { ok: true; params: FormParams }
  | { ok: false; response: Response; outcome: 'payload_too_large' | 'rejected_signature' };

/**
 * Read a Twilio webhook body and authenticate it. `expectedUrl` must come from configuration,
 * never from the request. Nothing is written by the caller until this returns ok.
 */
export async function readSignedTwilioRequest(
  request: Request,
  authToken: string,
  expectedUrl: string,
): Promise<ReadResult> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) {
    return { ok: false, response: plain(413, 'Payload Too Large'), outcome: 'payload_too_large' };
  }
  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) {
    return { ok: false, response: plain(413, 'Payload Too Large'), outcome: 'payload_too_large' };
  }
  const params = parseForm(body);
  const authentic = await validateTwilioSignature(
    authToken,
    expectedUrl,
    params,
    request.headers.get('x-twilio-signature'),
  );
  if (!authentic) {
    return { ok: false, response: plain(403, 'Forbidden'), outcome: 'rejected_signature' };
  }
  return { ok: true, params };
}

/** The first value of each parameter. */
export function firstValues(params: FormParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, values] of Object.entries(params)) {
    const first = values[0];
    if (first !== undefined) out[name] = first;
  }
  return out;
}
