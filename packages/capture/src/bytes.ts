const encoder = new TextEncoder();

export function utf8(value: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(value);
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(value)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Compare two secrets or signatures without leaking where they differ. Both sides are hashed
 * first, so the comparison runs over two equal-length digests whatever the input lengths are.
 */
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', utf8(a)),
    crypto.subtle.digest('SHA-256', utf8(b)),
  ]);
  const x = new Uint8Array(da);
  const y = new Uint8Array(db);
  let difference = 0;
  for (let i = 0; i < x.length; i++) difference |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return difference === 0;
}
