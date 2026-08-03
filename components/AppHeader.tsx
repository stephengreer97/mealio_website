'use client';

import { useRouter, usePathname } from 'next/navigation';
import { useState, useRef, useEffect } from 'react';

export default function AppHeader() {
  const router   = useRouter();
  const pathname = usePathname();
  const [isCreator, setIsCreator] = useState(false);
  const [isAdmin, setIsAdmin]   = useState(false);
  const [pendingDrafts, setPendingDrafts] = useState(0);
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

  /**
   * The pending-draft count on Creator Portal (MEAL-89).
   *
   * A badge and nothing else. A creator who opened the site to add a meal to
   * their cart is not interrupted, redirected or modal-trapped by drafts
   * waiting for them — the number is there when they look, and the decision to
   * go and deal with it is theirs.
   *
   * The count, not a dot: "10" tells a creator to set aside an evening, and a
   * dot reads identically for one draft and for twenty.
   *
   * Fired unconditionally rather than behind `isCreator`, because `isCreator`
   * resolves from a round trip of its own and the badge would flash in a beat
   * later than the button it sits on. The endpoint answers 0 for anyone who is
   * not a creator, so asking early is cheap and never wrong.
   */
  useEffect(() => {
    const token = localStorage.getItem('accessToken');
    if (!token) return;

    let live = true;
    const refresh = () => {
      fetch('/api/creator/import-drafts?count=1', { headers: { Authorization: `Bearer ${token}` } })
        .then(r => (r.ok ? r.json() : null))
        .then(data => { if (live && typeof data?.waiting === 'number') setPendingDrafts(data.waiting); })
        .catch(() => {});
    };
    refresh();

    // The web equivalent of an app foreground. A creator who left this tab open
    // for a day and came back should not be looking at yesterday's count, and a
    // 15-minute poller does not justify a socket to say so.
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVisible);

    // Fired by the queue on the portal when a draft is decided. The queue and
    // this header are siblings under a 2,000-line page with no shared store
    // between them, and the alternative — refetching on an interval — would
    // leave the badge reading 3 for up to a minute after the creator emptied it,
    // in the one place they can watch it not happen.
    const onChanged = (event: Event) => {
      const waiting = (event as CustomEvent<{ waiting?: number }>).detail?.waiting;
      if (typeof waiting === 'number') setPendingDrafts(waiting);
      else refresh();
    };
    window.addEventListener('mealio:draft-queue-changed', onChanged);

    return () => {
      live = false;
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('mealio:draft-queue-changed', onChanged);
    };
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
    // Badged as well as the desktop button, or the count is invisible to every
    // creator using the site on a phone — which is most of them, and exactly the
    // people a "10 recipes are waiting" number is meant to reach.
    ...(isCreator ? [{ label: 'Creator Portal', onClick: () => router.push('/creator'), active: pathname.startsWith('/creator'), badge: pendingDrafts }] : []),
    ...(isLoggedIn ? [{ label: 'Manage Account', onClick: () => router.push('/account'), active: pathname === '/account' }] : []),
    { label: isLoggedIn ? 'Log Out' : 'Sign In / Sign Up', onClick: isLoggedIn ? handleLogout : handleSignIn, active: false, danger: isLoggedIn },
  ] as { label: string; onClick: () => void; active: boolean; danger?: boolean; badge?: number }[];

  return (
    <header style={{ background: 'var(--brand)', position: 'relative' }}>
      <div className="max-w-5xl mx-auto px-6 py-3.5 flex items-center">

        {/* Logo — left */}
        <div className="flex-1 flex items-center">
          <button
            onClick={() => router.push('/discover')}
            style={{ fontFamily: 'var(--font-pacifico), cursive', background: 'none', border: 'none', padding: 0, cursor: 'pointer', lineHeight: 1 }}
            aria-label="Mealio home"
          >
            <span style={{ fontSize: '36px', lineHeight: '1', display: 'inline-block', verticalAlign: 'middle', color: '#fff' }}>M</span>
            <span style={{ fontSize: '26px', color: 'rgba(255,255,255,0.92)' }}>ealio</span>
          </button>
        </div>

        {/* Desktop Nav — center */}
        <nav className="hidden sm:flex items-center gap-0.5">
          <NavButton label="Discover" active={isNavActive('/discover')} onClick={() => router.push('/discover')} />
          {isLoggedIn && <NavButton label="My Meals" active={isNavActive('/my-meals')} onClick={() => router.push('/my-meals')} />}

          {isCreator && <CreatorNavButton active={pathname.startsWith('/creator')} onClick={() => router.push('/creator')} badge={pendingDrafts} />}
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
          <button
            onClick={isLoggedIn ? handleLogout : handleSignIn}
            className="hidden sm:block px-4 py-2 text-sm font-medium rounded-lg transition-colors"
            style={{ color: 'rgba(255,255,255,0.75)', background: 'transparent', border: 'none', cursor: 'pointer' }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(0,0,0,0.10)'; e.currentTarget.style.color = '#fff'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(255,255,255,0.75)'; }}
          >
            {isLoggedIn ? 'Log Out' : 'Sign In / Sign Up'}
          </button>

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
              className="flex w-full items-center gap-2 text-left px-5 py-3 text-sm font-medium transition-colors"
              style={{
                background: item.active ? 'var(--surface)' : 'transparent',
                color: item.danger ? 'var(--brand)' : item.active ? 'var(--text-1)' : 'var(--text-2)',
                border: 'none',
                cursor: 'pointer',
              }}
            >
              {item.label}
              {item.badge ? <DraftBadge count={item.badge} tone="dark" /> : null}
            </button>
          ))}
        </div>
      )}
    </header>
  );
}

/**
 * How many drafts are waiting, as a number.
 *
 * Never a dot. The count is the information — a creator seeing "10" knows to
 * set an evening aside and a creator seeing "1" knows it is a two-minute job,
 * and a dot says the same thing to both of them. Capped at 99+ only because the
 * badge stops being a badge somewhere past three digits, and by then the
 * difference between 100 and 140 is not a difference anyone acts on.
 *
 * Rendered with the count spelled out for screen readers: "7" beside a button
 * labelled "Creator Portal" is a number with no noun attached to it, which is
 * exactly as useful as it sounds.
 */
function DraftBadge({ count, tone }: { count: number; tone: 'light' | 'dark' }) {
  if (count <= 0) return null;
  return (
    <span
      data-testid="creator-draft-badge"
      aria-label={`${count} ${count === 1 ? 'recipe' : 'recipes'} waiting for you to review`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: '18px',
        height: '18px',
        padding: '0 5px',
        borderRadius: '99px',
        fontSize: '11px',
        fontWeight: 700,
        lineHeight: 1,
        background: tone === 'light' ? '#fff' : 'var(--brand)',
        color: tone === 'light' ? 'var(--brand)' : '#fff',
      }}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

function CreatorNavButton({ active, onClick, badge }: { active: boolean; onClick: () => void; badge: number }) {
  return (
    <button
      onClick={onClick}
      className="px-4 py-2 text-sm font-semibold rounded-lg transition-colors flex items-center gap-2"
      style={{
        background: active ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.15)',
        color: '#fff',
        border: '1px solid rgba(255,255,255,0.35)',
        cursor: 'pointer',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.25)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = active ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.15)'; }}
    >
      Creator Portal
      <DraftBadge count={badge} tone="light" />
    </button>
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
                color: 'var(--text-1)',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                fontWeight: 400,
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
