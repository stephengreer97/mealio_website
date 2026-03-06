'use client';

import { useEffect, useState } from 'react';

const CHROME_URL  = 'https://chromewebstore.google.com/detail/mealio/eccnnnhkdpigfgbmnnmhppmligjhfpne';
const FIREFOX_URL = 'https://addons.mozilla.org/en-US/firefox/addon/mealio/';
const EDGE_URL    = CHROME_URL;

function getExtensionUrl(): string {
  if (typeof navigator === 'undefined') return CHROME_URL;
  const ua = navigator.userAgent;
  if (ua.includes('Firefox/')) return FIREFOX_URL;
  if (ua.includes('Edg/'))    return EDGE_URL;
  return CHROME_URL;
}

function getLabel(): string {
  if (typeof navigator === 'undefined') return 'Add to Chrome';
  const ua = navigator.userAgent;
  if (ua.includes('Firefox/')) return 'Add to Firefox';
  if (ua.includes('Edg/'))    return 'Add to Edge';
  return 'Add to Chrome';
}

function isMobileDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

export default function ExtensionNudge() {
  const [show, setShow]   = useState(false);
  const [url, setUrl]     = useState(CHROME_URL);
  const [label, setLabel] = useState('Add to Chrome');
  const [mobile, setMobile] = useState(false);

  useEffect(() => {
    const installed = document.documentElement.hasAttribute('data-mealio-installed');
    if (!installed) {
      setShow(true);
      setUrl(getExtensionUrl());
      setLabel(getLabel());
      setMobile(isMobileDevice());
    }
  }, []);

  if (!show) return null;

  return (
    <div
      className="flex items-center gap-4 rounded-2xl px-5 py-4 mb-6"
      style={{
        background: 'var(--brand-light)',
        border: '1px solid var(--brand-border)',
      }}
    >
      {/* Icon */}
      <div
        className="flex-shrink-0 w-10 h-10 rounded-xl flex items-center justify-center"
        style={{ background: 'var(--brand)' }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/>
          <line x1="21.17" y1="8" x2="12" y2="8"/><line x1="3.95" y1="6.06" x2="8.54" y2="14"/>
          <line x1="10.88" y1="21.94" x2="15.46" y2="14"/>
        </svg>
      </div>

      {/* Text */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold" style={{ color: 'var(--text-1)' }}>Get the Mealio extension</p>
        {mobile ? (
          <p className="text-xs mt-0.5" style={{ color: 'var(--text-2)' }}>
            Open Mealio on a desktop browser to install the extension and add meals to your cart in one click.
          </p>
        ) : (
          <p className="text-xs mt-0.5" style={{ color: 'var(--text-2)' }}>
            Add meals to your cart automatically at 36 supported stores.
          </p>
        )}
      </div>

      {/* CTA — desktop only */}
      {!mobile && (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex-shrink-0 text-sm font-semibold px-4 py-2 rounded-xl transition-colors"
          style={{ background: 'var(--brand)', color: '#fff', textDecoration: 'none' }}
          onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--brand-dark)'}
          onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'var(--brand)'}
        >
          {label}
        </a>
      )}

      {/* Dismiss */}
      <button
        onClick={() => setShow(false)}
        className="flex-shrink-0 transition-colors"
        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px', color: 'var(--text-3)', lineHeight: 1 }}
        aria-label="Dismiss"
        onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = 'var(--text-2)'}
        onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = 'var(--text-3)'}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>
  );
}
