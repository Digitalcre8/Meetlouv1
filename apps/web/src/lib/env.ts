import { z } from 'zod';

const publicEnv = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
});

/** Browser-safe settings only: the project URL and the anon key. There is no other kind here. */
export function supabaseEnv(): { url: string; anonKey: string } {
  const parsed = publicEnv.parse({
    NEXT_PUBLIC_SUPABASE_URL: process.env['NEXT_PUBLIC_SUPABASE_URL'],
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'],
  });
  return { url: parsed.NEXT_PUBLIC_SUPABASE_URL, anonKey: parsed.NEXT_PUBLIC_SUPABASE_ANON_KEY };
}
