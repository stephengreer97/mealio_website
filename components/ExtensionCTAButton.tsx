'use client';

import { useEffect, useState } from 'react';

const CHROME_URL  = 'https://chromewebstore.google.com/detail/mealio/eccnnnhkdpigfgbmnnmhppmligjhfpne';
const FIREFOX_URL = 'https://addons.mozilla.org/en-US/firefox/addon/mealio/';
const EDGE_URL    = CHROME_URL;

type Browser = 'chrome' | 'firefox' | 'edge';

function detectBrowser(): Browser {
  if (typeof navigator === 'undefined') return 'chrome';
  const ua = navigator.userAgent;
  if (ua.includes('Firefox/')) return 'firefox';
  if (ua.includes('Edg/'))    return 'edge';
  return 'chrome';
}

const CONFIG: Record<Browser, { label: string; url: string; sub: string }> = {
  chrome:  { label: 'Add to Chrome',  url: CHROME_URL,  sub: 'Chrome Web Store' },
  firefox: { label: 'Add to Firefox', url: FIREFOX_URL, sub: 'Firefox Add-ons'  },
  edge:    { label: 'Add to Edge',    url: EDGE_URL,    sub: 'Edge Add-ons'     },
};

export default function ExtensionCTAButton() {
  const [browser, setBrowser] = useState<Browser>('chrome');

  useEffect(() => {
    setBrowser(detectBrowser());
  }, []);

  const { label, url, sub } = CONFIG[browser];

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        display: 'inline-flex', flexDirection: 'column', alignItems: 'center',
        background: '#dd0031', color: 'white', padding: '10px 22px',
        borderRadius: '8px', textDecoration: 'none', flexShrink: 0,
      }}
    >
      <span style={{ fontWeight: 700, fontSize: '14px' }}>{label}</span>
      <span style={{ fontSize: '11px', opacity: 0.8, marginTop: '1px' }}>{sub}</span>
    </a>
  );
}
