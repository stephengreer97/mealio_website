import { describe, it, expect } from 'vitest';
import {
  RUNNING_GRACE_MS,
  isBlockedStep,
  isFailingStep,
  runConcern,
  summarizeTrace,
  type TraceRunRow,
  type TraceStepRow,
} from '@/lib/automation-trace';

// The per-run reasoning, away from the route. What is worth pinning here is the
// small set of things this module refuses to claim — the route's tests drive the
// happy paths through the real fetch.

const run = (over: Partial<TraceRunRow> = {}): TraceRunRow => ({
  id: 'run-1',
  store_id: 'heb',
  source: 'my_meals',
  status: 'completed',
  outcome: 'failed',
  meal_count: 1,
  items_requested: 3,
  items_added: 1,
  started_at: '2026-08-01T10:00:00.000Z',
  completed_at: '2026-08-01T10:01:00.000Z',
  config_version: 12,
  app_version: '1.4.0',
  platform: 'ios',
  ...over,
});

const step = (seq: number, over: Partial<TraceStepRow> = {}): TraceStepRow => ({
  seq,
  step: 'search',
  outcome: 'ok',
  code: null,
  duration_ms: 100,
  item_index: 0,
  detail: null,
  config_version: 12,
  app_version: '1.4.0',
  occurred_at: '2026-08-01T10:00:05.000Z',
  ...over,
});

describe('a block is a block, however the client says so', () => {
  // Same three signals the funnel honours, for the same reason: a client that
  // reports only the code, because the step it died on was `search` rather than
  // `blocked`, must not have its wall counted as search drift.
  it('recognises the dedicated step, the outcome and the code', () => {
    expect(isBlockedStep({ step: 'blocked', outcome: 'error', code: null })).toBe(true);
    expect(isBlockedStep({ step: 'search', outcome: 'blocked', code: null })).toBe(true);
    expect(isBlockedStep({ step: 'search', outcome: 'error', code: 'waf_block' })).toBe(true);
    expect(isBlockedStep({ step: 'search', outcome: 'error', code: 'selector_miss' })).toBe(false);
  });

  it('keeps a block out of the drift-shaped failures, and skipped rows out of both', () => {
    expect(isFailingStep({ step: 'search', outcome: 'blocked', code: null })).toBe(false);
    expect(isFailingStep({ step: 'search', outcome: 'skipped', code: null })).toBe(false);
    expect(isFailingStep({ step: 'search', outcome: 'ok', code: null })).toBe(false);
    expect(isFailingStep({ step: 'search', outcome: 'empty', code: null })).toBe(true);
    expect(isFailingStep({ step: 'search', outcome: 'timeout', code: null })).toBe(true);
  });
});

describe('firstFailure refuses rather than guesses', () => {
  it('is `incomplete` on a prefix, even when the prefix contains a failure', () => {
    // The failure it can see may not be the FIRST one, and "the run died at
    // confirm" off a truncated read is the whole truncation bug family.
    const summary = summarizeTrace(
      run(),
      [step(1), step(2, { step: 'confirm', outcome: 'error', code: 'confirm_failed' })],
      { complete: false },
    );
    expect(summary.firstFailure).toEqual({ kind: 'incomplete' });
    expect(summary.complete).toBe(false);
    // The counts are still reported — they are simply lower bounds now.
    expect(summary.failures).toBe(1);
  });

  it('distinguishes no rows from no failures', () => {
    expect(summarizeTrace(run(), [], { complete: true }).firstFailure).toEqual({ kind: 'no_trace' });
    expect(summarizeTrace(run(), [step(1), step(2)], { complete: true }).firstFailure).toEqual({ kind: 'clean' });
  });

  it('takes the first row in seq order, not the first failure in the array', () => {
    // The rows arrive in the order the query returned them. If a caller ever hands
    // them over unordered this is where the wrong answer would come from, which is
    // why the route orders on `seq` and this function does not re-sort.
    const summary = summarizeTrace(
      run(),
      [
        step(1),
        step(2, { step: 'add_click', outcome: 'blocked', code: 'waf_block', item_index: 1 }),
        step(3, { step: 'confirm', outcome: 'error', code: 'confirm_failed' }),
      ],
      { complete: true },
    );
    expect(summary.firstFailure).toMatchObject({ kind: 'failed', seq: 2, blocked: true, itemIndex: 1 });
  });
});

