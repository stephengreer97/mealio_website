import { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
  const base = (process.env.NEXT_PUBLIC_APP_URL ?? 'https://mealio.co').trim();
  return {
    rules: [
      {
        userAgent: '*',
        allow:    ['/', '/help', '/pricing', '/about', '/privacy', '/terms', '/meal/'],
        disallow: [
          '/discover',
          '/account',
          '/creator',
          '/admin',
          '/api/',
          '/check-email',
          '/forgot-password',
          '/reset-password',
          '/verify-email',
          '/signout',
        ],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
  };
}
