// Safe to import anywhere on the server, including the web app: these helpers work through
// whatever client they are given, so a fee earner's session client is bound by RLS.
// Anything that needs the service role lives in './admin' and must never be imported by
// apps/web.
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  EMAIL_NOT_CAPTURED_EVENT,
  timelineRow,
  createMatterInput,
  createParticipantInput,
  err,
  firmRow,
  firmRole,
  inboundAddress,
  matterRow,
  ok,
  participantRow,
} from '@meetlou/domain';
import type {
  Audience,
  CreateMatterInput,
  EmailNotCapturedReason,
  CreateParticipantInput,
  FirmRow,
  FirmRole,
  MatterRow,
  ParticipantRow,
  Result,
  TimelineRow,
} from '@meetlou/domain';
import { z } from 'zod';
import { fromPostgrest, invalidInput } from './errors';
import type { RecordError } from './errors';

export type { RecordError, RecordErrorCode } from './errors';

const MATTER_COLUMNS =
  'id, firm_id, reference, kind, property_address, inbound_slug, line_e164, responsible_fee_earner_id';
const PARTICIPANT_COLUMNS = 'id, firm_id, matter_id, user_id, access, role, display_name';

export interface SessionFirm {
  firm: FirmRow;
  role: FirmRole;
}

/**
 * The firm the signed-in user belongs to, or null if they have no firm (or no session).
 *
 * A login that belongs to more than one firm is refused (`ambiguous_firm`) rather than quietly
 * given the oldest one: each firm is a separate controller (non-negotiable 11), and acting for
 * the wrong one is exactly the mistake that must not be possible by default.
 */
export async function getSessionFirm(
  db: SupabaseClient,
): Promise<Result<SessionFirm | null, RecordError>> {
  // Members can read each other's rows in their own firm, so ask for THIS user's memberships.
  const session = await db.auth.getUser();
  if (session.error !== null) return ok(null);
  const membership = await db
    .from('firm_users')
    .select('firm_id, role')
    .eq('user_id', session.data.user.id)
    .order('created_at', { ascending: true })
    .limit(2);
  if (membership.error !== null) return fromPostgrest(membership.error);
  const rows = membership.data as unknown[];
  if (rows.length === 0) return ok(null);
  if (rows.length > 1) {
    return err<RecordError>({
      code: 'ambiguous_firm',
      message: 'this login belongs to more than one firm',
    });
  }

  const parsed = z.object({ firm_id: z.uuid(), role: firmRole }).parse(rows[0]);
  const firm = await db
    .from('firms')
    .select('id, name, mail_domain')
    .eq('id', parsed.firm_id)
    .single();
  if (firm.error !== null) return fromPostgrest(firm.error);
  return ok({ firm: firmRow.parse(firm.data), role: parsed.role });
}

export interface CreatedMatter {
  matter: MatterRow;
  /** Where mail for this matter is addressed, or null if the firm has no mail domain yet. */
  inboundAddress: string | null;
}

export async function createMatter(
  db: SupabaseClient,
  input: unknown,
): Promise<Result<CreatedMatter, RecordError>> {
  const parsed = createMatterInput.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error);
  const i: CreateMatterInput = parsed.data;

  const firm = await db.from('firms').select('mail_domain').eq('id', i.firmId).maybeSingle();
  if (firm.error !== null) return fromPostgrest(firm.error);
  if (firm.data === null) {
    return err({ code: 'not_permitted', message: 'firm not found or not visible to this user' });
  }

  // inbound_slug is deliberately not sent: the database generates it and ignores any value.
  const inserted = await db
    .from('matters')
    .insert({
      firm_id: i.firmId,
      reference: i.reference,
      kind: i.kind,
      property_address: i.propertyAddress,
      ...(i.lineE164 === undefined ? {} : { line_e164: i.lineE164 }),
      ...(i.responsibleFeeEarnerId === undefined
        ? {}
        : { responsible_fee_earner_id: i.responsibleFeeEarnerId }),
    })
    .select(MATTER_COLUMNS)
    .single();
  if (inserted.error !== null) return fromPostgrest(inserted.error);

  const matter = matterRow.parse(inserted.data);
  const domain = z.object({ mail_domain: z.string().nullable() }).parse(firm.data).mail_domain;
  return ok({
    matter,
    inboundAddress: domain === null ? null : inboundAddress(matter.inbound_slug, domain),
  });
}

