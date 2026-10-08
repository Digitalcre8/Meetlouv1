import PostalMime from 'postal-mime';
import { z } from 'zod';
import { sha256Hex } from './bytes.ts';
import { sniffContentType } from './sniff.ts';

const MAX_MESSAGE_ID_LENGTH = 998;

/** `<abc@example.org>` and ` abc@example.org ` both become `abc@example.org`. Case is kept. */
export function normaliseMessageId(raw: string | undefined | null): string | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.trim().replace(/^<+/, '').replace(/>+$/, '').trim();
  if (trimmed.length === 0 || trimmed.length > MAX_MESSAGE_ID_LENGTH) return null;
  if (/[<>\s]/.test(trimmed)) return null;
  return trimmed;
}

/** The ids in a References (or In-Reply-To) header, in order, normalised, without repeats. */
export function parseMessageIds(raw: string | undefined | null): string[] {
  if (raw === undefined || raw === null) return [];
  const found = [...raw.matchAll(/<([^<>\s]+)>/g)].map((m) => normaliseMessageId(m[1]));
  const fallback = found.length === 0 ? raw.split(/\s+/).map(normaliseMessageId) : [];
  const ids = [...found, ...fallback].filter((id): id is string => id !== null);
  return [...new Set(ids)];
}

export interface ParsedAttachment {
  ordinal: number;
  filename: string;
  declaredContentType: string;
  sniffedContentType: string;
  bytes: Uint8Array<ArrayBuffer>;
  sha256: string;
}

export interface ParsedEmail {
  messageId: string;
  messageIdSynthesised: boolean;
  inReplyTo: string | null;
  references: string[];
  fromAddress: string;
  to: string[];
  cc: string[];
  subject: string | null;
  sentAt: Date | null;
  text: string | null;
  html: string | null;
  attachments: ParsedAttachment[];
}

export const MAX_ATTACHMENTS = 200;

function safeFilename(name: string | null | undefined, ordinal: number): string {
  const cleaned = (name ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/]/g, '_')
    .trim()
    .slice(0, 255);
  return cleaned.length > 0 ? cleaned : `attachment-${ordinal + 1}`;
}

type Mailbox = { address?: string | undefined; group?: Mailbox[] | undefined };
const addressesOf = (list: Mailbox[] | undefined): string[] =>
  (list ?? []).flatMap((m) => [
    ...(m.address !== undefined && m.address.length > 0 ? [m.address.toLowerCase()] : []),
    ...addressesOf(m.group),
  ]);

/**
 * Parse the raw message. Throws on a message too malformed or too deeply nested to parse;
 * the caller audits that rather than losing it.
 */
export async function parseEmail(raw: Uint8Array<ArrayBuffer>): Promise<ParsedEmail> {
  const parsed = await PostalMime.parse(raw, { maxNestingDepth: 20, maxHeadersSize: 256 * 1024 });

  let messageId = normaliseMessageId(parsed.messageId);
  let synthesised = false;
  if (messageId === null) {
    messageId = `${await sha256Hex(raw)}@meetlou.invalid`;
    synthesised = true;
  }

  const inReplyTo = parseMessageIds(parsed.inReplyTo)[0] ?? null;
  const sentAt = parsed.date !== undefined ? new Date(parsed.date) : null;

  const attachments: ParsedAttachment[] = [];
  for (const [ordinal, a] of parsed.attachments.entries()) {
    const bytes =
      typeof a.content === 'string'
        ? new TextEncoder().encode(a.content)
        : new Uint8Array(a.content instanceof Uint8Array ? a.content.slice() : a.content);
    attachments.push({
      ordinal,
      filename: safeFilename(a.filename, ordinal),
      declaredContentType: (a.mimeType || 'application/octet-stream').slice(0, 200),
      sniffedContentType: sniffContentType(bytes),
      bytes,
      sha256: await sha256Hex(bytes),
    });
  }

  return {
    messageId,
    messageIdSynthesised: synthesised,
    inReplyTo,
    references: parseMessageIds(parsed.references),
    fromAddress: parsed.from?.address?.toLowerCase() ?? 'unknown@invalid',
    to: addressesOf(parsed.to),
    cc: addressesOf(parsed.cc),
    subject: parsed.subject ?? null,
    sentAt:
      sentAt !== null &&
      !Number.isNaN(sentAt.getTime()) &&
      sentAt.getUTCFullYear() > 1970 &&
      sentAt.getUTCFullYear() < 2100
        ? sentAt
        : null,
    text: parsed.text ?? null,
    html: parsed.html ?? null,
    attachments,
  };
}

const envelope = z.object({ to: z.array(z.string()).min(1).max(200) });

/** The SMTP envelope recipients (RCPT TO). The To header can say anything; this cannot. */
export function envelopeRecipients(json: string): string[] | null {
  try {
    const parsed = envelope.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data.to.map((a) => a.trim().toLowerCase()) : null;
  } catch {
    return null;
  }
}

const SLUG = /^[a-z0-9]+-[0-9a-f]{24}$/;

/** The matter slug if `address` is `<slug>@<this firm's mail domain>`, else null. */
export function slugFromRecipient(address: string, mailDomain: string): string | null {
  const at = address.lastIndexOf('@');
  if (at < 1) return null;
  if (address.slice(at + 1) !== mailDomain.toLowerCase()) return null;
  const local = address.slice(0, at);
  return SLUG.test(local) ? local : null;
}
