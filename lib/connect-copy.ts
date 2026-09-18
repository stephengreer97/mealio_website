import type { ConnectedPlatform } from '@/lib/creator-sources';

/**
 * What a creator reads when connecting a publishing account ends in anything but
 * success, keyed by the `ConnectFailure` reason code (`lib/creator-connect.ts`).
 *
 * One copy, read by three places that must say the same thing: the website's
 * `PlatformConnectCard` and `YouTubeConnectCard`, which pick a sentence from the
 * `?reason=` the callback redirected with, and `POST /api/creator/<platform>/complete`,
 * which hands the sentence to the mobile app beside the same code. Before the app
 * flow these lived in the two cards; a second copy on the server would have
 * drifted the first time either was reworded.
 *
 * Client-safe on purpose: it imports nothing but a type, so the cards can pull it
 * into the browser bundle.
 *
 * The code picks the sentence; nothing here is ever taken from a URL. See
 * `ConnectFailure` for why that matters.
 */

const LABELS: Record<ConnectedPlatform, string> = {
  youtube: 'YouTube',
  instagram: 'Instagram',
  tiktok: 'TikTok',
};

/** Instagram and TikTok. */
const SOCIAL_FAILURE_COPY: Record<string, (label: string) => string> = {
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
   * now a real refusal (a personal account TikTok will not grant, a revoked
   * grant, a genuine cancel) and sending those creators to ask for an
   * allow-list they are not on buries the real cause under a support thread.
   *
   * So it names what we can actually know from a redirect, which is only that
   * the platform declined, and gives the two things that are worth trying.
   * Deliberately does not assert a cause.
   */
  unavailable: (label) =>
    `${label} would not connect that account. That usually means ${label} declined it rather than you ` +
    `cancelling: a personal account it will not grant access to, or a permission that was turned down. ` +
    `Try again, and if it keeps happening tell us which account and we will look at what ${label} sent back.`,
  scope: () =>
    'That connection came back without permission to read your posts, so there would be nothing to import. ' +
    'Connect again and leave the permission ticked.',
  account: (label) =>
    `We could not use that ${label} account. If it is a personal Instagram account, switch it to Professional ` +
    '(Business or Creator) in the Instagram app and try again.',
  store: () => 'We could not store that connection. Try again.',
};

/** YouTube names Google, whose screen the creator was actually on. */
const YOUTUBE_FAILURE_COPY: Record<string, string> = {
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

/** What an unknown or absent code falls through to. */
export const GENERIC_CONNECT_FAILURE = 'That connection did not complete.';

/**
 * The sentence for a failed attempt, or null when the code is not one we wrote
 * copy for (the caller falls back to `GENERIC_CONNECT_FAILURE`).
 */
export function connectFailureCopy(platform: ConnectedPlatform, reason: string | null | undefined): string | null {
  if (!reason) return null;
  if (platform === 'youtube') {
    return Object.prototype.hasOwnProperty.call(YOUTUBE_FAILURE_COPY, reason) ? YOUTUBE_FAILURE_COPY[reason] : null;
  }
  return Object.prototype.hasOwnProperty.call(SOCIAL_FAILURE_COPY, reason)
    ? SOCIAL_FAILURE_COPY[reason](LABELS[platform])
    : null;
}

/** The creator declined on the provider's own screen. */
export function connectCancelledCopy(platform: ConnectedPlatform): string {
  const where = platform === 'youtube' ? 'Google' : LABELS[platform];
  return `You cancelled on ${where}’s screen. Nothing was connected.`;
}
