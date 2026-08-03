import { readFileSync } from 'fs';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fakeDb } from '../helpers/supabase-mock';
import { publicLookup, stubFetch } from '../helpers/import-stubs';
import { importedGuacamole } from '../helpers/import-ui-fixtures';
import type { ImportResult, ImportSuccess } from '@/lib/import/types';
import type { RunImportOptions } from '@/lib/import/pipeline';

vi.mock('@/lib/logger', () => ({ log: vi.fn() }));

/**
 * The poller must never be able to publish. Mocked so the tests can assert the
 * publisher was not reached, rather than only that a draft row appeared.
 */
const publishCreatorMeal = vi.fn();
vi.mock('@/lib/creator-meals', () => ({
  publishCreatorMeal: (...args: unknown[]) => publishCreatorMeal(...args),
}));

import {
  cronScheduleFor,
  eligibleCreators,
  pollCreator,
  runPollPass,
  POLL_INTERVAL_MINUTES,
  POLL_ITEM_CAP,
  type PollDeps,
  type PollableCreator,
} from '@/lib/creator-poller';

/**
 * The feed poller (MEAL-75) and the email it sends (MEAL-76).
 *
 * Every test here is one of the ways this silently goes wrong, because none of
 * them announce themselves in production: the first poll importing a back
 * catalogue costs $13 and looks like the feature working, a high-water mark
 * loses posts with no error at all, and a source that starts refusing us is
 * indistinguishable from a creator who stopped publishing.
 *
 * Assertions are on **persisted state** — the rows in `creator_source_items`
 * and `creator_source_state` — rather than on call arguments, because those rows
 * are what the next pass reads and therefore what the behaviour actually is.
 */

const supabase = fakeDb as unknown as SupabaseClient;
const NOW = 1_800_000_000_000; // 2027-01-15T08:00:00Z
const NOW_ISO = new Date(NOW).toISOString();

function creatorRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c1',
    user_id: 'u1',
    display_name: 'Chef Sarah',
    website_url: 'https://chefsarah.test/',
    youtube_url: null,
    instagram_url: null,
    tiktok_url: null,
    feed_url: 'https://chefsarah.test/feed',
    primary_source: 'website',
    import_opt_in: true,
    ...overrides,
  };
}

function creator(overrides: Partial<PollableCreator> = {}): PollableCreator {
  return {
    id: 'c1',
    user_id: 'u1',
    display_name: 'Chef Sarah',
    website_url: 'https://chefsarah.test/',
    youtube_url: null,
    instagram_url: null,
    tiktok_url: null,
    feed_url: 'https://chefsarah.test/feed',
    source: 'website',
    ...overrides,
  };
}

/** An RSS feed of `n` posts, newest first, optionally with a publisher TTL. */
function feedWith(n: number, extra = ''): string {
  const items = Array.from({ length: n }, (_, i) =>
    `<item><title>Recipe ${i}</title><link>https://chefsarah.test/post-${i}</link>` +
    `<guid>guid-${i}</guid><pubDate>Tue, 29 Jul 2026 09:00:00 +0000</pubDate></item>`,
  ).join('');
  return `<rss><channel>${extra}${items}</channel></rss>`;
}

function feedRoutes(body: string, headers: Record<string, string> = {}) {
  return stubFetch({
    'https://chefsarah.test/robots.txt': { body: 'User-agent: *\nAllow: /' },
    'https://chefsarah.test/feed': { body, headers: { 'content-type': 'application/rss+xml', ...headers } },
  });
}

let success: ImportSuccess;

/** Deps with the pipeline stubbed. Every test that extracts anything uses this. */
function deps(overrides: Partial<PollDeps> = {}): PollDeps {
  return {
    supabase,
    now: () => NOW,
    queue: vi.fn(async () => `draft-${Math.random().toString(36).slice(2, 8)}`) as unknown as PollDeps['queue'],
    importer: (async () => success) as unknown as PollDeps['importer'],
    notifier: vi.fn(async () => undefined),
    ...overrides,
  };
}

