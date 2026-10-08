/**
 * ==========================================================================================
 * CONSENT WORDING. THE COLP MUST APPROVE THIS TEXT.
 *
 * This announcement IS the caller's consent to the call being recorded. There is no keypress:
 * a caller who stays on the line after hearing it has been told, in plain English, that the
 * call is recorded and why, and has been told how to decline (hang up). Everything in the
 * recording and the evidence file rests on this wording being clear, accurate and approved.
 *
 * Do not edit it casually. A wording change must:
 *   1. bump CONSENT_ANNOUNCEMENT_VERSION (stored on every call row, so the file shows exactly
 *      which wording each caller heard), and
 *   2. update APPROVED_CONSENT_WORDING in consent.test.ts (the test fails until you do, so
 *      no change can slip in unnoticed), and
 *   3. be approved by the COLP before release.
 *
 * {firm} is the firm's name; {property} is the matter's property address, so the caller
 * hears which matter the call is being filed against.
 * ==========================================================================================
 */
export const CONSENT_ANNOUNCEMENT_VERSION = '2026-10-08.1';

export const CONSENT_ANNOUNCEMENT_TEMPLATE =
  'Thank you for calling {firm}. This call is about {property}. ' +
  'This call will be recorded, and a written record of it will be kept on your file, ' +
  'so that we have an accurate account of what is said. ' +
  'If you do not want this call recorded, please hang up now and write to us instead. ' +
  'By staying on the line, you agree to the call being recorded.';

export function consentAnnouncement(firmName: string, propertyAddress: string): string {
  return CONSENT_ANNOUNCEMENT_TEMPLATE.replace('{firm}', () => firmName).replace(
    '{property}',
    () => propertyAddress,
  );
}

/** Spoken when a number reaches no matter. Says nothing about any firm or client. */
export const UNROUTED_MESSAGE =
  'Thank you for calling. We are sorry, but we cannot connect this number to a matter. ' +
  'Please check the number you dialled, or contact the firm directly. Goodbye.';

/** Spoken when the matter is found but there is nobody to put the caller through to. */
export const NO_ONE_AVAILABLE_MESSAGE =
  'Thank you for calling. We are sorry, but nobody is available to take your call. ' +
  'Please try again later, or write to us. Goodbye.';
