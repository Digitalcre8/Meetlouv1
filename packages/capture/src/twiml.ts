import { NO_ONE_AVAILABLE_MESSAGE, UNROUTED_MESSAGE } from './consent.ts';

export function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

const wrap = (inner: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
const say = (text: string) => `<Say language="en-GB">${escapeXml(text)}</Say>`;

/**
 * Plays the consent announcement, then asks Twilio to call us back. That callback only
 * happens once the announcement has finished playing and the caller is still on the line, so
 * its arrival is the evidence that the announcement was played.
 */
export function announceTwiml(announcement: string, continueUrl: string): string {
  return wrap(`${say(announcement)}<Redirect method="POST">${escapeXml(continueUrl)}</Redirect>`);
}

/**
 * The only place a recording instruction is produced. Callers must hold a persisted,
 * consented call row first (see handleAnnounced); a test enumerates the handler's outputs to
 * prove no other response contains `record`.
 */
export function dialAndRecordTwiml(
  feeEarnerE164: string,
  recordingStatusCallbackUrl: string,
): string {
  return wrap(
    `<Dial answerOnBridge="true" timeout="30" record="record-from-answer-dual" ` +
      `recordingStatusCallback="${escapeXml(recordingStatusCallbackUrl)}" ` +
      `recordingStatusCallbackEvent="completed" recordingStatusCallbackMethod="POST">` +
      `<Number>${escapeXml(feeEarnerE164)}</Number></Dial>`,
  );
}

export function unroutedTwiml(): string {
  return wrap(`${say(UNROUTED_MESSAGE)}<Hangup/>`);
}

export function noOneAvailableTwiml(): string {
  return wrap(`${say(NO_ONE_AVAILABLE_MESSAGE)}<Hangup/>`);
}
