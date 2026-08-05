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
  hasChannel: boolean;
  connected: boolean;
  channel: { id: string | null; title: string | null } | null;
  brokenReason: string | null;
  canWriteDescriptions: boolean;
  appendOptIn: boolean;
}

/**
 * What a failed attempt says, keyed by the callback's reason code.
 *
 * The card owns the sentences; the URL only picks between them. Same argument as
 * `PlatformConnectCard` — see `ConnectFailure` in `lib/creator-connect.ts`.
 */
const FAILURE_COPY: Record<string, string> = {
  expired: 'That connection attempt has expired. Start again from this page.',
  unverified: 'That connection could not be verified. Start again from this page.',
  'no-code': 'Google sent you back without an authorization code. Try connecting again.',
  exchange: 'Google would not complete that connection. Try connecting again.',
  account: 'We could not read a channel from that Google account. Make sure it has a YouTube channel, then try again.',
  store: 'We could not store that connection. Try again.',
  'consent-write':
    'Your channel is connected, but we could not save your choice about editing descriptions. It is off — set it ' +
    'from the card below.',
  'consent-withdraw':
    'We could not record that you no longer want Mealio editing your descriptions, so nothing was changed. Try again.',
};

/** What the OAuth callback redirected back with, if anything. */
function callbackOutcome(): { outcome: string; reason: string | null } | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const outcome = params.get('youtube');
  return outcome ? { outcome, reason: params.get('reason') } : null;
}

export interface YouTubeConnectCardProps {
  /**
   * Rendered inside the sync section rather than as a card of its own
   * (MEAL-101).
   *
   * Two things change and they are the same thing twice. The card chrome and the
   * "YouTube" eyebrow go, because the section already says which source this is
   * — a heading inside a heading reads as a second, nested decision. And the
   * `hasChannel` gate below is lifted: a creator who has just picked YouTube out
   * of a dropdown headed "Where do you publish?" has answered that question, so
   * hiding the connect button until a link exists would strand them on an empty
   * panel with no way forward.
   *
   * The consent tick is untouched in both modes, including its default of off
   * and the wording on the button. It is a permission over property that is not
   * ours, and nothing about where the control is drawn changes that.
   */
  embedded?: boolean;
  /**
   * Told whether a channel is connected, every time this card learns it.
   *
   * The sync section around it decides what to offer on that answer — the
   * catalogue checklist, and whether "sync from YouTube" is a thing the creator
   * can pick at all — and it must not guess: the grant lives in a different
   * table from the link, and a section that inferred one from the other would
   * offer a checklist for a channel nobody had connected.
   */
  onConnectionChange?: (connected: boolean) => void;
}

