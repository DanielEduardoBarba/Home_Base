import type { Metadata, Viewport } from 'next'
import { IBM_Plex_Mono, Syne } from 'next/font/google'
import './globals.css'

/** Self-hosted at build time — no runtime Google Fonts fetch on VPN. */
const syne = Syne({
  subsets: ['latin'],
  weight: ['500', '600', '700', '800'],
  variable: '--font-syne',
  display: 'swap',
  preload: true,
})

const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-plex',
  display: 'swap',
  preload: true,
})

export const metadata: Metadata = {
  title: 'Home Base',
  description: 'Home Base control plane — VPN remote workspace for your laptop',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Home Base',
  },
  icons: {
    icon: [{ url: '/icon.svg', type: 'image/svg+xml' }],
    apple: [{ url: '/icon.svg' }],
  },
  manifest: '/manifest.webmanifest',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
  themeColor: '#070a0f',
  interactiveWidget: 'resizes-content',
}

const themeBoot = `
try {
  var t = localStorage.getItem('hb-theme')
  if (t !== 'day' && t !== 'night') t = 'night'
  document.documentElement.dataset.theme = t
  document.documentElement.style.colorScheme = t === 'day' ? 'light' : 'dark'
  document.documentElement.dataset.safeTop =
    localStorage.getItem('hb-safe-top') === '1' ? '1' : '0'
} catch (e) {}
`

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${syne.variable} ${plexMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBoot }} />
      </head>
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  )
}