export async function createParticipant(
  db: SupabaseClient,
  input: unknown,
): Promise<Result<ParticipantRow, RecordError>> {
  const parsed = createParticipantInput.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error);
  const i: CreateParticipantInput = parsed.data;

  const inserted = await db
    .from('participants')
    .insert({
      firm_id: i.firmId,
      matter_id: i.matterId,
      display_name: i.displayName,
      access: i.access,
      role: i.role,
      ...(i.phoneE164 === undefined ? {} : { phone_e164: i.phoneE164 }),
      ...(i.email === undefined ? {} : { email: i.email }),
    })
    .select(PARTICIPANT_COLUMNS)
    .single();
  if (inserted.error !== null) return fromPostgrest(inserted.error);
  return ok(participantRow.parse(inserted.data));
}

export interface UncapturedEmailInput {
  firmId: string;
  matterId: string;
  reason: EmailNotCapturedReason;
  /** When the sender says they sent it. */
  occurredAt: Date;
}

/**
 * A fee earner records that an email was sent to a matter but never arrived (most often because
 * it exceeded the email provider's 30 MB limit, which drops it before it reaches us). The gap
 * becomes a fact on the timeline instead of an absence the file would silently hide.
 */
export async function recordUncapturedEmail(
  db: SupabaseClient,
  input: UncapturedEmailInput,
  actorUserId: string,
): Promise<Result<{ eventId: string }, RecordError>> {
  const inserted = await db
    .from('events')
    .insert({
      firm_id: input.firmId,
      matter_id: input.matterId,
      kind: EMAIL_NOT_CAPTURED_EVENT,
      visibility: 'firm',
      occurred_at: input.occurredAt.toISOString(),
      actor_kind: 'fee_earner',
      actor_id: actorUserId,
      summary: `email not captured: ${input.reason}`,
    })
    .select('id')
    .single();
  if (inserted.error !== null) return fromPostgrest(inserted.error);
  return ok({ eventId: z.object({ id: z.uuid() }).parse(inserted.data).id });
}

// --- the approval gate (rule 4) ---------------------------------------------------------------

const outputRef = z.object({ id: z.uuid(), firm_id: z.uuid(), matter_id: z.uuid() });

async function currentUserId(db: SupabaseClient): Promise<string | null> {
  const user = await db.auth.getUser();
  return user.error === null ? user.data.user.id : null;
}

/**
 * A fee earner approves a generated output for the client. Run through the fee earner's own
 * session: the database allows the insert only for a fee earner of the output's firm, as
 * themselves. The service role cannot do this, by design, and neither can a COLP or a participant.
 */
export async function approveOutput(
  db: SupabaseClient,
  outputId: string,
): Promise<Result<{ approvalId: string }, RecordError>> {
  const userId = await currentUserId(db);
  if (userId === null) return err({ code: 'not_permitted', message: 'not signed in' });

  const output = await db
    .from('generated_outputs')
    .select('id, firm_id, matter_id')
    .eq('id', outputId)
    .maybeSingle();
  if (output.error !== null) return fromPostgrest(output.error);
  if (output.data === null) {
    return err({ code: 'not_permitted', message: 'output not found or not visible to this user' });
  }
  const ref = outputRef.parse(output.data);

  const inserted = await db
    .from('approvals')
    .insert({
      firm_id: ref.firm_id,
      matter_id: ref.matter_id,
      generated_output_id: ref.id,
      approved_by: userId,
    })
    .select('id')
    .single();
  if (inserted.error !== null) return fromPostgrest(inserted.error);
  return ok({ approvalId: z.object({ id: z.uuid() }).parse(inserted.data).id });
}

