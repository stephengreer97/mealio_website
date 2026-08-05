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
  POLL_CREATOR_BATCH,
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

/**
 * The `creator_source_items` id for one of those posts.
 *
 * The URL, normalised — not the feed's guid. Which is the point: the id has to
 * survive the listing being answered by a different rung of the ladder, and only
 * the URL is common to all of them.
 */
function postId(i: number): string {
  return `chefsarah.test/post-${i}`;
}

/** `n` opted-in creators, `c0`…`c(n-1)`, each publishing on their own origin. */
function manyCreators(n: number) {
  return Array.from({ length: n }, (_, i) =>
    creatorRow({
      id: `c${i}`,
      user_id: `u${i}`,
      website_url: `https://c${i}.test/`,
      feed_url: `https://c${i}.test/feed`,
    }),
  );
}

/** A readable one-post feed for each of them. */
function feedRoutesFor(rows: Array<{ id: string }>) {
  return Object.fromEntries(
    rows.flatMap((row) => [
      [`https://${row.id}.test/robots.txt`, { body: '' }],
      [`https://${row.id}.test/feed`, { body: feedWith(1), headers: { 'content-type': 'application/rss+xml' } }],
    ]),
  );
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
  it('polls every fifteen minutes, which requires the Pro plan', () => {
    // Hobby caps cron jobs at once per day, and a shorter expression there does
    // not degrade — it fails at DEPLOY time with "Hobby accounts are limited to
    // daily cron jobs". So this value is a statement about the plan as much as
    // about the cadence, and a build that refuses on Hobby is the intended
    // outcome rather than a regression.
    expect(POLL_INTERVAL_MINUTES).toBe(15);
    expect(cronScheduleFor(15)).toBe('*/15 * * * *');
  });

  it('still knows the daily expression, for a fall back to Hobby', () => {
    // Kept because reverting is one constant, and the hour it would land on
    // should not have to be rediscovered under pressure.
    expect(cronScheduleFor(1440)).toBe('20 14 * * *');
  });

  it('produces the sub-hourly expression the Pro plan unlocks', () => {
    // The one-line change when the plan is upgraded: POLL_INTERVAL_MINUTES = 15,
    // regenerate vercel.json from this, and every backoff and TTL floor in the
    // poller follows because they are all expressed off the same constant.
    expect(cronScheduleFor(15)).toBe('*/15 * * * *');
    expect(cronScheduleFor(360)).toBe('0 */6 * * *');
  });

  it('refuses an interval no cron expression can honestly carry', () => {
    // A step restarts at the top of its field, so 45 minutes fires at :00 and
    // :45 — a 45-minute gap and then a 15-minute one — and 90 minutes rounds to
    // two hours. Returning those keeps the drift test green while the constant
    // and the deployed cadence disagree, which is the one failure this function
    // exists to catch.
    expect(() => cronScheduleFor(45)).toThrow(/no honest cron expression/);
    expect(() => cronScheduleFor(90)).toThrow(/no honest cron expression/);
    expect(() => cronScheduleFor(0)).toThrow(/no honest cron expression/);
    expect(() => cronScheduleFor(2880)).toThrow(/no honest cron expression/);
    // And the ones it can carry are unchanged.
    expect(cronScheduleFor(30)).toBe('*/30 * * * *');
    expect(cronScheduleFor(120)).toBe('0 */2 * * *');
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

    const queue = await eligibleCreators(supabase);

    expect(queue.creators.map((row) => row.id)).toEqual(['yes']);
    // The count is of the same predicate, not of the page: it is how a queue
    // longer than one pass becomes visible at all.
    expect(queue.eligible).toBe(1);
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
      { creator_id: 'c1', source: 'website', item_id: postId(1), status: 'imported', draft_id: 'draft-9' },
    ]);

    await pollCreator(deps({ fetchOptions: { fetchImpl: impl, lookup: publicLookup } }), creator(), null);

    // `imported` still points at its draft. Overwriting it with `seen` would
    // lose the link between the post and what was published from it.
    const already = items().find((row) => row.item_id === postId(1));
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
    // When it broke, which nothing recorded before (MEAL-96). `last_polled_at`
    // cannot answer it — a failure leaves that untouched on purpose, so the next
    // pass cannot mistake a broken source for one that has ever worked.
    expect(state()?.last_failed_at).toBeTruthy();
    expect(state()?.last_error).toBeTruthy();
  });

  it('stays a first poll when the baseline rows could not be written', async () => {
    // The same trap by the other door, and the expensive one. The feed reads
    // fine and the `creator_source_items` write fails — a deadlock, a 414, a
    // transient 5xx. Nothing is marked seen. If `last_polled_at` is written
    // anyway, the next pass is no longer a first poll: 200 archived posts are
    // all unseen, five are extracted and the creator is emailed about them, and
    // it repeats for forty passes — about $13 and forty emails.
    const { impl } = feedRoutes(feedWith(200));
    const importer = vi.fn(async () => success);
    const fetchOptions = { fetchImpl: impl, lookup: publicLookup };
    // The record lookup behind the catalog answers normally; the baseline upsert
    // after it is the one that fails.
    fakeDb.queue('creator_source_items', { data: [] });
    fakeDb.queue('creator_source_items', { error: { message: 'deadlock detected' } });

    const first = await pollCreator(
      deps({ importer: importer as unknown as PollDeps['importer'], fetchOptions }),
      creator(),
      null,
    );

    expect(first.status).toBe('failed');
    expect(items()).toHaveLength(0);
    expect(state()?.last_polled_at).toBeNull();

    // The next pass, reading the state this one wrote.
    const second = await pollCreator(
      deps({ importer: importer as unknown as PollDeps['importer'], fetchOptions }),
      creator(),
      {
        etag: state()?.etag ?? null,
        lastModified: state()?.last_modified ?? null,
        lastPolledAt: state()?.last_polled_at ?? null,
        pollAfter: state()?.poll_after ?? null,
        consecutiveFailures: state()?.consecutive_failures ?? 0,
      },
    );

    expect(importer).not.toHaveBeenCalled();
    expect(second.status).toBe('baselined');
    expect(second.baselined).toBe(200);
  });
});

