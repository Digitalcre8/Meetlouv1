import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { supabaseEnv } from '../env';

/** A Supabase client acting as the signed-in user: anon key + their session cookie, bound by RLS. */
export async function createSupabaseServerClient() {
  const store = await cookies();
  const { url, anonKey } = supabaseEnv();
  return createServerClient(url, anonKey, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (cookiesToSet) => {
        try {
          for (const { name, value, options } of cookiesToSet) store.set(name, value, options);
        } catch {
          // Called from a Server Component, which cannot set cookies. The middleware
          // refreshes the session on every request, so this is safe to ignore.
        }
      },
    },
  });
}