/** The `creator_source_state` row as it stands now. */
function state(creatorId = 'c1', source = 'website') {
  return fakeDb.rows('creator_source_state').find((row) => row.creator_id === creatorId && row.source === source);
}

function items() {
  return fakeDb.rows('creator_source_items');
}

beforeEach(async () => {
  fakeDb.reset();
  fakeDb.seed('creator_source_items', []);
  fakeDb.seed('creator_source_state', []);
  fakeDb.seed('user_profiles', [{ id: 'u1', email: 'sarah@chefsarah.test' }]);
  publishCreatorMeal.mockReset();
  success ??= await importedGuacamole();
});

// ── The schedule ─────────────────────────────────────────────────────────────

describe('the schedule is one constant', () => {
  it('ships daily, because a shorter Vercel Hobby cron fails the deployment', () => {
    // Not a preference. Hobby caps cron jobs at once per day and `*/15 * * * *`
    // fails at DEPLOY time with "Hobby accounts are limited to daily cron jobs"
    // — it does not silently degrade, it ships nothing.
    expect(POLL_INTERVAL_MINUTES).toBe(1440);
    expect(cronScheduleFor(1440)).toBe('0 4 * * *');
  });

  it('produces the sub-hourly expression the Pro plan unlocks', () => {
    // The one-line change when the plan is upgraded: POLL_INTERVAL_MINUTES = 15,
    // regenerate vercel.json from this, and every backoff and TTL floor in the
    // poller follows because they are all expressed off the same constant.
    expect(cronScheduleFor(15)).toBe('*/15 * * * *');
    expect(cronScheduleFor(360)).toBe('0 */6 * * *');
  });

  it('agrees with vercel.json, so the two cannot drift apart unnoticed', () => {
    // The failure this catches is invisible from inside the application:
    // believing we poll every fifteen minutes while the deployed schedule says
    // daily. Nothing in the code can tell.
    const crons = JSON.parse(readFileSync('vercel.json', 'utf8')).crons as Array<{ path: string; schedule: string }>;
    const poll = crons.find((cron) => cron.path === '/api/cron/poll');
    expect(poll?.schedule).toBe(cronScheduleFor(POLL_INTERVAL_MINUTES));
  });
});

// ── Who may be polled ────────────────────────────────────────────────────────

describe('nothing is polled without both switches', () => {
  it('skips a creator with a source but no opt-in, and one with opt-in but no source', async () => {
    fakeDb.seed('creators', [
      creatorRow({ id: 'yes' }),
      creatorRow({ id: 'no-opt-in', import_opt_in: false }),
      creatorRow({ id: 'no-source', primary_source: 'none' }),
    ]);

    const eligible = await eligibleCreators(supabase);

    expect(eligible.map((row) => row.id)).toEqual(['yes']);
  });

  it('refuses to poll a creator whose source is unset even when handed one directly', async () => {
    // Defence in depth: the rule has to be true of the function, not only of the
    // one query that calls it today.
    const result = await pollCreator(deps(), creator({ source: 'none' as never }), null);

    expect(result.status).toBe('skipped');
    expect(items()).toHaveLength(0);
  });

  it('takes an opt-out effect immediately — no in-flight state keeps a creator in', async () => {
    fakeDb.seed('creators', [creatorRow({ import_opt_in: false })]);
    // A state row from when they were opted in. The query, not the state, is
    // what decides.
    fakeDb.seed('creator_source_state', [
      { creator_id: 'c1', source: 'website', last_polled_at: '2027-01-01T00:00:00.000Z', poll_after: null, consecutive_failures: 0 },
    ]);

    const pass = await runPollPass(deps());

    expect(pass.eligible).toBe(0);
    expect(pass.polled).toBe(0);
  });
});

// ── The first poll ───────────────────────────────────────────────────────────

