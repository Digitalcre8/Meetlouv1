import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  envelopeRecipients,
  normaliseMessageId,
  parseEmail,
  parseMessageIds,
  slugFromRecipient,
} from './email-parse.ts';
import { sniffContentType } from './sniff.ts';

const fixture = (name: string, vars: Record<string, string>) => {
  let text = readFileSync(
    new URL(`../../../fixtures/sendgrid/messages/${name}.eml`, import.meta.url),
    'utf8',
  );
  for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{{${k}}}`, v);
  return new TextEncoder().encode(text.replace(/\r?\n/g, '\r\n'));
};
const VARS = {
  slug: '14meadowroad-0123456789abcdef01234567',
  mailDomain: 'matters.example.org',
  messageId: 'abc@mail.example.org',
  parentMessageId: 'parent@mail.example.org',
  rootMessageId: 'root@mail.example.org',
};

describe('Message-ID handling', () => {
  it('strips brackets and whitespace but keeps case', () => {
    expect(normaliseMessageId(' <Abc.DEF@Mail.Example.org> ')).toBe('Abc.DEF@Mail.Example.org');
    expect(normaliseMessageId('abc@x')).toBe('abc@x');
  });
  it('treats anything unusable as missing', () => {
    expect(normaliseMessageId('')).toBeNull();
    expect(normaliseMessageId(undefined)).toBeNull();
    expect(normaliseMessageId('<a b@x>')).toBeNull();
    expect(normaliseMessageId(`<${'a'.repeat(1000)}@x>`)).toBeNull();
  });
  it('reads a References header in order, without repeats', () => {
    expect(parseMessageIds('<a@x>\r\n <b@x> <a@x>  <c@x>')).toEqual(['a@x', 'b@x', 'c@x']);
    expect(parseMessageIds(undefined)).toEqual([]);
  });
});

describe('envelope routing inputs', () => {
  it('reads the envelope recipients, lower-cased', () => {
    expect(envelopeRecipients('{"to":["A@X.org","b@x.org"],"from":"z@x.org"}')).toEqual([
      'a@x.org',
      'b@x.org',
    ]);
  });
  it('rejects an envelope that is not usable', () => {
    for (const bad of ['', 'nope', '{}', '{"to":[]}', '{"to":"a@x"}', '{"to":[1]}']) {
      expect(envelopeRecipients(bad)).toBeNull();
    }
  });
  it('recognises a matter slug only at the firm mail domain', () => {
    const slug = '14meadowroad-0123456789abcdef01234567';
    expect(slugFromRecipient(`${slug}@matters.example.org`, 'Matters.Example.org')).toBe(slug);
    expect(slugFromRecipient(`${slug}@other.example.org`, 'matters.example.org')).toBeNull();
    expect(slugFromRecipient('postmaster@matters.example.org', 'matters.example.org')).toBeNull();
    expect(slugFromRecipient(`${slug}-x@matters.example.org`, 'matters.example.org')).toBeNull();
    expect(slugFromRecipient('no-at-sign', 'matters.example.org')).toBeNull();
  });
});

describe('parsing the raw message', () => {
  it('reads headers, bodies and addresses', async () => {
    const parsed = await parseEmail(fixture('client-first', VARS));
    expect(parsed).toMatchObject({
      messageId: 'abc@mail.example.org',
      messageIdSynthesised: false,
      inReplyTo: null,
      references: [],
      fromAddress: 'sarah.whitfield@example.org',
      to: [`${VARS.slug}@${VARS.mailDomain}`],
      subject: 'Mortgage offer and deposit for 14 Meadow Road',
    });
    expect(parsed.text).toContain('mortgage offer has come through');
    expect(parsed.html).toContain('<script>');
    expect(parsed.sentAt?.toISOString()).toBe('2026-10-08T08:15:00.000Z');
  });

  it('reads the threading headers of a reply and ignores its subject', async () => {
    const parsed = await parseEmail(fixture('agent-reply', VARS));
    expect(parsed.inReplyTo).toBe('parent@mail.example.org');
    expect(parsed.references).toEqual(['root@mail.example.org', 'parent@mail.example.org']);
    expect(parsed.cc).toEqual(['sarah.whitfield@example.org']);
  });

  it('synthesises a Message-ID from the bytes when there is none', async () => {
    const parsed = await parseEmail(fixture('no-message-id', VARS));
    expect(parsed.messageIdSynthesised).toBe(true);
    expect(parsed.messageId).toMatch(/^[0-9a-f]{64}@meetlou\.invalid$/);
  });

  it('extracts attachments with their declared and sniffed types', async () => {
    const parsed = await parseEmail(fixture('with-attachments', VARS));
    expect(
      parsed.attachments.map((a) => [a.filename, a.declaredContentType, a.sniffedContentType]),
    ).toEqual([
      ['TA6-property-information.pdf', 'application/pdf', 'application/pdf'],
      ['surveyor-invoice.pdf', 'application/pdf', 'application/x-msdownload'],
    ]);
    expect(parsed.attachments.every((a) => /^[0-9a-f]{64}$/.test(a.sha256))).toBe(true);
  });
});

describe('sniffing', () => {
  const b = (...n: number[]) => new Uint8Array(n);
  it('recognises common signatures from the bytes alone', () => {
    expect(sniffContentType(new TextEncoder().encode('%PDF-1.7'))).toBe('application/pdf');
    expect(sniffContentType(b(0x50, 0x4b, 3, 4))).toBe('application/zip');
    expect(sniffContentType(b(0x4d, 0x5a, 0x90))).toBe('application/x-msdownload');
    expect(sniffContentType(b(0xd0, 0xcf, 0x11, 0xe0))).toBe('application/x-ole-storage');
    expect(sniffContentType(new TextEncoder().encode('<html><script>'))).toBe('text/html');
    expect(sniffContentType(new TextEncoder().encode('plain words here'))).toBe('text/plain');
    expect(sniffContentType(b(0, 1, 2, 3, 0, 255, 0, 1))).toBe('application/octet-stream');
    expect(sniffContentType(b())).toBe('application/octet-stream');
  });
});
