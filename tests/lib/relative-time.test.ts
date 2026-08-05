import { describe, it, expect } from 'vitest';
import { daysSince, relativeTime } from '@/lib/relative-time';

/**
 * The screens this exists for ask "is this stale?", and an ISO timestamp does
 * not answer that without arithmetic nobody does in their head.
 */
const NOW = Date.parse('2026-08-05T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('relativeTime', () => {
  it('climbs through the units', () => {
    expect(relativeTime(ago(10 * 1000), NOW)).toBe('just now');
    expect(relativeTime(ago(5 * MINUTE), NOW)).toBe('5 minutes ago');
    expect(relativeTime(ago(4 * HOUR), NOW)).toBe('4 hours ago');
    expect(relativeTime(ago(4 * DAY), NOW)).toBe('4 days ago');
    expect(relativeTime(ago(200 * DAY), NOW)).toBe('7 months ago');
    expect(relativeTime(ago(800 * DAY), NOW)).toBe('2 years ago');
  });

  it('says a single unit in the singular', () => {
    expect(relativeTime(ago(DAY), NOW)).toBe('1 day ago');
    // Not "60 minutes ago", which is the same fact in the unit nobody chose.
    expect(relativeTime(ago(HOUR), NOW)).toBe('1 hour ago');
  });

  it('stays in days well past a month', () => {
    // A source that has produced nothing for 45 days should say so in days:
    // "1 month" rounds it into something less alarming than the number an
    // operator is about to make a decision on.
    expect(relativeTime(ago(45 * DAY), NOW)).toBe('45 days ago');
  });

  it('phrases a future instant forwards', () => {
    // `poll_after` is normally ahead of now, and "-2 hours ago" would just look
    // like the screen is broken.
    expect(relativeTime(new Date(NOW + 2 * HOUR).toISOString(), NOW)).toBe('in 2 hours');
  });

  it('returns null for a missing or unparseable timestamp', () => {
    // Null rather than a placeholder: "never polled" and "no failures yet" are
    // the same absent column and very different sentences.
    expect(relativeTime(null, NOW)).toBeNull();
    expect(relativeTime(undefined, NOW)).toBeNull();
    expect(relativeTime('', NOW)).toBeNull();
    expect(relativeTime('not a date', NOW)).toBeNull();
  });
});

describe('daysSince', () => {
  it('counts whole days, and nothing without a timestamp', () => {
    expect(daysSince(ago(62 * DAY + HOUR), NOW)).toBe(62);
    expect(daysSince(null, NOW)).toBeNull();
  });
});
