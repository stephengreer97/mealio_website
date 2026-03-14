import type { Metadata } from 'next'
import { Pacifico, Inter, JetBrains_Mono } from 'next/font/google'
import { Analytics } from '@vercel/analytics/next'
import './globals.css'

const pacifico = Pacifico({
  weight: '400',
  subsets: ['latin'],
  variable: '--font-pacifico',
  display: 'swap',
})

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
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
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className={`${pacifico.variable} ${inter.variable} ${jetbrainsMono.variable}`}>
        {children}
        <Analytics />
      </body>
    </html>
  )
}
