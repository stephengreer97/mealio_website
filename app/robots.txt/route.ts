import { NextResponse } from 'next/server';

export const dynamic = 'force-static';

export function GET() {
  const base = (process.env.NEXT_PUBLIC_APP_URL ?? 'https://mealio.co').trim();
  const body = `# Algolia-Crawler-Verif: 1C9245B9B7A631CC

User-agent: *
Allow: /
Disallow: /my-meals
Disallow: /account
Disallow: /creator
Disallow: /admin
Disallow: /api/
Disallow: /check-email
Disallow: /forgot-password
Disallow: /reset-password
Disallow: /verify-email
Disallow: /signout

Sitemap: ${base}/sitemap.xml
`;
  return new NextResponse(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
