import { z } from 'zod';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { addMatterEvent, approveOutput } from '@meetlou/records';
import { SupabaseBlobStore, SupabasePipelineStore, transcribeRecording } from '@meetlou/pipeline';
import { FakeSummariser, FakeTranscriber } from '@meetlou/providers';
import { serviceClient, signedInClient } from './clients';
import { FIXTURES_DIR } from './fixtures';
import type { LocalEnv } from './local-env';
import type { SeedResult } from './seed';

const HOUR = 3_600_000;

/**
 * Fill the seeded matter (MTR-1001) with a small, realistic timeline so the verification page has
 * something to show. Everything goes through the same database paths the real captures use, so
 * the events and audit rows are the ones the triggers write; only the two manual events (an
 * agreed exchange date for the whole chain, a note for the client) are written by the fee earner.
 * Safe to run twice: it does nothing if it has already run.
 */
export async function seedTimelineDemo(
  env: LocalEnv,
  seed: SeedResult,
): Promise<{ created: boolean }> {
  const admin = serviceClient(env);
  const { firm, matter } = seed;

  const already = await admin
    .from('events')
    .select('id')
    .eq('matter_id', matter.id)
    .eq('kind', 'matter.exchange_date_agreed')
    .limit(1);
  if (already.error !== null) throw new Error(already.error.message);
  if (already.data.length > 0) return { created: false };

  const call = async (from: string, hoursAgo: number) => {
    const inserted = await admin
      .from('calls')
      .insert({
        firm_id: firm.id,
        matter_id: matter.id,
        call_sid: `CA${randomBytes(16).toString('hex')}`,
        from_e164: from,
        to_e164: '+442079460958',
        started_at: new Date(Date.now() - hoursAgo * HOUR).toISOString(),
        consent_announcement_version: 'demo',
        consent_outcome: 'given',
        consent_given_at: new Date(Date.now() - hoursAgo * HOUR).toISOString(),
      })
      .select('id')
      .single();
    if (inserted.error !== null) throw new Error(inserted.error.message);
    return z.object({ id: z.uuid() }).parse(inserted.data).id;
  };

  // 1. The client phones, is recorded, and a summary is written and approved.
  const clientCall = await call('+447700900301', 5);
  const recordingSid = `RE${randomUUID().replaceAll('-', '')}`;
  const path = `${firm.id}/${matter.id}/${recordingSid}.wav`;
  const audio = new Uint8Array(readFileSync(`${FIXTURES_DIR}audio/stereo-2s.wav`));
  const uploaded = await admin.storage
    .from('recordings')
    .upload(path, audio, { contentType: 'audio/wav' });
  if (uploaded.error !== null) throw new Error(uploaded.error.message);
  const ingested = await admin.rpc('ingest_recording', {
    p_call_id: clientCall,
    p_recording_sid: recordingSid,
    p_storage_path: path,
    p_sha256: 'd'.repeat(64),
    p_byte_length: audio.byteLength,
    p_duration_seconds: 420,
    p_channels: 2,
  });
  if (ingested.error !== null) throw new Error(ingested.error.message);
  const recordingId = (ingested.data as { recording_id: string }[])[0]?.recording_id ?? '';

  const store = new SupabasePipelineStore(admin);
  const job = await store.getRecording(recordingId);
  if (job === null) throw new Error('demo recording not found');
  const outcome = await transcribeRecording(
    {
      store,
      blobs: new SupabaseBlobStore(admin),
      transcriber: new FakeTranscriber([
        { startSeconds: 0, channel: 0, text: 'How are the searches going?' },
        {
          startSeconds: 4,
          channel: 1,
          text: "They should be back by Friday the 16th. I'll chase on Wednesday.",
        },
      ]),
      summariser: new FakeSummariser({
        summary:
          'Sarah asked about the searches. The firm expects them back on 16 October and will chase on Wednesday.',
        actions: [{ description: 'Chase the search provider', owner: 'fee_earner', due: null }],
        keyDates: [{ date: '2026-10-16', description: 'Searches expected back' }],
      }),
    },
    job,
  );
  if (outcome.status !== 'summarised')
    throw new Error(`demo summary failed: ${JSON.stringify(outcome)}`);

  const feeEarner = await signedInClient(env, seed.feeEarner.email, seed.feeEarner.password);
  const approved = await approveOutput(feeEarner, outcome.outputId);
  if (!approved.ok) throw new Error(approved.error.message);

  // 2. The estate agent phones (the firm's record only), and emails with an attachment.
  await call('+447700900302', 3);
  const email = async (from: string, subject: string, attachments: unknown[]) => {
    const sent = await admin.rpc('ingest_email', {
      p_matter_id: matter.id,
      p_message_id: `${randomUUID()}@mail.example.org`,
      p_message_id_synthesised: false,
      p_in_reply_to: null,
      p_references: [],
      p_from_address: from,
      p_to_addresses: [seed.inboundAddress],
      p_cc_addresses: [],
      p_subject: subject,
      p_sent_at: null,
      p_raw_storage_path: `${firm.id}/${matter.id}/demo/raw.eml`,
      p_raw_sha256: randomBytes(32).toString('hex'),
      p_body_text_storage_path: null,
      p_body_html_storage_path: null,
      p_spf_result: 'pass',
      p_dkim_result: '{@example.org : pass}',
      p_attachments: attachments,
    });
    if (sent.error !== null) throw new Error(sent.error.message);
  };
  await email('priya.nandra@example.org', 'Viewing times', [
    {
      ordinal: 0,
      filename: 'TA6-draft.pdf',
      content_type: 'application/pdf',
      sniffed_content_type: 'application/pdf',
      byte_length: 1000,
      sha256: randomBytes(32).toString('hex'),
      storage_path: `${firm.id}/${matter.id}/demo-attachment`,
    },
  ]);
  await email('sarah.whitfield@example.org', 'Mortgage offer', []);

  // 3. The fee earner adds two facts to the timeline.
  const add = (kind: string, visibility: 'client' | 'chain', summary: string) =>
    addMatterEvent(
      feeEarner,
      { firmId: firm.id, matterId: matter.id, kind, visibility, summary, occurredAt: new Date() },
      seed.feeEarner.userId,
    );
  const note = await add(
    'matter.client_update',
    'client',
    'we have sent your completed TA6 to the other side',
  );
  const exchange = await add(
    'matter.exchange_date_agreed',
    'chain',
    'exchange agreed for 23 October',
  );
  if (!note.ok || !exchange.ok) throw new Error('demo events failed');

  return { created: true };
}
