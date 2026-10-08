import { INBOUND_REQUEST_LIMIT_BYTES, silentLogger } from '@meetlou/domain';
import type { Logger } from '@meetlou/domain';
import { constantTimeEqual, sha256Hex, utf8 } from './bytes.ts';
import {
  MAX_ATTACHMENTS,
  envelopeRecipients,
  parseEmail,
  slugFromRecipient,
} from './email-parse.ts';
import type { ParsedEmail } from './email-parse.ts';
import type { EmailIssue, InboundEmailStore, IngestEmailInput, ObjectStorage } from './ports.ts';
import { plain } from './twilio-request.ts';

export interface InboundEmailDeps {
  store: InboundEmailStore;
  /** Private 'emails' bucket: raw message and bodies. */
  emails: ObjectStorage;
  /** Private 'attachments' bucket. */
  attachments: ObjectStorage;
  logger?: Logger;
}

const KEY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SECRET = /^[0-9a-f]{64}$/;
/** Compared against when the key id is unknown, so a miss costs the same as a wrong secret. */
const NO_KEY_HASH = '0'.repeat(64);

const ok = () => new Response('OK', { status: 200, headers: { 'content-type': 'text/plain' } });
const notFound = () => plain(404, 'Not Found');

/**
 * Read and throw away a small request body before answering without having used it. A server
 * that answers and closes while the client is still sending makes the client see a reset
 * instead of the answer. Capped, so an unauthenticated caller cannot make us read much.
 */
async function discardBody(request: Request, limit = 1024 * 1024): Promise<void> {
  const reader = request.body?.getReader();
  if (reader === undefined) return;
  let seen = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      seen += value.byteLength;
      if (seen > limit) {
        await reader.cancel();
        return;
      }
    }
  } catch {
    // the client went away; nothing to discard
  }
}

/**
 * SendGrid Inbound Parse receiver (configure it with "POST the raw, full MIME message").
 *
 * Inbound Parse sends no signature and no secret header, so the credential is in the URL:
 *   .../sendgrid-inbound/<key id>/<secret>
 * The secret is hashed and compared in constant time with the stored hash. It is never logged,
 * never echoed, and never part of an error message: this function never puts the request URL
 * anywhere. Every failure to authenticate is the same bare 404 and writes nothing.
 *
 * After authentication, the status codes follow one rule. SendGrid retries any non-2xx for
 * days, so a message that can NEVER be filed (unknown recipient, not parseable, too large) is
 * answered 200 with an audit row, while a failure that might clear (database, storage) is 5xx.
 */
