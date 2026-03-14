import { ImageResponse } from 'next/og';

export const runtime     = 'edge';
export const alt         = "Mealio — Shop meals, we'll fill the cart";
export const size        = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OgImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          background: 'linear-gradient(135deg, #111118 0%, #1c0a0a 55%, #2a0d0d 100%)',
          display: 'flex',
          padding: '64px 72px',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          position: 'relative',
        }}
      >
        {/* Giant background cart — subtle watermark */}
        <div
          style={{
            position: 'absolute',
            right: 60,
            top: 40,
            fontSize: 380,
            opacity: 0.05,
            display: 'flex',
            lineHeight: '1',
          }}
        >
          🛒
        </div>

        {/* Main content column — space-between top / middle / bottom */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            flex: 1,
          }}
        >
          {/* Top: wordmark + underline accent */}
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div
              style={{
                fontSize: 100,
                fontWeight: 900,
                color: '#e8193a',
                letterSpacing: '-4px',
                lineHeight: '1',
              }}
            >
              Mealio
            </div>
            <div
              style={{
                width: 80,
                height: 6,
                background: 'linear-gradient(90deg, #e8193a, #ff6b6b)',
                borderRadius: 99,
                marginTop: 14,
              }}
            />
          </div>

          {/* Middle: tagline */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            <div
              style={{
                fontSize: 52,
                fontWeight: 800,
                color: 'white',
                lineHeight: '1.15',
                letterSpacing: '-1px',
              }}
            >
              Shop meals,
            </div>
            <div
              style={{
                fontSize: 52,
                fontWeight: 800,
                lineHeight: '1.15',
                letterSpacing: '-1px',
                display: 'flex',
              }}
            >
              <span style={{ color: '#e8193a' }}>we'll fill</span>
              <span style={{ color: 'white' }}>&nbsp;the cart.</span>
            </div>
          </div>

          {/* Bottom: food emojis row + domain pill */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <div style={{ display: 'flex', gap: 16 }}>
              <span style={{ fontSize: 46 }}>🍝</span>
              <span style={{ fontSize: 46 }}>🍗</span>
              <span style={{ fontSize: 46 }}>🥗</span>
              <span style={{ fontSize: 46 }}>🍕</span>
              <span style={{ fontSize: 46 }}>🌮</span>
              <span style={{ fontSize: 46 }}>🥩</span>
              <span style={{ fontSize: 46 }}>🥦</span>
            </div>
            <div
              style={{
                display: 'flex',
                alignSelf: 'flex-start',
                padding: '8px 22px',
                borderRadius: 999,
                border: '1px solid rgba(255,255,255,0.18)',
                color: 'rgba(255,255,255,0.45)',
                fontSize: 22,
                fontWeight: 500,
              }}
            >
              mealio.co
            </div>
          </div>
        </div>
      </div>
    ),
    size,
  );
}
