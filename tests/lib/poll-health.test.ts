import { describe, it, expect } from 'vitest';
import { pollConcern, pollStatus, type CreatorPollHealth } from '@/lib/poll-health';

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

describe('pollStatus — what the row is called', () => {
  it('calls a source with no failures and a recent post ok', () => {
    expect(pollStatus(health({ lastPolledAt: daysAgo(0), lastNewItemAt: daysAgo(2) }), NOW)).toBe('ok');
  });

  it('separates a failure or two from a source nobody has looked at', () => {
    expect(pollStatus(health({ consecutiveFailures: 1, lastNewItemAt: daysAgo(1) }), NOW)).toBe('wobbling');
    expect(pollStatus(health({ consecutiveFailures: 6, lastNewItemAt: daysAgo(1) }), NOW)).toBe('failing');
  });

  it('names the source that polls cleanly and produces nothing', () => {
    // Recent poll, no failures, next poll scheduled — healthy on every column
    // except the one this screen exists for.
    expect(pollStatus(health({ lastPolledAt: daysAgo(0), lastNewItemAt: daysAgo(60) }), NOW)).toBe('silent');
  });

  it('does not call a source silent before it has produced anything', () => {
    // A source configured this morning has no items and no way to tell "new" from
    // "never produced"; calling it silent puts every new creator at the top.
    expect(pollStatus(health({ lastPolledAt: daysAgo(0), lastNewItemAt: null }), NOW)).toBe('ok');
  });

  it('has a state for a creator with no source that is not a failure state', () => {
    expect(pollStatus(health({ source: null, lastNewItemAt: daysAgo(400) }), NOW)).toBe('unconfigured');
  });
});