export function createInboundEmailHandler(
  deps: InboundEmailDeps,
): (request: Request) => Promise<Response> {
  const { store, emails, attachments } = deps;
  const logger = deps.logger ?? silentLogger;
  const route = 'sendgrid-inbound';

  return async (request) => {
    // --- authenticate: the URL path is the credential ------------------------------------------
    const segments = new URL(request.url).pathname.split('/').filter((s) => s.length > 0);
    const secret = segments.at(-1) ?? '';
    const keyId = segments.at(-2) ?? '';
    if (!KEY_ID.test(keyId) || !SECRET.test(secret)) {
      logger.info('webhook', { route, outcome: 'not_found', status: 404 });
      await discardBody(request);
      return notFound();
    }
    const key = await store.findKey(keyId);
    const matches = await constantTimeEqual(
      await sha256Hex(secret),
      key?.secretSha256 ?? NO_KEY_HASH,
    );
    if (key === null || !matches || key.revoked) {
      logger.info('webhook', { route, outcome: 'not_found', status: 404 });
      await discardBody(request);
      return notFound();
    }
    const firmId = key.firmId;
    if (request.method !== 'POST') return plain(405, 'Method Not Allowed');

    const issue = async (
      action: EmailIssue,
      reason: string,
      emailSha256: string | null = null,
      recipientDomain: string | null = null,
    ) => {
      await store.recordIssue({ action, firmId, emailSha256, recipientDomain, reason });
      logger.info('webhook', { route, outcome: reason, status: 200, firmId });
      return ok();
    };

    try {
      // --- read the request ----------------------------------------------------------------------
      if (Number(request.headers.get('content-length') ?? '0') > INBOUND_REQUEST_LIMIT_BYTES) {
        return await issue('email.rejected', 'too_large');
      }
      let form: FormData;
      try {
        form = await request.formData();
      } catch {
        return await issue('email.rejected', 'malformed_form');
      }

      const rawField = form.get('email');
      if (rawField === null) {
        // Inbound Parse is in its parsed mode, not "POST the raw, full MIME message": the
        // unmodified message is not available, so there is nothing we can file as evidence.
        return await issue('email.rejected', 'not_raw_mime');
      }
      const rawBytes =
        typeof rawField === 'string'
          ? utf8(rawField)
          : new Uint8Array(await rawField.arrayBuffer());
      if (rawBytes.byteLength > INBOUND_REQUEST_LIMIT_BYTES) {
        return await issue('email.rejected', 'too_large');
      }
      const rawSha256 = await sha256Hex(rawBytes);

      const envelopeField = form.get('envelope');
      const recipients =
        typeof envelopeField === 'string' ? envelopeRecipients(envelopeField) : null;
      if (recipients === null) return await issue('email.rejected', 'no_envelope', rawSha256);

      // --- route on the ENVELOPE recipient, never the To header ----------------------------------
      const mailDomain = await store.findMailDomain(firmId);
      const matterIds = new Set<string>();
      let recipientDomain: string | null = null;
      for (const recipient of recipients) {
        recipientDomain ??= recipient.slice(recipient.lastIndexOf('@') + 1).slice(0, 253) || null;
        const slug = mailDomain === null ? null : slugFromRecipient(recipient, mailDomain);
        const matter = slug === null ? null : await store.findMatterBySlug(firmId, slug);
        if (matter !== null) matterIds.add(matter.matterId);
      }
      if (matterIds.size === 0) {
        // A mistyped address is not transient: answer 200, keep a trace, file nothing. The local
        // part is not recorded (it may be one character from another matter's address).
        return await issue('email.unrouted', 'unknown_recipient', rawSha256, recipientDomain);
      }

      let parsed: ParsedEmail;
      try {
        parsed = await parseEmail(rawBytes);
      } catch {
        return await issue('email.rejected', 'unparseable', rawSha256);
      }
      if (parsed.attachments.length > MAX_ATTACHMENTS) {
        return await issue('email.rejected', 'too_many_attachments', rawSha256);
      }

      const spf = field(form, 'SPF', 100);
      const dkim = field(form, 'dkim', 500);
      const messageHash = await sha256Hex(parsed.messageId);

      for (const matterId of matterIds) {
        const existing = await store.findEmail(matterId, parsed.messageId);
        if (existing !== null) {
          if (existing.rawSha256 !== rawSha256) {
            await store.recordIssue({
              action: 'email.duplicate_mismatch',
              firmId,
              emailSha256: rawSha256,
              recipientDomain: null,
              reason: 'same_message_id_different_bytes',
            });
          }
          logger.info('webhook', {
            route,
            outcome: 'duplicate',
            status: 200,
            firmId,
            matterId,
            emailId: existing.emailId,
            created: false,
          });
          continue;
        }

        const prefix = `${firmId}/${matterId}/${messageHash}`;
        const rawPath = `${prefix}/raw.eml`;
        await emails.put(rawPath, rawBytes, 'message/rfc822');
        const textPath = parsed.text === null ? null : `${prefix}/body.txt`;
        if (textPath !== null && parsed.text !== null) {
          await emails.put(textPath, utf8(parsed.text), 'text/plain');
        }
        // Stored as text/plain on purpose: HTML from a stranger is never served as a page.
        const htmlPath = parsed.html === null ? null : `${prefix}/body.html`;
        if (htmlPath !== null && parsed.html !== null) {
          await emails.put(htmlPath, utf8(parsed.html), 'text/plain');
        }

        const stored: IngestEmailInput['attachments'] = [];
        for (const a of parsed.attachments) {
          const storagePath = `${firmId}/${matterId}/${a.sha256}`;
          // Opaque bytes whatever the sender claimed.
          await attachments.put(storagePath, a.bytes, 'application/octet-stream');
          stored.push({
            ordinal: a.ordinal,
            filename: a.filename,
            contentType: a.declaredContentType,
            sniffedContentType: a.sniffedContentType,
            byteLength: a.bytes.byteLength,
            sha256: a.sha256,
            storagePath,
          });
        }

        const result = await store.ingest({
          matterId,
          messageId: parsed.messageId,
          messageIdSynthesised: parsed.messageIdSynthesised,
          inReplyTo: parsed.inReplyTo,
          references: parsed.references,
          fromAddress: parsed.fromAddress,
          to: parsed.to,
          cc: parsed.cc,
          subject: parsed.subject,
          sentAt: parsed.sentAt,
          rawStoragePath: rawPath,
          rawSha256,
          bodyTextStoragePath: textPath,
          bodyHtmlStoragePath: htmlPath,
          spfResult: spf,
          dkimResult: dkim,
          attachments: stored,
        });
        logger.info('webhook', {
          route,
          outcome: result.created ? 'email_stored' : 'duplicate',
          status: 200,
          firmId,
          matterId,
          emailId: result.emailId,
          created: result.created,
          attachments: stored.length,
        });
      }
      return ok();
    } catch (error) {
      // Transient (database, storage): ask SendGrid to retry. Nothing here can contain the URL.
      const failure = error instanceof Error ? error.message.slice(0, 200) : 'unknown';
      logger.error('webhook', { route, outcome: 'error', status: 500, firmId, failure });
      return plain(500, 'Internal Server Error');
    }
  };
}

function field(form: FormData, name: string, max: number): string | null {
  const value = form.get(name);
  return typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, max) : null;
}
