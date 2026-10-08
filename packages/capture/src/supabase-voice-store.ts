import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { NewCall, RoutedLine, UnroutedReason, VoiceStore } from './ports.ts';

const lineRow = z.object({
  id: z.uuid(),
  firm_id: z.uuid(),
  property_address: z.string(),
  responsible_fee_earner_id: z.uuid().nullable(),
  firms: z.object({ name: z.string() }),
});

/** Service-role implementation of VoiceStore. The client is injected; the key lives only in the function's environment. */
export class SupabaseVoiceStore implements VoiceStore {
  constructor(private readonly db: SupabaseClient) {}

  async findLine(toE164: string): Promise<RoutedLine | null> {
    const found = await this.db
      .from('matters')
      .select('id, firm_id, property_address, responsible_fee_earner_id, firms(name)')
      .eq('line_e164', toE164)
      .maybeSingle();
    if (found.error !== null) throw new Error(`findLine: ${found.error.message}`);
    if (found.data === null) return null;
    const matter = lineRow.parse(found.data);

    let phone: string | null = null;
    if (matter.responsible_fee_earner_id !== null) {
      const member = await this.db
        .from('firm_users')
        .select('phone_e164')
        .eq('id', matter.responsible_fee_earner_id)
        .maybeSingle();
      if (member.error !== null) throw new Error(`findLine: ${member.error.message}`);
      phone =
        z.object({ phone_e164: z.string().nullable() }).nullable().parse(member.data)?.phone_e164 ??
        null;
    }
    return {
      matterId: matter.id,
      firmId: matter.firm_id,
      firmName: matter.firms.name,
      propertyAddress: matter.property_address,
      feeEarnerPhoneE164: phone,
    };
  }

  async recordCall(call: NewCall): Promise<{ callId: string; created: boolean }> {
    // ON CONFLICT (call_sid) DO NOTHING: a retried delivery never creates a second call and
    // never updates the first (calls is append-only).
    const inserted = await this.db
      .from('calls')
      .upsert(
        {
          firm_id: call.firmId,
          matter_id: call.matterId,
          call_sid: call.callSid,
          from_e164: call.fromE164,
          to_e164: call.toE164,
          started_at: call.startedAt.toISOString(),
          consent_announcement_version: call.consentAnnouncementVersion,
          consent_outcome: 'given',
          consent_given_at: call.consentGivenAt.toISOString(),
        },
        { onConflict: 'call_sid', ignoreDuplicates: true },
      )
      .select('id');
    if (inserted.error !== null) throw new Error(`recordCall: ${inserted.error.message}`);
    const created = z.array(z.object({ id: z.uuid() })).parse(inserted.data);
    const first = created[0];
    if (first !== undefined) return { callId: first.id, created: true };

    const existing = await this.db.from('calls').select('id').eq('call_sid', call.callSid).single();
    if (existing.error !== null) throw new Error(`recordCall: ${existing.error.message}`);
    return { callId: z.object({ id: z.uuid() }).parse(existing.data).id, created: false };
  }

  async recordUnroutedCall(input: {
    callSid: string;
    toE164: string;
    reason: UnroutedReason;
  }): Promise<void> {
    const result = await this.db.rpc('record_unrouted_call', {
      p_call_sid: input.callSid,
      p_to_e164: input.toE164,
      p_reason: input.reason,
    });
    if (result.error !== null) throw new Error(`recordUnroutedCall: ${result.error.message}`);
  }
}
