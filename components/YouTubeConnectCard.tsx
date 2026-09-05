'use client';

import { useEffect, useState } from 'react';

/**
 * Connect a YouTube channel, from the creator portal (MEAL-74).
 *
 * Three decisions on one card, and they are deliberately not the same decision.
 *
 *   1. **Connecting** lets Mealio read the channel — the video list, titles and
 *      descriptions.
 *   2. **Reading captions**, for a video whose description is too short to read a
 *      recipe from. Its own control, because Google will not sell it on its own
 *      and it needs `youtube.force-ssl` (MEAL-138).
 *   3. **Editing descriptions** — adding the Mealio link to a video once a recipe
 *      from it is live. MEAL-77 forbids conflating this with reading, so it is
 *      separate, off by default, and switchable in one click.
 *
 * 2 and 3 are the *same Google scope* and not the same question, and this card is
 * where that stops being a trap. Until MEAL-138 there was one tick — description
 * editing — and it was the only thing that ever asked for `force-ssl`, so a
 * creator who declined it got a read-only grant and every thin-description video
 * on their channel silently failed to import. Ticking a box about editing
 * somebody's descriptions must not be the price of reading their subtitles.
 *
 * What the copy has to be honest about, and is: granting captions shows the
 * creator Google's own sentence, which mentions editing. Mealio still edits
 * nothing — `youtube_append_opt_in` gates every write server-side, and the
 * captions trip carries no answer to that question in either direction, so it
 * cannot set it (see `connect`, and the consent decision in the callback). The card
 * says so at the moment the creator is deciding, and that is only true because
 * the request omits the field: sending the stored `true` made this button the one
 * act that armed the append.
 *
 * The trip that *does* ask about editing is the append tick itself, which sends
 * `write: true` and says so on the button.
 */

interface Status {
  hasChannel: boolean;
  connected: boolean;
  channel: { id: string | null; title: string | null } | null;
  brokenReason: string | null;
  canWriteDescriptions: boolean;
  /** The grant carries `force-ssl`, so a thin-description video can be read from its captions. */
  canReadCaptions: boolean;
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
    'Your channel is connected, but we could not save your choice about editing descriptions. It is off. Set it ' +
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
   *
   * `captions` is the second reason to ask for the same scope (MEAL-138), sent on
   * its own so the server logs which question produced the consent screen. It
   * carries **no answer at all** about description editing: the field is omitted,
   * not set to the stored value and not set to `false`.
   *
   * Both of the other two were wrong, in opposite directions. `false` withdrew a
   * consent the creator had really given, without telling them. The stored value
   * re-asserted it — and since this trip is what grants `force-ssl`, a creator who
   * had ticked the box on the connect form and then unticked the scope on Google's
   * own screen would have a button labelled "read my captions" turn description
   * editing from impossible into live. Omitted, the callback touches the flag on
   * neither side, and the small print in the amber panel below is true.
   */
  const connect = async (options: { write?: boolean; captions?: boolean } = {}) => {
    setBusy(true);
    setError('');
    // The tick travels with the request that starts the round trip, so the
    // server stores what was on screen rather than trusting a later call — but
    // only when this trip is the one asking. A captions trip asks nothing about
    // editing and so answers nothing.
    const payload: { appendOptIn?: boolean; captions?: true } = {};
    if (options.captions) payload.captions = true;
    if (options.write !== undefined) payload.appendOptIn = options.write;
    else if (!options.captions) payload.appendOptIn = appendConsent;
    try {
      const res = await fetch('/api/creator/youtube/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
        body: JSON.stringify(payload),
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
   * connection to exist, but the reason is no longer the one written here until
   * this ticket. Since `8aec421` the Google screen asks for the write scope only
   * when a tick asks for it, so a plain "Connect YouTube" acquires nothing but
   * read — the tick is offered up front because it is the same question, asked
   * once, before there is a connection to ask it about, and because a creator who
   * wants the link added should not have to connect and then come back for it.
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

      {/* This paragraph used to promise captions on a plain connection, which
          stopped being true when the scope that reads them became incremental
          (MEAL-138): a creator read that sentence, connected, and got a grant
          that cannot read a single caption. Captions have their own control
          below, so this says only what connecting actually does. */}
      <p className="text-sm text-gray-600 leading-relaxed mb-4">
        {needsConnect
          ? 'Connecting lets Mealio read your videos’ titles and descriptions, so a recipe can be imported from a video instead of typed out again.'
          : 'Mealio can read this channel’s videos to import recipes from them.'}
      </p>

      {/* ── Captions (MEAL-138) ───────────────────────────────────────────────
          The consequence of not having this is otherwise invisible: a video whose
          description is under about 250 characters simply never becomes a recipe,
          and every screen that could have said why said "no recipe found". So it
          is stated here, to the one person who can fix it, with the button that
          fixes it. */}
      {hasConnection && !status.canReadCaptions && (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-3">
          <p className="text-sm text-amber-900 leading-relaxed">
            <span className="font-semibold">Mealio cannot read this channel’s captions.</span> Any video where
            the recipe is spoken rather than written out in the description gets skipped. There is nothing for
            us to read. YouTube shares captions only with the channel owner, and only through a permission this
            connection was not given.
          </p>
          <button
            onClick={() => { void connect({ captions: true }); }}
            disabled={busy}
            className="mt-3 bg-amber-600 hover:bg-amber-700 disabled:opacity-60 text-white text-sm font-semibold rounded-xl px-4 py-2 transition-colors"
          >
            {busy ? 'Opening Google…' : 'Let Mealio read my captions'}
          </button>
          {/* Google's screen says "See, edit, and permanently delete…" because
              this is the only scope it sells captions through. A creator meeting
              that sentence having been told we want to read subtitles deserves
              to have been warned, and to be told what still governs the edit. */}
          <p className="text-[11px] text-amber-800/80 mt-2 leading-relaxed">
            Google has no permission for captions alone, so its screen will mention editing your videos. Mealio
            still edits nothing unless you tick the box below. That is a separate setting, off unless you turn
            it on, and this does not turn it on.
          </p>
        </div>
      )}
      {hasConnection && status.canReadCaptions && (
        <p className="text-sm text-gray-600 leading-relaxed mb-4">
          Mealio can also read this channel’s captions, so a video whose description is too short still gets its
          recipe read from what you say in it.
        </p>
      )}

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
            {busy ? 'Opening Google…' : consent ? 'Connect YouTube and edit descriptions' : 'Connect YouTube'}
          </button>
          {/* Says which screen the creator is about to meet, and it differs by
              the tick: unticked, Google asks only to view the account
              (`youtube.readonly`), and the wider sentence about managing it
              appears only when the box above has asked for the write scope.
              Promising the wider one either way overstates what a plain connect
              takes — which is the mistake this ticket was auditing for. */}
          <p className="text-[11px] text-gray-400 mt-2">
            {consent
              ? 'Google will ask for permission to see, edit and delete your YouTube videos. That one permission is the ' +
                'only way it lets us add a link to a description. We use it to read your videos and to add that link, ' +
                'nothing else.'
              : 'Google will ask for permission to view your YouTube account. We use it to read your videos’ titles and ' +
                'descriptions.'}
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
