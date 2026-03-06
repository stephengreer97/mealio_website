import { ImageResponse } from 'next/og';

export const runtime     = 'edge';
export const alt         = 'Mealio — Grocery Shop Effortlessly';
export const size        = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OgImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%', height: '100%',
          background: 'linear-gradient(135deg, #c40029 0%, #dd0031 60%, #e8193a 100%)',
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }}
      >
        <div style={{ fontSize: 90, fontWeight: 800, color: 'white', letterSpacing: '-2px' }}>
          Mealio
        </div>
        <div style={{ fontSize: 34, color: 'rgba(255,255,255,0.82)', marginTop: 18, fontWeight: 400 }}>
          Grocery shop effortlessly
        </div>
        <div style={{
          marginTop: 40, fontSize: 20, color: 'rgba(255,255,255,0.6)',
          border: '1px solid rgba(255,255,255,0.3)', borderRadius: 999,
          padding: '8px 24px',
        }}>
          mealio.co
        </div>
      </div>
    ),
    size,
  );
}
