/**
 * What the bytes of an attachment look like, from their leading signature. The sender chooses
 * the declared type; this is an independent observation, stored beside it. It is not a malware
 * scan and not a security boundary: attachments are stored and served as opaque downloads
 * whatever either says.
 */
export function sniffContentType(bytes: Uint8Array): string {
  const starts = (...signature: number[]) => signature.every((b, i) => bytes[i] === b);
  const text = (n: number) => String.fromCharCode(...bytes.subarray(0, n));

  if (starts(0x25, 0x50, 0x44, 0x46)) return 'application/pdf'; // %PDF
  if (starts(0x50, 0x4b, 0x03, 0x04)) return 'application/zip'; // also docx, xlsx, odt
  if (starts(0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (starts(0x49, 0x49, 0x2a, 0x00) || starts(0x4d, 0x4d, 0x00, 0x2a)) return 'image/tiff';
  if (starts(0xd0, 0xcf, 0x11, 0xe0)) return 'application/x-ole-storage'; // legacy .doc/.xls (macros possible)
  if (starts(0x4d, 0x5a)) return 'application/x-msdownload'; // MZ: a Windows executable
  if (starts(0x7f, 0x45, 0x4c, 0x46)) return 'application/x-elf';
  if (text(5) === '{\\rtf') return 'application/rtf';

  const head = text(512).toLowerCase();
  if (/<\s*(!doctype html|html|script|iframe)/.test(head)) return 'text/html';
  if (head.startsWith('<?xml')) return 'application/xml';
  if (bytes.length > 0 && isMostlyText(bytes.subarray(0, 512))) return 'text/plain';
  return 'application/octet-stream';
}

function isMostlyText(sample: Uint8Array): boolean {
  let printable = 0;
  for (const b of sample) {
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127) || b >= 128) printable++;
  }
  return printable / sample.length > 0.95;
}
