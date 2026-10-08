import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { EmailIssue, InboundEmailStore, InboundKey, IngestEmailInput } from './ports.ts';

/** Service-role implementation of InboundEmailStore. */
export class SupabaseEmailStore implements InboundEmailStore {
  constructor(private readonly db: SupabaseClient) {}

  async findKey(keyId: string): Promise<InboundKey | null> {
    const found = await this.db
      .from('inbound_email_keys')
      .select('firm_id, secret_sha256, revoked_at')
      .eq('id', keyId)
      .maybeSingle();
    if (found.error !== null) throw new Error(`findKey: ${found.error.message}`);
    if (found.data === null) return null;
    const row = z
      .object({ firm_id: z.uuid(), secret_sha256: z.string(), revoked_at: z.string().nullable() })
      .parse(found.data);
    return {
      firmId: row.firm_id,
      secretSha256: row.secret_sha256,
      revoked: row.revoked_at !== null,
    };
  }

  async findMailDomain(firmId: string): Promise<string | null> {
    const found = await this.db.from('firms').select('mail_domain').eq('id', firmId).maybeSingle();
    if (found.error !== null) throw new Error(`findMailDomain: ${found.error.message}`);
    return (
      z.object({ mail_domain: z.string().nullable() }).nullable().parse(found.data)?.mail_domain ??
      null
    );
  }

  async findMatterBySlug(firmId: string, slug: string): Promise<{ matterId: string } | null> {
    const found = await this.db
      .from('matters')
      .select('id')
      .eq('inbound_slug', slug)
      .eq('firm_id', firmId)
      .maybeSingle();
    if (found.error !== null) throw new Error(`findMatterBySlug: ${found.error.message}`);
    if (found.data === null) return null;
    return { matterId: z.object({ id: z.uuid() }).parse(found.data).id };
  }

  async findEmail(
    matterId: string,
    messageId: string,
  ): Promise<{ emailId: string; rawSha256: string } | null> {
    const found = await this.db
      .from('emails')
      .select('id, raw_sha256')
      .eq('matter_id', matterId)
      .eq('message_id', messageId)
      .maybeSingle();
    if (found.error !== null) throw new Error(`findEmail: ${found.error.message}`);
    if (found.data === null) return null;
    const row = z.object({ id: z.uuid(), raw_sha256: z.string() }).parse(found.data);
    return { emailId: row.id, rawSha256: row.raw_sha256 };
  }

  async ingest(input: IngestEmailInput): Promise<{ emailId: string; created: boolean }> {
    const result = await this.db.rpc('ingest_email', {
      p_matter_id: input.matterId,
      p_message_id: input.messageId,
      p_message_id_synthesised: input.messageIdSynthesised,
      p_in_reply_to: input.inReplyTo,
      p_references: input.references,
      p_from_address: input.fromAddress,
      p_to_addresses: input.to,
      p_cc_addresses: input.cc,
      p_subject: input.subject,
      p_sent_at: input.sentAt?.toISOString() ?? null,
      p_raw_storage_path: input.rawStoragePath,
      p_raw_sha256: input.rawSha256,
      p_body_text_storage_path: input.bodyTextStoragePath,
      p_body_html_storage_path: input.bodyHtmlStoragePath,
      p_spf_result: input.spfResult,
      p_dkim_result: input.dkimResult,
      p_attachments: input.attachments.map((a) => ({
        ordinal: a.ordinal,
        filename: a.filename,
        content_type: a.contentType,
        sniffed_content_type: a.sniffedContentType,
        byte_length: a.byteLength,
        sha256: a.sha256,
        storage_path: a.storagePath,
      })),
    });
    if (result.error !== null) throw new Error(`ingest: ${result.error.message}`);
    const row = z
      .array(z.object({ email_id: z.uuid(), created: z.boolean() }))
      .length(1)
      .parse(result.data)[0];
    if (row === undefined) throw new Error('ingest: no result');
    return { emailId: row.email_id, created: row.created };
  }

  async recordIssue(input: {
    action: EmailIssue;
    firmId: string;
    emailSha256: string | null;
    recipientDomain: string | null;
    reason: string;
  }): Promise<void> {
    const result = await this.db.rpc('record_email_issue', {
      p_action: input.action,
      p_firm_id: input.firmId,
      p_email_sha256: input.emailSha256,
      p_recipient_domain: input.recipientDomain,
      p_reason: input.reason,
    });
    if (result.error !== null) throw new Error(`recordIssue: ${result.error.message}`);
  }
}