export default function YouTubeConnectCard({ embedded = false, onConnectionChange }: YouTubeConnectCardProps = {}) {
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
      if (!res.ok) return;
      const next: Status = await res.json();
      setStatus(next);
      // Seeded from the stored flag rather than from `false`. The tick on the
      // connect form is a *current* permission, and showing a granted one as
      // off both misreports it and quietly withdraws it on the next reconnect.
      setAppendConsent(next.appendOptIn === true);
      // A broken grant is not a connection as far as the section is concerned:
      // nothing can be listed through it, so offering a catalogue would be a
      // button that fails. The reconnect prompt is this card's to show, and it
      // is already showing it.
      onConnectionChange?.(next.connected && !next.brokenReason);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  /**
   * Start a consent round trip.
   *
   * `write` is passed explicitly by the caller that already knows the answer —
   * the append toggle, which sends the creator here the moment they ask for
   * description editing on a connection that only has read. Otherwise it
   * follows the tick on the connect form, which is the same question asked
   * before there is any connection at all.
   */
  const connect = async (options: { write?: boolean } = {}) => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/creator/youtube/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
        // The tick travels with the request that starts the round trip, so the
        // server stores what was on screen rather than trusting a later call.
        body: JSON.stringify({ appendOptIn: options.write ?? appendConsent }),
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
        // The connection has read access and nothing else, which is now the
        // ordinary case: the write scope is asked for when somebody ticks this
        // box rather than when they connect. So take them straight to Google
        // instead of reporting a refusal and making them find the button —
        // ticking the box *is* the request, and the consent screen is the rest
        // of it.
        if (data?.needsConsent) {
          setAppendConsent(true);
          await connect({ write: true });
          return;
        }
        setError(data.error || 'Could not save that.');
        return;
      }
      setStatus(prev => (prev ? { ...prev, appendOptIn: next } : prev));
      // Kept in step so a reconnect from a broken connection carries the choice
      // the creator has just made rather than the one they made last time.
      setAppendConsent(next);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/creator/youtube', { method: 'DELETE', headers: { Authorization: `Bearer ${token()}` } });
      // Never assumed. "Your channel is disconnected" is the last thing a
      // creator will check up on, so it is said only once the server says so.
      if (!res.ok) {
        setError((await res.json().catch(() => null))?.error || 'Could not disconnect that channel.');
        return;
      }
      await load();
    } catch {
      setError('Could not disconnect that channel.');
    } finally {
      setBusy(false);
    }
  };

  if (loading || !status) return null;

  /**
   * Nothing at all for a creator with no YouTube channel (MEAL-78).
   *
   * Hidden, not disabled. The append consent below is a permission over property
   * that is not ours, and a permission prompt about a channel that does not
   * exist is one a creator learns to click past — which is exactly what makes
   * the next one worthless. A creator who starts a channel later adds the link
   * in the editor above (MEAL-94) and this appears.
   *
   * The consent tick stays part of *connecting* rather than waiting for a
   * connection to exist: the Google screen asks for the write scope either way,
   * so a "Connect YouTube" button with no tick beside it would acquire
   * description-write access without ever naming it (MEAL-74).
   *
   * Not applied when embedded. There the creator has just picked YouTube from a
   * dropdown, which is the same statement the link was standing in for, made
   * more directly — and hiding the panel they navigated to would be a dead end
   * with nothing on it.
   */
  if (!status.hasChannel && !embedded) return null;

  /**
   * A grant row exists — healthy or broken. Broken still needs reconnecting,
   * but it is a connection: the consent attached to it is real, revocable, and
   * the channel can still be disconnected. Rendering a broken connection as if
   * nothing were connected showed a granted permission as off and offered no
   * way to withdraw it, which is the opposite of what a broken grant needs.
   */
  const hasConnection = status.connected;
  const needsConnect = !status.connected || Boolean(status.brokenReason);
  const consent = hasConnection ? status.appendOptIn : appendConsent;

  return (
    <div className={embedded ? '' : 'bg-white rounded-2xl shadow-sm border border-gray-100 p-6'}>
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          {!embedded && (
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-0.5">YouTube</p>
          )}
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
        <p className="text-sm text-red-600 mb-3">
          {(callback.reason && FAILURE_COPY[callback.reason]) || 'That connection did not complete.'}
        </p>
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

      <p className="text-sm text-gray-600 leading-relaxed mb-4">
        {needsConnect
          ? 'Connecting lets Mealio read your videos’ titles and descriptions — and their captions, which YouTube only shares with the channel owner — so a recipe can be imported from a video instead of typed out again.'
          : 'Mealio can read this channel’s videos to import recipes from them.'}
      </p>

      {/* One control, whichever state the card is in. On a connection that
          exists it writes through immediately, so consent can be withdrawn
          while the grant is broken; with nothing connected it is a local tick
          that travels with the request that starts the OAuth round trip. */}
      <label className="flex items-start gap-3 mb-4 cursor-pointer">
        {/* Never disabled for want of the write scope. A connection without it
            is now the ordinary state — it is asked for when somebody ticks this
            box rather than when they connect — so locking the box would lock
            away the only way to ask. The PATCH answers `needsConsent` and the
            tick becomes a consent trip. */}
        <input
          type="checkbox"
          checked={consent}
          disabled={busy}
          onChange={e => (hasConnection ? setAppendOptIn(e.target.checked) : setAppendConsent(e.target.checked))}
          className="mt-0.5 h-4 w-4 rounded border-gray-300 text-red-600 focus:ring-red-500 disabled:opacity-50"
        />
        <span className="text-sm text-gray-600 leading-relaxed">
          <span className="font-semibold text-gray-800">
            {needsConnect ? 'Also let' : 'Let'} Mealio add the Mealio link to a video&rsquo;s description
          </span>{' '}
          once a recipe from that video is live. Only for videos a Mealio recipe came from, and always shown to
          you first.{' '}
          {needsConnect
            ? 'You can switch this off at any time, and left unticked nothing on your channel is ever edited.'
            : 'Switching this off stops any future edits; links already added stay where they are.'}
        </span>
      </label>


      {needsConnect && (
        <>
          <button
            onClick={() => { void connect(); }}
            disabled={busy}
            className="w-full sm:w-auto bg-red-600 hover:bg-red-700 disabled:opacity-60 text-white text-sm font-semibold rounded-xl px-5 py-2.5 transition-colors"
          >
            {/* Plain when it is only asking to read. The write scope stays
                named, because a creator who has just ticked that box is about to
                grant description-editing on their own channel, and a button that
                said only "Connect YouTube" would be where that disappeared. */}
            {busy ? 'Opening Google…' : consent ? 'Connect YouTube — and edit descriptions' : 'Connect YouTube'}
          </button>
          <p className="text-[11px] text-gray-400 mt-2">
            Google will ask for permission to manage your YouTube account. We use it to read your videos, and — only
            if you ticked the box above — to add a link to a description.
          </p>
        </>
      )}

      {/* Offered whenever a grant exists, broken included. A creator who cannot
          reconnect must still be able to take the stored token away.

          Embedded, the sync section owns this: revoking the grant is only half
          of stopping, and the half that leaves the row pointing at a source with
          nothing behind it. The exception is a *broken* grant, which the section
          reads as "not connected" and so offers no button for — and that is
          precisely the creator who most needs one. */}
      {hasConnection && (!embedded || Boolean(status.brokenReason)) && (
        <button
          onClick={disconnect}
          disabled={busy}
          className={`text-xs font-semibold text-gray-500 hover:text-gray-800 border border-gray-200 rounded-lg px-3 py-1.5 hover:bg-gray-50 disabled:opacity-60 transition-colors${
            needsConnect ? ' mt-3 block' : ''
          }`}
        >
          Disconnect YouTube
        </button>
      )}

      {error && <p className="text-sm text-red-600 mt-3">{error}</p>}
    </div>
  );
}
