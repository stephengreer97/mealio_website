'use client';

import Link from 'next/link';

const linkStyle: React.CSSProperties = { color: 'var(--text-2)', textDecoration: 'none' };
const mutedStyle: React.CSSProperties = { color: 'var(--text-3)', textDecoration: 'none' };

function FooterLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      prefetch={false}
      className="text-sm transition-colors"
      style={linkStyle}
      onMouseEnter={e => ((e.currentTarget as HTMLElement).style.color = 'var(--text-1)')}
      onMouseLeave={e => ((e.currentTarget as HTMLElement).style.color = 'var(--text-2)')}
    >
      {children}
    </Link>
  );
}

export default function AppFooter() {
  return (
    <footer style={{ borderTop: '1px solid var(--border)', background: 'var(--surface-raised)' }}>
      <div className="max-w-6xl mx-auto px-6 pt-12 pb-8">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-10 mb-10">

          {/* Brand column */}
          <div>
            <div style={{ display: 'flex', alignItems: 'baseline', marginBottom: '10px', lineHeight: 1 }}>
              <span
                style={{
                  fontFamily: 'var(--font-display), Georgia, serif',
                  fontWeight: 600,
                  fontSize: '24px',
                  letterSpacing: '-0.02em',
                  color: 'var(--text-1)',
                  fontVariationSettings: "'SOFT' 80, 'WONK' 1",
                }}
              >
                Mealio
              </span>
              <span aria-hidden style={{ width: 6, height: 6, borderRadius: 999, marginLeft: 4, background: 'var(--brand)', display: 'inline-block' }} />
            </div>
            <p className="text-sm leading-relaxed" style={{ color: 'var(--text-3)', maxWidth: '240px' }}>
              Shop meals, we&apos;ll fill the cart. Save the recipes you love and get every ingredient into your grocery cart in one tap.
            </p>
          </div>

          {/* Product column */}
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider mb-3.5" style={{ color: 'var(--text-3)' }}>Product</p>
            <nav className="flex flex-col gap-2.5">
              <FooterLink href="/discover">Discover Meals</FooterLink>
              <FooterLink href="/pricing">Pricing</FooterLink>
              <FooterLink href="/help">Help &amp; FAQ</FooterLink>
              <FooterLink href="/about">About</FooterLink>
            </nav>
          </div>

          {/* Creators column */}
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider mb-3.5" style={{ color: 'var(--text-3)' }}>Creators</p>
            <nav className="flex flex-col gap-2.5">
              <FooterLink href="/creator/apply">Become a Creator</FooterLink>
              <FooterLink href="/creator">Creator Portal</FooterLink>
            </nav>
          </div>

        </div>

        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-6" style={{ borderTop: '1px solid var(--border)' }}>
          <p className="text-xs" style={{ color: 'var(--text-3)' }}>
            © {new Date().getFullYear()} Mealio. All rights reserved.
          </p>
          <nav className="flex items-center gap-5">
            <Link href="/privacy" prefetch={false} className="text-xs transition-colors" style={mutedStyle}
              onMouseEnter={e => ((e.currentTarget as HTMLElement).style.color = 'var(--text-2)')}
              onMouseLeave={e => ((e.currentTarget as HTMLElement).style.color = 'var(--text-3)')}
            >Privacy</Link>
            <Link href="/terms" prefetch={false} className="text-xs transition-colors" style={mutedStyle}
              onMouseEnter={e => ((e.currentTarget as HTMLElement).style.color = 'var(--text-2)')}
              onMouseLeave={e => ((e.currentTarget as HTMLElement).style.color = 'var(--text-3)')}
            >Terms</Link>
            <a href="mailto:contact@mealio.co" className="text-xs transition-colors" style={mutedStyle}
              onMouseEnter={e => ((e.currentTarget as HTMLElement).style.color = 'var(--text-2)')}
              onMouseLeave={e => ((e.currentTarget as HTMLElement).style.color = 'var(--text-3)')}
            >Contact</a>
          </nav>
        </div>
      </div>
    </footer>
  );
}