describe('the first poll of a source imports nothing', () => {
  it('marks a 200-post archive seen without a single extraction', async () => {
    const { impl } = feedRoutes(feedWith(200));
    const importer = vi.fn(async () => success);

    const result = await pollCreator(
      deps({ importer: importer as unknown as PollDeps['importer'], fetchOptions: { fetchImpl: impl, lookup: publicLookup } }),
      creator(),
      null,
    );

    // The whole point: 200 extractions at ~$0.067 is about $13 and 200 drafts
    // nobody asked for. Back-catalog import is MEAL-79, never a side effect of
    // connecting a feed.
    expect(importer).not.toHaveBeenCalled();
    expect(result.status).toBe('baselined');
    expect(result.baselined).toBe(200);
    expect(items()).toHaveLength(200);
    expect(items().every((row) => row.status === 'seen')).toBe(true);
    expect(result.drafts).toHaveLength(0);
  });

  it('does not downgrade an item an operator already synced', async () => {
    const { impl } = feedRoutes(feedWith(3));
    fakeDb.seed('creator_source_items', [
      { creator_id: 'c1', source: 'website', item_id: 'guid-1', status: 'imported', draft_id: 'draft-9' },
    ]);

    await pollCreator(deps({ fetchOptions: { fetchImpl: impl, lookup: publicLookup } }), creator(), null);

    // `imported` still points at its draft. Overwriting it with `seen` would
    // lose the link between the post and what was published from it.
    const already = items().find((row) => row.item_id === 'guid-1');
    expect(already).toMatchObject({ status: 'imported', draft_id: 'draft-9' });
    expect(items().filter((row) => row.status === 'seen')).toHaveLength(2);
  });

  it('stays a first poll when the feed could not be read, rather than baselining nothing', async () => {
    // The trap: writing `last_polled_at` on a failed attempt makes the NEXT poll
    // think the baseline has already run, and it imports the whole archive.
    const { impl } = stubFetch({
      'https://chefsarah.test/robots.txt': { body: '' },
      'https://chefsarah.test/feed': { status: 500, body: 'boom' },
    });

    const failed = await pollCreator(
      deps({ fetchOptions: { fetchImpl: impl, lookup: publicLookup } }),
      creator(),
      null,
    );

    expect(failed.status).toBe('failed');
    expect(state()?.last_polled_at).toBeNull();
    expect(state()?.consecutive_failures).toBe(1);
  });
});

// ── What counts as new ───────────────────────────────────────────────────────

describe('what we have seen is a set, never a high-water mark', () => {
  const seen = { creator_id: 'c1', source: 'website', item_id: 'guid-0', status: 'seen' };
  const polled = { lastPolledAt: '2027-01-14T08:00:00.000Z', etag: null, lastModified: null, pollAfter: null, consecutiveFailures: 0 };

  it('imports a backdated entry that sorts BELOW everything already seen', async () => {
    // A scheduled post that published late carries an earlier date than posts we
    // have already processed. Under a last-seen timestamp or guid it is never
    // seen again, and there is no error — just a missing recipe.
    const backdated =
      '<item><title>Older recipe</title><link>https://chefsarah.test/older</link>' +
      '<guid>guid-older</guid><pubDate>Mon, 01 Jan 2024 09:00:00 +0000</pubDate></item>';
    const { impl } = feedRoutes(`<rss><channel>${backdated}<item><title>Recipe 0</title>` +
      '<link>https://chefsarah.test/post-0</link><guid>guid-0</guid>' +
      '<pubDate>Tue, 29 Jul 2026 09:00:00 +0000</pubDate></item></channel></rss>');
    fakeDb.seed('creator_source_items', [seen]);

    const result = await pollCreator(
      deps({ fetchOptions: { fetchImpl: impl, lookup: publicLookup } }),
      creator(),
      polled,
    );

    expect(result.newItems).toBe(1);
    expect(result.drafted).toBe(1);
    expect(items().find((row) => row.item_id === 'guid-older')).toMatchObject({ status: 'imported' });
  });

  it('does not re-draft an item that was already rejected by the gate', async () => {
    const { impl } = feedRoutes(feedWith(1));
    fakeDb.seed('creator_source_items', [{ ...seen, status: 'rejected', detail: 'Not a recipe: a trip to Portland' }]);

    const result = await pollCreator(
      deps({ fetchOptions: { fetchImpl: impl, lookup: publicLookup } }),
      creator(),
      polled,
    );

    // A record of ANY status means "we have met this item". A declined post has
    // to stay declined, or a creator gets asked about it every single cycle.
    expect(result.newItems).toBe(0);
    expect(result.drafted).toBe(0);
  });

  it('caps the batch, defers the rest, and says so out loud', async () => {
    const { impl } = feedRoutes(feedWith(20));
    const importer = vi.fn(async () => success);

    const result = await pollCreator(
      deps({ importer: importer as unknown as PollDeps['importer'], fetchOptions: { fetchImpl: impl, lookup: publicLookup } }),
      creator(),
      polled,
    );

    expect(importer).toHaveBeenCalledTimes(POLL_ITEM_CAP);
    expect(result.deferred).toBe(20 - POLL_ITEM_CAP);
    // A site republishing its archive after a migration looks exactly like a
    // burst of new posts, so exceeding the cap is a signal, not just a cost.
    expect(result.signal?.kind).toBe('flood');
    // The deferred items have no record, so they are simply new again next
    // cycle — no separate queue to keep true.
    expect(items()).toHaveLength(POLL_ITEM_CAP);
  });
});

