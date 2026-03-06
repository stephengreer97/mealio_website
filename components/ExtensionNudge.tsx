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
  const [show, setShow] = useState(false);
  const [url, setUrl]   = useState(CHROME_URL);
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
    <div className="flex items-center gap-4 rounded-xl px-5 py-4 mb-6"
      style={{ background: 'var(--wk-surface)', border: '1px solid var(--wk-border)' }}>
      {/* Icon */}
      <div className="flex-shrink-0 w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: 'var(--wk-red)' }}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2H2l10 10V2z"/><path d="M12 2h10L12 12V2z"/>
          <circle cx="12" cy="17" r="5"/>
        </svg>
      </div>

      {/* Text */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-wk-text">Get the Mealio extension</p>
        {mobile ? (
          <p className="text-xs text-wk-text2 mt-0.5">Open Mealio on a desktop browser to install the extension and add meals to your cart in one click.</p>
        ) : (
          <p className="text-xs text-wk-text2 mt-0.5">Add meals to your cart automatically at 36 supported stores.</p>
        )}
      </div>

      {/* CTA — desktop only */}
      {!mobile && (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex-shrink-0 text-sm font-semibold px-4 py-2 rounded-lg"
          style={{ background: 'var(--wk-red)', color: '#fff', textDecoration: 'none' }}
        >
          {label}
        </a>
      )}

      {/* Dismiss */}
      <button
        onClick={() => setShow(false)}
        className="flex-shrink-0 text-wk-text3 hover:text-wk-text2"
        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: '18px', lineHeight: 1 }}
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}
