import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FakeSupabase } from '../helpers/supabase-mock';
import { runFunnelAlerts } from '@/lib/funnel-alerts';
import { DEFAULT_BLOCKED_RATE_THRESHOLD } from '@/lib/automation-funnel';

vi.mock('@/lib/logger', () => ({ log: vi.fn() }));

/**
 * MEAL-6's alert: the funnel's own judgement, arriving without being asked for.
 *
 * Two properties carry this and neither is visible in a single run:
 *
 *  - It fires on a **transition**, not on a state. Every test here that sweeps
 *    twice is about the second sweep. A daily job with no hysteresis mails every
 *    admin every morning about one broken store until somebody fixes it, which is
 *    how the alert earns a filter rule — and an alert in a folder is worse than
 *    none, because everyone believes it is working.
 *  - The judgement is `aggregateFunnel`'s, not this module's. The threshold below
 *    is imported rather than written out for that reason: a test that spelled
 *    "3%" itself would keep passing after the page and the email had drifted
 *    apart, which is the exact failure the design is trying to prevent.
 */

const NOW = Date.parse('2026-03-08T14:00:00.000Z');
const HOUR = 3_600_000;
const iso = (hoursAgo: number) => new Date(NOW - hoursAgo * HOUR).toISOString();

const db = new FakeSupabase();
const notifier = vi.fn();

let runSeq = 0;

/** A run of `requested` items that added `added`, `hoursAgo` before NOW. */
function runRow(hoursAgo: number, requested: number, added: number, store = 'heb') {
  return {
    id: `run-${store}-${runSeq++}`,
    store_id: store,
    outcome: added === requested ? 'success' : 'partial',
    status: 'completed',
    items_requested: requested,
    items_added: added,
    started_at: iso(hoursAgo),
    completed_at: iso(hoursAgo),
  };
}

let stepSeq = 0;

function stepRow(over: Record<string, any>) {
  return {
    id: `step-${stepSeq++}`,
    store_id: 'heb',
    run_id: null,
    step: 'add_click',
    outcome: 'ok',
    code: null,
    duration_ms: 100,
    detail: null,
    occurred_at: iso(6),
    ...over,
  };
}

/** Seven healthy days: 3 runs a day, all ten items added. */
function healthyBaseline(store = 'heb') {
  const runs: any[] = [];
  for (let day = 1; day <= 7; day++) {
    for (let i = 0; i < 3; i++) runs.push(runRow(day * 24 + 12, 10, 10, store));
  }
  return runs;
}

/** Today, after somebody renamed a product-tile selector: 4 of 10 items land. */
function brokenToday(store = 'heb') {
  return Array.from({ length: 5 }, () => runRow(6, 10, 4, store));
}

function sweep() {
  return runFunnelAlerts({ supabase: db as any, now: () => NOW, notifier });
}

/** The stores in the one send, or [] if nothing was sent. */
function digest() {
  return notifier.mock.calls[0]?.[0]?.stores ?? [];
}

function stored(storeId = 'heb') {
  return db.rows('automation_alert_state').find((r) => r.store_id === storeId);
}

beforeEach(() => {
  db.reset();
  notifier.mockReset();
  notifier.mockResolvedValue(undefined);
  runSeq = 0;
  stepSeq = 0;
  // Seeded empty rather than left absent: an unseeded table in the fake swallows
  // writes without erroring, so the marks a test asserts on would never land.
  db.seed('automation_alert_state', []);
  db.seed('automation_runs', []);
  db.seed('automation_steps', []);
  db.seed('stores', [{ id: 'heb', name: 'H-E-B' }, { id: 'kroger', name: 'Kroger' }]);
  // The real recipient list, so the wiring to `adminNotifyEmails` is exercised
  // rather than stubbed past.
  db.seed('user_profiles', [{ email: 'ops@mealio.co', is_admin: true }]);
});

