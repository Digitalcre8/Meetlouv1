import { getSessionFirm } from '@meetlou/records';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '../lib/supabase/server';
import { signOut } from './sign-in/actions';

export default async function HomePage() {
  const supabase = await createSupabaseServerClient();
  const session = await getSessionFirm(supabase);
  if (!session.ok || session.value === null) redirect('/sign-in');

  return (
    <main>
      <h1>{session.value.firm.name}</h1>
      <p>Signed in as a {session.value.role.replace('_', ' ')}.</p>
      <p>
        <Link href="/internal/timeline">Internal: timeline check</Link>
      </p>
      <form action={signOut}>
        <button type="submit">Sign out</button>
      </form>
    </main>
  );
}
