import { ImageResponse } from 'next/og';

export const runtime     = 'edge';
export const alt         = "Mealio — Shop meals, we'll fill the cart";
export const size        = { width: 1200, height: 630 };
export const contentType = 'image/png';

// Fetch a Google Font's woff2 file by parsing its CSS API response.
// URL must be pre-built as a string — do not use URLSearchParams for the
// family specifier because it percent-encodes `:` and `@` which breaks the
// Google Fonts variant syntax (e.g. `DM+Sans:wght@500`).
async function loadGoogleFont(cssUrl: string): Promise<ArrayBuffer> {
  const css = await fetch(cssUrl, {
    headers: {
      // Request woff2 (modern browsers) so Google returns a woff2 src.
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  }).then(r => r.text());

  // Extract the first woff2 URL (Latin subset comes first).
  const match = css.match(/src: url\(([^)]+\.woff2)\)/);
  if (!match) throw new Error(`woff2 URL not found in CSS from: ${cssUrl}`);
  return fetch(match[1]).then(r => r.arrayBuffer());
}

export default async function OgImage() {
  const [pacificoData, dmSansData] = await Promise.all([
    loadGoogleFont('https://fonts.googleapis.com/css2?family=Pacifico&display=swap'),
    loadGoogleFont('https://fonts.googleapis.com/css2?family=DM+Sans:wght@500&display=swap'),
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
            letterSpacing: '4px',
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
