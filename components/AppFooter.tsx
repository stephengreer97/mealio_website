'use client';

import Link from 'next/link';

export default function AppFooter() {

  return (
    <footer style={{ borderTop: '1px solid var(--border)', background: 'var(--surface-raised)' }}>
      <div className="max-w-5xl mx-auto px-6 py-8">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-8 mb-8">
          {/* Brand column */}
          <div>
            <div style={{ fontFamily: 'var(--font-pacifico), cursive', lineHeight: 1, marginBottom: '8px' }}>
              <span style={{ fontSize: '28px', color: 'var(--brand)' }}>M</span>
              <span style={{ fontSize: '21px', color: 'var(--brand)' }}>ealio</span>
            </div>
            <p className="text-xs leading-relaxed" style={{ color: 'var(--text-3)', maxWidth: '200px' }}>
              Shop meals, we'll fill the cart.
            </p>
          </div>

          {/* Links column */}
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--text-3)' }}>Product</p>
            <nav className="flex flex-col gap-2">
              <Link href="/discover" prefetch={false} className="text-sm transition-colors" style={{ color: 'var(--text-2)', textDecoration: 'none' }}
                onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = 'var(--text-1)'}
                onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = 'var(--text-2)'}
              >Discover Meals</Link>
              <Link href="/pricing" prefetch={false} className="text-sm transition-colors" style={{ color: 'var(--text-2)', textDecoration: 'none' }}
                onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = 'var(--text-1)'}
                onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = 'var(--text-2)'}
              >Pricing</Link>
              <Link href="/help" prefetch={false} className="text-sm transition-colors" style={{ color: 'var(--text-2)', textDecoration: 'none' }}
                onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = 'var(--text-1)'}
                onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = 'var(--text-2)'}
              >Help & FAQ</Link>
              <Link href="/creator/apply" prefetch={false} className="text-sm transition-colors" style={{ color: 'var(--text-2)', textDecoration: 'none' }}
                onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = 'var(--text-1)'}
                onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = 'var(--text-2)'}
              >Become a Creator</Link>
            </nav>
          </div>

        </div>

        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-6" style={{ borderTop: '1px solid var(--border)' }}>
          <p className="text-xs" style={{ color: 'var(--text-3)' }}>
            © {new Date().getFullYear()} Mealio. All rights reserved.
          </p>
          <nav className="flex items-center gap-5">
            <Link href="/privacy" prefetch={false} className="text-xs transition-colors" style={{ color: 'var(--text-3)', textDecoration: 'none' }}
              onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = 'var(--text-2)'}
              onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = 'var(--text-3)'}
            >Privacy</Link>
            <Link href="/terms" prefetch={false} className="text-xs transition-colors" style={{ color: 'var(--text-3)', textDecoration: 'none' }}
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