// ── Per-item independence, and the gate ──────────────────────────────────────

describe('each item stands alone', () => {
  const polled = { lastPolledAt: '2027-01-14T08:00:00.000Z', etag: null, lastModified: null, pollAfter: null, consecutiveFailures: 0 };

  it('lands the other items when one extraction fails, and leaves that one retryable', async () => {
    const { impl } = feedRoutes(feedWith(3));
    const importer = vi.fn(async (url: string, _options: RunImportOptions): Promise<ImportResult> =>
      url.endsWith('post-1')
        ? { status: 'rejected', url, stage: 'extract', reason: 'timeout', detail: 'The model timed out.', meta: { cached: false } }
        : success,
    );

    const result = await pollCreator(
      deps({ importer: importer as unknown as PollDeps['importer'], fetchOptions: { fetchImpl: impl, lookup: publicLookup } }),
      creator(),
      polled,
    );

    expect(result.drafted).toBe(2);
    expect(result.failed).toBe(1);
    // `failed`, not `rejected`: the gate said nothing about this post, we just
    // did not manage to read it. Retryable is the whole difference.
    expect(items().find((row) => row.item_id === 'guid-1')).toMatchObject({ status: 'failed' });
  });

  it('drops a gate rejection silently — no draft, no email', async () => {
    const { impl } = feedRoutes(feedWith(1));
    const notifier = vi.fn(async () => undefined);
    const importer = vi.fn(async (url: string): Promise<ImportResult> => ({
      status: 'rejected', url, stage: 'gate', reason: 'gate-no',
      detail: 'Not a recipe: a post about a trip to Portland.', meta: { cached: false },
    }));
    fakeDb.seed('creators', [creatorRow()]);
    fakeDb.seed('creator_source_state', [
      { creator_id: 'c1', source: 'website', last_polled_at: polled.lastPolledAt, poll_after: null, consecutive_failures: 0 },
    ]);

    const pass = await runPollPass(
      deps({ notifier, importer: importer as unknown as PollDeps['importer'], fetchOptions: { fetchImpl: impl, lookup: publicLookup } }),
    );

    // Nobody asked for this import, so a false positive that reached the creator
    // would be spam with our name on it.
    expect(pass.rejected).toBe(1);
    expect(pass.drafted).toBe(0);
    expect(notifier).not.toHaveBeenCalled();
    expect(items()[0]).toMatchObject({ status: 'rejected' });
  });

  it('resolves an unsure gate verdict as a no, unlike the operator path', async () => {
    const { impl } = feedRoutes(feedWith(1));
    const importer = vi.fn(async (_url: string, _options: RunImportOptions) => success);

    await pollCreator(
      deps({ importer: importer as unknown as PollDeps['importer'], fetchOptions: { fetchImpl: impl, lookup: publicLookup } }),
      creator(),
      polled,
    );

    // `manual` attempts an unsure verdict because an operator picked the URL and
    // is watching. Nobody is watching here.
    expect(importer.mock.calls[0][1].mode).toBe('poller');
  });

  it('never publishes', async () => {
    const { impl } = feedRoutes(feedWith(2));

    const result = await pollCreator(
      deps({ fetchOptions: { fetchImpl: impl, lookup: publicLookup } }),
      creator(),
      polled,
    );

    expect(result.drafted).toBe(2);
    expect(publishCreatorMeal).not.toHaveBeenCalled();
  });
});

