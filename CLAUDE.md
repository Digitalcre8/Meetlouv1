# Meet Lou

UK conveyancing product. It records and transcribes client phone calls, captures matter email and documents, and attaches everything to the right matter as a timestamped, exportable evidence record.

Conveyancing is the most complained-about area of law in England and Wales, and poor communication is the largest complaint type. **This is a defence file first and a productivity tool second. That ordering decides arguments.**

**Tie-breaker.** When a design decision is genuinely balanced, ask: if this ends up in front of the Legal Ombudsman, does it make the file easier or harder to defend? Choose easier.

Read before working: `docs/DATA-MODEL.md`, `docs/BUILD-ORDER.md`, `docs/THREAT-MODEL.md`.

## Scope: the capture spine only

In scope:

- Repo scaffolding and CI
- Postgres schema with row-level security
- Auth, and firm, matter and participant records
- Inbound call capture via Twilio: consent, dual-channel recording, storage
- Inbound email capture via SendGrid Inbound Parse, including attachments
- Transcription and summarisation behind a provider-agnostic interface
- The `events` table (the shared timeline), read receipts, and an append-only audit log
- Retention, legal hold and scheduled erasure
- A local harness that replays webhook fixtures, so all of the above is testable without real credentials

**Out of scope. Do not build it, scaffold it, or leave TODOs for it:**

- The client-facing app and the fee-earner app
- Outbound calling, SMS, attendance notes, promise chasing
- Case management integrations, billing, SSO
- Any UI beyond one internal page used to verify a matter's timeline

If something out of scope looks necessary to make something in scope work, **stop and ask**. The same goes if a task appears to require breaking a non-negotiable.

## Stack (decided, do not propose alternatives)

- pnpm workspaces monorepo
- Next.js 15, App Router, TypeScript strict, **no `any`**
- Supabase: Postgres, Auth, Storage, Edge Functions on Deno. **Project region: London** (UK data residency)
- Database changes are numbered SQL migrations, **append-only**. Never edit a migration that has already run
- zod at every external boundary
- Vitest for unit and integration tests. Playwright only where a browser is genuinely needed
- **No ORM.** SQL and the Supabase client

## Non-negotiables

1. **Consent precedes capture.** No code path begins a recording before the consent announcement has played. Consent is stored as a fact on the call row, with the time it was given.
2. **The record is evidence.** Rows in `calls`, `emails` and `events` are append-only from the application's point of view. A correction is a new row referencing the old one (`supersedes_id`). Nothing is updated to change what it says happened.
3. **Deletion is a scheduled retention job, never an application action.** It writes an audit entry naming the fact of deletion, not the content.
4. **Nothing generated reaches a client unapproved.** Model output flagged client-visible needs an approval row written by a fee earner before it can be served.
5. **Dual-channel, or say so.** Download recordings with `RequestedChannels=2` and verify the channel count in the WAV header. If a recording came back mono, mark the call and never present it as diarised.
6. **Thread email on Message-ID, In-Reply-To and References.** Never on the subject line.
7. **Every webhook is idempotent.** CallSid and Message-ID are unique keys. Assume every delivery arrives at least twice.
8. **Every webhook authenticates itself.** Twilio by signature; SendGrid Inbound Parse by a long random secret in the URL path, compared in constant time. Each needs a test proving a bad one is rejected.
9. **The service role key never reaches the browser.** The client uses the anon key and RLS. A test must prove a user of firm A cannot read firm B's matters.
10. **Never log secrets, recording URLs, transcripts or email bodies.** Log identifiers and outcomes.

## Domain language

Use these words in the schema, code, tests and docs:

matter (never "case"), fee earner (never "lawyer"), participant, COLP, enquiries, searches (LLC1, CON29, CON29DW), TA6 and TA10, exchange, completion, chain, build-over agreement, indemnity insurance, retention period, legal hold, evidence bundle.

`scripts/check-guards.sh` does not police vocabulary; reviewers do.

## Repo layout

```
apps/web/            Next.js 15. Anon key + RLS only. One internal timeline page. Nothing else.
packages/domain/     Types, zod schemas, constants, clock, redacting logger. No I/O.
packages/capture/    Webhook handlers as (Request, Deps) => Response; consent, signature
                     checks, threading, WAV header parsing. Web-standard APIs only (runs in Deno and Node).
packages/providers/  Transcriber and Summariser interfaces + deterministic fakes. Vendor adapters live here.
packages/retention/  Retention calculation, legal hold checks, erasure runner.
tools/harness/       Local CLI that signs and replays fixtures against a local stack.
fixtures/            twilio/ and sendgrid/ webhook payloads, synthetic only. No real personal data, ever.
supabase/migrations/ NNNN_name.sql, append-only.
supabase/functions/  Thin Deno entrypoints (a few lines each) wiring Deps into packages/capture.
supabase/tests/      SQL-level tests (RLS, append-only triggers).
docs/                DATA-MODEL, BUILD-ORDER, THREAT-MODEL.
```

Package names are `@meetlou/<dir>`. Packages import each other by source (`main` points at `src/index.ts`); there is no build step for libraries.

## Commands

