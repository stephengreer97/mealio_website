import { MetadataRoute } from 'next';

export default function sitemap(): MetadataRoute.Sitemap {
  const base = (process.env.NEXT_PUBLIC_APP_URL ?? 'https://mealio.co').trim();
  const now  = new Date();

  return [
    { url: base,                  lastModified: now, changeFrequency: 'monthly', priority: 1.0 },
    { url: `${base}/help`,        lastModified: now, changeFrequency: 'monthly', priority: 0.8 },
    { url: `${base}/pricing`,     lastModified: now, changeFrequency: 'monthly', priority: 0.8 },
    { url: `${base}/about`,       lastModified: now, changeFrequency: 'yearly',  priority: 0.5 },
    { url: `${base}/privacy`,     lastModified: now, changeFrequency: 'yearly',  priority: 0.3 },
    { url: `${base}/terms`,       lastModified: now, changeFrequency: 'yearly',  priority: 0.3 },
  ];
}