// ── What counts as new ───────────────────────────────────────────────────────

describe('what we have seen is a set, never a high-water mark', () => {
  const seen = { creator_id: 'c1', source: 'website', item_id: postId(0), status: 'seen' };
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
    expect(items().find((row) => row.item_id === 'chefsarah.test/older')).toMatchObject({ status: 'imported' });
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
    expect(result.signals[0]?.kind).toBe('flood');
    // The deferred items have no record, so they are simply new again next
    // cycle — no separate queue to keep true.
    expect(items()).toHaveLength(POLL_ITEM_CAP);
  });
});

// ── Item identity, across the rungs of the ladder ────────────────────────────

describe('an item id does not depend on which rung answered', () => {
  const polled = { lastPolledAt: '2027-01-14T08:00:00.000Z', etag: null, lastModified: null, pollAfter: null, consecutiveFailures: 0 };

  /**
   * The whole discovery ladder, which is what a creator with no confirmed
   * `feed_url` walks on every single poll. `feedStatus` is what the RSS rungs
   * answer with; the sitemap below them lists the same three posts by URL.
   */
  function ladderRoutes(feedStatus: number) {
    const sitemap =
      '<urlset>' +
      [0, 1, 2]
        .map((i) => `<url><loc>https://chefsarah.test/post-${i}</loc><lastmod>2026-07-29</lastmod></url>`)
        .join('') +
      '</urlset>';
    const down = { status: feedStatus, body: 'service unavailable' };
    return stubFetch({
      'https://chefsarah.test/robots.txt': { body: '' },
      'https://chefsarah.test/': { body: '<html><head></head><body>Chef Sarah</body></html>' },
      'https://chefsarah.test/feed':
        feedStatus === 200 ? { body: feedWith(3), headers: { 'content-type': 'application/rss+xml' } } : down,
      'https://chefsarah.test/rss': down,
      'https://chefsarah.test/feed.xml': down,
      'https://chefsarah.test/sitemap.xml': { body: sitemap, headers: { 'content-type': 'application/xml' } },
    });
  }

  it('does not re-import the archive when a 503 drops the poll onto the sitemap rung', async () => {
    // RSS keys by guid and a sitemap keys by URL, so under the feed's own ids a
    // single 503 on `/feed` makes every already-baselined post new again — and
    // three posts is under the flood cap, so nothing says a word about it.
    const importer = vi.fn(async () => success);
    const undiscovered = creator({ feed_url: null });

    const first = await pollCreator(
      deps({ importer: importer as unknown as PollDeps['importer'], fetchOptions: { fetchImpl: ladderRoutes(200).impl, lookup: publicLookup } }),
      undiscovered,
      null,
    );
    expect(first.baselined).toBe(3);

    const second = await pollCreator(
      deps({ importer: importer as unknown as PollDeps['importer'], fetchOptions: { fetchImpl: ladderRoutes(503).impl, lookup: publicLookup } }),
      undiscovered,
      polled,
    );

    expect(second.newItems).toBe(0);
    expect(importer).not.toHaveBeenCalled();
    expect(second.signals).toEqual([]);
    expect(items()).toHaveLength(3);
  });

  it('reads the same post at http and at https as one item', async () => {
    // The other half of the same rule: a scheme or trailing-slash move is not a
    // new post, and normalising is what keeps it from reading as one.
    const secure = '<item><title>Recipe 0</title><link>https://chefsarah.test/post-0/</link>' +
      '<guid>guid-brand-new</guid><pubDate>Tue, 29 Jul 2026 09:00:00 +0000</pubDate></item>';
    const { impl } = feedRoutes(`<rss><channel>${secure}</channel></rss>`);
    fakeDb.seed('creator_source_items', [
      { creator_id: 'c1', source: 'website', item_id: postId(0), status: 'seen' },
    ]);

    const result = await pollCreator(
      deps({ fetchOptions: { fetchImpl: impl, lookup: publicLookup } }),
      creator(),
      polled,
    );

    expect(result.newItems).toBe(0);
  });

  it('says so when a listing contains nothing we recognise, even under the flood cap', async () => {
    // Three posts, all new, on a source we have polled before. `flood` cannot
    // see this — three is under a cap of five — and it is the common shape of an
    // id change, so the signal has to fire on the shape rather than the volume.
    const { impl } = feedRoutes(feedWith(3));

    const result = await pollCreator(
      deps({ fetchOptions: { fetchImpl: impl, lookup: publicLookup } }),
      creator(),
      polled,
    );

    expect(result.signals.map((signal) => signal.kind)).toEqual(['all-new']);
    expect(result.signals[0].detail).toContain('changed item id');
  });

  it('does not cry reset over a two-entry feed, where everything new means nothing', async () => {
    const { impl } = feedRoutes(feedWith(2));

    const result = await pollCreator(
      deps({ fetchOptions: { fetchImpl: impl, lookup: publicLookup } }),
      creator(),
      polled,
    );

    expect(result.signals).toEqual([]);
  });
});

