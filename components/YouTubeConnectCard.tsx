'use client';

import { useEffect, useState } from 'react';

/**
 * Connect a YouTube channel, from the creator portal (MEAL-74).
 *
 * Two decisions on one card, and they are deliberately not the same decision.
 * Connecting lets Mealio **read** the channel — titles, descriptions and, for a
 * video whose description is thin, captions. The tickbox beside it is consent to
 * **write**: to add the Mealio link to a video's description once a recipe from
 * it is live. MEAL-77 forbids conflating those, so the box is separate, off by
 * default, and switchable in one click afterwards.
 *
 * Both are named on the button itself. The consent screen asks for the write
 * scope either way — asking for it later would re-prompt every creator who had
 * already connected — and a "Connect YouTube" button that quietly acquires
 * description-write access is the sort of thing that reads as a bait-and-switch
 * when a creator notices later.
 */

interface Status {
  connected: boolean;
  channel: { id: string | null; title: string | null } | null;
  brokenReason: string | null;
  canWriteDescriptions: boolean;
  appendOptIn: boolean;
}

/** What the OAuth callback redirected back with, if anything. */
function callbackOutcome(): { outcome: string; detail: string | null } | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const outcome = params.get('youtube');
  return outcome ? { outcome, detail: params.get('detail') } : null;
}

export default function YouTubeConnectCard() {
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [appendConsent, setAppendConsent] = useState(false);
  const [callback] = useState(callbackOutcome);

  const token = () => (typeof window === 'undefined' ? '' : localStorage.getItem('accessToken') ?? '');

  const load = async () => {
    try {
      const res = await fetch('/api/creator/youtube', { headers: { Authorization: `Bearer ${token()}` } });
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
      const res = await fetch('/api/creator/youtube/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
        // The tick travels with the request that starts the round trip, so the
        // server stores what was on screen rather than trusting a later call.
        body: JSON.stringify({ appendOptIn: appendConsent }),
      });
      const data = await res.json();
      if (!res.ok || !data.url) {
        setError(data.error || 'Could not start the YouTube connection.');
        return;
      }
      window.location.href = data.url;
    } catch {
      setError('Could not start the YouTube connection.');
    } finally {
      setBusy(false);
    }
  };

  const setAppendOptIn = async (next: boolean) => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/creator/youtube', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
        body: JSON.stringify({ appendOptIn: next }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Could not save that.');
        return;
      }
      setStatus(prev => (prev ? { ...prev, appendOptIn: next } : prev));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    setError('');
    try {
      await fetch('/api/creator/youtube', { method: 'DELETE', headers: { Authorization: `Bearer ${token()}` } });
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (loading || !status) return null;

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-0.5">YouTube</p>
          <h2 className="text-base font-bold text-gray-900 leading-tight">
            {status.connected ? status.channel?.title || 'Connected channel' : 'Connect your channel'}
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
      {callback?.outcome === 'cancelled' && (
        <p className="text-sm text-gray-500 mb-3">You cancelled on Google&rsquo;s screen. Nothing was connected.</p>
      )}

      {/* A grant that has stopped working is the failure this whole feature is
          written around: it looks exactly like a channel that published nothing.
          So it is stated here, to the one person who can fix it. */}
      {status.brokenReason && (
        <p className="text-sm text-red-600 mb-3">
          Your YouTube connection stopped working: {status.brokenReason} Reconnect to carry on importing.
        </p>
      )}

      {!status.connected || status.brokenReason ? (
        <>
          <p className="text-sm text-gray-600 leading-relaxed mb-4">
            Connecting lets Mealio read your videos&rsquo; titles and descriptions — and their captions, which
            YouTube only shares with the channel owner — so a recipe can be imported from a video instead of
            typed out again.
          </p>

          <label className="flex items-start gap-3 mb-4 cursor-pointer">
            <input
              type="checkbox"
              checked={appendConsent}
              onChange={e => setAppendConsent(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-gray-300 text-red-600 focus:ring-red-500"
            />
            <span className="text-sm text-gray-600 leading-relaxed">
              <span className="font-semibold text-gray-800">Also let Mealio add the Mealio link to a video&rsquo;s description</span>{' '}
              once a recipe from that video is live. Only for videos a Mealio recipe came from, always shown to you
              first, and you can switch this off at any time. Leave it unticked and nothing on your channel is
              ever edited.
            </span>
          </label>

          <button
            onClick={connect}
            disabled={busy}
            className="w-full sm:w-auto bg-red-600 hover:bg-red-700 disabled:opacity-60 text-white text-sm font-semibold rounded-xl px-5 py-2.5 transition-colors"
          >
            {busy ? 'Opening Google…' : 'Connect YouTube — read my videos' + (appendConsent ? ' and edit their descriptions' : '')}
          </button>
          <p className="text-[11px] text-gray-400 mt-2">
            Google will ask for permission to manage your YouTube account. We use it to read your videos, and — only
            if you ticked the box above — to add a link to a description.
          </p>
        </>
      ) : (
        <>
          <p className="text-sm text-gray-600 leading-relaxed mb-4">
            Mealio can read this channel&rsquo;s videos to import recipes from them.
          </p>

          <label className="flex items-start gap-3 mb-4 cursor-pointer">
            <input
              type="checkbox"
              checked={status.appendOptIn}
              disabled={busy || !status.canWriteDescriptions}
              onChange={e => setAppendOptIn(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-gray-300 text-red-600 focus:ring-red-500 disabled:opacity-50"
            />
            <span className="text-sm text-gray-600 leading-relaxed">
              <span className="font-semibold text-gray-800">Let Mealio add the Mealio link to a video&rsquo;s description</span>{' '}
              when a recipe from that video goes live. Switching this off stops any future edits; links already
              added stay where they are.
            </span>
          </label>

          {!status.canWriteDescriptions && (
            <p className="text-xs text-gray-500 mb-4">
              This connection was made without permission to edit descriptions. Reconnect YouTube if you want to
              allow it.
            </p>
          )}

          <button
            onClick={disconnect}
            disabled={busy}
            className="text-xs font-semibold text-gray-500 hover:text-gray-800 border border-gray-200 rounded-lg px-3 py-1.5 hover:bg-gray-50 disabled:opacity-60 transition-colors"
          >
            Disconnect YouTube
          </button>
        </>
      )}

      {error && <p className="text-sm text-red-600 mt-3">{error}</p>}
    </div>
  );
}
