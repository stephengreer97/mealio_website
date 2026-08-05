import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DEFAULT_PAGE_ROWS, FakeSupabase } from '../helpers/supabase-mock';
import { runPollHealthAlerts } from '@/lib/poll-health-alerts';
import { SILENT_AFTER_DAYS } from '@/lib/poll-health';
import { DIGEST_ROWS } from '@/lib/email';

vi.mock('@/lib/logger', () => ({ log: vi.fn() }));

/**
 * The alert that turns MEAL-96's screen into something an operator is told.
 *
 * Two properties carry this feature, and neither is visible in a single run:
 *
 *  - It fires on a **transition**, not on a state. Every one of these tests that
 *    runs the sweep twice is about the second run, because a sweep that emails
 *    whenever a source is unhealthy is a sweep an operator filters to a folder
 *    inside a week — at which point the alert is worse than none, since everyone
 *    believes it is working.
 *  - The judgement is `pollStatus`'s, not this module's. The thresholds below
 *    are imported rather than written out for that reason: a test that spells
 *    "30 days" itself would keep passing after the two definitions diverged,
 *    which is the exact failure the design is trying to prevent.
 */

const NOW = Date.parse('2026-03-01T12:00:00.000Z');
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(NOW - n * DAY).toISOString();

const db = new FakeSupabase();
const notifier = vi.fn();

/** A creator whose source is actually being polled. */
function creator(id: string, extra: Record<string, any> = {}) {
  return {
    id,
    display_name: `Chef ${id}`,
    handle: `@${id}`,
    import_opt_in: true,
    primary_source: 'website',
    ...extra,
  };
}

/** Their `creator_source_state` row: polled cleanly this morning by default. */
function state(creatorId: string, extra: Record<string, any> = {}) {
  return {
    creator_id: creatorId,
    source: 'website',
    last_polled_at: daysAgo(0),
    poll_after: null,
    consecutive_failures: 0,
    last_failed_at: null,
    last_error: null,
    last_status: null,
    health_alerted_status: null,
    health_alerted_at: null,
    ...extra,
  };
}

/**
 * The last post polling saw for them. This is what silence is measured from.
 *
 * `source` is carried because the column exists and is NOT NULL: an item belongs
 * to the source it came off, and a creator moved from one to another still has
 * every one of the old source's posts in this table.
 */
function item(creatorId: string, seenDaysAgo: number, source = 'website') {
  return { creator_id: creatorId, source, created_at: daysAgo(seenDaysAgo) };
}

function sweep() {
  return runPollHealthAlerts({ supabase: db as any, now: () => NOW, notifier });
}

/** The digest's rows from the one send, or [] if nothing was sent. */
function digest() {
  return notifier.mock.calls[0]?.[0]?.sources ?? [];
}

function stored(creatorId: string, source = 'website') {
  return db.rows('creator_source_state').find((row) => row.creator_id === creatorId && row.source === source);
}

beforeEach(() => {
  db.reset();
  notifier.mockReset();
  notifier.mockResolvedValue(undefined);
  // The real recipient list, so the wiring to `adminNotifyEmails` is exercised
  // rather than stubbed past.
  db.seed('user_profiles', [{ email: 'ops@mealio.co', is_admin: true }]);
});

