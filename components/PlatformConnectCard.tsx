'use client';

import { useEffect, useState } from 'react';

/**
 * Connect an Instagram or TikTok account, from the creator portal
 * (MEAL-82 / MEAL-83).
 *
 * One card for both because the decision is genuinely the same one: connecting
 * lets Mealio **read** what the creator posted, and there is nothing else to
 * agree to. Neither platform exposes a way to edit the text of a post made in
 * the app, so neither has YouTube's second consent — which is why
 * `YouTubeConnectCard` stays its own component rather than being folded in here.
 *
 * What the two cards do have to say differently is the honest limit of each, and
 * a creator deserves to read that before connecting rather than after their
 * first empty import:
 *
 *   - Instagram reads the **caption**. A Reel whose recipe is only spoken aloud
 *     gives us almost nothing.
 *   - TikTok reads the **description**, and that is the end of it — TikTok's API
 *     hands over no video and no transcript, so there is no future version of
 *     this that does better.
 *
 * The expiry is shown for Instagram because it is real and it is short: sixty
 * days, renewed automatically, and a creator who can see the date can ask about
 * it if it ever stops moving.
 */

type SocialPlatform = 'instagram' | 'tiktok';

interface Status {
  connected: boolean;
  account: { id: string | null; name: string | null } | null;
  brokenReason: string | null;
  expiresAt: string | null;
}

interface CardCopy {
  label: string;
  /** What connecting gets us, and what it does not. */
  pitch: string;
  button: string;
  /** Shown once connected — the ceiling, restated where it still matters. */
  connectedNote: string;
  /** Tailwind classes for the platform's own colour on the action button. */
  buttonClass: string;
  cancelled: string;
  showExpiry: boolean;
}

const COPY: Record<SocialPlatform, CardCopy> = {
  instagram: {
    label: 'Instagram',
    pitch:
      'Connecting lets Mealio read the captions on your posts and Reels, so a recipe you have already written ' +
      'out can be imported instead of typed again. We cannot read what is only spoken in a video — if your ' +
      'recipe lives in the voiceover rather than the caption, this will find very little. Instagram also ' +
      'requires a Professional (Business or Creator) account; personal accounts get no access at all.',
    button: 'Connect Instagram — read my captions',
    connectedNote:
      'Mealio reads the captions on this account to import recipes from them. Nothing on your account is ever ' +
      'edited.',
    buttonClass: 'bg-pink-600 hover:bg-pink-700 focus:ring-pink-500',
    cancelled: 'You cancelled on Instagram’s screen. Nothing was connected.',
    showExpiry: true,
  },
  tiktok: {
    label: 'TikTok',
    pitch:
      'Connecting lets Mealio read the descriptions on your videos, so a recipe you have written out there can ' +
      'be imported instead of typed again. TikTok gives apps the description and nothing else — no video file ' +
      'and no transcript — so if your recipes are spoken rather than written, there is nothing here for us to ' +
      'read, and that is a limit of TikTok rather than something we can improve.',
    button: 'Connect TikTok — read my descriptions',
    connectedNote:
      'Mealio reads the descriptions on this account to import recipes from them. Nothing on your account is ' +
      'ever edited.',
    buttonClass: 'bg-gray-900 hover:bg-black focus:ring-gray-700',
    cancelled: 'You cancelled on TikTok’s screen. Nothing was connected.',
    showExpiry: false,
  },
};

/** What the OAuth callback redirected back with, if anything. */
function callbackOutcome(platform: SocialPlatform): { outcome: string; detail: string | null } | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const outcome = params.get(platform);
  return outcome ? { outcome, detail: params.get('detail') } : null;
}

function formatExpiry(iso: string | null): string | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

export default function PlatformConnectCard({ platform }: { platform: SocialPlatform }) {
  const copy = COPY[platform];
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [callback] = useState(() => callbackOutcome(platform));

  const token = () => (typeof window === 'undefined' ? '' : localStorage.getItem('accessToken') ?? '');
  const endpoint = `/api/creator/${platform}`;

  const load = async () => {
    try {
      const res = await fetch(endpoint, { headers: { Authorization: `Bearer ${token()}` } });
      if (res.ok) setStatus(await res.json());
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const connect = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`${endpoint}/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
      });
      const data = await res.json();
      if (!res.ok || !data.url) {
        setError(data.error || `Could not start the ${copy.label} connection.`);
        return;
      }
      window.location.href = data.url;
    } catch {
      setError(`Could not start the ${copy.label} connection.`);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    setError('');
    try {
      await fetch(endpoint, { method: 'DELETE', headers: { Authorization: `Bearer ${token()}` } });
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (loading || !status) return null;

  const expiry = copy.showExpiry ? formatExpiry(status.expiresAt) : null;

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-0.5">{copy.label}</p>
          <h2 className="text-base font-bold text-gray-900 leading-tight">
            {status.connected
              ? status.account?.name
                ? `@${status.account.name}`
                : 'Connected account'
              : 'Connect your account'}
          </h2>
        </div>
        {status.connected && !status.brokenReason && (
          <span className="flex-shrink-0 text-[11px] font-semibold text-green-700 bg-green-50 border border-green-100 rounded-md px-2 py-0.5">
            Connected
          </span>
        )}
      </div>

      {callback?.outcome === 'failed' && (
        <p className="text-sm text-red-600 mb-3">{callback.detail || 'That connection did not complete.'}</p>
      )}
      {callback?.outcome === 'cancelled' && <p className="text-sm text-gray-500 mb-3">{copy.cancelled}</p>}

      {/* A grant that has stopped working is the failure this whole feature is
          written around: it looks exactly like an account that posted nothing.
          So it is stated here, to the one person who can fix it. */}
      {status.brokenReason && (
        <p className="text-sm text-red-600 mb-3">
          Your {copy.label} connection stopped working: {status.brokenReason} Reconnect to carry on importing.
        </p>
      )}

      {!status.connected || status.brokenReason ? (
        <>
          <p className="text-sm text-gray-600 leading-relaxed mb-4">{copy.pitch}</p>
          <button
            onClick={connect}
            disabled={busy}
            className={`w-full sm:w-auto ${copy.buttonClass} disabled:opacity-60 text-white text-sm font-semibold rounded-xl px-5 py-2.5 transition-colors`}
          >
            {busy ? `Opening ${copy.label}…` : copy.button}
          </button>
          <p className="text-[11px] text-gray-400 mt-2">
            We only ask for permission to read your own posts. Nothing is posted, edited or deleted on your
            account, and you can disconnect at any time.
          </p>
        </>
      ) : (
        <>
          <p className="text-sm text-gray-600 leading-relaxed mb-4">{copy.connectedNote}</p>

          {/* Instagram's grant genuinely expires. It renews itself, but showing
              the date means a creator can notice if it ever stops moving —
              rather than finding out when their imports quietly stop. */}
          {expiry && (
            <p className="text-xs text-gray-500 mb-4">
              This connection renews itself automatically, and lasts until {expiry} if it does not.
            </p>
          )}

          <button
            onClick={disconnect}
            disabled={busy}
            className="text-xs font-semibold text-gray-500 hover:text-gray-800 border border-gray-200 rounded-lg px-3 py-1.5 hover:bg-gray-50 disabled:opacity-60 transition-colors"
          >
            Disconnect {copy.label}
          </button>
        </>
      )}

      {error && <p className="text-sm text-red-600 mt-3">{error}</p>}
    </div>
  );
}
