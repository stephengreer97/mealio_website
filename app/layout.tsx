import type { Metadata } from 'next'
import { Fraunces, Instrument_Sans, JetBrains_Mono } from 'next/font/google'
import { Analytics } from '@vercel/analytics/next'
import './globals.css'

// Display serif — the brand voice. Wordmark, headings, editorial moments.
// (globals.css aliases the legacy --font-pacifico variable to this, so every
// page that renders the old wordmark picks up the new identity automatically.)
const fraunces = Fraunces({
  subsets: ['latin'],
  variable: '--font-display',
  axes: ['opsz', 'SOFT', 'WONK'],
  display: 'swap',
})

// UI sans — body copy, controls, data. (Aliased to the legacy --font-inter.)
const instrumentSans = Instrument_Sans({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
})

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
})

const APP_URL = (process.env.NEXT_PUBLIC_APP_URL ?? 'https://mealio.co').trim();

export const metadata: Metadata = {
  metadataBase: new URL(APP_URL),
  title: {
    default:  'Mealio',
    template: '%s | Mealio',
  },
  description: "Shop meals, we'll fill the cart. Save your favorite meals and add all ingredients to your grocery cart in one click.",
  openGraph: {
    type:        'website',
    siteName:    'Mealio',
    title:       'Mealio',
    description: "Shop meals, we'll fill the cart.",
    url:         '/',
  },
  twitter: {
    card:        'summary_large_image',
    title:       'Mealio',
    description: "Shop meals, we'll fill the cart.",
  },
  appleWebApp: {
    capable:         true,
    statusBarStyle:  'default',
    title:           'Mealio',
  },
  formatDetection: { telephone: false },
  other: {
    'apple-itunes-app': 'app-id=6761012560',
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className={`${fraunces.variable} ${instrumentSans.variable} ${jetbrainsMono.variable}`}>
        {children}
        <Analytics />
      </body>
    </html>
  )
}