describe('a store regressing', () => {
  it('emails an operator, and the email carries the failure codes', async () => {
    // The acceptance criterion, as close to literally as a test can get it:
    // point a store at a bad selector, and one sweep later somebody is told —
    // with the breakdown, not just "the store is down".
    db.seed('automation_runs', [...healthyBaseline(), ...brokenToday()]);
    db.seed('automation_steps', [
      ...Array.from({ length: 30 }, () => stepRow({ step: 'add_click', outcome: 'error', code: 'selector_miss' })),
      ...Array.from({ length: 20 }, () => stepRow({ step: 'add_click', outcome: 'ok' })),
      ...Array.from({ length: 20 }, () => stepRow({ step: 'confirm', outcome: 'ok' })),
      stepRow({ step: 'search', outcome: 'empty', code: 'no_candidates' }),
    ]);

    const pass = await sweep();

    expect(pass).toMatchObject({ storesExamined: 1, alerting: 1, alerted: 1, emailsSent: 1 });
    expect(notifier).toHaveBeenCalledTimes(1);
    expect(notifier.mock.calls[0][0].adminEmails).toEqual(['ops@mealio.co']);

    const heb = digest()[0];
    expect(heb.storeId).toBe('heb');
    // The catalog's name, not the id — cosmetic, but it is what an operator
    // scanning an inbox recognises.
    expect(heb.storeLabel).toBe('H-E-B');
    expect(heb.reasons).toContain('success_drop');
    expect(heb.itemSuccessRecent).toBe(0.4);
    expect(heb.itemSuccessMedian).toBe(1);
    // Commonest first. This is the whole difference between an alert and a
    // notification: `selector_miss × 30` names the afternoon's work.
    expect(heb.failureCodes[0]).toEqual({ code: 'selector_miss', count: 30 });
    expect(heb.failureCodes).toContainEqual({ code: 'no_candidates', count: 1 });
  });

  // ── MEAL-29 ──────────────────────────────────────────────────────────────
  // The whole sweep, not the aggregator: rows out of the database, through the
  // SELECT, into the judgement, into an inbox. `aggregateFunnel` is unit-tested
  // and would go on passing with `item_index` missing from the steps query —
  // every row would arrive without it, every count would be zero, and the alert
  // would fire exactly as it did before. This is the test that reads the column.
  it('does not email anyone about a store that only ran out of stock', async () => {
    const today = brokenToday();
    db.seed('automation_runs', [...healthyBaseline(), ...today]);
    // Six of the ten items in each run, which is the entire shortfall: the store
    // did not have them. Nothing about our automation moved.
    db.seed('automation_steps', today.flatMap((r) =>
      Array.from({ length: 6 }, (_, i) => stepRow({
        run_id: r.id,
        step: 'confirm',
        outcome: 'error',
        code: 'out_of_stock',
        item_index: i,
        detail: { path: 'parallel_add' },
      })),
    ));

    const pass = await sweep();

    expect(pass).toMatchObject({ alerting: 0, alerted: 0, emailsSent: 0 });
    expect(notifier).not.toHaveBeenCalled();
  });

  it('still emails when the shortfall is only partly the store\'s shelf', async () => {
    // The guard on the test above. Four of the six missing items were out of
    // stock; the other two were us. Of the six items the store could have
    // supplied we added four — 67% against a 100% median, still a regression,
    // and an operator still hears about it.
    const today = brokenToday();
    db.seed('automation_runs', [...healthyBaseline(), ...today]);
    db.seed('automation_steps', today.flatMap((r) =>
      Array.from({ length: 4 }, (_, i) => stepRow({
        run_id: r.id,
        step: 'confirm',
        outcome: 'error',
        code: 'out_of_stock',
        item_index: i,
        detail: { path: 'parallel_add' },
      })),
    ));

    const pass = await sweep();

    expect(pass).toMatchObject({ alerting: 1, alerted: 1, emailsSent: 1 });
    const heb = digest()[0];
    expect(heb.reasons).toContain('success_drop');
    expect(heb.itemSuccessRecent).toBeCloseTo(4 / 6);
    // The email says how many it took out, or the reader cannot make
    // "20 added of 50 asked for" agree with the 67% two rows below it.
    expect(heb.itemsUnavailable).toBe(20);
    expect(heb.itemsRequested).toBe(260);
    expect(heb.itemsAdded).toBe(230);
  });

  it('says nothing the next day while it is broken the same way', async () => {
    db.seed('automation_runs', [...healthyBaseline(), ...brokenToday()]);
    await sweep();
    expect(notifier).toHaveBeenCalledTimes(1);

    notifier.mockClear();
    const second = await sweep();

    expect(second).toMatchObject({ alerting: 1, alerted: 0, suppressed: 1, emailsSent: 0 });
    expect(notifier).not.toHaveBeenCalled();
  });

  it('records what it said, so the suppression survives a restart', async () => {
    db.seed('automation_runs', [...healthyBaseline(), ...brokenToday()]);
    await sweep();
    expect(stored()).toMatchObject({ store_id: 'heb', alerted_reasons: ['success_drop'] });
    expect(stored()!.alerted_at).toBe(new Date(NOW).toISOString());
  });

  it('sends a second email when the store breaks in a NEW way', async () => {
    db.seed('automation_runs', [...healthyBaseline(), ...brokenToday()]);
    await sweep();
    notifier.mockClear();

    // Same drop, and now a WAF wall on top of it. Different problem, different
    // fix, and an operator told about the first has not been told about this.
    const walled = brokenToday();
    db.seed('automation_runs', [...db.rows('automation_runs'), ...walled]);
    db.seed('automation_steps', walled.map((r) => stepRow({
      run_id: r.id, step: 'add_click', outcome: 'blocked', occurred_at: r.started_at,
    })));

    const pass = await sweep();

    expect(pass).toMatchObject({ alerted: 1, emailsSent: 1 });
    expect(digest()[0].reasons).toEqual(['success_drop', 'blocked']);
    // …and the mail leads with the reason it exists, not the one already read.
    expect(digest()[0].newReasons).toEqual(['blocked']);
    expect(stored()!.alerted_reasons).toEqual(['blocked', 'success_drop']);
  });

  it('does not re-raise a reason that comes back after dropping away', async () => {
    // The mark is the UNION, never shrinking while the store stays unhealthy. A
    // store that flaps between one reason and two must not mail on every bounce.
    db.seed('automation_alert_state', [{
      store_id: 'heb', alerted_reasons: ['blocked', 'success_drop'], alerted_at: iso(24),
    }]);
    db.seed('automation_runs', [...healthyBaseline(), ...brokenToday()]);

    const pass = await sweep();

    expect(pass).toMatchObject({ alerting: 1, suppressed: 1, emailsSent: 0 });
  });

  it('remembers a reason that has since resolved, so its return is not news', async () => {
    // Three sweeps, and the third is the whole test. Writing only the CURRENT
    // reasons on the second sweep would forget that day one's drop was already
    // reported — so day three's identical drop reads as new and mails again,
    // about a store nobody has fixed and everybody has been told about.
    //
    // The store is never healthy in between, so nothing re-arms it. That is what
    // makes the mark's growth, and not the recovery path, the thing under test.

    // Day 1: item success has fallen away. No wall.
    db.seed('automation_runs', [...healthyBaseline(), ...brokenToday()]);
    expect(await sweep()).toMatchObject({ emailsSent: 1 });
    expect(stored()!.alerted_reasons).toEqual(['success_drop']);

    // Day 2: the drop is gone, and a WAF wall has appeared instead. 46 clean
    // runs and 4 walled ones, against a 9-day window of 71 runs in all — over
    // the 3% blocked threshold, while the item rate is back within 8 points of
    // its median. (The blocked share is a share of every run in the WINDOW, not
    // of today's, which is why four are needed and not two.)
    const walled = Array.from({ length: 4 }, () => runRow(6, 10, 0));
    const clean = Array.from({ length: 46 }, () => runRow(6, 10, 10));
    db.seed('automation_runs', [...healthyBaseline(), ...clean, ...walled]);
    db.seed('automation_steps', walled.map((r) => stepRow({
      run_id: r.id, step: 'add_click', outcome: 'blocked', occurred_at: r.started_at,
    })));
    notifier.mockClear();
    expect(await sweep()).toMatchObject({ emailsSent: 1 });
    expect(digest()[0].newReasons).toEqual(['blocked']);
    // Both, not just the one that is true today.
    expect(stored()!.alerted_reasons).toEqual(['blocked', 'success_drop']);

    // Day 3: the drop is back, alongside the wall that never went away.
    db.seed('automation_runs', [...healthyBaseline(), ...brokenToday(), ...walled]);
    notifier.mockClear();

    const third = await sweep();

    expect(third).toMatchObject({ alerting: 1, suppressed: 1, alerted: 0, emailsSent: 0 });
    expect(notifier).not.toHaveBeenCalled();
  });
});

