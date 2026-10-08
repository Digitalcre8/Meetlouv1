// Twilio voice webhooks: the inbound call (announce, then consent + dial) and the recording
// status callback. All behaviour lives in packages/capture; this file only wires configuration
// and the service-role client into it.
//
// Twilio does not send a Supabase JWT, so this function is deployed with verify_jwt = false
// (supabase/config.toml). Its authentication is the X-Twilio-Signature check in the handlers.
import { createClient } from '@supabase/supabase-js';
import { createLogger } from '@meetlou/domain';
import {
  SupabaseObjectStorage,
  SupabaseRecordingStore,
  SupabaseVoiceStore,
  TwilioRecordingDownloader,
  createRecordingStatusHandler,
  createTwilioRouter,
  createTwilioVoiceHandler,
  readVoiceConfig,
} from '@meetlou/capture';

const logger = createLogger((line) => console.log(line));
const config = readVoiceConfig((name) => Deno.env.get(name));
const supabaseUrl = Deno.env.get('SUPABASE_URL');
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

if (!config.ok || supabaseUrl === undefined || serviceRoleKey === undefined) {
  // Fail closed and loudly: never serve without signature validation. Names only, no values.
  const missing = config.ok ? [] : config.invalid;
  if (supabaseUrl === undefined) missing.push('SUPABASE_URL');
  if (serviceRoleKey === undefined) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  console.error(JSON.stringify({ level: 'error', event: 'misconfigured', invalid: missing }));
  Deno.serve(() => new Response('Service misconfigured', { status: 500 }));
} else {
  const db = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const handler = createTwilioRouter({
    voice: createTwilioVoiceHandler({
      config: config.value,
      store: new SupabaseVoiceStore(db),
      clock: { now: () => new Date() },
      logger,
    }),
    recordingStatus: createRecordingStatusHandler({
      config: config.value,
      store: new SupabaseRecordingStore(db),
      downloader: new TwilioRecordingDownloader(config.value),
      storage: new SupabaseObjectStorage(db),
      logger,
    }),
  });
  Deno.serve({ port: Number(Deno.env.get('PORT') ?? 8000) }, handler);
}