describe('what the trace says about its own coverage', () => {
  it('calls a run with only terminal rows uninstrumented', () => {
    const summary = summarizeTrace(
      run({ outcome: 'success', items_added: 3 }),
      [step(1, { step: 'login_check' }), step(2, { step: 'reconcile' }), step(3, { step: 'run_summary' })],
      { complete: true },
    );
    expect(summary.noItemInstrumentation).toBe(true);
    expect(summary.missingItemSteps).toEqual(['search', 'candidates', 'add_click', 'confirm']);
    // …and does not therefore call it a failure.
    expect(summary.firstFailure).toEqual({ kind: 'clean' });
  });

  it('does not call a run uninstrumented when only some item steps are missing', () => {
    const summary = summarizeTrace(
      run(),
      [step(1, { step: 'search' }), step(2, { step: 'candidates' })],
      { complete: true },
    );
    expect(summary.noItemInstrumentation).toBe(false);
    expect(summary.missingItemSteps).toEqual(['add_click', 'confirm']);
  });

  it('counts seq holes and a late start, and reports no holes when there are none', () => {
    const gappy = summarizeTrace(run(), [step(3), step(7)], { complete: true });
    expect(gappy.seq).toEqual({ min: 3, max: 7, count: 2, missing: 3, startsLate: true });

    const dense = summarizeTrace(run(), [step(1), step(2), step(3)], { complete: true });
    expect(dense.seq).toEqual({ min: 1, max: 3, count: 3, missing: 0, startsLate: false });

    const empty = summarizeTrace(run(), [], { complete: true });
    expect(empty.seq).toEqual({ min: null, max: null, count: 0, missing: 0, startsLate: false });
  });

  it('folds the run row\'s versions in with every step\'s, and flags disagreement', () => {
    const mixed = summarizeTrace(
      run({ config_version: 11 }),
      [step(1, { config_version: 12 }), step(2, { config_version: 12, app_version: '1.4.1' })],
      { complete: true },
    );
    expect(mixed.versions.configVersions).toEqual([11, 12]);
    expect(mixed.versions.appVersions).toEqual(['1.4.0', '1.4.1']);
    expect(mixed.versions.mixed).toBe(true);

    const agreed = summarizeTrace(run(), [step(1)], { complete: true });
    expect(agreed.versions).toEqual({ configVersions: [12], appVersions: ['1.4.0'], mixed: false });
  });

  it('reports the run_summary code without letting it be the verdict', () => {
    const summary = summarizeTrace(
      run(),
      [
        step(1, { step: 'add_click', outcome: 'blocked', code: 'waf_block' }),
        step(2, { step: 'confirm', outcome: 'error', code: 'confirm_failed' }),
        step(3, { step: 'run_summary', outcome: 'error', code: 'confirm_failed' }),
      ],
      { complete: true },
    );
    // MEAL-123: the summary names the noise and the ordered trace names the wall.
    expect(summary.runSummaryCode).toBe('confirm_failed');
    expect(summary.hasRunSummary).toBe(true);
    expect(summary.firstFailure).toMatchObject({ code: 'waf_block' });
  });

  it('leaves itemsMissed null when either count is absent', () => {
    // Never 0: a run that reported no counts has not added everything it was asked
    // for, it has told us nothing.
    expect(summarizeTrace(run({ items_requested: null }), [], { complete: true }).itemsMissed).toBeNull();
    expect(summarizeTrace(run({ items_added: null }), [], { complete: true }).itemsMissed).toBeNull();
    expect(summarizeTrace(run({ items_requested: 3, items_added: 1 }), [], { complete: true }).itemsMissed).toBe(2);
  });
});