/** Withdraw an approval. The client stops seeing the summary at once; approve a newer version instead. */
export async function withdrawApproval(
  db: SupabaseClient,
  approvalId: string,
): Promise<Result<{ withdrawalId: string }, RecordError>> {
  const userId = await currentUserId(db);
  if (userId === null) return err({ code: 'not_permitted', message: 'not signed in' });

  const approval = await db
    .from('approvals')
    .select('id, firm_id, matter_id')
    .eq('id', approvalId)
    .maybeSingle();
  if (approval.error !== null) return fromPostgrest(approval.error);
  if (approval.data === null) {
    return err({
      code: 'not_permitted',
      message: 'approval not found or not visible to this user',
    });
  }
  const ref = outputRef.parse(approval.data);

  const inserted = await db
    .from('approval_withdrawals')
    .insert({
      firm_id: ref.firm_id,
      matter_id: ref.matter_id,
      approval_id: ref.id,
      withdrawn_by: userId,
    })
    .select('id')
    .single();
  if (inserted.error !== null) return fromPostgrest(inserted.error);
  return ok({ withdrawalId: z.object({ id: z.uuid() }).parse(inserted.data).id });
}

export interface ClientVisibleSummary {
  outputId: string;
  matterId: string;
  callId: string;
  version: number;
  approvedAt: string;
  content: { summary: string; actions: unknown[]; keyDates: unknown[] };
}

/**
 * THE client-visible route. It reads `client_visible_outputs`, which is built from the approval
 * rows: an output with no approval, a withdrawn approval, or a newer version is not here. Nothing
 * that serves a client may read generated_outputs directly.
 */
export async function getClientVisibleSummaries(
  db: SupabaseClient,
): Promise<Result<ClientVisibleSummary[], RecordError>> {
  const rows = await db
    .from('client_visible_outputs')
    .select('output_id, matter_id, call_id, version, content, approved_at');
  if (rows.error !== null) return fromPostgrest(rows.error);
  return ok(
    z
      .array(
        z.object({
          output_id: z.uuid(),
          matter_id: z.uuid(),
          call_id: z.uuid(),
          version: z.number().int(),
          approved_at: z.string(),
          content: z.object({
            summary: z.string(),
            actions: z.array(z.unknown()),
            keyDates: z.array(z.unknown()),
          }),
        }),
      )
      .parse(rows.data)
      .map((r) => ({
        outputId: r.output_id,
        matterId: r.matter_id,
        callId: r.call_id,
        version: r.version,
        approvedAt: r.approved_at,
        content: r.content,
      })),
  );
}

// --- the shared timeline -----------------------------------------------------------------------

const TIMELINE_COLUMNS =
  'event_id, matter_id, kind, visibility, subject_kind, subject_id, occurred_at, recorded_at, actor_kind, actor_id, summary, read_at';

/**
 * A matter's timeline AS THE CALLER. There is no role argument and no filtering here: the view is
 * read under the caller's own session, and row-level security on events decides what comes back.
 * The same call by a fee earner, a client participant and a chain participant returns three sets.
 */
export async function getMatterTimeline(
  db: SupabaseClient,
  matterId: string,
  options: { limit?: number } = {},
): Promise<Result<TimelineRow[], RecordError>> {
  const rows = await db
    .from('matter_timeline')
    .select(TIMELINE_COLUMNS)
    .eq('matter_id', matterId)
    .order('occurred_at', { ascending: true })
    .order('recorded_at', { ascending: true })
    .limit(options.limit ?? 500);
  if (rows.error !== null) return fromPostgrest(rows.error);
  return ok(z.array(timelineRow).parse(rows.data));
}

/**
 * For a fee earner checking what another audience would see: the same rule the policy applies,
 * over what the caller can already see. It is a check on the rule, not how participants are served.
 */
