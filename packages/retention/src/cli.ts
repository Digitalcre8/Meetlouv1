import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from '@meetlou/domain';
import { runRetention } from './run.ts';
import { SupabaseObjectStore, SupabaseRetentionDb } from './supabase-ports.ts';

/**
 * The scheduled job. Run it from the host's scheduler (cron, a scheduled workflow); it is not an
 * HTTP endpoint and nothing else starts it. It needs:
 *
 *   SUPABASE_URL                  the project's API URL
 *   RETENTION_JWT                 a token whose role claim is retention_runner (database access)
 *   SUPABASE_SERVICE_ROLE_KEY     to empty storage folders (the platform owns storage grants)
 */
function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is not set`);
  return value;
}

const url = required('SUPABASE_URL');
const connect = (key: string) =>
  createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as SupabaseClient;
const db = new SupabaseRetentionDb(connect(required('RETENTION_JWT')));
const objects = new SupabaseObjectStore(connect(required('SUPABASE_SERVICE_ROLE_KEY')));
const log = createLogger((line) => process.stdout.write(`${line}\n`));

const summary = await runRetention({ db, objects, log });
process.stdout.write(`${JSON.stringify({ event: 'retention.run', ...summary })}\n`);
process.exitCode = summary.failed > 0 ? 1 : 0;