describe('runConcern, the definition the list filters on', () => {
  const NOW = Date.parse('2026-08-01T10:05:00.000Z');
  const clean = {
    status: 'completed',
    outcome: 'success',
    items_requested: 3,
    items_added: 3,
    started_at: '2026-08-01T10:00:00.000Z',
    completed_at: '2026-08-01T10:01:00.000Z',
  };

  it('calls a completed full success clean and nothing else', () => {
    expect(runConcern(clean, NOW))
      .toEqual({ running: false, abandoned: false, failed: false, partialAdds: false, clean: true });
  });

  it('separates the three ways a run is not clean', () => {
    expect(runConcern({ ...clean, status: 'started', outcome: null, completed_at: null, started_at: '2026-07-30T10:00:00.000Z' }, NOW))
      .toMatchObject({ abandoned: true, failed: false, clean: false });
    expect(runConcern({ ...clean, outcome: 'failed' }, NOW))
      .toMatchObject({ abandoned: false, failed: true, clean: false });
    expect(runConcern({ ...clean, items_added: 1 }, NOW))
      .toMatchObject({ partialAdds: true, failed: false, clean: false });
  });

  it('does not call a finished run with no outcome clean', () => {
    // The row PostgREST's `outcome <> 'success'` silently drops. If this returned
    // `clean: true` the UI would contradict the list it appears in.
    expect(runConcern({ ...clean, status: 'completed', outcome: null }, NOW).clean).toBe(false);
  });

  it('cannot judge partial adds without both counts', () => {
    expect(runConcern({ ...clean, items_requested: null }, NOW).partialAdds).toBe(false);
    expect(runConcern({ ...clean, items_added: null }, NOW).partialAdds).toBe(false);
  });

  // ── In flight is not abandoned ────────────────────────────────────────────
  //
  // `status = 'started'` alone says both "the engine wedged" and "come back in a
  // minute", and the list orders newest-first, so the in-flight rows are the FIRST
  // thing an operator sees. Calling a run that started five seconds ago ABANDONED
  // turns a store's dinner-hour peak into an apparent wave of wedged engines —
  // every one of which completes a minute later.

  const inFlight = (secondsAgo: number) => runConcern(
    { ...clean, status: 'started', outcome: null, completed_at: null,
      started_at: new Date(NOW - secondsAgo * 1000).toISOString() },
    NOW,
  );

  it('calls a run that started seconds ago running, not abandoned', () => {
    expect(inFlight(5)).toMatchObject({ running: true, abandoned: false, clean: false });
  });

  it('calls a run still unfinished past the grace band abandoned, not running', () => {
    expect(inFlight(RUNNING_GRACE_MS / 1000 + 60)).toMatchObject({ running: false, abandoned: true, clean: false });
  });

  it('flips at the grace band and not before it', () => {
    // Both sides of the same boundary, so a cutoff quietly changed to zero or to
    // infinity fails here rather than passing as "well, it's a band".
    expect(inFlight(RUNNING_GRACE_MS / 1000 - 1).running).toBe(true);
    expect(inFlight(RUNNING_GRACE_MS / 1000 + 1).running).toBe(false);
  });

  it('is not running once a completed_at has landed, whatever status says', () => {
    // A half-applied completion write. It DID report finishing, so waiting on it is
    // the wrong instruction — this is a row to look at.
    expect(runConcern(
      { ...clean, status: 'started', outcome: null, started_at: new Date(NOW - 5000).toISOString() },
      NOW,
    )).toMatchObject({ running: false, abandoned: true });
  });

  it('resolves an unknown age toward abandoned rather than toward running', () => {
    // `started_at` is NOT NULL in the schema, so this is defensive — and it errs
    // toward showing the row rather than relabelling it as something to wait for.
    expect(runConcern({ ...clean, status: 'started', outcome: null, completed_at: null, started_at: null }, NOW))
      .toMatchObject({ running: false, abandoned: true });
  });

  it('never calls a running run clean — it has not finished', () => {
    expect(inFlight(5).clean).toBe(false);
  });
});
