import { ImageResponse } from 'next/og';
import { readFile } from 'fs/promises';
import path from 'path';

export const runtime     = 'nodejs';
export const alt         = "Mealio — Shop meals, we'll fill the cart";
export const size        = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default async function OgImage() {
  const [pacificoData, dmSansData] = await Promise.all([
    readFile(path.join(process.cwd(), 'app/fonts/Pacifico.woff2')),
    readFile(path.join(process.cwd(), 'app/fonts/DMSans-Medium.woff2')),
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