describe('a source going unhealthy', () => {
  it('emails an operator the first time a source is producing nothing', async () => {
    db.seed('creators', [creator('sarah')]);
    db.seed('creator_source_state', [state('sarah')]);
    db.seed('creator_source_items', [item('sarah', SILENT_AFTER_DAYS + 15)]);

    const pass = await sweep();

    expect(pass).toMatchObject({ examined: 1, unhealthy: 1, alerted: 1, emailsSent: 1 });
    expect(notifier).toHaveBeenCalledTimes(1);
    expect(notifier.mock.calls[0][0].adminEmails).toEqual(['ops@mealio.co']);
    // The status word is `pollStatus`'s, and the days are what an operator
    // actually decides on — a month and a year both read as "producing nothing".
    expect(digest()[0]).toMatchObject({
      creatorName: 'Chef sarah',
      handle: '@sarah',
      sourceLabel: 'Website',
      status: 'silent',
      quietDays: SILENT_AFTER_DAYS + 15,
    });
  });

  it('says nothing the next day while it is still silent', async () => {
    db.seed('creators', [creator('sarah')]);
    db.seed('creator_source_state', [state('sarah')]);
    db.seed('creator_source_items', [item('sarah', 60)]);

    await sweep();
    const second = await sweep();

    // The suppression lives in the row, not in the process: this is a second
    // cron invocation reading what the first one wrote.
    expect(stored('sarah')?.health_alerted_status).toBe('silent');
    expect(notifier).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ unhealthy: 1, suppressed: 1, alerted: 0, emailsSent: 0 });
  });

  it('raises it again when a silent source starts erroring, because that is a different problem', async () => {
    db.seed('creators', [creator('sarah')]);
    db.seed('creator_source_state', [state('sarah', {
      health_alerted_status: 'silent',
      consecutive_failures: 6,
      last_failed_at: daysAgo(2),
      last_error: 'HTTP 500',
    })]);
    db.seed('creator_source_items', [item('sarah', 60)]);

    const pass = await sweep();

    expect(pass.alerted).toBe(1);
    expect(digest()[0]).toMatchObject({ status: 'failing', consecutiveFailures: 6, lastError: 'HTTP 500' });
    expect(stored('sarah')?.health_alerted_status).toBe('failing');
  });

  it('re-arms when the source recovers, so the next break is raised too', async () => {
    db.seed('creators', [creator('sarah')]);
    db.seed('creator_source_state', [state('sarah', { health_alerted_status: 'silent' })]);
    db.seed('creator_source_items', [item('sarah', 1)]);

    const recovery = await sweep();

    expect(recovery).toMatchObject({ unhealthy: 0, recovered: 1, emailsSent: 0 });
    expect(stored('sarah')?.health_alerted_status).toBeNull();
    expect(stored('sarah')?.health_alerted_at).toBeNull();

    // And it breaks again. Without the clear above, this second break is silent
    // forever — the mark is only ever cleared by a recovery.
    db.seed('creator_source_items', [item('sarah', 90)]);
    const relapse = await sweep();

    expect(relapse.alerted).toBe(1);
    expect(notifier).toHaveBeenCalledTimes(1);
  });
});

describe('what must never produce an email', () => {
  it('leaves a creator whose import an operator paused alone', async () => {
    // Silent by construction: nothing has polled them since the pause, so the
    // last item ages past the threshold and stays there. That is the pause
    // working, and alerting on it makes every deliberate pause a false alarm a
    // month later.
    db.seed('creators', [creator('sarah', { import_opt_in: false })]);
    db.seed('creator_source_state', [state('sarah')]);
    db.seed('creator_source_items', [item('sarah', 200)]);

    const pass = await sweep();

    expect(pass).toMatchObject({ examined: 0, emailsSent: 0 });
    expect(notifier).not.toHaveBeenCalled();
  });

  it('leaves a creator nobody has set polling up for alone', async () => {
    // No state row at all — `unconfigured`. Nothing is broken about them, and
    // floating them into an alert is how the alert earns a filter rule.
    db.seed('creators', [creator('newbie')]);
    db.seed('creator_source_state', []);

    const pass = await sweep();

    expect(pass).toMatchObject({ examined: 0, unhealthy: 0, emailsSent: 0 });
  });

  it('leaves a source with a failure or two alone — that is weather', async () => {
    db.seed('creators', [creator('sarah'), creator('luis')]);
    db.seed('creator_source_state', [
      state('sarah', { consecutive_failures: 1, last_failed_at: daysAgo(0) }),
      state('luis'),
    ]);
    db.seed('creator_source_items', [item('sarah', 2), item('luis', 2)]);

    const pass = await sweep();

    expect(pass).toMatchObject({ examined: 2, unhealthy: 0, emailsSent: 0 });
  });
});

