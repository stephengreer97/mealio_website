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
  /** False when this deployment has no app credentials for the platform. */
  configured?: boolean;
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
    button: 'Connect Instagram',
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
    button: 'Connect TikTok',
    connectedNote:
      'Mealio reads the descriptions on this account to import recipes from them. Nothing on your account is ' +
      'ever edited.',
    buttonClass: 'bg-gray-900 hover:bg-black focus:ring-gray-700',
    cancelled: 'You cancelled on TikTok’s screen. Nothing was connected.',
    showExpiry: false,
  },
};

/**
 * What a failed attempt says, keyed by the callback's reason code.
 *
 * The card owns every one of these sentences and the URL only picks between
 * them. See `ConnectFailure` in `lib/creator-connect.ts`: the callback used to
 * put the sentence itself in the query string, which meant anyone who could get
 * a creator to open a link chose the prose rendered inside our error styling on
 * our own domain. An unknown or absent code falls through to the generic line,
 * so a hand-written URL is at worst a wrong answer and never an attacker's.
 */
const FAILURE_COPY: Record<string, (label: string) => string> = {
  expired: () => 'That connection attempt has expired. Start again from this page.',
  unverified: () => 'That connection could not be verified. Start again from this page.',
  'no-code': (label) => `${label} sent you back without an authorization code. Try connecting again.`,
  exchange: (label) => `${label} would not complete that connection. Try connecting again.`,
  /**
   * The platform refused the account, rather than the creator declining
   * (MEAL-101).
   *
   * The callback used to read *any* `error` on the redirect as "cancelled",
   * which is the worst kind of wrong: it blames a creator for something they
   * did not do and gives them nothing to do next.
   *
   * This wording changed when TikTok approved the app (2026-08-06). While the
   * credentials were sandbox ones, a refusal was overwhelmingly the tester
   * allow-list, and the copy said so and told the creator to ask us to add
   * them. On production credentials that advice is actively wrong: a refusal is
   * now a real refusal — a personal account TikTok will not grant, a revoked
   * grant, a genuine cancel — and sending those creators to ask for an
   * allow-list they are not on buries the real cause under a support thread.
   *
   * So it names what we can actually know from a redirect, which is only that
   * the platform declined, and gives the two things that are worth trying.
   * Deliberately does not assert a cause.
   */
  unavailable: (label) =>
    `${label} would not connect that account. That usually means ${label} declined it rather than you ` +
    `cancelling — a personal account it will not grant access to, or a permission that was turned down. ` +
    `Try again, and if it keeps happening tell us which account and we will look at what ${label} sent back.`,
  scope: () =>
    'That connection came back without permission to read your posts, so there would be nothing to import. ' +
    'Connect again and leave the permission ticked.',
  account: (label) =>
    `We could not use that ${label} account. If it is a personal Instagram account, switch it to Professional ` +
    '(Business or Creator) in the Instagram app and try again.',
  store: () => 'We could not store that connection. Try again.',
};

/** What the OAuth callback redirected back with, if anything. */
function callbackOutcome(platform: SocialPlatform): { outcome: string; reason: string | null } | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const outcome = params.get(platform);
  return outcome ? { outcome, reason: params.get('reason') } : null;
}

function formatExpiry(iso: string | null): string | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

export interface PlatformConnectCardProps {
  platform: SocialPlatform;
  /**
   * Rendered inside the sync section rather than as a card of its own
   * (MEAL-101). Drops the card chrome and the platform eyebrow, which the
   * section's own dropdown has already said.
   */
  embedded?: boolean;
  /** Told whether an account is connected, every time this card learns it. */
  onConnectionChange?: (connected: boolean) => void;
  /** Shown above the button — what to expect from pressing it. */
  note?: string | null;
}

