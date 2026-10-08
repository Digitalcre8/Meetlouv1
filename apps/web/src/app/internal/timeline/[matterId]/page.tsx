import { compareAudiences } from '@meetlou/domain';
import type { Audience, TimelineRow } from '@meetlou/domain';
import { getMatterTimeline, getSessionFirm, getTimelinePreview } from '@meetlou/records';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { z } from 'zod';
import { createSupabaseServerClient } from '../../../../lib/supabase/server';

// Internal verification only. See ../page.tsx.

const when = (iso: string) => iso.slice(0, 16).replace('T', ' ');

function Column({ title, note, rows }: { title: string; note: string; rows: TimelineRow[] }) {
  return (
    <section>
      <h2>
        {title} ({rows.length})
      </h2>
      <p>{note}</p>
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Event</th>
            <th>Visibility</th>
            <th>Summary</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.event_id}>
              <td>{when(r.occurred_at)}</td>
              <td>{r.kind}</td>
              <td>{r.visibility}</td>
              <td>{r.summary}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export default async function TimelineCheckPage({
  params,
}: {
  params: Promise<{ matterId: string }>;
}) {
  const { matterId } = await params;
  if (!z.uuid().safeParse(matterId).success) notFound();

  const supabase = await createSupabaseServerClient();
  const session = await getSessionFirm(supabase);
  if (!session.ok || session.value === null) redirect('/sign-in');

  const matter = await supabase
    .from('matters')
    .select('reference, property_address')
    .eq('id', matterId)
    .maybeSingle();
  if (matter.data === null) notFound();
  const { reference, property_address } = z
    .object({ reference: z.string(), property_address: z.string() })
    .parse(matter.data);

  // The firm column is what the database returns to this signed-in user. The other two apply the
  // visibility rule the database applies to those participants; the test suite proves they match
  // what real participant logins are given.
  const firm = await getMatterTimeline(supabase, matterId);
  const preview = async (audience: Audience) => getTimelinePreview(supabase, matterId, audience);
  const [client, chain, firmPreview] = await Promise.all([
    preview('client'),
    preview('chain'),
    preview('firm'),
  ]);
  if (!firm.ok || !client.ok || !chain.ok || !firmPreview.ok) {
    return (
      <main>
        <h1>Timeline check</h1>
        <p role="alert">The timeline could not be read.</p>
      </main>
    );
  }

  const checks = [
    ...compareAudiences(firm.value, client.value, chain.value),
    {
      name: 'the firm preview is exactly what the database returns to you',
      ok:
        [...firm.value.map((e) => e.event_id)].sort().join() ===
        [...firmPreview.value.map((e) => e.event_id)].sort().join(),
      detail: `${firm.value.length} and ${firmPreview.value.length}`,
    },
  ];

  return (
    <main>
      <h1>Timeline check: {reference}</h1>
      <p>{property_address}</p>
      <section>
        <h2>Checks</h2>
        <ul>
          {checks.map((c) => (
            <li key={c.name}>
              {c.ok ? 'PASS' : 'FAIL'}: {c.name} ({c.detail})
            </li>
          ))}
        </ul>
      </section>
      <Column title="As the firm" note="Everything on the matter." rows={firm.value} />
      <Column
        title="As the client"
        note="Client and chain events. Nothing internal. No firm user is named."
        rows={client.value}
      />
      <Column
        title="As a chain participant"
        note="Chain events only. No documents."
        rows={chain.value}
      />
      <p>
        <Link href="/internal/timeline">All matters</Link>
      </p>
    </main>
  );
}
