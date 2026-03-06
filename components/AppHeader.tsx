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
    fetch('/api/creator/me', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data?.creator) setIsCreator(true); })
      .catch(() => {});
    try {
      const user = JSON.parse(localStorage.getItem('user') ?? '{}');
      if (user?.isAdmin) setIsAdmin(true);
    } catch {}
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

  const handleLogout = () => {
    localStorage.clear();
    router.push('/');
  };

  const isNavActive = (path: string) => pathname === path;

  const mobileNavItems = [
    { label: 'Discover',         onClick: () => router.push('/discover'),  active: pathname === '/discover' },
    { label: 'My Meals',         onClick: () => router.push('/my-meals'),  active: pathname === '/my-meals' },
    { label: 'Help',             onClick: () => router.push('/help'),      active: pathname === '/help' },
    { label: 'Privacy Policy',   onClick: () => router.push('/privacy'),   active: pathname === '/privacy' },
    { label: 'Terms of Service', onClick: () => router.push('/terms'),     active: pathname === '/terms' },
    { label: 'Contact',          onClick: () => { window.location.href = 'mailto:contact@mealio.co'; }, active: false },
    ...(isAdmin   ? [{ label: 'Admin',          onClick: () => router.push('/admin'),   active: pathname === '/admin' }] : []),
    ...(isCreator ? [{ label: 'Creator Portal', onClick: () => router.push('/creator'), active: pathname.startsWith('/creator') }] : []),
    { label: 'Manage Account',   onClick: () => router.push('/account'),   active: pathname === '/account' },
    { label: 'Log Out',          onClick: handleLogout, active: false, danger: true },
  ] as { label: string; onClick: () => void; active: boolean; danger?: boolean }[];

  return (
    <header style={{ background: 'var(--brand)', position: 'relative' }}>
      <div className="max-w-5xl mx-auto px-6 py-3.5 flex justify-between items-center">
        {/* Logo */}
        <button
          onClick={() => router.push('/discover')}
          style={{ fontFamily: 'var(--font-pacifico), cursive', background: 'none', border: 'none', padding: 0, cursor: 'pointer', lineHeight: 1 }}
          aria-label="Mealio home"
        >
          <span style={{ fontSize: '36px', lineHeight: '1', display: 'inline-block', verticalAlign: 'middle', color: '#fff' }}>M</span>
          <span style={{ fontSize: '26px', color: 'rgba(255,255,255,0.92)' }}>ealio</span>
        </button>

        {/* Desktop Nav */}
        <nav className="hidden sm:flex items-center gap-0.5">
          <NavButton label="Discover" active={isNavActive('/discover')} onClick={() => router.push('/discover')} />
          <NavButton label="My Meals" active={isNavActive('/my-meals')} onClick={() => router.push('/my-meals')} />

          <DropdownMenu
            label="Help & FAQ"
            active={pathname === '/help' || pathname === '/privacy' || pathname === '/terms'}
            onLabelClick={() => router.push('/help')}
            items={[
              { label: 'Help & FAQ',     onClick: () => router.push('/help') },
              { label: 'Privacy Policy', onClick: () => router.push('/privacy') },
              { label: 'Terms of Service', onClick: () => router.push('/terms') },
              { label: 'Contact',        onClick: () => { window.location.href = 'mailto:contact@mealio.co'; } },
            ]}
          />

          <DropdownMenu
            label="Account"
            active={pathname === '/account'}
            onLabelClick={() => router.push('/account')}
            items={[
              ...(isAdmin   ? [{ label: 'Admin',          onClick: () => router.push('/admin')   }] : []),
              ...(isCreator ? [{ label: 'Creator Portal', onClick: () => router.push('/creator') }] : []),
              { label: 'Manage Account', onClick: () => router.push('/account') },
              { label: 'Log Out',        onClick: handleLogout },
            ]}
          />
        </nav>

        {/* Mobile Hamburger */}
        <button
          ref={hamburgerRef}
          className="sm:hidden flex flex-col justify-center items-center gap-[5px] p-2"
          onClick={() => setMobileOpen(prev => !prev)}
          style={{ background: 'none', border: 'none', cursor: 'pointer' }}
          aria-label="Menu"
        >
          <span style={{ display: 'block', width: '20px', height: '1.5px', background: '#fff', borderRadius: '2px', transition: 'transform 0.2s', transform: mobileOpen ? 'translateY(6.5px) rotate(45deg)' : 'none' }} />
          <span style={{ display: 'block', width: '20px', height: '1.5px', background: '#fff', borderRadius: '2px', opacity: mobileOpen ? 0 : 1, transition: 'opacity 0.15s' }} />
          <span style={{ display: 'block', width: '20px', height: '1.5px', background: '#fff', borderRadius: '2px', transition: 'transform 0.2s', transform: mobileOpen ? 'translateY(-6.5px) rotate(-45deg)' : 'none' }} />
        </button>
      </div>

      {/* Mobile Menu */}
      {mobileOpen && (
        <div
          ref={mobileMenuRef}
          className="sm:hidden absolute left-0 right-0 z-50 py-1.5 shadow-xl"
          style={{ background: 'var(--surface-raised)', borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)' }}
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

function NavButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="px-4 py-2 text-sm font-medium rounded-lg transition-colors"
      style={{
        color: active ? '#fff' : 'rgba(255,255,255,0.75)',
        background: active ? 'rgba(0,0,0,0.16)' : 'transparent',
        border: 'none',
        cursor: 'pointer',
      }}
      onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'rgba(0,0,0,0.10)'; e.currentTarget.style.color = '#fff'; }}
      onMouseLeave={e => { if (!active) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(255,255,255,0.75)'; } }}
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
        className="px-4 py-2 text-sm font-medium rounded-lg flex items-center gap-1 transition-colors"
        style={{
          color: active || open ? '#fff' : 'rgba(255,255,255,0.75)',
          background: active || open ? 'rgba(0,0,0,0.16)' : 'transparent',
          border: 'none',
          cursor: 'pointer',
        }}
        onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'rgba(0,0,0,0.10)'; e.currentTarget.style.color = '#fff'; }}
        onMouseLeave={e => { if (!active && !open) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(255,255,255,0.75)'; } }}
      >
        {label}
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.65, marginTop: '1px', transition: 'transform 0.15s', transform: open ? 'rotate(180deg)' : 'none' }}>
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-1.5 py-1 rounded-xl z-50"
          style={{
            background: 'var(--surface-raised)',
            border: '1px solid var(--border)',
            boxShadow: 'var(--shadow-md)',
            minWidth: '168px',
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
                color: item.label === 'Log Out' ? 'var(--brand)' : 'var(--text-1)',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                fontWeight: item.label === 'Log Out' ? 500 : 400,
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