describe('recovery', () => {
  it('re-arms the alert when the store is healthy on every count', async () => {
    db.seed('automation_alert_state', [{
      store_id: 'heb', alerted_reasons: ['success_drop'], alerted_at: iso(24),
    }]);
    db.seed('automation_runs', [...healthyBaseline(), ...Array.from({ length: 5 }, () => runRow(6, 10, 10))]);

    const pass = await sweep();

    expect(pass).toMatchObject({ alerting: 0, recovered: 1, emailsSent: 0 });
    expect(stored()!.alerted_reasons).toBeNull();
  });

  it('mails again when a fixed store breaks a second time', async () => {
    db.seed('automation_runs', [...healthyBaseline(), ...brokenToday()]);
    await sweep();

    // Fixed.
    db.seed('automation_runs', [...healthyBaseline(), ...Array.from({ length: 5 }, () => runRow(6, 10, 10))]);
    await sweep();
    notifier.mockClear();

    // Broken again. Without the clear on recovery this is silent forever.
    db.seed('automation_runs', [...healthyBaseline(), ...brokenToday()]);
    const pass = await sweep();

    expect(pass).toMatchObject({ alerted: 1, emailsSent: 1 });
  });

  it('leaves the mark alone for a store that simply went quiet', async () => {
    // No telemetry at all is not a recovery — nobody shopped, so nothing was
    // observed. Clearing on silence would re-arm a store that is still broken.
    db.seed('automation_alert_state', [{
      store_id: 'heb', alerted_reasons: ['success_drop'], alerted_at: iso(24),
    }]);

    const pass = await sweep();

    expect(pass).toMatchObject({ storesExamined: 0, recovered: 0, emailsSent: 0 });
    expect(stored()!.alerted_reasons).toEqual(['success_drop']);
  });
});

