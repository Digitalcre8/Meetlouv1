import { getSessionFirm } from '@meetlou/records';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { createSupabaseServerClient } from '../../../lib/supabase/server';

// Internal verification only: it exists to check that a matter's timeline differs by audience in
// the right ways. It is not the product's UI and should not grow into it.
export default async function TimelineIndexPage() {
  const supabase = await createSupabaseServerClient();
  const session = await getSessionFirm(supabase);
  if (!session.ok || session.value === null) redirect('/sign-in');

  const matters = await supabase
    .from('matters')
    .select('id, reference, property_address')
    .order('reference', { ascending: true });
  const rows = z
    .array(z.object({ id: z.uuid(), reference: z.string(), property_address: z.string() }))
    .parse(matters.data ?? []);

  return (
    <main>
      <h1>Timeline check</h1>
      <p>Pick a matter to see its timeline as the firm, the client and a chain participant.</p>
      <ul>
        {rows.map((m) => (
          <li key={m.id}>
            <Link href={`/internal/timeline/${m.id}`}>
              {m.reference}, {m.property_address}
            </Link>
          </li>
        ))}
      </ul>
      <p>
        <Link href="/">Back</Link>
      </p>
    </main>
  );
}
