// SendGrid Inbound Parse receiver. All behaviour lives in packages/capture; this file only
// wires the service-role client into it.
//
// Inbound Parse cannot send a Supabase JWT, so this function is deployed with verify_jwt =
// false (supabase/config.toml). Its authentication is the secret in the URL path, checked by
// the handler. Note that the path IS the credential: nothing here logs, echoes or stores it.
import { createClient } from '@supabase/supabase-js';
import { createLogger } from '@meetlou/domain';
import {
  SupabaseEmailStore,
  SupabaseObjectStorage,
  createInboundEmailHandler,
} from '@meetlou/capture';

const logger = createLogger((line) => console.log(line));
const supabaseUrl = Deno.env.get('SUPABASE_URL');
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

if (supabaseUrl === undefined || serviceRoleKey === undefined) {
  const missing = [
    ...(supabaseUrl === undefined ? ['SUPABASE_URL'] : []),
    ...(serviceRoleKey === undefined ? ['SUPABASE_SERVICE_ROLE_KEY'] : []),
  ];
  console.error(JSON.stringify({ level: 'error', event: 'misconfigured', invalid: missing }));
  Deno.serve(() => new Response('Service misconfigured', { status: 500 }));
} else {
  const db = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const handler = createInboundEmailHandler({
    store: new SupabaseEmailStore(db),
    emails: new SupabaseObjectStorage(db, 'emails'),
    attachments: new SupabaseObjectStorage(db, 'attachments'),
    logger,
  });
  Deno.serve({ port: Number(Deno.env.get('PORT') ?? 8000) }, handler);
}
