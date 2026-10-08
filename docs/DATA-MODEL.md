# Data model

## As built: migrations 0001 to 0007

The first draft below was written before the schema. Where it disagrees with this section, **this section is right** (it is what the migrations and tests do). The recording, transcript, generated-output, approval, retention and legal-hold tables below are still the plan and arrive in later migrations.

| Migration                              | Contents                                                                                                                                                                                                                                                                                                    |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0001_foundation`                      | `app` helper schema (not API-exposed), default privileges revoked from `anon`/`authenticated`/`service_role`, the `raise_append_only()` guard                                                                                                                                                               |
| `0002_firms`                           | `firms`, `firm_users` (role: `fee_earner`, `colp`, `admin`), `app.is_firm_user`, `app.has_firm_role`                                                                                                                                                                                                        |
| `0003_matters_participants`            | `matters`, `participants`, slug generator, `app.participant_access`                                                                                                                                                                                                                                         |
| `0004_calls_emails`                    | `calls`, `emails`                                                                                                                                                                                                                                                                                           |
| `0005_events_receipts`                 | `events`, `receipts`, `app.can_see_event`, `app.can_see_event_id`                                                                                                                                                                                                                                           |
| `0006_attachments`                     | `attachments`, `app.attachment_shared_with_client`                                                                                                                                                                                                                                                          |
| `0007_audit_log`                       | `audit_log`, `app.audit_change()` triggers on the mutable tables                                                                                                                                                                                                                                            |
| `0008_mail_domain_and_address_slugs`   | `firms.mail_domain`; `inbound_slug` now built from the property address                                                                                                                                                                                                                                     |
| `0009_voice_routing`                   | `firm_users.phone_e164`, `matters.responsible_fee_earner_id`, `calls.from_e164` nullable, wider `audit_log.detail` allow-list, `record_unrouted_call()`                                                                                                                                                     |
| `0010_call_recordings`                 | `call_recordings`, `recording_suppressions`, `ingest_recording()`, `record_recording_issue()`                                                                                                                                                                                                               |
| `0011_recordings_bucket`               | the private `recordings` Storage bucket and its read policy                                                                                                                                                                                                                                                 |
| `0012_transcripts`                     | `transcripts` (guards only), `recordings_awaiting_transcription`                                                                                                                                                                                                                                            |
| `0013_inbound_email`                   | `inbound_email_keys`, `register_inbound_email_key()`, `ingest_email()`, `record_email_issue()`, view `email_threads`, `emails.message_id_synthesised`, `attachments.sniffed_content_type`                                                                                                                   |
| `0014_email_buckets`                   | the private `emails` and `attachments` buckets and their read policy                                                                                                                                                                                                                                        |
| `0015_transcript_versions`             | `transcripts.version` / `supersedes_id`, `current_transcripts`, `store_transcript()`, the private `transcripts` bucket                                                                                                                                                                                      |
| `0016_generated_outputs_and_approvals` | `generated_outputs`, `approvals`, `approval_withdrawals`, `client_visible_outputs`, `call_summaries_current`, the work-queue views, `store_generated_output()`                                                                                                                                              |
| `0017_timeline`                        | event triggers on every capture table, `app.capture_visibility()`, `app.visibility_allows()`, capture audit triggers, `record_recording_access()`, `receipts.reader_role`, views `matter_timeline` / `matter_event_reads`, `matter_timeline_as()`                                                           |
| `0018_retention`                       | `retention_policies`, `matter_retention_overrides`, `legal_holds`, `legal_hold_releases`, `erasure_requests`, `erasure_request_decisions`, `erasure_runs`, `erasure_run_completions`, `matters.closed_recorded_at`, the `retention_runner` role, `retention_due()`, `begin_erasure()`, `complete_erasure()` |

Changes from the draft:

- **Tables are named `firm_users` (not `firm_members`), `receipts` (not `event_reads`) and `attachments` (not `email_attachments`).**
- **Routing is on the matter, not the firm.** `matters.inbound_slug` (unique) is `<address prefix>-<24 hex chars = 96 random bits>` (from migration 0008 the prefix is the first line of `property_address`, lower-cased, letters and digits only, at most 30 characters: `14 Meadow Road, Sale M33 2QX` gives `14meadowroad`); the matter's mail address is `<inbound_slug>@<firms.mail_domain>`. It is always generated by a trigger, a caller-supplied value is overwritten, and it is immutable. `matters.line_e164` (unique) routes calls. So `inbound_email_keys`, `firm_phone_numbers` and `matter_assignments` are gone: a call or email is attached to its matter when it is written, `matter_id` is `not null`, and a misfiled item is corrected by a new row with `supersedes_id`.
- **`emails` idempotency is `unique (matter_id, message_id)`**, not global, so one firm cannot cause another firm's legitimate email to be dropped as a duplicate by reusing a Message-ID.
- **`events.visibility` is `firm`, `client` or `chain`, default `firm`.** One function, `app.can_see_event`, holds the rule: a firm user sees everything on their firm's matters; a `client` participant sees `client` and `chain` events on their own matter; a `chain` participant sees `chain` events only; participants never see `firm` events.
- **Documents.** A firm user reads every attachment on their firm's matters. A `client` participant reads an attachment only once a `client`-visibility event about it exists (the fee earner's "document shared" event, which puts the sharing on the timeline). A `chain` participant never reads one: no branch of the policy admits them, and a `chain`-visibility event about a document does not unlock it. Participants read no `calls`, `emails` or `matters` rows.
- **Participants have `user_id` and `access`** (`client` or `chain`) alongside the descriptive `role`.
- **Two-layer append-only.** `calls`, `emails`, `attachments`, `events`, `receipts` and `audit_log` have no UPDATE, DELETE or TRUNCATE grant for any API role, and a trigger raises for every role including the table owner. Retention's delete path (milestone M7) will be added by a later migration for evidence tables; **`audit_log` is never deletable**.
- **Column-level grants** stop `authenticated` writing `inbound_slug`, moving rows between firms, or supplying `recorded_at`/`read_at`.
- **`audit_log.detail`** accepts only the keys `changed_columns` and `counts` (a check constraint), so values and content cannot be written into it. The hash chain from the draft is not built yet.
- **Voice routing (0009).** A call to `matters.line_e164` rings the matter's `responsible_fee_earner_id` at that member's `firm_users.phone_e164`. `calls.from_e164` is null when the caller withholds their number (a null is honest; an invented number would not be). `audit_log.detail` may now also carry `call_sid`, `to_e164` and `reason` (still no content, never the caller's number). `public.record_unrouted_call()` (service role only) writes a `call.unrouted` audit row, unique per call SID so redeliveries add none.
- **The `calls` row is written when the announcement has played**, not at the first webhook (see BUILD-ORDER M3), so `consent_given_at` is the moment Twilio confirmed the caller heard it and stayed.
- **Recordings (0010-0012).** `call_recordings` (unique `twilio_recording_sid`; `channels` is read from the WAV header, `is_dual_channel` is generated from it; a trigger refuses a recording for a call without consent). `recording_suppressions` holds why a recording is not a real conversation (`misdial`, `near_duplicate` naming the original, `single_speaker`), one row per reason, nothing deleted. `ingest_recording()` does the insert, events and guards in one transaction under a per-matter advisory lock. Audio lives in the private `recordings` bucket at `<firm_id>/<matter_id>/<recording_sid>.wav`; only that firm's members can read it. `transcripts` exists so the database itself refuses `diarised = true` for a mono recording and records a single-speaker transcript as a suppression. `audit_log.detail` may now name a `recording_sid`.
- **Inbound email (0013-0014).** `inbound_email_keys` holds only the SHA-256 of each URL secret (column-level: even the COLP cannot select it) and a `revoked_at`; every change is audited. `ingest_email()` writes the email, its attachments and their events in one transaction, idempotent on `(matter_id, message_id)`, and flags a redelivery whose bytes differ. `email_threads` is a view over the raw headers: `thread_key` is found by walking In-Reply-To / References up through parents on file, never from the subject. Raw messages, bodies and attachments live in private buckets `emails` and `attachments`, named `<firm>/<matter>/...`, readable only by that firm's members.
- **Model output and the approval gate (0015-0016).** `generated_outputs` holds each summary as validated JSON in a `content` column (the transcript text stays in Storage), with provider, model, prompt version, a `run_id` for idempotency, a per-call `version` and `supersedes_id`. This replaces the earlier plan of a `client_visible` boolean and `body_storage_path`: **there is no flag**, because the database policy has to be the gate. `approvals` (one per output, insert-only, a fee earner as themselves) and `approval_withdrawals` are the only thing that makes an output reach a client, via the view `client_visible_outputs`. Participants have no policy on `generated_outputs`, `approvals` or `call_summaries_current`. Transcripts are versioned the same way and `transcripts.diarised` can be true only for a two-channel recording.
- **Not yet built:** a transcription vendor adapter, legal holds, erasure schedule, webhook receipts, quarantine. `calls` holds consent facts only until the recordings table exists.

Design principle: **the record is evidence**. Two classes of table.

- **Reference tables** (mutable, every change audited): `firms`, `firm_members`, `matters`, `participants`, `firm_phone_numbers`, `inbound_email_keys`, `retention_policies`.
- **Evidence tables** (insert-only, enforced in Postgres): everything else. No `UPDATE`, no `DELETE`, except by the retention role. "Status" that changes over time (recording arrived, transcript finished, assigned to a matter) is a **new row in a satellite table**, never a mutated column.

Common to every evidence row: `id uuid pk`, `firm_id` (RLS anchor), `recorded_at timestamptz default now()` (server time, never client-supplied), and where the thing has a source time, `occurred_at`. Correction = new row with `supersedes_id` pointing at the old one; readers show the latest unsuperseded row and the history is always available.

All tables: `ENABLE` and `FORCE ROW LEVEL SECURITY`.

## Roles

| Role                                               | Who                                   | Can                                                                                                                         |
| -------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `authenticated` (+ `firm_members.role`)            | Signed-in firm staff via the anon key | Read own firm's data under RLS. Insert only `event_reads` and `approvals` (own rows).                                       |
| `service_role`                                     | Edge Functions (webhooks, jobs)       | Insert evidence rows. **Granted no UPDATE/DELETE on evidence tables.** Bypasses RLS, so never reachable from the browser.   |
| `retention_runner`                                 | The scheduled erasure function only   | The only role with `DELETE` on evidence tables, via `SECURITY DEFINER` functions that check legal hold and retention first. |
| `firm_members.role`: `fee_earner`, `colp`, `admin` | Enumerates within a firm              | `colp` and `admin` manage reference data and legal holds; `fee_earner` writes approvals; all three read the firm's matters. |

`SECURITY DEFINER` functions set `search_path` explicitly. `EXECUTE` on retention functions is revoked from `public`, `authenticated` and `service_role`.

A helper `auth_firm_ids()` (stable, `SECURITY DEFINER`) returns the firm ids of the current `auth.uid()` from `firm_members`. Policies use `firm_id in (select auth_firm_ids())`.

## Reference tables

### `firms`

`id`, `name`, `created_at`. Key: `id`.
RLS: a member may read their own firm. Nobody writes via the API; firms are provisioned by an operator migration/script.

### `firm_members`

`(firm_id, user_id)` unique; `role` in (`fee_earner`, `colp`, `admin`); `created_at`. `user_id` references `auth.users`.
RLS: a member may read the membership rows of their own firm. Only `colp`/`admin` of that firm may insert/update/delete members. Every change writes an `audit_log` row.

### `matters`

`id`, `firm_id`, `reference` (firm's own file reference; unique per firm), `kind` (`sale`, `purchase`, `sale_and_purchase`, `remortgage`, `transfer_of_equity`), `property_address`, `responsible_fee_earner_id`, `opened_at`, `closed_at`, `exchanged_at`, `completed_at`, `retention_policy_id`.
Keys: `id`; `unique (firm_id, reference)`.
RLS: members of the firm may read. `fee_earner`/`colp`/`admin` of the firm may insert and update. No delete from the API (only the retention job removes a matter). Changes to `closed_at` (which starts the retention clock), `exchanged_at` and `completed_at` are audited.

### `participants`

`id`, `firm_id`, `matter_id`, `role` (`client`, `other_side_client`, `other_side_representative`, `estate_agent`, `lender`, `mortgage_broker`, `other`), `display_name`, `phone_e164`, `email`.
Keys: `id`; unique `(matter_id, phone_e164)` and `(matter_id, lower(email))` where not null.
RLS: members of the firm read; fee earners/COLP/admin write. Used only to _suggest_ matter assignment by caller number or sender address; the assignment itself is a recorded fact (see `matter_assignments`).

### `firm_phone_numbers`

`id`, `firm_id`, `twilio_number_e164` (unique across the system), `forward_to_e164`, `consent_announcement_version`.
RLS: members read; `colp`/`admin` write. This is how an inbound `To` number resolves to a firm.

### `inbound_email_keys`

`id`, `firm_id`, `public_id uuid` (appears in the URL, not secret), `secret_sha256 bytea` (SHA-256 of the secret that is also in the URL; the secret itself is never stored), `created_at`, `revoked_at`.
RLS: `colp`/`admin` of the firm read metadata (never `secret_sha256`: column-level revoke) and revoke. Creation is via a function that returns the secret once. Two active keys per firm permitted so rotation has no gap.

### `retention_policies`

`id`, `firm_id`, `name`, `retention_period_years` (integer; the firm's value, set by the COLP), `starts_from` (`matter_closed_at`), `created_by`.
RLS: members read; `colp` writes. There is deliberately **no default value supplied by the code**: the firm states its retention period (see open question in BUILD-ORDER).

## Evidence tables

### `calls`

One row per call, written when the consent outcome is known (see Consent below).

| Column                                                        | Notes                                             |
| ------------------------------------------------------------- | ------------------------------------------------- |
| `id`, `firm_id`                                               |                                                   |
| `twilio_call_sid text`                                        | **Idempotency key**: `unique`                     |
| `direction`                                                   | `inbound` only for now                            |
| `from_e164`, `to_e164`                                        |                                                   |
| `started_at` (Twilio time, `occurred_at`), `recorded_at`      |                                                   |
| `consent_announcement_version`, `consent_announcement_sha256` | Which exact wording was played                    |
| `consent_outcome`                                             | `given`, `declined`, `no_response`                |
| `consent_given_at timestamptz`                                | Not null iff outcome = `given`. Check constraint. |
| `supersedes_id`                                               | Correction chain                                  |

Check constraint: `consent_outcome = 'given'` <=> `consent_given_at is not null`.
RLS: members of the firm read. No insert policy for `authenticated`; only `service_role` inserts. Append-only trigger.

### `call_recordings`

One row per recording artefact received. `id`, `firm_id`, `call_id`, `twilio_recording_sid` (**unique**), `storage_path`, `sha256`, `byte_length`, `duration_seconds`, `channels smallint` (read **from the WAV header**, not from Twilio's claim), `requested_channels smallint` (2), `is_dual_channel boolean` generated from `channels = 2`, `received_at`.
Constraint: recording row may only be inserted if the parent call has `consent_outcome = 'given'` (enforced by trigger; a recording callback for a non-consented call goes to `quarantined_inputs`, never to storage under a matter).
RLS: members read. Insert by `service_role` only. Append-only. A mono result is stored as `channels = 1` and surfaced; nothing downstream may call it diarised.

### `transcripts`

`id`, `firm_id`, `call_recording_id`, `provider`, `provider_job_id`, `model`, `diarised boolean` (check: true only if the recording `is_dual_channel`), `language`, `body_storage_path` (the transcript text lives in Storage, not a column, so it is excluded from ordinary SELECTs and logs), `sha256`, `produced_at`.
Key: unique `(call_recording_id, provider, provider_job_id)`. A re-transcription is a new row.
RLS/append-only as above.

### `generated_outputs`

Anything a model produced: summaries now, other kinds later. `id`, `firm_id`, `source_kind` / `source_id` (a `transcripts` or `emails` row), `kind` (`call_summary`, `email_summary`), `provider`, `model`, `prompt_version`, `body_storage_path`, `sha256`, `client_visible boolean not null default false`, `produced_at`.
Key: unique `(source_kind, source_id, kind, provider, model, prompt_version)`.
RLS: members read. Fee-earner-facing reads are always allowed. **Client-facing read is exposed only through the view `client_visible_outputs`, which joins `approvals`** (below). There is no policy or view that serves a `client_visible` output without an approval.

### `approvals`

`id`, `firm_id`, `generated_output_id`, `approved_by` (a `fee_earner` member, enforced by trigger on role), `approved_at`.
Key: unique `(generated_output_id)` (first approval stands; a retraction is a new `approval_withdrawals` row, which the view honours).
RLS: members read. Insert allowed only where `approved_by = auth.uid()` and the user's role in that firm is `fee_earner`. Cannot be inserted by `service_role` on behalf of a user (no grant).

### `emails`

| Column                                                           | Notes                                                                                              |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `id`, `firm_id`                                                  |                                                                                                    |
| `message_id text`                                                | Normalised (angle brackets stripped, trimmed). **Idempotency key: `unique (firm_id, message_id)`** |
| `in_reply_to text null`                                          | Normalised                                                                                         |
| `references_ids text[]`                                          | Normalised, in header order                                                                        |
| `from_address`, `to_addresses[]`, `cc_addresses[]`               |                                                                                                    |
| `subject`                                                        | Stored for display; **never used for threading**                                                   |
| `sent_at` (`Date` header, claimed, `occurred_at`), `recorded_at` | Both kept                                                                                          |
| `raw_storage_path`, `raw_sha256`                                 | The unmodified MIME as received, in Storage                                                        |
| `body_text_storage_path`, `body_html_storage_path`               | Bodies in Storage, not columns                                                                     |
| `spf_result`, `dkim_result`                                      | As reported by SendGrid. Recorded as claims, never trusted for assignment                          |
| `supersedes_id`                                                  |                                                                                                    |

If an email arrives with no Message-ID, one is synthesised as `sha256(raw)@meetlou.invalid` and flagged `message_id_synthesised`, so the idempotency key still holds.
RLS: members read. Insert by `service_role` only. Append-only.

### `email_attachments`

`id`, `firm_id`, `email_id`, `ordinal`, `filename`, `declared_content_type`, `sniffed_content_type`, `byte_length`, `sha256`, `storage_path`, `content_id`.
Key: unique `(email_id, ordinal)`. Identical bytes are stored once per firm under `sha256` and referenced by many rows.
RLS and append-only as `emails`.

**Thread view `email_threads`** (not a table). `thread_key` is derived, never stored: the first entry of `references_ids`, else `in_reply_to`, else the email's own `message_id`; when the referenced parent exists in `emails`, that parent's `thread_key` wins. Because it is a view over raw headers, a parent that arrives after its reply cannot require an update, and a thread merge is simply a different answer from the same immutable rows.

### `matter_assignments`

How an email, call or any evidence row is attached to a matter. `id`, `firm_id`, `subject_kind` (`call`, `email`), `subject_id`, `matter_id`, `method` (`auto_participant_phone`, `auto_participant_email`, `auto_matter_reference`, `manual`), `assigned_by` (null for automatic), `assigned_at`, `supersedes_id`.
RLS: members read. Fee earners/COLP/admin may insert `manual` rows for their firm; automatic rows by `service_role`. Append-only; the _effective_ matter is the latest unsuperseded assignment. Reassignment is a new row, so the file shows that, when, and by whom a call was moved.

### `events` (the shared timeline)

`id`, `firm_id`, `matter_id` (null while unassigned), `kind` (`call.received`, `call.consent_recorded`, `call.recording_stored`, `call.recording_mono`, `call.transcribed`, `email.received`, `email.attachment_stored`, `output.generated`, `output.approved`, `matter.assigned`, `legal_hold.placed`, `legal_hold.released`, ...), `subject_kind`, `subject_id`, `occurred_at`, `recorded_at`, `actor_kind` (`system`, `fee_earner`, `participant`), `actor_id`, `summary` (short, fixed-vocabulary, **no body content**), `supersedes_id`.
Key: `unique (subject_kind, subject_id, kind)` for the system-generated kinds, which makes event emission idempotent too.
RLS: members read rows where `firm_id` is theirs. Insert by `service_role` and, for `output.approved`/`matter.assigned (manual)`, by the same transaction that wrote the approval/assignment. Append-only.
View `matter_timeline(matter_id)` = events whose `matter_id` is set **or** whose subject has an effective assignment to that matter, ordered by `occurred_at`, then `recorded_at`.

### `event_reads` (read receipts)

`id`, `firm_id`, `event_id`, `user_id`, `read_at`. Key: unique `(event_id, user_id)` (first read stands).
RLS: a member may read the receipts of their firm; may insert only with `user_id = auth.uid()` and a matching `firm_id`. Append-only.

### `legal_holds` and `legal_hold_releases`

`legal_holds`: `id`, `firm_id`, `matter_id`, `reason_code` (`complaint`, `claim`, `regulatory`, `other`), `placed_by` (`colp` or `admin`), `placed_at`. `legal_hold_releases`: `id`, `legal_hold_id` (unique), `released_by`, `released_at`.
A matter is _on hold_ iff it has a hold with no release. Two insert-only tables avoid updating a hold to release it.
RLS: members read; only `colp`/`admin` insert, `placed_by = auth.uid()`. Free-text reason is deliberately not stored in a column that logs could capture; the code set is enough for the file, and detail belongs in the firm's own complaint system.

### `erasure_schedule`

`id`, `firm_id`, `matter_id` (unique), `erase_after date` (matter `closed_at` + the firm's `retention_period_years`), `scheduled_at`.
Maintained by `service_role`/the retention function when a matter closes or the policy changes (a policy change inserts a replacement via the `supersedes_id` convention). The runner only erases where `erase_after <= today`, the matter is not on hold **at the moment of erasure** (checked inside the erasing transaction), and the matter is closed.

### `audit_log`

`id bigint identity`, `firm_id`, `occurred_at`, `actor_kind`, `actor_id`, `action` (e.g. `matter.closed`, `member.added`, `evidence.erased`, `legal_hold.placed`), `object_kind`, `object_id`, `detail jsonb` (identifiers and **counts only**, validated by a check that rejects keys outside an allow-list), `prev_hash bytea`, `row_hash bytea`.
`row_hash = sha256(prev_hash || canonical(row))`: a hash chain, so deletion or alteration of an audit entry is detectable.
Reference-table changes are written by triggers. Erasure writes, for example, `evidence.erased` with `{matter_id, calls: 4, emails: 112, recordings: 4, attachments: 37}` and nothing about content.
RLS: `colp`/`admin` of the firm read. Nobody inserts via the API; triggers and `SECURITY DEFINER` functions do. Append-only, and the retention role may not delete audit rows either.

### `webhook_receipts`

`id`, `source` (`twilio_voice`, `twilio_recording`, `sendgrid_inbound`), `delivery_key` (CallSid / RecordingSid / Message-ID), `received_at`, `outcome` (`accepted`, `duplicate`, `rejected_auth`, `rejected_invalid`), `firm_id` (nullable), `byte_length`.
**No unique constraint**: each delivery is its own row, so "arrived three times, processed once" is itself on the file. No payload bodies. Retained shorter than evidence (retention job).

### `quarantined_inputs`

Inputs that authenticated but cannot be safely attached: a recording callback for a call with no consent row; an email whose firm key was revoked yet arrived; a recording that failed hash/format verification. `id`, `source`, `delivery_key`, `reason`, `storage_path`, `received_at`. `service_role` insert; `colp`/`admin` read. Never shown on a matter timeline.

## Idempotency keys

| Input                            | Key                                                                                 | Mechanism                                                                                                                         |
| -------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Twilio voice webhook (consent)   | `calls.twilio_call_sid`                                                             | `INSERT … ON CONFLICT DO NOTHING`; the repeat returns the same TwiML for the stored outcome                                       |
| Twilio recording-status callback | `call_recordings.twilio_recording_sid`                                              | Same. Download/verify happens before the insert; storage path is derived from the sid, so a retry overwrites with identical bytes |
| SendGrid Inbound Parse           | `emails.(firm_id, message_id)`                                                      | Same. Attachments keyed `(email_id, ordinal)`; storage keyed by `sha256`                                                          |
| Transcription job                | `transcripts.(call_recording_id, provider, provider_job_id)`                        | Job id supplied by the provider (or generated and persisted before the call)                                                      |
| Summary                          | `generated_outputs.(source_kind, source_id, kind, provider, model, prompt_version)` | Re-running with the same inputs is a no-op                                                                                        |
| System-generated event           | `events.(subject_kind, subject_id, kind)`                                           | Emitted in the same transaction as its subject row                                                                                |
| Approval / read receipt          | `approvals.generated_output_id`, `event_reads.(event_id, user_id)`                  | First write stands                                                                                                                |
| Erasure                          | `erasure_schedule.matter_id`, plus the `evidence.erased` audit row                  | Runner re-executes safely: storage deletes are idempotent, row deletes are by matter                                              |

Every handler returns `200` for a duplicate (so the vendor stops retrying) and records the duplicate in `webhook_receipts`.

## Consent, in data terms

1. Twilio hits the voice webhook with `CallSid`. Signature verified. Number resolved to a firm.
2. The response is TwiML that plays the announcement (`<Gather>` with `<Say>`/`<Play>`) and nothing else: **no recording TwiML**. Nothing is persisted that claims consent.
3. The `<Gather>` action callback arrives after the announcement has played and the caller has responded (or continued, per the firm's chosen mechanism; see open question). Only now is the `calls` row inserted with `consent_outcome` and `consent_given_at`.
4. Only on `given` does the handler return the `<Dial record="record-from-answer-dual">` TwiML. The builder function takes a `PersistedConsentedCall` type that can only be produced by reading a `calls` row back, so the unguarded path does not compile.
5. A recording callback for a call without a `given` consent row is quarantined and never transcribed.

## Storage layout

Private buckets only, London region. Paths begin with `firm_id`, and Storage RLS mirrors table RLS on that first path segment.

- `recordings/{firm_id}/{call_id}/{recording_sid}.wav`
- `transcripts/{firm_id}/{call_id}/{transcript_id}.json`
- `emails/{firm_id}/{email_id}/raw.eml`, `body.txt`, `body.html`
- `attachments/{firm_id}/{sha256}`
- `outputs/{firm_id}/{generated_output_id}.json`

Every object has its SHA-256 in the owning row. Objects are served only via short-lived signed URLs minted for an authenticated member; signed URLs are never logged.

## Cross-tenant guarantee

Every tenant table has `firm_id`, and every policy is expressed as `firm_id in (select auth_firm_ids())` (plus role checks). `supabase/tests/` contains a test that creates firm A and firm B with a user each, seeds a matter, call, email and event per firm, and asserts that A's user can read none of B's rows from **every** tenant table, and cannot write to them. The test enumerates tables from `information_schema` and fails if a table in the public schema lacks RLS or policies, so a future table cannot ship unprotected.

## Timeline and access (0017)

- **One event per capture, written by trigger** in the same transaction as the capture row. Kinds: `call.received`, `call.consent_not_given`, `call.recording_stored`, `call.transcribed`, `call.summarised`, `email.received`, `email.attachment_stored`, `output.approved` (client-visible; withdrawal is firm-only). The events unique index is the backstop against a second event.
- **Visibility.** Audiences nest: `firm` sees everything, `client` sees `client` and `chain` events, `chain` sees `chain` events only. A call or email is `client` only when the client participant is a party (matching phone number, or matching email with SPF or DKIM passing); everything else is `firm`. Recordings, attachments, transcripts and summaries are `firm`.
- **`matter_timeline`** is a security-invoker view over `events` plus the caller's own read receipt; `actor_id` is null unless the caller is a firm user. `matter_timeline_as(matter, audience)` applies the same rule for the verification page.
- **Receipts** carry `reader_role` (firm role, or participant access) set by a BEFORE INSERT trigger; a reader cannot choose it.
- **Recording access**: `recording_access` is only through `record_recording_access()` (service role), which audits then returns the storage path. The storage read policy on `recordings` is dropped.
- **Audit actions added**: `call.captured`, `recording.captured`, `email.captured`, `attachment.captured`, `transcript.created`, `output.generated`, `approval.recorded`, `approval.withdrawn`, `recording.accessed`.

## Retention, legal hold and erasure (0018)

- **Period.** `retention_policies` (a firm's stated period; insert-only, the latest row applies; COLP inserts) and `matter_retention_overrides` (per matter, with a reason code; COLP inserts). `app.effective_retention_years(matter)` is the latest override, else the firm's latest policy, else null. Null means never erased.
- **Clock.** `matters.closed_recorded_at` is set by the `matters_before_write` trigger whenever `closed_at` changes and cannot be written by any API role. A matter is due when `greatest(closed_at, closed_recorded_at) + period <= now()`. The job reads the database clock.
- **Hold.** A matter is held while any `legal_holds` row has no `legal_hold_releases` row (`app.matter_on_hold`). Inserting a hold locks the matter row, as the job does, so the two are ordered.
- **Request.** `erasure_requests` (any member) and `erasure_request_decisions` (COLP, one per request, `approved` or `refused`). Only `approved` counts, and only on a closed, unheld matter (`app.matter_erasure_basis`).
- **Authorisation.** `erasure_runs` has one row per erasure started (matter id with **no foreign key**, the firm's own file reference, basis) and `erasure_run_completions` the counts when it finished. Both survive the matter. A run with no completion is **open**, and an open run on an unheld matter is the only thing the retention role's delete policies accept (`app.erasure_authorised`). Only `begin_erasure()` writes a run, and only after checking eligibility itself.
- **Policies added (`<table>_<verb>_<who>`).** `*_select_firm` on the six reference tables: any member reads. `retention_policies_insert_colp`, `matter_retention_overrides_insert_colp`, `erasure_request_decisions_insert_colp`: COLP, as themselves. `legal_holds_insert_colp_admin`, `legal_hold_releases_insert_colp_admin`: COLP or admin. `erasure_requests_insert_firm`: any member. `erasure_runs_select_colp_admin`, `erasure_run_completions_select_colp_admin`: the proof is for the COLP and admins. `<table>_select_retention` and `<table>_delete_retention` on every table the job removes from: the retention role, only while the matter has an open run and no hold.
- **Who may delete.** Nobody but `retention_runner`, which is NOLOGIN and reached by a token with that role claim. `app.raise_append_only()` lets it through for DELETE on every evidence table except `audit_log`, and for nothing else. Execute on the job's functions is granted to it alone.
- **Audit actions added.** `retention_policy.set`, `retention_override.set`, `legal_hold.placed`, `legal_hold.released`, `erasure.requested`, `erasure.approved`, `erasure.refused`, `erasure.started`, `erasure.blocked`, `evidence.erased`, `retention.skipped_hold`, `retention.run`.
