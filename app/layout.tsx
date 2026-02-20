import type { Metadata } from 'next'
import { Pacifico } from 'next/font/google'
import './globals.css'

const pacifico = Pacifico({
  weight: '400',
  subsets: ['latin'],
  variable: '--font-pacifico',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Mealio - Grocery Shop Effortlessly',
  description: 'Automatically add meal ingredients to your cart',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className={pacifico.variable}>{children}</body>
    </html>
  )
}
