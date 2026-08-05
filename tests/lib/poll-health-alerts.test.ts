import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FakeSupabase } from '../helpers/supabase-mock';
import { runPollHealthAlerts } from '@/lib/poll-health-alerts';
import { SILENT_AFTER_DAYS } from '@/lib/poll-health';

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

/** The last post polling saw for them. This is what silence is measured from. */
function item(creatorId: string, seenDaysAgo: number) {
  return { creator_id: creatorId, created_at: daysAgo(seenDaysAgo) };
}

function sweep() {
  return runPollHealthAlerts({ supabase: db as any, now: () => NOW, notifier });
}

/** The digest's rows from the one send, or [] if nothing was sent. */
function digest() {
  return notifier.mock.calls[0]?.[0]?.sources ?? [];
}

function stored(creatorId: string) {
  return db.rows('creator_source_state').find((row) => row.creator_id === creatorId);
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
});