describe('when the email does not happen', () => {
  it('marks nothing when the send fails, so the next sweep raises it again', async () => {
    db.seed('creators', [creator('sarah')]);
    db.seed('creator_source_state', [state('sarah')]);
    db.seed('creator_source_items', [item('sarah', 60)]);
    notifier.mockRejectedValueOnce(new Error('Resend refused the poll health alert email'));

    const failed = await sweep();

    expect(failed).toMatchObject({ alerted: 0, emailsSent: 0 });
    // The mark means "an operator has been told". Writing it on a send that was
    // refused would suppress every future sweep for this source.
    expect(stored('sarah')?.health_alerted_status).toBeNull();

    const retry = await sweep();
    expect(retry).toMatchObject({ alerted: 1, emailsSent: 1 });
  });

  it('sends nothing at all when it cannot read what it has already reported', async () => {
    db.seed('creators', [creator('sarah')]);
    db.seed('creator_source_state', [state('sarah')]);
    db.seed('creator_source_items', [item('sarah', 60)]);
    // What a deploy that landed ahead of `add-poll-health-alert-state.sql` gets
    // back. Treated as "nothing has been reported yet" it would make every
    // unhealthy source a fresh transition every day — the daily spam this whole
    // design is built to avoid — so the sweep fails closed instead.
    // Two queued results because two reads hit this table: `pollHealthByCreator`
    // asks for the columns that have always been there and is answered normally,
    // and only the read of the new column fails.
    db.queue('creator_source_state', { data: [state('sarah')], error: null });
    db.queue('creator_source_state', {
      data: null,
      error: { code: '42703', message: 'column creator_source_state.health_alerted_status does not exist' },
    });

    await expect(sweep()).rejects.toThrow(/health_alerted_status/);
    expect(notifier).not.toHaveBeenCalled();
  });

  it('does not mark when there is nobody to tell', async () => {
    db.seed('user_profiles', []);
    delete process.env.ADMIN_EMAIL;
    db.seed('creators', [creator('sarah')]);
    db.seed('creator_source_state', [state('sarah')]);
    db.seed('creator_source_items', [item('sarah', 60)]);

    const pass = await sweep();

    expect(notifier).not.toHaveBeenCalled();
    expect(pass).toMatchObject({ unhealthy: 1, alerted: 0, emailsSent: 0 });
    expect(stored('sarah')?.health_alerted_status).toBeNull();
  });
});

describe('the digest', () => {
  it('is one email for everything that changed, worst first', async () => {
    db.seed('creators', [creator('sarah'), creator('luis'), creator('mei')]);
    db.seed('creator_source_state', [
      state('sarah'),
      state('luis', { consecutive_failures: 8, last_failed_at: daysAgo(1), last_error: 'ECONNREFUSED' }),
      state('mei'),
    ]);
    db.seed('creator_source_items', [item('sarah', 45), item('luis', 3), item('mei', 200)]);

    const pass = await sweep();

    expect(notifier).toHaveBeenCalledTimes(1);
    expect(pass).toMatchObject({ examined: 3, unhealthy: 3, alerted: 3, emailsSent: 1 });
    // Ordered by `pollConcern`, the same score the Sources tab sorts on, so the
    // email and the screen it links to agree about what to look at first — and
    // that score is why seven months of silence outranks eight failures in a
    // row, rather than "failing" simply beating "silent".
    expect(digest().map((row: { creatorName: string }) => row.creatorName)).toEqual([
      'Chef mei', 'Chef luis', 'Chef sarah',
    ]);
  });

  /**
   * The overflow line is a count, not a report.
   *
   * A digest lists `DIGEST_ROWS` cards and summarises the rest. Marking all of
   * them as reported meant the summarised ones were never NAMED in any email —
   * the mark suppresses every later sweep, and the only thing that would ever
   * bring them back was recovering and breaking again. Worst on the first sweep
   * after a deploy, which is exactly when the backlog is largest.
   */
  it('names the sources it defers instead of burying them, on the next day', async () => {
    // Silent for longer the higher the number, so `pollConcern` orders them
    // predictably and "the tail of the list" is a set this test can name.
    const many = Array.from({ length: DIGEST_ROWS + 5 }, (_, i) => `c${String(i).padStart(2, '0')}`);
    db.seed('creators', many.map((id) => creator(id)));
    db.seed('creator_source_state', many.map((id) => state(id)));
    db.seed('creator_source_items', many.map((id, i) => item(id, SILENT_AFTER_DAYS + 10 + i)));

    const first = await sweep();

    // Every one of them is in the email — the count and the subject are honest.
    expect(digest()).toHaveLength(DIGEST_ROWS + 5);
    // But only the ones with a card of their own are recorded as reported.
    expect(first).toMatchObject({ unhealthy: DIGEST_ROWS + 5, alerted: DIGEST_ROWS, deferred: 5, emailsSent: 1 });
    const marked = many.filter((id) => stored(id)?.health_alerted_status === 'silent');
    expect(marked).toHaveLength(DIGEST_ROWS);

    const second = await sweep();

    // The five nobody was told about by name are the whole of the next digest,
    // rather than sources that are unhealthy forever and never mentioned again.
    expect(second).toMatchObject({ alerted: 5, deferred: 0, emailsSent: 1 });
    const namedNow = notifier.mock.calls[1][0].sources.map((row: { creatorName: string }) => row.creatorName);
    expect(namedNow).toHaveLength(5);
    expect(new Set(namedNow)).toEqual(new Set(many.slice(0, 5).map((id) => `Chef ${id}`)));
  });
});

