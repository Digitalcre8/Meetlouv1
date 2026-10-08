'use server';

import { getSessionFirm } from '@meetlou/records';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { createSupabaseServerClient } from '../../lib/supabase/server';

const credentials = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  password: z.string().min(1),
});

export async function signIn(formData: FormData): Promise<void> {
  const parsed = credentials.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  });
  if (!parsed.success) redirect('/sign-in?error=1');

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);

  // One message for every failure, so the form does not reveal which emails have accounts.
  if (error !== null) redirect('/sign-in?error=1');

  // A valid login that belongs to no firm is not a fee earner: do not leave it signed in.
  const session = await getSessionFirm(supabase);
  if (!session.ok || session.value === null) {
    await supabase.auth.signOut();
    redirect('/sign-in?error=1');
  }
  redirect('/');
}

export async function signOut(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect('/sign-in');
}
