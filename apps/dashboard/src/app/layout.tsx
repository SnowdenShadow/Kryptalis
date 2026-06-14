import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { headers } from 'next/headers';
import './globals.css';
import { Providers } from '@/components/providers';
import { Toaster } from 'sonner';

const inter = Inter({ subsets: ['latin'], variable: '--font-sans' });

export const metadata: Metadata = {
  title: 'DockControl',
  description: 'The next-generation self-hosted infrastructure platform',
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Per-request CSP nonce minted by src/middleware.ts. Reading headers()
  // here deliberately opts every route into dynamic rendering — required
  // for the nonce CSP: statically prerendered HTML would embed Next's
  // inline bootstrap scripts WITHOUT a nonce and the browser would block
  // them. Next stamps this nonce on its own inline scripts automatically
  // (it reads it from the forwarded Content-Security-Policy request
  // header); we only need to apply it to our hand-written inline script.
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/*
          Read the saved locale BEFORE React boots so <html lang> is correct
          on first paint. Avoids the EN→FR flash on hydration. Inline + sync
          on purpose — runs before any client component renders.
        */}
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var l=localStorage.getItem('dockcontrol-lang');if(l!=='fr'&&l!=='en'){l=((navigator.languages&&navigator.languages[0])||navigator.language||'').toLowerCase().indexOf('fr')===0?'fr':'en';}document.documentElement.lang=l;}catch(e){}})();`,
          }}
        />
      </head>
      <body className={`${inter.variable} antialiased`}>
        <Providers>
          {children}
          <Toaster richColors position="bottom-right" />
        </Providers>
      </body>
    </html>
  );
}
