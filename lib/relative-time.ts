/**
 * "4 days ago", for screens whose real question is "is this stale?" (MEAL-96).
 *
 * An admin screen full of ISO timestamps answers a question nobody is asking.
 * The operator scanning poll health wants to know whether a source went quiet
 * this morning or in June, and nobody answers that by subtracting dates in their
 * head — so the age is the text and the exact instant goes in a `title`.
 *
 * Future instants are phrased forwards ("in 2 hours"), because the same screen
 * renders `poll_after`: the moment the next poll becomes allowed is normally
 * ahead of now, and "in 2 hours" is what makes the backoff legible where
 * "-2 hours ago" would just look broken.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/**
 * How long ago (or how far ahead) `at` is, in words, or null if it is not a
 * usable timestamp.
 *
 * Null rather than a placeholder so the caller decides what an absent moment
 * reads as: "never polled" and "no failures yet" are the same missing column and
 * very different sentences.
 */
export function relativeTime(at: string | null | undefined, now: number = Date.now()): string | null {
  const t = typeof at === 'string' && at ? Date.parse(at) : NaN;
  if (!Number.isFinite(t)) return null;

  const delta = now - t;
  const ahead = delta < 0;
  const ms = Math.abs(delta);

  if (ms < 45 * 1000) return ahead ? 'in a moment' : 'just now';

  let phrase: string;
  if (ms < 45 * MINUTE) phrase = plural(Math.round(ms / MINUTE), 'minute');
  // Handing over to days before the full 24 are up, because "1 day ago" is what
  // somebody scanning for staleness reads, and "24 hours ago" makes them divide.
  else if (ms < 22 * HOUR) phrase = plural(Math.round(ms / HOUR), 'hour');
  // Days are the unit this screen lives in — a source that has produced nothing
  // for 45 days should still say so in days, because "1 month" reads as rounder
  // and less alarming than the number an operator is deciding on.
  else if (ms < 90 * DAY) phrase = plural(Math.round(ms / DAY), 'day');
  else if (ms < 365 * DAY) phrase = plural(Math.round(ms / (30 * DAY)), 'month');
  else phrase = plural(Math.round(ms / (365 * DAY)), 'year');

  return ahead ? `in ${phrase}` : `${phrase} ago`;
}

/** Whole days between `at` and `now`, or null when there is no timestamp. */
export function daysSince(at: string | null | undefined, now: number = Date.now()): number | null {
  const t = typeof at === 'string' && at ? Date.parse(at) : NaN;
  if (!Number.isFinite(t)) return null;
  return Math.floor((now - t) / DAY);
}