export async function getTimelinePreview(
  db: SupabaseClient,
  matterId: string,
  forAudience: Audience,
): Promise<Result<TimelineRow[], RecordError>> {
  const rows = await db.rpc('matter_timeline_as', {
    p_matter_id: matterId,
    p_audience: forAudience,
  });
  if (rows.error !== null) return fromPostgrest(rows.error);
  const mapped = z
    .array(z.object({ ...timelineRow.shape, event_id: z.uuid() }))
    .parse(rows.data)
    .sort(
      (a, b) =>
        a.occurred_at.localeCompare(b.occurred_at) || a.recorded_at.localeCompare(b.recorded_at),
    );
  return ok(mapped);
}

/**
 * Record that the caller opened an event. The first opening stands: the database keeps one
 * receipt per (event, reader), stamped with the server's clock and the reader's capacity at the
 * time. Opening it again changes nothing. Only an event the caller may see can be opened.
 */
export async function markEventRead(
  db: SupabaseClient,
  eventId: string,
): Promise<Result<{ opened: boolean }, RecordError>> {
  const userId = await currentUserId(db);
  if (userId === null) return err({ code: 'not_permitted', message: 'not signed in' });
  const event = await db
    .from('matter_timeline')
    .select('event_id, matter_id')
    .eq('event_id', eventId)
    .maybeSingle();
  if (event.error !== null) return fromPostgrest(event.error);
  if (event.data === null) {
    return err({ code: 'not_permitted', message: 'event not found or not visible to this user' });
  }
  const ref = z.object({ event_id: z.uuid(), matter_id: z.uuid() }).parse(event.data);
  // A participant cannot read the matter row; the receipt carries the firm id of the event.
  const eventRow = await db.from('events').select('firm_id').eq('id', eventId).single();
  if (eventRow.error !== null) return fromPostgrest(eventRow.error);
  const firmId = z.object({ firm_id: z.uuid() }).parse(eventRow.data).firm_id;

  const inserted = await db
    .from('receipts')
    .upsert(
      { firm_id: firmId, matter_id: ref.matter_id, event_id: eventId, user_id: userId },
      { onConflict: 'event_id,user_id', ignoreDuplicates: true },
    )
    .select('id');
  if (inserted.error !== null) return fromPostgrest(inserted.error);
  return ok({ opened: inserted.data.length > 0 });
}

export interface EventRead {
  eventId: string;
  readerRole: string;
  readAt: string;
  displayName: string | null;
}

/** For the firm: who has opened what on a matter, when, and in what capacity. */
export async function getMatterEventReads(
  db: SupabaseClient,
  matterId: string,
): Promise<Result<EventRead[], RecordError>> {
  const rows = await db
    .from('matter_event_reads')
    .select('event_id, reader_role, read_at, display_name')
    .eq('matter_id', matterId)
    .order('read_at', { ascending: true });
  if (rows.error !== null) return fromPostgrest(rows.error);
  return ok(
    z
      .array(
        z.object({
          event_id: z.uuid(),
          reader_role: z.string(),
          read_at: z.string(),
          display_name: z.string().nullable(),
        }),
      )
      .parse(rows.data)
      .map((r) => ({
        eventId: r.event_id,
        readerRole: r.reader_role,
        readAt: r.read_at,
        displayName: r.display_name,
      })),
  );
}

export interface MatterEventInput {
  firmId: string;
  matterId: string;
  kind: string;
  visibility: Audience;
  summary: string;
  occurredAt: Date;
}

/** A fee earner adds a fact to the timeline (an agreed exchange date, a note for the client). */
export async function addMatterEvent(
  db: SupabaseClient,
  input: MatterEventInput,
  actorUserId: string,
): Promise<Result<{ eventId: string }, RecordError>> {
  const inserted = await db
    .from('events')
    .insert({
      firm_id: input.firmId,
      matter_id: input.matterId,
      kind: input.kind,
      visibility: input.visibility,
      occurred_at: input.occurredAt.toISOString(),
      actor_kind: 'fee_earner',
      actor_id: actorUserId,
      summary: input.summary,
    })
    .select('id')
    .single();
  if (inserted.error !== null) return fromPostgrest(inserted.error);
  return ok({ eventId: z.object({ id: z.uuid() }).parse(inserted.data).id });
}