// ── Retrying what failed ─────────────────────────────────────────────────────

describe('a failed item is retried, and its loss is said out loud', () => {
  const polled = { lastPolledAt: '2027-01-14T08:00:00.000Z', etag: null, lastModified: null, pollAfter: null, consecutiveFailures: 0 };
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  // Derived from the interval, not written as a fixed number of days. The retry
  // window is `3 * POLL_INTERVAL_MS`, so a fixture spelled "one day ago" was
  // inside the window at 1440 minutes and outside it at 15 — the tests broke on
  // the upgrade for a reason that had nothing to do with retrying.
  const INTERVAL = POLL_INTERVAL_MINUTES * 60_000;

  /** A post we tried to extract and could not, first met and last touched when it says. */
  function failedItem(firstSeenAgo: number, touchedAgo: number) {
    return {
      creator_id: 'c1',
      source: 'website',
      item_id: postId(0),
      url: 'https://chefsarah.test/post-0',
      status: 'failed',
      detail: 'The model timed out.',
      created_at: new Date(NOW - firstSeenAgo).toISOString(),
      updated_at: new Date(NOW - touchedAgo).toISOString(),
    };
  }

  it('gives it another go on the next pass', async () => {
    // The comment in the poller, the schema comment on `status` and the
    // `idx_source_items_failed` index all promise this. Without it one model
    // timeout loses one recipe permanently, and nothing anywhere says so.
    const { impl } = feedRoutes(feedWith(1));
    const importer = vi.fn(async () => success);
    fakeDb.seed('creator_source_items', [failedItem(INTERVAL, INTERVAL)]);

    const result = await pollCreator(
      deps({ importer: importer as unknown as PollDeps['importer'], fetchOptions: { fetchImpl: impl, lookup: publicLookup } }),
      creator(),
      polled,
    );

    expect(result.newItems).toBe(0);
    expect(result.retried).toBe(1);
    expect(result.drafted).toBe(1);
    expect(items()[0]).toMatchObject({ status: 'imported' });
  });

  it('leaves an item alone while its extraction may still be running', async () => {
    const { impl } = feedRoutes(feedWith(1));
    const importer = vi.fn(async () => success);
    fakeDb.seed('creator_source_items', [failedItem(DAY, 60_000)]);

    const result = await pollCreator(
      deps({ importer: importer as unknown as PollDeps['importer'], fetchOptions: { fetchImpl: impl, lookup: publicLookup } }),
      creator(),
      polled,
    );

    expect(result.retried).toBe(0);
    expect(importer).not.toHaveBeenCalled();
  });

  it('stops retrying once the attempts are spent, rather than paying forever', async () => {
    const { impl } = feedRoutes(feedWith(1));
    const importer = vi.fn(async () => success);
    fakeDb.seed('creator_source_items', [failedItem(4 * DAY, 4 * DAY)]);

    const result = await pollCreator(
      deps({ importer: importer as unknown as PollDeps['importer'], fetchOptions: { fetchImpl: impl, lookup: publicLookup } }),
      creator(),
      polled,
    );

    expect(result.retried).toBe(0);
    expect(importer).not.toHaveBeenCalled();
  });

  it('raises a signal on the attempt that turns out to be the last one', async () => {
    // The point of bounding the retries is that they end; the point of the
    // signal is that a recipe ending is a thing somebody is told about.
    const { impl } = feedRoutes(feedWith(1));
    const importer = vi.fn(async (url: string): Promise<ImportResult> => ({
      status: 'rejected', url, stage: 'extract', reason: 'timeout',
      detail: 'The model timed out again.', meta: { cached: false },
    }));
    fakeDb.seed('creator_source_items', [failedItem(2.5 * INTERVAL, INTERVAL)]);

    const result = await pollCreator(
      deps({ importer: importer as unknown as PollDeps['importer'], fetchOptions: { fetchImpl: impl, lookup: publicLookup } }),
      creator(),
      polled,
    );

    expect(result.retried).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.signals.map((signal) => signal.kind)).toEqual(['lost']);
    expect(result.signals[0].detail).toContain('https://chefsarah.test/post-0');
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
    expect(items().find((row) => row.item_id === postId(1))).toMatchObject({ status: 'failed' });
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

  it('queues the draft for the CREATOR, who is the one the email tells to review it', async () => {
    // The email says "Review and publish" and links to the creator portal. A
    // draft filed in the operator's queue makes that a request to act on
    // something they cannot open — and MEAL-89's page not existing yet is a
    // reason for the data to be right, not a reason for it to be wrong.
    const { impl } = feedRoutes(feedWith(1));
    const queue = vi.fn(async (_supabase: unknown, input: unknown) => { void input; return 'draft-1'; });

    await pollCreator(
      deps({ queue: queue as unknown as PollDeps['queue'], fetchOptions: { fetchImpl: impl, lookup: publicLookup } }),
      creator(),
      polled,
    );

    expect(queue.mock.calls[0][1]).toMatchObject({ reviewBy: 'creator' });
  });

  it('does not draft the same post twice when two passes overlap', async () => {
    // A 15-minute cron retried by Vercel, or an operator opening the endpoint by
    // hand. The UNIQUE key is documented as the guarantee against this, and it
    // can only be one if the row exists before the money is spent.
    fakeDb.unique('creator_source_items', ['creator_id', 'source', 'item_id']);
    const { impl } = feedRoutes(feedWith(1));
    const queue = vi.fn(async () => 'draft-1');
    const shared = deps({
      queue: queue as unknown as PollDeps['queue'],
      fetchOptions: { fetchImpl: impl, lookup: publicLookup },
    });

    const [one, two] = await Promise.all([
      pollCreator(shared, creator(), polled),
      pollCreator(shared, creator(), polled),
    ]);

    expect(queue).toHaveBeenCalledTimes(1);
    expect(items()).toHaveLength(1);
    expect([one.drafted, two.drafted].sort()).toEqual([0, 1]);
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
    // thing to go and look at, and an ever-growing interval hides that. A WEEK,
    // spelled out: `day * 7` is only the ceiling while the interval happens to
    // be a day, so it would follow the constant instead of pinning it.
    const week = 7 * 24 * 60 * 60_000;
    await poll(9);
    expect(state()?.poll_after).toBe(new Date(NOW + week).toISOString());
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
    expect(result.signals[0]?.kind).toBe('blocked');
    expect(result.signals[0]?.detail).toContain('previously working');
  });

  it('does not call a first-ever 403 a change — there is nothing it changed from', async () => {
    const { impl } = stubFetch({
      'https://chefsarah.test/robots.txt': { body: '' },
      'https://chefsarah.test/feed': { status: 403, body: 'forbidden' },
    });

    const result = await pollCreator(deps({ fetchOptions: { fetchImpl: impl, lookup: publicLookup } }), creator(), null);

    expect(result.status).toBe('blocked');
    expect(result.signals).toEqual([]);
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

  it('sends nothing after a poll that worked and found nothing new', async () => {
    // The quiet healthy case, which is the common one. A zero-entry feed does
    // NOT test it: it fails to parse, so the pass reports `no-feed` and never
    // reaches the email at all — the silence came from the failure path.
    fakeDb.seed('creators', [creatorRow()]);
    fakeDb.seed('creator_source_items', [
      { creator_id: 'c1', source: 'website', item_id: postId(0), status: 'seen' },
    ]);
    const { impl } = feedRoutes(feedWith(1));
    const notifier = vi.fn(async () => undefined);

    const pass = await runPollPass(deps({ notifier, fetchOptions: { fetchImpl: impl, lookup: publicLookup } }));

    expect(pass.polled).toBe(1);
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
    // Ordered on `creators.poll_queue_position_at`, in SQL. `never` has none at all,
    // which is the case the ordering is easiest to get backwards: Postgres sorts
    // NULLs LAST on ASC, so a query that does not ask for `nullsFirst` puts
    // every creator we have never polled at the very back of the queue.
    fakeDb.seed('creators', [
      creatorRow({ id: 'recent', website_url: 'https://recent.test/', feed_url: 'https://recent.test/feed', poll_queue_position_at: '2027-01-15T07:00:00.000Z' }),
      creatorRow({ id: 'stale', website_url: 'https://stale.test/', feed_url: 'https://stale.test/feed', poll_queue_position_at: '2027-01-01T07:00:00.000Z' }),
      creatorRow({ id: 'never', website_url: 'https://never.test/', feed_url: 'https://never.test/feed', poll_queue_position_at: null }),
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
    // And every one of them has taken their turn, so the next pass starts from
    // an order this pass has already moved on.
    expect(fakeDb.rows('creators').map((row) => row.poll_queue_position_at)).toEqual([NOW_ISO, NOW_ISO, NOW_ISO]);
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
    // One post already known, so this is a burst of new items rather than a
    // listing in which nothing is recognised — the second of those raises its
    // own signal, and this test is about the first.
    fakeDb.seed('creator_source_items', [{ creator_id: 'c1', source: 'website', item_id: postId(0), status: 'seen' }]);
    const { impl } = feedRoutes(feedWith(20));

    const pass = await runPollPass(deps({ fetchOptions: { fetchImpl: impl, lookup: publicLookup } }));

    expect(pass.signals).toHaveLength(1);
    expect(pass.signals[0]).toContain('19 new items');
  });

  it('counts sources whose listing failed, so a pass where everything failed is not a clean one', async () => {
    // `failed` counts ITEMS, and a source that could not be listed has no items
    // — so fifty creators all returning 500 reported polled: 0 and everything
    // else zero, which is character for character a quiet healthy pass.
    fakeDb.seed('creators', [creatorRow()]);
    fakeDb.seed('creator_source_state', [
      { creator_id: 'c1', source: 'website', last_polled_at: '2027-01-14T08:00:00.000Z', poll_after: null, consecutive_failures: 0 },
    ]);
    const { impl } = stubFetch({
      'https://chefsarah.test/robots.txt': { body: '' },
      'https://chefsarah.test/feed': { status: 500, body: 'boom' },
    });

    const pass = await runPollPass(deps({ fetchOptions: { fetchImpl: impl, lookup: publicLookup } }));

    expect(pass.sourcesFailed).toBe(1);
    expect(pass.polled).toBe(0);
    expect(state()?.consecutive_failures).toBe(1);
  });

  it('reaches the longest-waiting creator even when more are eligible than a pass can hold', async () => {
    // 101 opted-in creators. A `LIMIT` with no `ORDER BY` is a truncation rather
    // than a selection, so sorting the survivors sorts the wrong hundred:
    // Postgres returns the same rows every time, and the one at the back is
    // never polled and nothing says so.
    const rows = manyCreators(101).map((row, i) => ({
      ...row,
      // The last row is the one waiting longest — and the one a bare LIMIT drops.
      poll_queue_position_at: i === 100 ? '2020-01-01T00:00:00.000Z' : '2027-01-15T07:00:00.000Z',
    }));
    fakeDb.seed('creators', rows);
    const { impl, calls } = stubFetch(feedRoutesFor(rows));

    const pass = await runPollPass(deps({ fetchOptions: { fetchImpl: impl, lookup: publicLookup } }));

    expect(calls).toContain('https://c100.test/feed');
    expect(pass.polled + pass.baselined).toBe(POLL_CREATOR_BATCH);
    // The hundred-and-first is not "skipped" — nothing dropped them. They are
    // still in the queue, and `eligible` is where a queue longer than a pass
    // shows up.
    expect(pass.skipped).toBe(0);
    expect(pass.eligible).toBe(101);
    // And the state read is inside the URI ceiling, because an `.in()` filter
    // travels in the query string.
    const stateReads = fakeDb.calls.filter((call) => call.table === 'creator_source_state' && call.method === 'in');
    expect(Math.max(...stateReads.map((call) => call.args[1].length))).toBeLessThanOrEqual(POLL_CREATOR_BATCH);
  });

  it('reaches every creator within three passes when two and a half times a batch are eligible', async () => {
    // The test the single-pass ones cannot be. 250 creators and a batch of 100:
    // whatever one pass does looks correct, and the defect is only ever visible
    // across passes — the same hundred rows come back, get sorted, get polled,
    // and creators 101 to 250 are never polled again as long as the system runs.
    // No error, no signal, no count that moves.
    const rows = manyCreators(250);
    fakeDb.seed('creators', rows);
    const { impl, calls } = stubFetch(feedRoutesFor(rows));

    const polled: string[] = [];
    // A day and a half per pass, so the `poll_after` a successful poll writes
    // has expired by the next one. Backoff decides whether a creator is polled
    // when their turn comes; it must not be what decides whose turn it is.
    for (let pass = 0; pass < 3; pass++) {
      calls.length = 0;
      await runPollPass(deps({ now: () => NOW + pass * 36 * 3_600_000, fetchOptions: { fetchImpl: impl, lookup: publicLookup } }));
      for (const url of calls) if (url.endsWith('/feed')) polled.push(new URL(url).hostname);
    }

    // Everybody, inside the three passes 250 creators at 100 a pass needs.
    expect(new Set(polled).size).toBe(250);
    // And nobody twice while somebody was still waiting for their first. This
    // is the assertion the bug fails: with the ordering broken, passes two and
    // three re-poll the same hundred and the first repeat arrives while 150
    // creators have never been polled at all.
    const seen = new Set<string>();
    let firstRepeat = polled.length;
    for (let i = 0; i < polled.length; i++) {
      if (seen.has(polled[i])) { firstRepeat = i; break; }
      seen.add(polled[i]);
    }
    expect(new Set(polled.slice(0, firstRepeat)).size).toBe(250);
  });

  it('sorts a creator who has never been polled ahead of one polled long ago', async () => {
    // Postgres puts NULLs LAST on ASC. A creator with no `poll_queue_position_at` has
    // waited the longest by definition, so the query has to say `nullsFirst` —
    // and a fake that models NULL as an empty string agrees with the code
    // instead of with the database and hides exactly this.
    const rows = manyCreators(101).map((row, i) => ({
      ...row,
      // Everyone has been polled recently except the last, who has never been
      // polled at all. Without `nullsFirst` they are last in line, forever.
      poll_queue_position_at: i === 100 ? null : '2027-01-15T07:00:00.000Z',
    }));
    fakeDb.seed('creators', rows);
    const { impl, calls } = stubFetch(feedRoutesFor(rows));

    await runPollPass(deps({ fetchOptions: { fetchImpl: impl, lookup: publicLookup } }));

    expect(calls.filter((url) => url.endsWith('/feed'))[0]).toBe('https://c100.test/feed');
  });

  it('moves a creator whose source keeps failing to the back of the queue anyway', async () => {
    // A permanently-failing creator that never advances is the starvation bug
    // wearing a different hat: they sort first, they fail, they sort first
    // again, and every creator behind them waits on a feed that is never going
    // to answer.
    fakeDb.seed('creators', [creatorRow({ poll_queue_position_at: '2020-01-01T00:00:00.000Z' })]);
    const { impl } = stubFetch({
      'https://chefsarah.test/robots.txt': { body: '' },
      'https://chefsarah.test/feed': { status: 500, body: 'boom' },
    });

    const pass = await runPollPass(deps({ fetchOptions: { fetchImpl: impl, lookup: publicLookup } }));

    expect(pass.sourcesFailed).toBe(1);
    // The turn was taken. The two `poll_queue_position_at` columns say different things
    // on purpose and this is where they part: the one on `creators` is a queue
    // position and has to advance on a failure, and the one on
    // `creator_source_state` means "when we last successfully LISTED this
    // source" — advancing that on a failed attempt would tell the next pass the
    // baseline had run and import the creator's whole back catalogue.
    expect(fakeDb.row('creators', 'c1')?.poll_queue_position_at).toBe(NOW_ISO);
    expect(state()?.last_polled_at).toBeNull();
    // And the backoff is untouched by any of it.
    expect(state()?.consecutive_failures).toBe(1);
    expect(state()?.poll_after).toBe(new Date(NOW + 2 * POLL_INTERVAL_MINUTES * 60_000).toISOString());
  });

  it('does not let a hundred backing-off creators hold the queue against the one behind them', async () => {
    // `poll_after` decides WHETHER a creator is polled when their turn comes up.
    // It must not be what decides WHOSE turn it is: a hundred creators inside a
    // seven-day backoff, all sorting ahead of everyone, fill every slot in the
    // batch with work the pass then declines to do — and creator 101 is never
    // reached, for a week, with `skipped: 100` the only trace.
    const rows = manyCreators(101).map((row, i) => ({
      ...row,
      last_polled_at: i === 100 ? '2027-01-14T00:00:00.000Z' : '2027-01-01T00:00:00.000Z',
    }));
    fakeDb.seed('creators', rows);
    fakeDb.seed(
      'creator_source_state',
      rows.slice(0, 100).map((row) => ({
        creator_id: row.id,
        source: 'website',
        last_polled_at: '2027-01-01T00:00:00.000Z',
        poll_after: new Date(NOW + 7 * 24 * 3_600_000).toISOString(),
        consecutive_failures: 5,
      })),
    );
    const { impl, calls } = stubFetch(feedRoutesFor(rows));

    const first = await runPollPass(deps({ fetchOptions: { fetchImpl: impl, lookup: publicLookup } }));

    expect(first.skipped).toBe(100);
    expect(calls).toHaveLength(0);

    calls.length = 0;
    const second = await runPollPass(deps({ fetchOptions: { fetchImpl: impl, lookup: publicLookup } }));

    // The hundred took their turn without being polled, so the one behind them
    // is at the front now. Their own backoff is unchanged — nothing about
    // taking a turn shortens or lengthens it.
    expect(calls.filter((url) => url.endsWith('/feed'))).toEqual(['https://c100.test/feed']);
    expect(second.baselined).toBe(1);
    expect(fakeDb.rows('creator_source_state').find((row) => row.creator_id === 'c0')?.poll_after)
      .toBe(new Date(NOW + 7 * 24 * 3_600_000).toISOString());
  });

  it('leaves the creators a short pass never reached at the front of the next one', async () => {
    // The budget is a wall clock, not a row count, so where a pass stops is not
    // knowable in advance. What has to be true is that stopping is a delay
    // rather than a loss: an unreached creator is untouched, keeps the older
    // timestamp that put them in this batch, and leads the next pass.
    fakeDb.seed('creators', [
      creatorRow({ id: 'a', user_id: 'ua', website_url: 'https://a.test/', feed_url: 'https://a.test/feed', poll_queue_position_at: null }),
      creatorRow({ id: 'b', user_id: 'ub', website_url: 'https://b.test/', feed_url: 'https://b.test/feed', poll_queue_position_at: null }),
      creatorRow({ id: 'c', user_id: 'uc', website_url: 'https://c.test/', feed_url: 'https://c.test/feed', poll_queue_position_at: null }),
    ]);
    const routes = feedRoutesFor([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    const { impl: fast, calls } = stubFetch(routes);
    // Every fetch costs 60ms of real time, so the first creator alone — robots
    // and feed — overruns a 100ms budget.
    const slow = (async (...args: Parameters<typeof fetch>) => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return fast(...args);
    }) as unknown as typeof fetch;

    const short = await runPollPass(
      deps({ deadline: Date.now() + 100, fetchOptions: { fetchImpl: slow, lookup: publicLookup } }),
    );

    expect(short.skipped).toBe(2);
    expect(fakeDb.rows('creators').map((row) => row.poll_queue_position_at)).toEqual([NOW_ISO, null, null]);

    calls.length = 0;
    await runPollPass(deps({ now: () => NOW + 36 * 3_600_000, fetchOptions: { fetchImpl: fast, lookup: publicLookup } }));

    expect(calls.filter((url) => url.endsWith('/feed'))).toEqual([
      'https://b.test/feed',
      'https://c.test/feed',
      'https://a.test/feed',
    ]);
  });

  it('emails each creator as their drafts land, not after every creator has been polled', async () => {
    // The pass has a 240s budget under a 300s function limit, and the deadline
    // is checked before each item — so one long extraction can overshoot and the
    // send loop at the end never runs. The drafts are already recorded
    // `imported`, so they are never new again: nobody is ever told, and there is
    // no path by which they could be.
    const order: string[] = [];
    fakeDb.seed('creators', [
      creatorRow({ id: 'first', user_id: 'u-first', website_url: 'https://first.test/', feed_url: 'https://first.test/feed' }),
      creatorRow({ id: 'second', user_id: 'u-second', website_url: 'https://second.test/', feed_url: 'https://second.test/feed' }),
    ]);
    fakeDb.seed('creator_source_state', [
      { creator_id: 'first', source: 'website', last_polled_at: '2027-01-01T00:00:00.000Z', poll_after: null, consecutive_failures: 0 },
      { creator_id: 'second', source: 'website', last_polled_at: '2027-01-10T00:00:00.000Z', poll_after: null, consecutive_failures: 0 },
    ]);
    fakeDb.seed('user_profiles', [
      { id: 'u-first', email: 'first@test' },
      { id: 'u-second', email: 'second@test' },
    ]);
    const impl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/feed')) order.push(`poll:${new URL(url).hostname}`);
      return new Response(url.endsWith('robots.txt') ? '' : feedWith(1), {
        status: 200,
        headers: { 'content-type': 'application/rss+xml' },
      });
    }) as unknown as typeof fetch;
    const notifier = vi.fn(async (to: string) => {
      order.push(`email:${to}`);
    });

    const pass = await runPollPass(deps({ notifier, fetchOptions: { fetchImpl: impl, lookup: publicLookup } }));

    expect(pass.emailsSent).toBe(2);
    expect(order).toEqual(['poll:first.test', 'email:first@test', 'poll:second.test', 'email:second@test']);
  });
});
