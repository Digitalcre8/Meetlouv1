import { createHmac } from 'node:crypto';

/**
 * Twilio's request signature, written independently of packages/capture (Node's HMAC, not
 * Web Crypto) so a mistake in one implementation cannot hide a matching mistake in the other.
 * Algorithm: url + each POST param sorted by name as name+value, HMAC-SHA1 with the auth
 * token, base64.
 */
export function signTwilioRequest(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  const signed = Object.keys(params)
    .sort()
    .reduce((acc, name) => acc + name + (params[name] ?? ''), url);
  return createHmac('sha1', authToken).update(signed, 'utf8').digest('base64');
}