/**
 * The read that judges everybody at once, at a size where PostgREST truncates.
 *
 * `creator_source_items` is append-only, so an unordered select comes back
 * oldest-first and the 1000-row page ceiling cuts the newest rows — the only
 * ones `lastNewItemAt` is asking about — with no error and nothing saying the
 * answer was short. The failure mode is not a missing alert, it is the loudest
 * possible false one: every creator reads as having last produced something
 * months ago, so every creator is `silent`, all of them are emailed about at
 * once, and all of them are marked so the wrong verdict sticks.
 */
describe('at a scale where one page is not the whole table', () => {
  const CREATORS = 100;
  const OLD_PER_CREATOR = 10;
  const RECENT_PER_CREATOR = 2;
  const ids = Array.from({ length: CREATORS }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);

  it('does not call a hundred creators who posted yesterday silent', async () => {
    db.seed('creators', ids.map((id) => creator(id)));
    db.seed('creator_source_state', ids.map((id) => state(id)));

    // Seeded in the order an append-only table holds them: oldest first, all
    // creators interleaved. The ten old rows each come to exactly one page, so
    // an unordered read returns those and nothing else — and the two rows per
    // creator that say they posted this week are precisely what falls off.
    const rows: Array<Record<string, any>> = [];
    for (let age = 200; age > 200 - OLD_PER_CREATOR; age--) {
      for (const id of ids) rows.push(item(id, age));
    }
    for (const age of [2, 1]) {
      for (const id of ids) rows.push(item(id, age));
    }
    expect(rows).toHaveLength(CREATORS * (OLD_PER_CREATOR + RECENT_PER_CREATOR));
    expect(CREATORS * OLD_PER_CREATOR).toBe(DEFAULT_PAGE_ROWS);
    db.seed('creator_source_items', rows);

    const pass = await sweep();

    // All hundred are looked at, and not one of them is a problem.
    expect(pass).toMatchObject({ examined: CREATORS, unhealthy: 0, alerted: 0, emailsSent: 0 });
    expect(notifier).not.toHaveBeenCalled();
    // And nothing was written, so tomorrow is not suppressed by today's mistake.
    expect(db.rows('creator_source_state').some((row) => row.health_alerted_status !== null)).toBe(false);
  });

  it('examines every eligible creator, not the first arbitrary five hundred', async () => {
    // The sweep used to read creators with a bare `.limit(500)`: past that,
    // an unstable arbitrary five hundred were judged and the rest were never
    // alerted on, with nothing anywhere saying a limit had been reached.
    const many = Array.from({ length: 600 }, (_, i) => `c${String(i).padStart(3, '0')}`);
    db.seed('creators', many.map((id) => creator(id)));
    db.seed('creator_source_state', many.map((id) => state(id)));
    db.seed('creator_source_items', many.map((id) => item(id, 90)));

    const pass = await sweep();

    expect(pass.examined).toBe(600);
    expect(pass.unhealthy).toBe(600);
  });
});

/**
 * One creator, two `creator_source_state` rows.
 *
 * The primary key is `(creator_id, source)` and the admin PATCH that moves a
 * creator from their blog to their channel never deletes the row it moved them
 * off. Folding every row for a creator into one entry means last-row-wins in an
 * order PostgREST does not define — so the source that is actually polled is
 * never judged, the email names the wrong platform, and the mark that suppresses
 * tomorrow's repeat lands on a row nothing reads.
 */
describe('a creator whose source was changed', () => {
  beforeEach(() => {
    db.seed('creators', [creator('maya', { primary_source: 'youtube' })]);
    db.seed('creator_source_state', [
      // The leftover. Its numbers are stale and healthy-looking, and it is first
      // in every order a database might hand these back in.
      state('maya', { source: 'website' }),
      state('maya', { source: 'youtube' }),
    ]);
    db.seed('creator_source_items', [
      item('maya', 1, 'website'),
      item('maya', 90, 'youtube'),
    ]);
  });

  it('judges the source the creator is actually polled on', async () => {
    const pass = await sweep();

    expect(pass).toMatchObject({ examined: 1, unhealthy: 1, alerted: 1, emailsSent: 1 });
    // The live source, by name, and its own silence — not the blog's recent post.
    expect(digest()).toHaveLength(1);
    expect(digest()[0]).toMatchObject({ sourceLabel: 'YouTube', status: 'silent', quietDays: 90 });
  });

  it('marks the row it judged, not the one it did not', async () => {
    await sweep();

    expect(stored('maya', 'youtube')?.health_alerted_status).toBe('silent');
    // A mark on the leftover would suppress nothing and confuse the next reader.
    expect(stored('maya', 'website')?.health_alerted_status).toBeNull();

    // And the suppression works, which it cannot if the mark is on the wrong row.
    const second = await sweep();
    expect(second).toMatchObject({ suppressed: 1, alerted: 0, emailsSent: 0 });
  });
});