// ── Polling hygiene ──────────────────────────────────────────────────────────

describe('polling hygiene', () => {
  const polled = { lastPolledAt: '2027-01-14T08:00:00.000Z', etag: '"v1"', lastModified: null, pollAfter: null, consecutiveFailures: 0 };

  it('replays the stored validator and treats a 304 as a good answer', async () => {
    const seenHeaders: Array<Record<string, string>> = [];
    const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('robots.txt')) return new Response('', { status: 200, headers: { 'content-type': 'text/plain' } });
      seenHeaders.push(init?.headers as Record<string, string>);
      return new Response(null, { status: 304 });
    }) as unknown as typeof fetch;

    const result = await pollCreator(
      deps({ fetchOptions: { fetchImpl: impl, lookup: publicLookup } }),
      creator(),
      polled,
    );

    expect(seenHeaders[0]['if-none-match']).toBe('"v1"');
    // Not a failure: an unchanged feed costing 300 bytes is the design working.
    expect(result.status).toBe('not-modified');
    expect(state()?.consecutive_failures).toBe(0);
    expect(state()?.last_polled_at).toBe(NOW_ISO);
  });

  it('stores the validators a feed hands back, so the next poll can be conditional', async () => {
    const { impl } = feedRoutes(feedWith(1), { etag: '"v2"', 'last-modified': 'Tue, 14 Jan 2027 08:00:00 GMT' });

    await pollCreator(deps({ fetchOptions: { fetchImpl: impl, lookup: publicLookup } }), creator(), polled);

    expect(state()).toMatchObject({ etag: '"v2"', last_modified: 'Tue, 14 Jan 2027 08:00:00 GMT' });
  });

  it('honours an advertised TTL longer than our own interval', async () => {
    // The publisher asked, in writing, on their own feed. Weekly beats daily.
    const { impl } = feedRoutes(feedWith(1, '<sy:updatePeriod>weekly</sy:updatePeriod>'));

    await pollCreator(deps({ fetchOptions: { fetchImpl: impl, lookup: publicLookup } }), creator(), polled);

    const week = new Date(NOW + 7 * 24 * 3600 * 1000).toISOString();
    expect(state()?.poll_after).toBe(week);
  });

  it('does not let a short TTL pull us in faster than our own interval', async () => {
    // `<ttl>5</ttl>` is a feed saying it may be re-read every five minutes. That
    // is permission, not an instruction.
    const { impl } = feedRoutes(feedWith(1, '<ttl>5</ttl>'));

    await pollCreator(deps({ fetchOptions: { fetchImpl: impl, lookup: publicLookup } }), creator(), polled);

    expect(state()?.poll_after).toBe(new Date(NOW + POLL_INTERVAL_MINUTES * 60_000).toISOString());
  });

  it('backs off further on each consecutive refusal, up to a ceiling', async () => {
    const { impl } = stubFetch({
      'https://chefsarah.test/robots.txt': { body: '' },
      'https://chefsarah.test/feed': { status: 429, body: 'slow down' },
    });
    const day = POLL_INTERVAL_MINUTES * 60_000;
    const poll = (consecutiveFailures: number) =>
      pollCreator(deps({ fetchOptions: { fetchImpl: impl, lookup: publicLookup } }), creator(), { ...polled, consecutiveFailures });

    // Doubling matters more than the exact numbers: hammering a host that has
    // just refused us is what turns a temporary 429 into a permanent block.
    await poll(0);
    expect(state()).toMatchObject({ poll_after: new Date(NOW + day * 2).toISOString(), consecutive_failures: 1 });
    await poll(1);
    expect(state()).toMatchObject({ poll_after: new Date(NOW + day * 4).toISOString(), consecutive_failures: 2 });

    // And then it stops doubling. Past a week a source is not "busy", it is a
    // thing to go and look at, and an ever-growing interval hides that.
    await poll(9);
    expect(state()?.poll_after).toBe(new Date(NOW + day * 7).toISOString());
  });

  it('does not poll a source before its poll_after', async () => {
    fakeDb.seed('creators', [creatorRow()]);
    fakeDb.seed('creator_source_state', [
      { creator_id: 'c1', source: 'website', last_polled_at: NOW_ISO, poll_after: new Date(NOW + 3_600_000).toISOString(), consecutive_failures: 1 },
    ]);
    const impl = vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch;

    const pass = await runPollPass(deps({ fetchOptions: { fetchImpl: impl, lookup: publicLookup } }));

    expect(pass.skipped).toBe(1);
    expect(impl).not.toHaveBeenCalled();
  });

  it('raises a signal when a source that used to work starts refusing us', async () => {
    const { impl } = stubFetch({
      'https://chefsarah.test/robots.txt': { body: '' },
      'https://chefsarah.test/feed': { status: 403, body: 'forbidden' },
    });

    const result = await pollCreator(
      deps({ fetchOptions: { fetchImpl: impl, lookup: publicLookup } }),
      creator(),
      polled,
    );

    expect(result.status).toBe('blocked');
    // The point of the signal: a creator's site blocking us must not present as
    // that creator having stopped publishing.
    expect(result.signal?.kind).toBe('blocked');
    expect(result.signal?.detail).toContain('previously working');
  });

  it('does not call a first-ever 403 a change — there is nothing it changed from', async () => {
    const { impl } = stubFetch({
      'https://chefsarah.test/robots.txt': { body: '' },
      'https://chefsarah.test/feed': { status: 403, body: 'forbidden' },
    });

    const result = await pollCreator(deps({ fetchOptions: { fetchImpl: impl, lookup: publicLookup } }), creator(), null);

    expect(result.status).toBe('blocked');
    expect(result.signal).toBeNull();
  });

  it('sends the honest User-Agent with a contact URL', async () => {
    const seen: Array<Record<string, string>> = [];
    const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init?.headers as Record<string, string>);
      return new Response(String(input).endsWith('robots.txt') ? '' : feedWith(1), {
        status: 200,
        headers: { 'content-type': 'application/rss+xml' },
      });
    }) as unknown as typeof fetch;

    await pollCreator(deps({ fetchOptions: { fetchImpl: impl, lookup: publicLookup } }), creator(), polled);

    // No browser impersonation. A publisher who wants to know who is reading
    // their feed can find out from the request itself.
    expect(seen.every((headers) => headers['user-agent'] === 'MealioBot/1.0 (+https://mealio.co/about)')).toBe(true);
  });

  it('honours robots.txt and does not fetch a disallowed feed', async () => {
    const { impl, calls } = stubFetch({
      'https://chefsarah.test/robots.txt': { body: 'User-agent: *\nDisallow: /feed' },
      'https://chefsarah.test/feed': { body: feedWith(3) },
    });

    const result = await pollCreator(deps({ fetchOptions: { fetchImpl: impl, lookup: publicLookup } }), creator(), polled);

    expect(calls).toEqual(['https://chefsarah.test/robots.txt']);
    expect(result.drafted).toBe(0);
  });
});