describe('when the alert cannot be delivered', () => {
  it('marks nothing when there is nobody to tell, and retries next sweep', async () => {
    db.seed('user_profiles', []);
    db.seed('automation_runs', [...healthyBaseline(), ...brokenToday()]);

    const pass = await sweep();

    expect(pass).toMatchObject({ alerting: 1, alerted: 0, emailsSent: 0 });
    expect(notifier).not.toHaveBeenCalled();
    expect(stored()).toBeUndefined();

    // Somebody exists now. The store is still broken and is still a transition.
    db.seed('user_profiles', [{ email: 'ops@mealio.co', is_admin: true }]);
    expect(await sweep()).toMatchObject({ alerted: 1, emailsSent: 1 });
  });

  it('marks nothing when Resend refuses the send', async () => {
    // Marking first would suppress tomorrow's retry on the strength of an email
    // nobody received — and since the mark is only cleared by a recovery, that
    // store would never be raised again.
    notifier.mockRejectedValue(new Error('Resend refused the cart automation alert email'));
    db.seed('automation_runs', [...healthyBaseline(), ...brokenToday()]);

    const pass = await sweep();

    expect(pass).toMatchObject({ alerted: 0, emailsSent: 0 });
    expect(stored()).toBeUndefined();

    notifier.mockReset();
    notifier.mockResolvedValue(undefined);
    expect(await sweep()).toMatchObject({ alerted: 1, emailsSent: 1 });
  });

  it('fails closed when the suppression state cannot be read', async () => {
    // Code deployed ahead of add-automation-alert-state.sql. Reading a missing
    // table as "nothing has been reported" would make every broken store a fresh
    // transition every single day, which is the outcome the whole design exists
    // to prevent. /api/cron/daily catches this and the other passes carry on.
    db.seed('automation_runs', [...healthyBaseline(), ...brokenToday()]);
    db.queue('automation_alert_state', {
      data: null, count: null, error: { code: '42P01', message: 'relation "automation_alert_state" does not exist' },
    });

    await expect(sweep()).rejects.toThrow(/cannot read what has already been reported/);
    expect(notifier).not.toHaveBeenCalled();
  });

  it('still alerts when the store catalog cannot be read, using the raw id', async () => {
    // A cosmetic lookup must never be a reason an operator is not told.
    db.seed('automation_runs', [...healthyBaseline(), ...brokenToday()]);
    db.queue('stores', { data: null, count: null, error: { message: 'boom' } });

    const pass = await sweep();

    expect(pass).toMatchObject({ alerted: 1, emailsSent: 1 });
    expect(digest()[0].storeLabel).toBe('heb');
  });
});

