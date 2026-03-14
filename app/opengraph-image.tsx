import { ImageResponse } from 'next/og';

export const runtime     = 'edge';
export const alt         = "Mealio — Shop meals, we'll fill the cart";
export const size        = { width: 1200, height: 630 };
export const contentType = 'image/png';

async function loadGoogleFont(family: string, text?: string): Promise<ArrayBuffer> {
  const params = new URLSearchParams({ family, display: 'swap' });
  if (text) params.set('text', text);
  const css = await fetch(`https://fonts.googleapis.com/css2?${params}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
  }).then(r => r.text());
  const url = css.match(/src: url\((.+?)\) format\('woff2'\)/)?.[1];
  if (!url) throw new Error(`Could not parse font URL for ${family}`);
  return fetch(url).then(r => r.arrayBuffer());
}

export default async function OgImage() {
  const [pacificoData, dmSansData] = await Promise.all([
    loadGoogleFont('Pacifico', 'Mealio'),
    loadGoogleFont('DM+Sans:wght@500', "Shop meals, we'll fill the cart"),
  ]);

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          background: '#DD0031',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div
          style={{
            fontFamily: 'Pacifico',
            fontSize: 160,
            color: 'white',
            lineHeight: 1,
          }}
        >
          Mealio
        </div>
        <div
          style={{
            fontFamily: 'DM Sans',
            fontSize: 30,
            fontWeight: 500,
            color: 'rgba(255,255,255,0.85)',
            letterSpacing: '3px',
            textTransform: 'uppercase',
            marginTop: 32,
          }}
        >
          Shop meals, we'll fill the cart
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: 'Pacifico', data: pacificoData, style: 'normal', weight: 400 },
        { name: 'DM Sans',  data: dmSansData,   style: 'normal', weight: 500 },
      ],
    },
  );
}
