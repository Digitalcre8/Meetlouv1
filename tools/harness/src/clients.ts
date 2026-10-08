import { createClient } from '@supabase/supabase-js';
import type { LocalEnv } from './local-env';

const options = { auth: { persistSession: false, autoRefreshToken: false } } as const;

/** Bypasses RLS. Operator and harness use only. */
export function serviceClient(env: LocalEnv) {
  return createClient(env.apiUrl, env.serviceRoleKey, options);
}

/** What a browser would hold: the anon key, bound by RLS once signed in. */
export function anonClient(env: LocalEnv) {
  return createClient(env.apiUrl, env.anonKey, options);
}

export async function signedInClient(env: LocalEnv, email: string, password: string) {
  const client = anonClient(env);
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error !== null) throw new Error(`sign-in failed: ${error.message}`);
  return client;
}
