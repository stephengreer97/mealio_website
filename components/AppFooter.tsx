'use client';

import Link from 'next/link';

export default function AppFooter() {
  return (
    <footer style={{ borderTop: '1px solid var(--wk-border)', background: 'var(--wk-card)' }}>
      <div className="max-w-5xl mx-auto px-6 py-5 flex flex-col sm:flex-row items-center justify-between gap-3">
        <p className="text-xs text-wk-text3">
          © {new Date().getFullYear()} Mealio. All rights reserved.
        </p>
        <nav className="flex items-center gap-4">
          <Link href="/help"    className="text-xs text-wk-text3 hover:text-wk-text2 transition-colors">Help</Link>
          <Link href="/privacy" className="text-xs text-wk-text3 hover:text-wk-text2 transition-colors">Privacy</Link>
          <Link href="/terms"   className="text-xs text-wk-text3 hover:text-wk-text2 transition-colors">Terms</Link>
        </nav>
      </div>
    </footer>
  );
}