describe('what the sweep declines to raise', () => {
  it('leaves a store alone that has always been middling', async () => {
    // 70% every day for a week and 70% today. The MEAL-31 trap: an absolute
    // floor mails about this every morning forever, and nothing has changed.
    const steady: any[] = [];
    for (let day = 0; day <= 7; day++) {
      for (let i = 0; i < 3; i++) steady.push(runRow(day * 24 + 6, 10, 7));
    }
    db.seed('automation_runs', steady);

    const pass = await sweep();

    expect(pass).toMatchObject({ storesExamined: 1, alerting: 0, emailsSent: 0 });
  });

  it('uses the funnel\'s own blocked threshold rather than one of its own', async () => {
    // 4% of runs walled off — under the 20% this module shipped with, over the
    // 3% MEAL-6 settled on. Asserted through the exported default so the page
    // and the email cannot drift apart without a test noticing.
    expect(DEFAULT_BLOCKED_RATE_THRESHOLD).toBe(0.03);
    const runs = Array.from({ length: 50 }, () => runRow(6, 10, 10));
    db.seed('automation_runs', runs);
    db.seed('automation_steps', runs.slice(0, 2).map((r) => stepRow({
      run_id: r.id, step: 'add_click', outcome: 'blocked', occurred_at: r.started_at,
    })));

    const pass = await sweep();

    expect(pass).toMatchObject({ alerting: 1, alerted: 1 });
    expect(digest()[0].reasons).toEqual(['blocked']);
    expect(digest()[0].blockedRuns).toBe(2);
  });

  it('digests several stores into one email, busiest first', async () => {
    db.seed('automation_runs', [
      ...healthyBaseline('heb'), ...brokenToday('heb'), ...brokenToday('heb'),
      ...healthyBaseline('kroger'), ...brokenToday('kroger'),
    ]);

    const pass = await sweep();

    expect(pass).toMatchObject({ storesExamined: 2, alerting: 2, alerted: 2, emailsSent: 1 });
    expect(notifier).toHaveBeenCalledTimes(1);
    expect(digest().map((s: any) => s.storeId)).toEqual(['heb', 'kroger']);
  });
});