/**
 * Hysteresis: one unfixed source is one conversation, not one a day.
 *
 * Both sequences below are a single source nobody has touched, and under a plain
 * "has the word changed?" test both produced a fresh email every time the word
 * moved. An operator who is mailed daily about something they already know about
 * filters the alert to a folder, and from then on it is worse than not having
 * one, because everybody believes it is working.
 */
describe('a source that flaps', () => {
  function setState(creatorId: string, values: Record<string, any>) {
    Object.assign(stored(creatorId)!, values);
  }

  it('does not treat a dip to a failure or two as the source coming back', async () => {
    db.seed('creators', [creator('sarah')]);
    db.seed('creator_source_state', [state('sarah', { consecutive_failures: 6, last_failed_at: daysAgo(1) })]);
    db.seed('creator_source_items', [item('sarah', 2)]);

    await sweep();
    expect(stored('sarah')?.health_alerted_status).toBe('failing');

    // The backoff does its job for a day and the count falls back to `wobbling`.
    // That is weather, not a fix — and it used to clear the mark, which re-armed
    // the alert for the very next poll that failed.
    setState('sarah', { consecutive_failures: 1 });
    const dip = await sweep();
    expect(dip).toMatchObject({ recovered: 0, emailsSent: 0 });
    expect(stored('sarah')?.health_alerted_status).toBe('failing');

    // Back to failing, same unfixed source, same day-old news.
    setState('sarah', { consecutive_failures: 6 });
    const again = await sweep();
    expect(again).toMatchObject({ suppressed: 1, alerted: 0, emailsSent: 0 });
    expect(notifier).toHaveBeenCalledTimes(1);
  });

  it('says the escalation once and does not say it again when it drops back', async () => {
    // A chronically silent source that errors intermittently: the count crosses
    // three and resets, so the status flips silent → failing → silent → failing.
    // Five days of one dead blog used to be five emails.
    db.seed('creators', [creator('sarah')]);
    db.seed('creator_source_state', [state('sarah')]);
    db.seed('creator_source_items', [item('sarah', 120)]);

    await sweep();
    expect(stored('sarah')?.health_alerted_status).toBe('silent');

    // Worth saying out loud once: a quiet source that has started erroring is a
    // different problem with a different fix.
    setState('sarah', { consecutive_failures: 4, last_failed_at: daysAgo(0) });
    const escalation = await sweep();
    expect(escalation).toMatchObject({ alerted: 1, emailsSent: 1 });
    expect(stored('sarah')?.health_alerted_status).toBe('failing');

    // And then nothing more, either way it flips.
    setState('sarah', { consecutive_failures: 0 });
    expect(await sweep()).toMatchObject({ suppressed: 1, alerted: 0, emailsSent: 0 });
    setState('sarah', { consecutive_failures: 5 });
    expect(await sweep()).toMatchObject({ suppressed: 1, alerted: 0, emailsSent: 0 });

    // Two emails about two genuinely different things, over four days.
    expect(notifier).toHaveBeenCalledTimes(2);
    // The mark stays at the worse of the two, so the drop back cannot re-arm it.
    expect(stored('sarah')?.health_alerted_status).toBe('failing');
  });

  it('still re-arms when the source is genuinely polling and producing again', async () => {
    db.seed('creators', [creator('sarah')]);
    db.seed('creator_source_state', [state('sarah', { health_alerted_status: 'failing', consecutive_failures: 6 })]);
    db.seed('creator_source_items', [item('sarah', 1)]);

    setState('sarah', { consecutive_failures: 0 });
    const pass = await sweep();

    expect(pass).toMatchObject({ recovered: 1, emailsSent: 0 });
    expect(stored('sarah')?.health_alerted_status).toBeNull();
  });
});
