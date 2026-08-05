import { describe, it, expect } from 'vitest';
import { pollConcern, type CreatorPollHealth } from '@/lib/poll-health';

const health = (over: Partial<CreatorPollHealth> = {}): CreatorPollHealth => ({
  creatorId: 'c1', source: 'website', lastPolledAt: null, pollAfter: null,
  consecutiveFailures: 0, lastFailedAt: null, lastError: null, lastStatus: null,
  lastNewItemAt: null, draftedCount: 0, publishedCount: 0, ...over,
});

const NOW = Date.parse('2026-08-05T00:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

describe('pollConcern — who is broken, not how is everyone', () => {
  it('ranks an erroring source above a merely quiet one', () => {
    const failing = health({ consecutiveFailures: 6, lastNewItemAt: daysAgo(1), lastPolledAt: daysAgo(1) });
    const quiet = health({ lastNewItemAt: daysAgo(30), lastPolledAt: daysAgo(1) });
    expect(pollConcern(failing, NOW)).toBeGreaterThan(pollConcern(quiet, NOW));
  });

  it('surfaces a source that polls happily and produces nothing', () => {
    // The failure this screen exists for: every other column reads healthy — a
    // poll an hour ago, no failures, next poll scheduled — and the source has
    // not yielded a recipe in two months.
    const silent = health({ lastPolledAt: daysAgo(0), lastNewItemAt: daysAgo(60) });
    const healthy = health({ lastPolledAt: daysAgo(0), lastNewItemAt: daysAgo(1) });
    expect(pollConcern(silent, NOW)).toBeGreaterThan(pollConcern(healthy, NOW));
  });

  it('does not call a creator broken for never setting polling up', () => {
    // Nothing is wrong here, and floating them to the top buries what is.
    expect(pollConcern(health({ source: null, lastNewItemAt: daysAgo(400) }), NOW)).toBe(0);
  });
});
