'use client';

import Link from 'next/link';

const CHROME_URL = 'https://chromewebstore.google.com/detail/mealio/eccnnnhkdpigfgbmnnmhppmligjhfpne';

export default function AppFooter() {
  return (
    <footer style={{ borderTop: '1px solid var(--border)', background: 'var(--surface-raised)' }}>
      <div className="max-w-5xl mx-auto px-6 py-8">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-8 mb-8">
          {/* Brand column */}
          <div>
            <div style={{ fontFamily: 'var(--font-pacifico), cursive', lineHeight: 1, marginBottom: '8px' }}>
              <span style={{ fontSize: '28px', color: 'var(--brand)' }}>M</span>
              <span style={{ fontSize: '21px', color: 'var(--brand)' }}>ealio</span>
            </div>
            <p className="text-xs leading-relaxed" style={{ color: 'var(--text-3)', maxWidth: '200px' }}>
              Save meals. Fill your cart in one click. Works at 36+ grocery stores.
            </p>
          </div>

          {/* Links column */}
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--text-3)' }}>Product</p>
            <nav className="flex flex-col gap-2">
              <Link href="/discover" className="text-sm transition-colors" style={{ color: 'var(--text-2)', textDecoration: 'none' }}
                onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = 'var(--text-1)'}
                onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = 'var(--text-2)'}
              >Discover Meals</Link>
              <Link href="/pricing" className="text-sm transition-colors" style={{ color: 'var(--text-2)', textDecoration: 'none' }}
                onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = 'var(--text-1)'}
                onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = 'var(--text-2)'}
              >Pricing</Link>
              <Link href="/help" className="text-sm transition-colors" style={{ color: 'var(--text-2)', textDecoration: 'none' }}
                onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = 'var(--text-1)'}
                onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = 'var(--text-2)'}
              >Help & FAQ</Link>
              <Link href="/about" className="text-sm transition-colors" style={{ color: 'var(--text-2)', textDecoration: 'none' }}
                onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = 'var(--text-1)'}
                onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = 'var(--text-2)'}
              >About</Link>
            </nav>
          </div>

          {/* Extension CTA column */}
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--text-3)' }}>Get the Extension</p>
            <a
              href={CHROME_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all"
              style={{ background: 'var(--brand)', color: '#fff', textDecoration: 'none' }}
              onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--brand-dark)'}
              onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'var(--brand)'}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/>
                <line x1="21.17" y1="8" x2="12" y2="8"/><line x1="3.95" y1="6.06" x2="8.54" y2="14"/>
                <line x1="10.88" y1="21.94" x2="15.46" y2="14"/>
              </svg>
              Add to Chrome — Free
            </a>
            <p className="text-xs mt-2" style={{ color: 'var(--text-3)' }}>Also available for Firefox &amp; Edge</p>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-6" style={{ borderTop: '1px solid var(--border)' }}>
          <p className="text-xs" style={{ color: 'var(--text-3)' }}>
            © {new Date().getFullYear()} Mealio. All rights reserved.
          </p>
          <nav className="flex items-center gap-5">
            <Link href="/privacy" className="text-xs transition-colors" style={{ color: 'var(--text-3)', textDecoration: 'none' }}
              onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = 'var(--text-2)'}
              onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = 'var(--text-3)'}
            >Privacy</Link>
            <Link href="/terms" className="text-xs transition-colors" style={{ color: 'var(--text-3)', textDecoration: 'none' }}
              onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = 'var(--text-2)'}
              onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = 'var(--text-3)'}
            >Terms</Link>
            <a href="mailto:contact@mealio.co" className="text-xs transition-colors" style={{ color: 'var(--text-3)', textDecoration: 'none' }}
              onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = 'var(--text-2)'}
              onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = 'var(--text-3)'}
            >Contact</a>
          </nav>
        </div>
      </div>
    </footer>
  );
}
