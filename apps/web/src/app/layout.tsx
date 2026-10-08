import type { ReactNode } from 'react';

export const metadata = { title: 'Meet Lou' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-GB">
      <body>{children}</body>
    </html>
  );
}
