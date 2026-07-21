'use client';

import { useRouter, usePathname } from 'next/navigation';
import { useState, useRef, useEffect } from 'react';

export default function AppHeader() {
  const router   = useRouter();
  const pathname = usePathname();
  const [isCreator, setIsCreator] = useState(false);
  const [isAdmin, setIsAdmin]   = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const mobileMenuRef = useRef<HTMLDivElement>(null);
  const hamburgerRef  = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const token = localStorage.getItem('accessToken');
    if (!token) return;
    // Usage analytics: log one "open" per browser session (fire-and-forget).
    try {
      if (!sessionStorage.getItem('mealio_open_logged')) {
        sessionStorage.setItem('mealio_open_logged', '1');
        fetch('/api/usage/open', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ source: 'web', platform: 'web' }),
        }).catch(() => {});
      }
    } catch {}
    try {
      const user = JSON.parse(localStorage.getItem('user') ?? '{}');
      if (user?.isAdmin)   setIsAdmin(true);
      if (user?.isCreator) setIsCreator(true);
    } catch {}
    fetch('/api/creator/me', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        const creator = !!data?.creator;
        setIsCreator(creator);
        try {
          const user = JSON.parse(localStorage.getItem('user') ?? '{}');
          localStorage.setItem('user', JSON.stringify({ ...user, isCreator: creator }));
        } catch {}
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!mobileOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        mobileMenuRef.current && !mobileMenuRef.current.contains(target) &&
        hamburgerRef.current  && !hamburgerRef.current.contains(target)
      ) {
        setMobileOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [mobileOpen]);

  useEffect(() => { setMobileOpen(false); }, [pathname]);

  const [isLoggedIn, setIsLoggedIn] = useState(false);

  useEffect(() => {
    setIsLoggedIn(!!localStorage.getItem('accessToken'));
  }, []);

  // Slide the web session on load: swap the current token for a fresh 90-day one
  // so active web users are never force-logged-out at expiry (mobile already does
  // this on launch). A revoked/expired token just fails silently and is left as-is.
  useEffect(() => {
    const token = localStorage.getItem('accessToken');
    if (!token) return;
    fetch('/api/auth/renew', { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
      .then(r => (r.ok ? r.json() : null))
      .then(data => {
        if (data?.accessToken) localStorage.setItem('accessToken', data.accessToken);
        if (data?.user) localStorage.setItem('user', JSON.stringify(data.user));
      })
      .catch(() => {});
  }, []);

  const handleLogout = () => {
    localStorage.clear();
    window.location.href = '/discover';
  };

  const handleSignIn = () => {
    router.push('/signin');
  };

  const isNavActive = (path: string) => pathname === path;

  const mobileNavItems = [
    { label: 'Discover',         onClick: () => router.push('/discover'),  active: pathname === '/discover' },
    ...(isLoggedIn ? [{ label: 'My Meals', onClick: () => router.push('/my-meals'), active: pathname === '/my-meals' }] : []),
    { label: 'Help',             onClick: () => router.push('/help'),      active: pathname === '/help' },
    { label: 'Privacy Policy',   onClick: () => router.push('/privacy'),   active: pathname === '/privacy' },
    { label: 'Terms of Service', onClick: () => router.push('/terms'),     active: pathname === '/terms' },
    { label: 'Contact',          onClick: () => { window.location.href = 'mailto:contact@mealio.co'; }, active: false },
    ...(isAdmin   ? [{ label: 'Admin',          onClick: () => router.push('/admin'),   active: pathname === '/admin' }] : []),
    ...(isCreator ? [{ label: 'Creator Portal', onClick: () => router.push('/creator'), active: pathname.startsWith('/creator') }] : []),
    ...(isLoggedIn ? [{ label: 'Manage Account', onClick: () => router.push('/account'), active: pathname === '/account' }] : []),
    { label: isLoggedIn ? 'Log Out' : 'Sign In / Sign Up', onClick: isLoggedIn ? handleLogout : handleSignIn, active: false, danger: isLoggedIn },
  ] as { label: string; onClick: () => void; active: boolean; danger?: boolean }[];

  return (
    <header
      className="sticky top-0 z-40"
      style={{
        background: 'rgba(250, 246, 240, 0.86)',
        backdropFilter: 'blur(14px)',
        WebkitBackdropFilter: 'blur(14px)',
        borderBottom: '1px solid var(--border)',
      }}
    >
      <div className="max-w-6xl mx-auto px-6 h-16 flex items-center">

        {/* Wordmark — left */}
        <div className="flex-1 flex items-center">
          <button
            onClick={() => router.push('/discover')}
            aria-label="Mealio home"
            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', lineHeight: 1, display: 'flex', alignItems: 'baseline' }}
          >
            <span
              style={{
                fontFamily: 'var(--font-display), Georgia, serif',
                fontWeight: 600,
                fontSize: '26px',
                letterSpacing: '-0.02em',
                color: 'var(--text-1)',
                fontVariationSettings: "'SOFT' 80, 'WONK' 1",
              }}
            >
              Mealio
            </span>
            <span
              aria-hidden
              style={{
                width: 7, height: 7, borderRadius: 999, marginLeft: 4,
                background: 'var(--brand)', display: 'inline-block', transform: 'translateY(-1px)',
              }}
            />
          </button>
        </div>

        {/* Desktop Nav — center */}
        <nav className="hidden sm:flex items-center gap-1">
          <NavButton label="Discover" active={isNavActive('/discover')} onClick={() => router.push('/discover')} />
          {isLoggedIn && <NavButton label="My Meals" active={isNavActive('/my-meals')} onClick={() => router.push('/my-meals')} />}

          {isCreator && <CreatorNavButton active={pathname.startsWith('/creator')} onClick={() => router.push('/creator')} />}
          <DropdownMenu
            label="Help & FAQ"
            active={pathname === '/help' || pathname === '/privacy' || pathname === '/terms'}
            onLabelClick={() => router.push('/help')}
            items={[
              { label: 'Help & FAQ',       onClick: () => router.push('/help') },
              { label: 'Privacy Policy',   onClick: () => router.push('/privacy') },
              { label: 'Terms of Service', onClick: () => router.push('/terms') },
              { label: 'Contact',          onClick: () => { window.location.href = 'mailto:contact@mealio.co'; } },
            ]}
          />
          {isAdmin   && <NavButton label="Admin"   active={pathname === '/admin'}           onClick={() => router.push('/admin')}   />}
          {isLoggedIn && <NavButton label="Account" active={isNavActive('/account')} onClick={() => router.push('/account')} />}
        </nav>

        {/* Right — Log Out / Sign In (desktop) + Hamburger (mobile) */}
        <div className="flex-1 flex items-center justify-end">
          {isLoggedIn ? (
            <button
              onClick={handleLogout}
              className="hidden sm:block px-4 py-2 text-sm font-medium rounded-full transition-colors"
              style={{ color: 'var(--text-2)', background: 'transparent', border: 'none', cursor: 'pointer' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface)'; e.currentTarget.style.color = 'var(--text-1)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-2)'; }}
            >
              Log Out
            </button>
          ) : (
            <button
              onClick={handleSignIn}
              className="hidden sm:inline-flex items-center text-sm font-semibold rounded-full transition-all"
              style={{
                background: 'var(--brand)', color: '#fff', border: 'none', cursor: 'pointer',
                padding: '9px 20px', boxShadow: 'var(--shadow-brand)',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--brand-dark)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'var(--brand)'; }}
            >
              Sign In
            </button>
          )}

          {/* Mobile Hamburger */}
          <button
            ref={hamburgerRef}
            className="sm:hidden flex flex-col justify-center items-center gap-[5px] p-2"
            onClick={() => setMobileOpen(prev => !prev)}
            style={{ background: 'none', border: 'none', cursor: 'pointer' }}
            aria-label="Menu"
          >
            <span style={{ display: 'block', width: '20px', height: '1.5px', background: 'var(--text-1)', borderRadius: '2px', transition: 'transform 0.2s', transform: mobileOpen ? 'translateY(6.5px) rotate(45deg)' : 'none' }} />
            <span style={{ display: 'block', width: '20px', height: '1.5px', background: 'var(--text-1)', borderRadius: '2px', opacity: mobileOpen ? 0 : 1, transition: 'opacity 0.15s' }} />
            <span style={{ display: 'block', width: '20px', height: '1.5px', background: 'var(--text-1)', borderRadius: '2px', transition: 'transform 0.2s', transform: mobileOpen ? 'translateY(-6.5px) rotate(-45deg)' : 'none' }} />
          </button>
        </div>
      </div>

      {/* Mobile Menu */}
      {mobileOpen && (
        <div
          ref={mobileMenuRef}
          className="sm:hidden absolute left-3 right-3 z-50 py-2 rounded-2xl"
          style={{
            top: 'calc(100% + 6px)',
            background: 'var(--surface-raised)',
            border: '1px solid var(--border)',
            boxShadow: 'var(--shadow-lg)',
            animation: 'scaleIn 0.16s ease both',
            transformOrigin: 'top center',
          }}
        >
          {mobileNavItems.map(item => (
            <button
              key={item.label}
              onClick={item.onClick}
              className="block w-full text-left px-5 py-3 text-sm font-medium transition-colors"
              style={{
                background: item.active ? 'var(--surface)' : 'transparent',
                color: item.danger ? 'var(--brand)' : item.active ? 'var(--text-1)' : 'var(--text-2)',
                border: 'none',
                cursor: 'pointer',
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </header>
  );
}

function CreatorNavButton({ active, onClick }: { active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="px-4 py-2 text-sm font-semibold rounded-full transition-colors"
      style={{
        background: active ? 'var(--brand-light)' : 'transparent',
        color: 'var(--brand)',
        border: '1px solid var(--brand-border)',
        cursor: 'pointer',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = 'var(--brand-light)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = active ? 'var(--brand-light)' : 'transparent'; }}
    >
      Creator Portal
    </button>
  );
}

function NavButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="px-4 py-2 text-sm font-medium rounded-full transition-colors"
      style={{
        color: active ? 'var(--text-1)' : 'var(--text-2)',
        background: active ? 'var(--surface)' : 'transparent',
        border: 'none',
        cursor: 'pointer',
        fontWeight: active ? 600 : 500,
      }}
      onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--surface)'; e.currentTarget.style.color = 'var(--text-1)'; }}
      onMouseLeave={e => { if (!active) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-2)'; } }}
    >
      {label}
    </button>
  );
}

function DropdownMenu({
  label, active, onLabelClick, items,
}: {
  label: string;
  active: boolean;
  onLabelClick?: () => void;
  items: { label: string; onClick: () => void }[];
}) {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = () => { if (closeTimer.current) clearTimeout(closeTimer.current); setOpen(true); };
  const hide = () => { closeTimer.current = setTimeout(() => setOpen(false), 120); };

  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);

  return (
    <div className="relative" onMouseEnter={show} onMouseLeave={hide}>
      <button
        onClick={onLabelClick}
        className="px-4 py-2 text-sm font-medium rounded-full flex items-center gap-1 transition-colors"
        style={{
          color: active || open ? 'var(--text-1)' : 'var(--text-2)',
          background: active || open ? 'var(--surface)' : 'transparent',
          border: 'none',
          cursor: 'pointer',
        }}
        onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--surface)'; e.currentTarget.style.color = 'var(--text-1)'; }}
        onMouseLeave={e => { if (!active && !open) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-2)'; } }}
      >
        {label}
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.65, marginTop: '1px', transition: 'transform 0.15s', transform: open ? 'rotate(180deg)' : 'none' }}>
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-1.5 py-1.5 rounded-2xl z-50"
          style={{
            background: 'var(--surface-raised)',
            border: '1px solid var(--border)',
            boxShadow: 'var(--shadow-lg)',
            minWidth: '176px',
            animation: 'scaleIn 0.14s ease both',
            transformOrigin: 'top right',
          }}
          onMouseEnter={show}
          onMouseLeave={hide}
        >
          {items.map(item => (
            <button
              key={item.label}
              onClick={() => { setOpen(false); item.onClick(); }}
              className="block w-full text-left px-4 py-2.5 text-sm transition-colors"
              style={{
                color: 'var(--text-1)',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                fontWeight: 450,
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
