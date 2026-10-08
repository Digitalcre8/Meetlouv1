// The audited route to a recording's audio. Called with the signed-in user's own token (the
// platform verifies the JWT; the handler checks it again and checks the user's right to the
// recording under RLS). Every access is written to the audit log before the link is returned.
import { createClient } from '@supabase/supabase-js';
import { createLogger } from '@meetlou/domain';
import { SupabaseAccessStore, createRecordingAccessHandler } from '@meetlou/access';

const logger = createLogger((line) => console.log(line));
const url = Deno.env.get('SUPABASE_URL');
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const anonKey = Deno.env.get('SUPABASE_ANON_KEY');

if (url === undefined || serviceRoleKey === undefined || anonKey === undefined) {
  const missing = [
    ...(url === undefined ? ['SUPABASE_URL'] : []),
    ...(serviceRoleKey === undefined ? ['SUPABASE_SERVICE_ROLE_KEY'] : []),
    ...(anonKey === undefined ? ['SUPABASE_ANON_KEY'] : []),
  ];
  console.error(JSON.stringify({ level: 'error', event: 'misconfigured', invalid: missing }));
  Deno.serve(() => new Response('Service misconfigured', { status: 503 }));
} else {
  const admin = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  Deno.serve(
    { port: Number(Deno.env.get('PORT') ?? 8000) },
    createRecordingAccessHandler({
      store: new SupabaseAccessStore(admin, { url, anonKey }),
      logger,
    }),
  );
}