```
pnpm verify      # format check + lint + typecheck + test + guards. Run before every commit.
pnpm lint        # eslint, strictTypeChecked; no-explicit-any, no-console are errors
pnpm typecheck
pnpm test        # vitest, all workspaces
pnpm guards      # scripts/check-guards.sh: service-role-in-browser, migration numbering/immutability
```

CI (`.github/workflows/ci.yml`) runs exactly `pnpm verify`'s steps. If it passes locally, it passes in CI.

## Conventions

### TypeScript

- `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`. No `any`, no `!` non-null assertions, no `@ts-ignore`. Use `unknown` and narrow with zod.
- Every external input (webhook body, header, env var, model output, database JSON column) is parsed by a zod schema at the boundary. Past the boundary, types are trusted.
- Expected failures are returned values (`Result<T, E>` from `@meetlou/domain`), not exceptions. Exceptions are for bugs.
- Handlers take their dependencies (`db`, `storage`, `clock`, `ids`, `providers`) as an argument. No module-level singletons, no `Date.now()` or `crypto.randomUUID()` called directly in domain logic: inject `Clock` and `IdGenerator`. This is what makes the harness and the time-travel retention tests possible.
- No `console`. Use the logger from `@meetlou/domain`, which accepts only an event name plus a typed field set of identifiers and outcomes. It has no way to pass free text bodies.
- Constant-time comparison for every secret (`crypto.subtle` digest then equality over fixed-length bytes, or `timingSafeEqual`). Never `===` on a secret.

### SQL and Supabase

- Migrations: `supabase/migrations/NNNN_snake_case.sql`, four digits, sequential, no gaps. A mistake is fixed by the next migration, never by editing. The guard enforces this against the base branch.
- Tables are plural snake_case (`matters`, `participants`). A fee earner is a `firm_members` row with `role = 'fee_earner'`, not a separate table. Columns snake_case. Primary key `id uuid default gen_random_uuid()`.
- Time: `timestamptz`, UTC. Every evidence row has two times: `occurred_at` (when it happened, from the source) and `recorded_at` (when we received it, `default now()`, never supplied by the client). Never collapse them.
- Phone numbers are E.164 text. Emails are lower-cased on write for matching, with the original kept.
- Every table: `enable row level security` **and** `force row level security`, in the same migration that creates it. No table without policies. No `using (true)`. Policies are named `<table>_<verb>_<who>` and each is described in plain English in `docs/DATA-MODEL.md`.
- Evidence tables (`calls`, `emails`, `events`, and the append-only satellites listed in DATA-MODEL) carry a `BEFORE UPDATE OR DELETE` trigger that raises, and the application roles are not granted UPDATE or DELETE. Only the retention role may delete.
- Foreign keys everywhere. `firm_id` on every tenant table, denormalised deliberately, so RLS never needs a join to find the tenant.
- Idempotent inserts: `insert ... on conflict (<idempotency key>) do nothing`, then read back. See the idempotency table in DATA-MODEL.
- Never `select *` in application code; name the columns. Never build SQL by string concatenation.
- The Supabase client in `apps/web` is created with the anon key and the user's session. The service role client exists only in Edge Functions and tools, constructed in one place, and is never imported from a file under `apps/web`.

### Testing

- Test names use the domain language: `matter`, `fee earner`, `participant`.
- No test touches the network or a real vendor. Real credentials are never required to run anything in this repo.
- Fixtures under `fixtures/` are synthetic. Phone numbers use Ofcom drama ranges (`07700 900xxx`, `020 7946 0xxx`), email uses `example.com`/`example.org`.
- Each non-negotiable has at least one test that fails if the guarantee is broken. A PR that weakens one of those tests needs an explicit note.
- Property/negative tests are preferred where a guarantee is "never": e.g. enumerate every code path that returns TwiML containing `<Record>`/`record=` and assert a persisted consent row precedes it.

### Process

- Develop on the branch the session names; commit small; run `pnpm verify` first.
- Each milestone in `docs/BUILD-ORDER.md` ends at its stated "done" and stops for review. Do not start the next one unprompted.
- Do not add dependencies casually. Each new runtime dependency needs a one-line justification in the PR/commit message. Prefer Web-standard APIs in `packages/capture` so it runs in both Deno and Node.
- Secrets live only in the host's secret store. `.env.example` lists names, never values. Do not commit a `.env`.
- Fixtures and logs may never contain real client data.

## Decisions taken (and open)

Taken, recorded so they are not re-litigated:

- Capture endpoints are **Supabase Edge Functions** (inside the London project, independent of web deploys); logic is in `packages/capture`, pure and Web-standard, so Vitest tests it directly in Node.
- **Append-only is enforced in Postgres**, not just by convention (triggers + grants), so it holds even against a leaked service role key.
- **Assignment to a matter is itself a fact**: an insert-only `matter_assignments` row, not a mutable `matter_id`. Unassigned capture is held at firm level.
- **Consent is decided before the call row exists**: the `calls` row is written when the consent outcome is known, and recording TwiML can only be built from a persisted consented call.
- **Email threading is a view** over stored raw headers, not a stored column, so late-arriving parents can never require an update.

Open questions are listed at the end of `docs/BUILD-ORDER.md`. Do not resolve them silently.
