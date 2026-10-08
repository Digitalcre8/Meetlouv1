// The transcription and summarisation job runner. Not a webhook: it is called on a schedule (or by
// an operator) with the service role key, and works through the queues. The providers are chosen
// here from configuration; nothing in packages/pipeline knows which model is behind them.
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { createLogger } from '@meetlou/domain';
import {
  SupabaseBlobStore,
  SupabasePipelineStore,
  createProcessingHandler,
} from '@meetlou/pipeline';
import { AnthropicSummariser, RuleBasedSummariser } from '@meetlou/providers';
import type { Summariser, Transcriber } from '@meetlou/providers';

const logger = createLogger((line) => console.log(line));
const supabaseUrl = Deno.env.get('SUPABASE_URL');
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

// TRANSCRIBER: no vendor adapter exists yet. Add one in packages/providers, implementing
// Transcriber, and select it here; the pipeline does not change.
const transcriberName = Deno.env.get('TRANSCRIBER') ?? 'none';
const summariserName = Deno.env.get('SUMMARISER') ?? 'anthropic';

function chooseSummariser(): Summariser | null {
  if (summariserName === 'rule-based') return new RuleBasedSummariser();
  if (summariserName === 'anthropic') {
    // Reads ANTHROPIC_API_KEY (or another configured credential) from the environment.
    return new AnthropicSummariser(new Anthropic(), {
      ...(Deno.env.get('ANTHROPIC_MODEL') === undefined
        ? {}
        : { model: Deno.env.get('ANTHROPIC_MODEL') as string }),
    });
  }
  return null;
}

const transcriber: Transcriber | null = null; // see TRANSCRIBER above
const summariser = chooseSummariser();

if (
  supabaseUrl === undefined ||
  serviceRoleKey === undefined ||
  transcriber === null ||
  summariser === null
) {
  const missing = [
    ...(supabaseUrl === undefined ? ['SUPABASE_URL'] : []),
    ...(serviceRoleKey === undefined ? ['SUPABASE_SERVICE_ROLE_KEY'] : []),
    ...(transcriber === null ? [`TRANSCRIBER (${transcriberName}: no adapter configured)`] : []),
    ...(summariser === null ? [`SUMMARISER (${summariserName})`] : []),
  ];
  console.error(JSON.stringify({ level: 'error', event: 'misconfigured', invalid: missing }));
  Deno.serve(() => new Response('Service misconfigured', { status: 503 }));
} else {
  const db = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  Deno.serve(
    { port: Number(Deno.env.get('PORT') ?? 8000) },
    createProcessingHandler({
      deps: {
        store: new SupabasePipelineStore(db),
        blobs: new SupabaseBlobStore(db),
        transcriber,
        summariser,
        logger,
      },
      serviceRoleKey,
    }),
  );
}
