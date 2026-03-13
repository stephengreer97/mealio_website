'use client';

import Link from 'next/link';
import { useState, useEffect } from 'react';

const CHROME_URL  = 'https://chromewebstore.google.com/detail/mealio/eccnnnhkdpigfgbmnnmhppmligjhfpne';
const FIREFOX_URL = 'https://addons.mozilla.org/firefox/addon/mealio/';
const EDGE_URL    = 'https://microsoftedge.microsoft.com/addons/detail/odmgaejgoagcjbimmdpecimocekjiobi';

function getExtensionUrl(): string {
  if (typeof navigator === 'undefined') return CHROME_URL;
  const ua = navigator.userAgent;
  if (ua.includes('Firefox')) return FIREFOX_URL;
  if (ua.includes('Edg/')) return EDGE_URL;
  return CHROME_URL;
}

export default function AppFooter() {
  const [extUrl, setExtUrl] = useState(CHROME_URL);
  useEffect(() => { setExtUrl(getExtensionUrl()); }, []);

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
              <Link href="/creator/apply" className="text-sm transition-colors" style={{ color: 'var(--text-2)', textDecoration: 'none' }}
                onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = 'var(--text-1)'}
                onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = 'var(--text-2)'}
              >Become a Creator</Link>
            </nav>
          </div>

          {/* Extension CTA column */}
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--text-3)' }}>Get the Extension</p>
            <a
              href={extUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all"
              style={{ background: 'var(--brand)', color: '#fff', textDecoration: 'none' }}
              onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--brand-dark)'}
              onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'var(--brand)'}
            >
              Add Extension — Free
            </a>
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
