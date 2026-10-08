# Threat model (short)

Scope: the capture spine. What matters most is **integrity of the record** (a false or missing entry defeats the defence file), then confidentiality of client data.

## If an attacker discovers the Inbound Parse URL

The URL is `/sendgrid-inbound/{public_id}/{secret}`; the secret is the only credential, and SendGrid Inbound Parse does not sign its requests.

- **Can:** inject forged emails into _that one firm's_ record. A forged email can appear to be from a client or the other side. They can flood storage and the function.
- **Cannot:** read anything (the endpoint only accepts); touch another firm (the key resolves to exactly one firm); change or delete existing rows (insert-only, no UPDATE for the function's role); reach a matter by guessing (assignment is by participant address or matter reference, and an unmatched email lands unassigned at firm level).
- **Mitigations:** SPF and DKIM results stored as claims and shown to the fee earner as "unverified" when they fail; forged mail never silently becomes a client communication; payload size cap and per-key rate limit with every rejection recorded in `webhook_receipts`; two-key rotation (revoke and reissue in minutes); the secret is stored only as a SHA-256 and compared in constant time; the URL is never logged (paths are redacted to `public_id`).
- **Residual:** a forged email that passes automatic assignment is on the file until a fee earner supersedes it. The correction is a new row, and the forged one stays visible as such. That is the correct outcome for evidence.

## What a malicious inbound email can do

- **HTML/script in the body:** bodies are stored inert. The internal page renders **text only**. HTML is never rendered in the app.
- **Hostile attachment (macro document, executable, archive bomb, polyglot):** stored under its hash, never opened or parsed server-side, content type sniffed and recorded (declared type is not trusted), served only as `Content-Disposition: attachment` with `X-Content-Type-Options: nosniff` via short-lived signed URLs. No malware scanner in the spine (open question 6).
- **Spoofed From/Date/Message-ID:** `recorded_at` is server time and is what the timeline orders on; `sent_at` is displayed as the sender's claim. A colliding Message-ID is a duplicate no-op, so an attacker cannot overwrite a genuine email by replaying its ID (though they can pre-empt it; the key is `(firm_id, message_id)` and the raw MIME hash is stored, so a mismatch on replay is recorded as a `duplicate` receipt with a differing hash and flagged for review).
- **Header tricks to hijack a thread:** threading uses only Message-ID, In-Reply-To and References, which the attacker controls. A forged References can pull a forged email into a genuine thread. It appears in the timeline with its own `recorded_at` and failed SPF/DKIM flags. It does not alter or reorder genuine rows.
- **Prompt injection into the summariser:** the model has no tools and no write access; its output is zod-validated, stored as untrusted text with `client_visible = false`, and cannot reach a client without a fee earner approval. Email text is never concatenated into SQL or paths; filenames are sanitised and storage paths are built from ids and hashes.
- **Resource exhaustion:** size caps on body and attachment count/size, request timeout, per-key rate limit.

## What a leaked Twilio auth token exposes

The token is both the API credential and the webhook-signing key.

- **Can:** forge signed webhooks, including a **fake consent callback** (claiming a caller consented) and fake recording callbacks pointing at attacker-chosen media; call Twilio's REST API to list, download and **delete recordings held at Twilio**; place calls and run up charges; change number configuration.
- **Cannot:** read our database or Storage; alter or delete anything already stored (insert-only, and we hold our own verified copy with a hash).
- **Mitigations:** recording downloads are fetched by us from Twilio by SID over the API, so a forged callback cannot make us ingest arbitrary URLs (the callback's URL field is ignored); a recording whose SID Twilio does not know returns 404 and is quarantined; a recording is verified (channel count, length, hash) before it is stored; forged consent is limited to calls that Twilio also reports (a cross-check against Twilio's call resource by CallSid is planned for the consent callback); webhook auth failures alert; rotate the token and run the harness's signature tests after.
- **Residual:** the signature scheme means whoever holds the token can forge consent. The defence is the cross-check plus the fact that the announcement version and hash are recorded with each consent.

## What a leaked service role key exposes

- **Can:** read every firm's rows and (with the Storage API) every object; bypass RLS entirely; insert rows into any firm, including forged evidence and events; delete Storage objects directly through the Storage API.
- **Cannot (by design):** update or delete rows in evidence tables or the audit log, because UPDATE/DELETE are not granted to `service_role` and a trigger raises regardless; invoke erasure (EXECUTE on the retention functions is not granted to it); write an approval (insert requires `auth.uid()` to be a fee earner); mint user sessions. It is not the database password or the JWT secret.
- **Worse than the service role key:** the database password or direct DB owner access (can drop triggers) and the project JWT secret (can forge any user). These are separate credentials with separate handling; treat any of the three as a full-incident.
- **Mitigations:** the key exists only in the Edge Function secret store and tooling, never in `apps/web` (CI guard), never in `NEXT_PUBLIC_*` (CI guard), never logged; rotation is a runbook step; stored hashes make Storage object deletion or substitution detectable (`sha256` in every owning row); inserted rows carry `recorded_at` from the database clock, so a forger cannot backdate them.
- **Residual:** confidentiality is lost for the window of exposure; deleted Storage objects are not recoverable by us (Supabase backups aside). A nightly re-hash job would detect it (open question 5).

## The voice webhook (built in M3)

- **Forged request:** every request, on both routes, must carry a valid `X-Twilio-Signature`, checked in constant time against a URL built from configuration (`TWILIO_VOICE_BASE_URL`), never from the request host. A failure returns 403 and writes nothing. If configuration is missing the function refuses to serve (500) rather than skip the check.
- **What the dialled number is:** the number rung comes from our database (`firm_users.phone_e164`), never from the request, so a forged or replayed request cannot make us dial or record an attacker-chosen number.
- **Replay:** a captured, genuine `announced` request can be replayed; it is idempotent on `call_sid` and writes nothing new. The `started` value is part of the signed URL and is range-checked (not in the future, not older than 15 minutes).
- **Unrouted numbers** are never silent: a polite answer and a `call.unrouted` audit row (SID and line only, no caller number).
- **Residual:** with `verify_jwt = false` the function is reachable by anyone on the internet; the signature is the whole defence, so a leaked Twilio token (see above) defeats it.

## The recording status callback (built in M4)

- **Same authentication as the voice webhook:** signature over a URL built from configuration; nothing is fetched or written for a failure.
- **No SSRF through the callback.** The `RecordingUrl` Twilio sends is ignored; the download URL is built from configuration plus a validated `RE...` SID, so a forged or replayed callback cannot point us at an arbitrary host. The account SID in the callback must match ours.
- **No consent, no audio.** A callback for a call with no consented row is audited (`recording.quarantined`) and the audio is never fetched; it stays at Twilio.
- **Hostile bytes.** Only a WAV with a valid header and one or two channels is accepted; anything else is audited and not stored. The bucket accepts only audio MIME types and caps size. We never decode or transcode the audio in the webhook.
- **Resource use.** Downloads over 150 MB are refused and audited; the body of the callback itself is capped at 16 KB.
- **Leaked service role key (unchanged):** can still delete Storage objects through the Storage API (see open question 5); the SHA-256 in `call_recordings` makes substitution or loss detectable.
- **Twilio-side copies remain.** We do not delete the recording at Twilio after storing it (that is a retention-job step, open question 4), so a recording that failed to ingest can be recovered from the SID in its audit row.

## The Inbound Parse receiver (built in M5)

What an attacker who finds the URL reaches is as described above, with these specifics now true:

- **The URL is `<key id>/<secret>`; the secret is 256 random bits**, stored only as a SHA-256, compared in constant time, and per firm. Guessing it is infeasible; a _leak_ (a pasted URL, a SendGrid screenshot, the platform's request logs) is the realistic risk, and the response is to mint a new key, switch SendGrid to it, and revoke the old one (no gap, nothing lost).
- **What a holder of one firm's URL can do:** file forged email onto _that firm's_ matters if they also know a matter's slug (96 random bits, never exposed by the receiver: a wrong slug and another firm's slug are indistinguishable and neither is recorded). They cannot read anything, touch another firm, or alter an existing row.
- **Forged mail is visible as forged:** SPF and DKIM verdicts are stored on the row; spoofed mail that arrives with `fail`/`softfail` says so, and the message's SHA-256 and `recorded_at` are the server's, not the sender's.
- **A replayed Message-ID cannot overwrite a real email:** the first stands; a different body under the same ID raises an `email.duplicate_mismatch` audit row.
- **Hostile content:** the message is parsed with a nesting limit and a header-size limit; attachments are stored as opaque bytes (never opened, never served with the sender's content type) with a sniffed type recorded beside the claimed one; HTML bodies are stored as plain text. There is no malware scanner (open question 6).
- **Resource use:** requests over 32 MB are refused from the header; a 30 MB message is held in memory while parsed.
- **Absence:** mail over the provider's 30 MB limit never arrives and leaves no trace; see `INBOUND_EMAIL_LIMITATION` and `recordUncapturedEmail`.
