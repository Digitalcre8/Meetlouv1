/**
 * SendGrid Inbound Parse drops a message over 30 MB (attachments included) before it reaches
 * us. Such a message leaves NO trace in our systems, so the evidence file cannot show it
 * arrived and must never imply it did.
 */
export const PROVIDER_MESSAGE_LIMIT_BYTES = 30 * 1024 * 1024;

/** The largest request we will read: the provider limit plus form-encoding overhead. */
export const INBOUND_REQUEST_LIMIT_BYTES = 32 * 1024 * 1024;

/** To be printed on any export or timeline that summarises captured email. */
export const INBOUND_EMAIL_LIMITATION =
  'Email larger than 30 MB (including attachments) is rejected by the email provider before it ' +
  'reaches this system and is not captured. Absence of an email from this record is not proof ' +
  'that it was not sent.';

/** Event kind a fee earner records when they learn a message was sent but could not be captured. */
export const EMAIL_NOT_CAPTURED_EVENT = 'email.not_captured';

export type EmailNotCapturedReason = 'over_provider_limit' | 'bounced' | 'other';
