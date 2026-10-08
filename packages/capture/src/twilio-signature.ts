import { constantTimeEqual, toBase64, utf8 } from './bytes.ts';

/** A parsed application/x-www-form-urlencoded body. A name may repeat, so values are lists. */
export type FormParams = Record<string, string[]>;

export function parseForm(body: string): FormParams {
  const params: FormParams = {};
  for (const [name, value] of new URLSearchParams(body)) {
    (params[name] ??= []).push(value);
  }
  return params;
}

/**
 * Twilio's signed string: the full URL, then every POST parameter sorted by name, each as
 * name immediately followed by value. A repeated name contributes its values sorted.
 */
export function twilioSignedString(url: string, params: FormParams): string {
  let signed = url;
  for (const name of Object.keys(params).sort()) {
    for (const value of [...(params[name] ?? [])].sort()) signed += name + value;
  }
  return signed;
}

/** HMAC-SHA1 of the signed string with the account auth token, base64. */
export async function twilioSignature(
  authToken: string,
  url: string,
  params: FormParams,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    utf8(authToken),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, utf8(twilioSignedString(url, params)));
  return toBase64(new Uint8Array(mac));
}

/**
 * `url` must be built from configuration, never from the inbound request: the Host header is
 * attacker-influenced and, behind a proxy, is not the URL Twilio signed anyway.
 */
export async function validateTwilioSignature(
  authToken: string,
  url: string,
  params: FormParams,
  presented: string | null,
): Promise<boolean> {
  if (presented === null || presented.length === 0) return false;
  return constantTimeEqual(await twilioSignature(authToken, url, params), presented);
}
