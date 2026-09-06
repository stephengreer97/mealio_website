// MEAL-219's nightly half: roll yesterday up, then prune past the window.
//
// Two properties carry this, and neither is "it called the RPC":
//
//   1. A NIGHT THE CRON DOES NOT FIRE MUST NOT LEAVE A HOLE. Rolling only
//      yesterday means a missed run leaves that day missing from
//      `automation_daily` until the prune reaches it thirty days later, and a
//      funnel with a missing day reads as a day when nothing happened.
//   2. THE PRUNE MUST STILL RUN WHEN A ROLLUP FAILED. It does its own rollup of
//      every day it touches, so it is not waiting on the loop, and skipping it
//      would let raw steps pile up past the window for nothing.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: vi.fn() }));

import { runAutomationRollup, ROLLUP_DAYS } from '@/lib/automation-rollup';

const rpc = vi.fn();
const supabase = { rpc } as never;

beforeEach(() => {
  rpc.mockReset();
  rpc.mockImplementation(async (fn: string) =>
    fn === 'roll_up_automation_day'
      ? { data: 7, error: null }
      : { data: [{ rolled_days: 2, deleted_rows: 5000 }], error: null });
});

const daysAsked = () =>
  rpc.mock.calls.filter((c) => c[0] === 'roll_up_automation_day').map((c) => c[1].target_day);

describe('which days get rolled up', () => {
  it('covers more than one, so a missed night closes on the next run', () => {
    expect(ROLLUP_DAYS).toBeGreaterThan(1);
  });

  it('asks for yesterday first, then backwards', async () => {
    await runAutomationRollup({ supabase });
    const days = daysAsked();
    expect(days).toHaveLength(ROLLUP_DAYS);
    // Recent first: the day the dashboard is most likely to be reading is the
    // one that lands even if a later call fails.
    expect([...days].sort().reverse()).toEqual(days);
  });

  it('never asks for TODAY, which is still being written', async () => {
    // Rolling up a day in progress produces an aggregate that is wrong the
    // moment the next run happens, and the dashboard reads `steps` for recent
    // windows anyway.
    await runAutomationRollup({ supabase });
    const today = new Date().toISOString().slice(0, 10);
    expect(daysAsked()).not.toContain(today);
  });

  it('uses UTC dates, matching how both SQL functions bucket occurred_at', async () => {
    await runAutomationRollup({ supabase });
    daysAsked().forEach((d: string) => expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/));
  });

  it('sums the rows each day wrote', async () => {
    const r = await runAutomationRollup({ supabase, days: 2 });
    expect(r.rowsWritten).toBe(14);
    expect(r.daysRolled).toHaveLength(2);
  });
});

describe('the prune', () => {
  it('runs, and reports what it removed', async () => {
    const r = await runAutomationRollup({ supabase });
    expect(rpc).toHaveBeenCalledWith('prune_automation_steps', { keep_days: 30 });
    expect(r.prunedDaysRolled).toBe(2);
    expect(r.prunedRows).toBe(5000);
  });

  it('reads a RETURNS TABLE answer, which arrives as an array of one row', async () => {
    // supabase-js hands back `[{...}]` for a set-returning function. Reading it
    // as an object gives undefined and reports a prune that did nothing.
    rpc.mockImplementation(async (fn: string) =>
      fn === 'prune_automation_steps'
        ? { data: [{ rolled_days: 1, deleted_rows: 42 }], error: null }
        : { data: 0, error: null });
    const r = await runAutomationRollup({ supabase });
    expect(r.prunedRows).toBe(42);
  });

  it('STILL RUNS when a rollup failed', async () => {
    rpc.mockImplementation(async (fn: string) =>
      fn === 'roll_up_automation_day'
        ? { data: null, error: { code: '42883', message: 'function does not exist' } }
        : { data: [{ rolled_days: 0, deleted_rows: 0 }], error: null });
    await runAutomationRollup({ supabase });
    expect(rpc.mock.calls.some((c) => c[0] === 'prune_automation_steps')).toBe(true);
  });

  it('honours a different retention window', async () => {
    await runAutomationRollup({ supabase, keepDays: 90 });
    expect(rpc).toHaveBeenCalledWith('prune_automation_steps', { keep_days: 90 });
  });
});

describe('when the migration has not been run', () => {
  it('NAMES the failure instead of reporting a quiet zero', async () => {
    // A missing function means the SQL has not been run. The failure mode of a
    // quiet catch is a dashboard reading zero that looks like nobody used the
    // app, which is the exact misreading this retention design exists to avoid.
    rpc.mockImplementation(async () =>
      ({ data: null, error: { code: '42883', message: 'function public.roll_up_automation_day(date) does not exist' } }));
    const r = await runAutomationRollup({ supabase, days: 1 });
    expect(r.errors).toHaveLength(2);
    expect(r.errors.join(' ')).toContain('does not exist');
    expect(r.daysRolled).toEqual([]);
  });

  it('carries on past one bad day rather than abandoning the rest', async () => {
    let call = 0;
    rpc.mockImplementation(async (fn: string) => {
      if (fn !== 'roll_up_automation_day') return { data: [{ rolled_days: 0, deleted_rows: 0 }], error: null };
      call++;
      return call === 1
        ? { data: null, error: { code: 'XX000', message: 'deadlock detected' } }
        : { data: 3, error: null };
    });
    const r = await runAutomationRollup({ supabase, days: 3 });
    expect(r.daysRolled).toHaveLength(2);
    expect(r.errors).toHaveLength(1);
  });
});