// ── The pass, and the email ──────────────────────────────────────────────────

describe('one email per batch (MEAL-76)', () => {
  beforeEach(() => {
    fakeDb.seed('creator_source_state', [
      { creator_id: 'c1', source: 'website', last_polled_at: '2027-01-14T08:00:00.000Z', poll_after: null, consecutive_failures: 0 },
    ]);
  });

  it('sends one message listing three drafts, not three messages', async () => {
    fakeDb.seed('creators', [creatorRow()]);
    const { impl } = feedRoutes(feedWith(3));
    const notifier = vi.fn(async () => undefined);

    const pass = await runPollPass(deps({ notifier, fetchOptions: { fetchImpl: impl, lookup: publicLookup } }));

    expect(pass.drafted).toBe(3);
    expect(pass.emailsSent).toBe(1);
    expect(notifier).toHaveBeenCalledTimes(1);
    const [to, name, drafts] = notifier.mock.calls[0] as unknown as [string, string, unknown[]];
    expect(to).toBe('sarah@chefsarah.test');
    expect(name).toBe('Chef Sarah');
    expect(drafts).toHaveLength(3);
  });

  it('carries the photo, the ingredient count and the flag count — enough to judge from the inbox', async () => {
    fakeDb.seed('creators', [creatorRow()]);
    const { impl } = feedRoutes(feedWith(1));
    const notifier = vi.fn(async () => undefined);

    await runPollPass(deps({ notifier, fetchOptions: { fetchImpl: impl, lookup: publicLookup } }));

    const drafts = (notifier.mock.calls[0] as unknown as [string, string, any[]])[2];
    expect(drafts[0]).toMatchObject({
      name: success.draft.name,
      ingredientCount: success.draft.ingredients.length,
      sourceUrl: 'https://chefsarah.test/post-0',
    });
    expect(typeof drafts[0].needALook).toBe('number');
  });

  it('sends nothing when nothing was drafted', async () => {
    fakeDb.seed('creators', [creatorRow()]);
    const { impl } = feedRoutes(feedWith(0));
    const notifier = vi.fn(async () => undefined);

    const pass = await runPollPass(deps({ notifier, fetchOptions: { fetchImpl: impl, lookup: publicLookup } }));

    expect(pass.drafted).toBe(0);
    expect(notifier).not.toHaveBeenCalled();
  });

  it('is transactional: marketing_opt_out does not suppress it', async () => {
    // A creator who unsubscribed from campaigns has still asked us to import
    // their recipes. Drafts they are never told about are worse than no drafts.
    fakeDb.seed('creators', [creatorRow()]);
    fakeDb.seed('user_profiles', [{ id: 'u1', email: 'sarah@chefsarah.test', marketing_opt_out: true }]);
    const { impl } = feedRoutes(feedWith(1));
    const notifier = vi.fn(async () => undefined);

    const pass = await runPollPass(deps({ notifier, fetchOptions: { fetchImpl: impl, lookup: publicLookup } }));

    expect(pass.emailsSent).toBe(1);
  });

  it('keeps the drafts when the email throws', async () => {
    fakeDb.seed('creators', [creatorRow()]);
    const { impl } = feedRoutes(feedWith(2));
    const notifier = vi.fn(async () => {
      throw new Error('Resend is down');
    });

    const pass = await runPollPass(deps({ notifier, fetchOptions: { fetchImpl: impl, lookup: publicLookup } }));

    expect(pass.drafted).toBe(2);
    expect(pass.emailsSent).toBe(0);
    expect(items().filter((row) => row.status === 'imported')).toHaveLength(2);
  });
});

