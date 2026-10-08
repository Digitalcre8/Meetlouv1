/** The address mail for a matter is sent to: <inbound_slug>@<firm mail domain>. */
export function inboundAddress(inboundSlug: string, firmMailDomain: string): string {
  return `${inboundSlug}@${firmMailDomain}`;
}

const SLUG = /^([a-z0-9]+)-([0-9a-f]{24})$/;

/** Split a slug into its human prefix and its random suffix, or null if malformed. */
export function parseInboundSlug(slug: string): { prefix: string; suffix: string } | null {
  const match = SLUG.exec(slug);
  if (match === null) return null;
  return { prefix: match[1] ?? '', suffix: match[2] ?? '' };
}