export default function PlatformConnectCard({
  platform,
  embedded = false,
  onConnectionChange,
  note,
}: PlatformConnectCardProps) {
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
      if (!res.ok) return;
      const next: Status = await res.json();
      setStatus(next);
      // A broken grant is not a connection as far as the section is concerned:
      // nothing can be listed through it, so offering a catalogue would be a
      // button that fails. The reconnect prompt is this card's to show.
      onConnectionChange?.(next.connected && !next.brokenReason);
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
      const res = await fetch(endpoint, { method: 'DELETE', headers: { Authorization: `Bearer ${token()}` } });
      // Never assumed. "Your account is disconnected" is the last thing a
      // creator will go back and check, so a failed delete has to say so here
      // rather than leave the grant live behind a card that reads as revoked.
      if (!res.ok) {
        setError((await res.json().catch(() => null))?.error || `Could not disconnect that ${copy.label} account.`);
        return;
      }
      await load();
    } catch {
      setError(`Could not disconnect that ${copy.label} account.`);
    } finally {
      setBusy(false);
    }
  };

  if (loading || !status) return null;

  const expiry = copy.showExpiry ? formatExpiry(status.expiresAt) : null;

  const unconfigured = status.configured === false;

  return (
    <div className={embedded ? '' : 'bg-white rounded-2xl shadow-sm border border-gray-100 p-6'}>
      {/* Nothing above the button until there is something only a heading could
          say. Embedded, "Connect your account" over a button that says Connect
          is the same sentence twice; once connected the account's own name is
          the thing a creator came to check. */}
      {(status.connected || !embedded) && (
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="min-w-0">
            {!embedded && (
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-0.5">{copy.label}</p>
            )}
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
      )}

      {callback?.outcome === 'failed' && (
        <p className="text-sm text-red-600 mb-3">
          {(callback.reason && FAILURE_COPY[callback.reason]?.(copy.label)) || 'That connection did not complete.'}
        </p>
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
          {/* The pitch belongs to the standalone card. Inside the sync section
              the promise is already made once, at the top, and repeating it per
              platform is the same paragraph a third time. */}
          {!embedded && <p className="text-sm text-gray-600 leading-relaxed mb-4">{copy.pitch}</p>}

          {/* What to expect from the press, said before it. Only rendered when a
              platform supplies a `note`; none do today — TikTok's sandbox note
              was dropped when the app was approved (2026-08-06). Kept because a
              platform-specific caveat before the press is the right shape for
              one, and Instagram will need it if it ships gated. */}
          {note && !unconfigured && (
            <p className="text-sm text-amber-800 bg-amber-50 border border-amber-100 rounded-xl px-3 py-2.5 mb-4 leading-relaxed" data-testid={`note-${platform}`}>
              {note}
            </p>
          )}

          {/* No credentials on this deployment at all. Said instead of the
              button rather than beside it: `tiktokAuthUrl` returns null without
              a client key, so the press could only ever produce a 500. */}
          {unconfigured ? (
            <p className="text-sm text-amber-800 bg-amber-50 border border-amber-100 rounded-xl px-3 py-2.5 leading-relaxed" data-testid={`unconfigured-${platform}`}>
              {copy.label} syncing is not switched on here yet. Nothing is wrong with your account — get in touch
              and we will tell you when it is ready.
            </p>
          ) : (
            <button
              onClick={connect}
              disabled={busy}
              className={`w-full sm:w-auto ${copy.buttonClass} disabled:opacity-60 text-white text-sm font-semibold rounded-xl px-5 py-2.5 transition-colors`}
            >
              {busy ? `Opening ${copy.label}…` : copy.button}
            </button>
          )}
          {!unconfigured && (
            <p className="text-[11px] text-gray-400 mt-2">
              We only ask for permission to read your own posts. Nothing is posted, edited or deleted on your
              account, and you can disconnect at any time.
            </p>
          )}
        </>
      ) : (
        <>
          {/* The connected note belongs to the standalone card. Inside the
              sync section the promise at the top has already said what Mealio
              does with a connected account, and saying it again under the
              account name reads as a disclaimer rather than an explanation. */}
          {!embedded && <p className="text-sm text-gray-600 leading-relaxed mb-4">{copy.connectedNote}</p>}

          {/* Instagram's grant genuinely expires. It renews itself, but showing
              the date means a creator can notice if it ever stops moving —
              rather than finding out when their imports quietly stop. */}
          {expiry && (
            <p className="text-xs text-gray-500 mb-4">
              This connection renews itself automatically, and lasts until {expiry} if it does not.
            </p>
          )}

          {/* Embedded, the sync section owns disconnection: revoking the grant
              is only half of stopping, and the half that leaves the row pointing
              at a source with nothing behind it. Two buttons that both say
              "Disconnect" and do different amounts of it is worse than one. */}
          {!embedded && (
            <button
              onClick={disconnect}
              disabled={busy}
              className="text-xs font-semibold text-gray-500 hover:text-gray-800 border border-gray-200 rounded-lg px-3 py-1.5 hover:bg-gray-50 disabled:opacity-60 transition-colors"
            >
              Disconnect {copy.label}
            </button>
          )}
        </>
      )}

      {error && <p className="text-sm text-red-600 mt-3">{error}</p>}
    </div>
  );
}