describe('the pass', () => {
  it('polls the longest-waiting creator first, so a short budget cannot starve the tail', async () => {
    fakeDb.seed('creators', [
      creatorRow({ id: 'recent', website_url: 'https://recent.test/', feed_url: 'https://recent.test/feed' }),
      creatorRow({ id: 'stale', website_url: 'https://stale.test/', feed_url: 'https://stale.test/feed' }),
      creatorRow({ id: 'never', website_url: 'https://never.test/', feed_url: 'https://never.test/feed' }),
    ]);
    fakeDb.seed('creator_source_state', [
      { creator_id: 'recent', source: 'website', last_polled_at: '2027-01-15T07:00:00.000Z', poll_after: null, consecutive_failures: 0 },
      { creator_id: 'stale', source: 'website', last_polled_at: '2027-01-01T07:00:00.000Z', poll_after: null, consecutive_failures: 0 },
    ]);
    const { impl, calls } = stubFetch(Object.fromEntries(
      ['recent', 'stale', 'never'].flatMap((host) => [
        [`https://${host}.test/robots.txt`, { body: '' }],
        [`https://${host}.test/feed`, { body: feedWith(0), headers: { 'content-type': 'application/rss+xml' } }],
      ]),
    ));

    await runPollPass(deps({ fetchOptions: { fetchImpl: impl, lookup: publicLookup } }));

    // Never-polled first — they have no baseline yet — then longest-waiting. A
    // creator the budget did not reach is untouched, so this ordering puts them
    // at the front of the next pass without anything having to remember them. A
    // stable order starves the tail permanently the first time a pass runs long,
    // and does it silently.
    expect(calls.filter((url) => url.endsWith('/feed'))).toEqual([
      'https://never.test/feed',
      'https://stale.test/feed',
      'https://recent.test/feed',
    ]);
  });

  it('does not hit an origin twice in one pass after it has refused us', async () => {
    fakeDb.seed('creators', [creatorRow({ id: 'c1' }), creatorRow({ id: 'c2', user_id: 'u2' })]);
    const { impl, calls } = stubFetch({
      'https://chefsarah.test/robots.txt': { body: '' },
      'https://chefsarah.test/feed': { status: 429, body: 'slow down' },
    });

    const pass = await runPollPass(deps({ fetchOptions: { fetchImpl: impl, lookup: publicLookup } }));

    // `poll_after` is the durable half of the backoff; this is the half it
    // cannot express. Being told twice inside a minute is exactly what turns a
    // temporary 429 into a permanent block.
    expect(pass.blocked).toBe(1);
    expect(pass.skipped).toBe(1);
    expect(calls.filter((url) => url.endsWith('/feed'))).toHaveLength(1);
  });

  it('keeps going when one creator blows up unexpectedly', async () => {
    fakeDb.seed('creators', [
      creatorRow({ id: 'bad', website_url: 'https://bad.test/', feed_url: 'https://bad.test/feed' }),
      creatorRow({ id: 'good', website_url: 'https://good.test/', feed_url: 'https://good.test/feed' }),
    ]);
    const impl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('https://bad.test')) throw { toString: () => { throw new Error('unserialisable'); } };
      return new Response(url.endsWith('robots.txt') ? '' : feedWith(1), {
        status: 200,
        headers: { 'content-type': 'application/rss+xml' },
      });
    }) as unknown as typeof fetch;

    const pass = await runPollPass(deps({ fetchOptions: { fetchImpl: impl, lookup: publicLookup } }));

    // The point is the other creator, not the failure: one bad feed ending a
    // pass would mean everyone behind them silently stops being polled.
    expect(pass.baselined).toBe(1);
    expect(fakeDb.rows('creator_source_state').map((row) => row.creator_id)).toEqual(['good']);
  });

  it('reports the signals in the result, not only in a log line', async () => {
    fakeDb.seed('creators', [creatorRow()]);
    fakeDb.seed('creator_source_state', [
      { creator_id: 'c1', source: 'website', last_polled_at: '2027-01-14T08:00:00.000Z', poll_after: null, consecutive_failures: 0 },
    ]);
    const { impl } = feedRoutes(feedWith(20));

    const pass = await runPollPass(deps({ fetchOptions: { fetchImpl: impl, lookup: publicLookup } }));

    expect(pass.signals).toHaveLength(1);
    expect(pass.signals[0]).toContain('20 new items');
  });
});
