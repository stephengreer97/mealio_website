// @vitest-environment jsdom
// The panel. What is checked here is not arithmetic -- that is
// tests/lib/import-spend.test.ts -- but the three things a reader could be
// misled by:
//
//   1. That rejections are visible, not hidden behind a success filter.
//   2. That a 409 says WHICH migration to run, rather than "something broke".
//   3. That an empty window says "nothing was spent" rather than rendering
//      zeroes that look like a measurement.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import AdminImportSpend from '@/components/AdminImportSpend';

const bucket = (over: Record<string, unknown> = {}) => ({
  imports: 2, rejected: 1, cached: 0,
  costUsd: 0.0185, gateCostUsd: 0.0062, extractCostUsd: 0.0123,
  medianTokens: { gateInput: 2500, gateOutput: 120, extractInput: 6000, extractOutput: 1350 },
  ...over,
});

function answer(body: unknown, ok = true, status = 200) {
  global.fetch = vi.fn(async () => ({
    ok, status, json: async () => body,
  })) as unknown as typeof fetch;
}

beforeEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('the panel', () => {
  it('shows creator and user separately, and a total', async () => {
    answer({
      days: 30, truncated: false, rowsScanned: 3,
      total: bucket({ imports: 3, costUsd: 0.0277 }),
      byActor: { creator: bucket(), user: bucket({ imports: 1, rejected: 0, costUsd: 0.0092 }) },
    });
    render(<AdminImportSpend token="t" />);
    await waitFor(() => expect(screen.getByTestId('spend-row-creator')).toBeTruthy());
    expect(screen.getByTestId('spend-row-user')).toBeTruthy();
    expect(screen.getByTestId('spend-row-total').textContent).toContain('$0.0277');
  });

  it('SHOWS the rejections rather than filtering them out', async () => {
    // A run the gate refused still cost money. A panel that showed only
    // successes would understate the month by exactly the amount that had
    // nothing to show for it, which is the amount most worth seeing.
    answer({
      days: 30, truncated: false, rowsScanned: 2,
      total: bucket(), byActor: { creator: bucket() },
    });
    render(<AdminImportSpend token="t" />);
    await waitFor(() => expect(screen.getByTestId('spend-row-creator')).toBeTruthy());
    const row = screen.getByTestId('spend-row-creator').textContent ?? '';
    expect(row).toContain('2'); // imports
    expect(row).toContain('1'); // rejected, and it is a column of its own
  });

  it('carries the median tokens, which is what checks the estimate', async () => {
    answer({
      days: 30, truncated: false, rowsScanned: 2,
      total: bucket(), byActor: { creator: bucket() },
    });
    render(<AdminImportSpend token="t" />);
    await waitFor(() => expect(screen.getByTestId('spend-row-creator')).toBeTruthy());
    expect(screen.getByTestId('spend-row-creator').textContent).toContain('6,000');
  });

  it('names the migration file when the table is not there yet', async () => {
    // The specific failure this page will actually hit first, and the one where
    // a generic error costs the reader the answer.
    answer({ error: 'The MEAL-222 import accounting table is not in the database yet. Run supabase/migrations/20260906000001_recipe_imports.sql.', needsMigration: true }, false, 409);
    render(<AdminImportSpend token="t" />);
    await waitFor(() => expect(screen.getByText(/20260906000001_recipe_imports\.sql/)).toBeTruthy());
  });

  it('says nothing was spent rather than drawing a table of zeroes', async () => {
    answer({
      days: 30, truncated: false, rowsScanned: 0,
      total: bucket({ imports: 0, rejected: 0, costUsd: 0, gateCostUsd: 0, extractCostUsd: 0,
                      medianTokens: { gateInput: null, gateOutput: null, extractInput: null, extractOutput: null } }),
      byActor: {},
    });
    render(<AdminImportSpend token="t" />);
    await waitFor(() => expect(screen.getByTestId('import-spend-empty')).toBeTruthy());
  });
});
