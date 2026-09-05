// MEAL-222. What imports cost over a window, split by who ran them.
//
// The two things that make this worth a unit test rather than only a route
// test are both ways a spend figure can be confidently wrong:
//
//   1. `numeric` arrives from PostgREST as a STRING. Postgres numeric is
//      arbitrary precision and a JSON number is a double, so it is handed over
//      as text rather than silently rounded. Summing with `+` without coercing
//      CONCATENATES, and "0.0031" + "0.0123" is "0.00310.0123" -- a dashboard
//      number with no decimal point that reads as merely large, not as broken.
//   2. Medians must come from the rows that PAID. A cache hit and a stage that
//      never ran are both nulls, and counting them as zero drags the typical
//      shape towards a number no real import has ever had.
import { describe, it, expect } from 'vitest';
import { buildSpendView, type SpendRow } from '@/lib/import-spend';

const row = (over: Partial<SpendRow> = {}): SpendRow => ({
  actor: 'creator',
  outcome: 'ok',
  stage: 'complete',
  cached: false,
  gate_cost_usd: '0.0031',
  extract_cost_usd: '0.0123',
  total_cost_usd: '0.0154',
  gate_input_tokens: 2500,
  gate_output_tokens: 120,
  extract_input_tokens: 6000,
  extract_output_tokens: 1350,
  ...over,
});

describe('the money', () => {
  it('ADDS numeric strings instead of concatenating them', () => {
    const view = buildSpendView([row(), row()]);
    expect(view.total.costUsd).toBeCloseTo(0.0308, 6);
    // The failure this guards is not "slightly off", it is a different type.
    expect(typeof view.total.costUsd).toBe('number');
    expect(String(view.total.costUsd)).not.toContain('0.01540.0154');
  });

  it('keeps the gate and the extraction apart in the totals too', () => {
    const view = buildSpendView([row(), row()]);
    expect(view.total.gateCostUsd).toBeCloseTo(0.0062, 6);
    expect(view.total.extractCostUsd).toBeCloseTo(0.0246, 6);
  });

  it('counts a rejection as spend, because it is', () => {
    // The gate said no. It still cost money, and a summary that filtered to
    // successes would understate the month by exactly the amount that had
    // nothing to show for it.
    const view = buildSpendView([
      row({ outcome: 'rejected', stage: 'gate', extract_cost_usd: null, total_cost_usd: '0.0031',
            extract_input_tokens: null, extract_output_tokens: null }),
    ]);
    expect(view.total.imports).toBe(1);
    expect(view.total.rejected).toBe(1);
    expect(view.total.costUsd).toBeCloseTo(0.0031, 6);
  });
});

describe('the split Stephen asked for', () => {
  it('separates creator from user, and the parts sum to the total', () => {
    const view = buildSpendView([
      row({ actor: 'creator' }), row({ actor: 'creator' }), row({ actor: 'user' }),
    ]);
    expect(view.byActor.creator.imports).toBe(2);
    expect(view.byActor.user.imports).toBe(1);
    const summed = view.byActor.creator.costUsd + view.byActor.user.costUsd;
    expect(summed).toBeCloseTo(view.total.costUsd, 6);
  });

  it('buckets an unattributable row rather than dropping it', () => {
    // A row we cannot attribute is still money we spent. A total that does not
    // match the sum of its parts is worse than an ugly label.
    const view = buildSpendView([row({ actor: null }), row({ actor: 'user' })]);
    expect(view.total.imports).toBe(2);
    expect(view.byActor.unknown.imports).toBe(1);
    const summed = Object.values(view.byActor).reduce((n, b) => n + b.imports, 0);
    expect(summed).toBe(view.total.imports);
  });
});

describe('the median token shape, which is the point as much as the money', () => {
  it('is a MEDIAN, so one enormous page does not move it', () => {
    // TYPICAL_IMPORT_TOKENS answers "what will the next import cost". A mean
    // over a 40,000-word outlier answers a question nobody asked.
    const view = buildSpendView([
      row({ extract_input_tokens: 6000 }),
      row({ extract_input_tokens: 6200 }),
      row({ extract_input_tokens: 400_000 }),
    ]);
    expect(view.total.medianTokens.extractInput).toBe(6200);
  });

  it('ignores the rows that never paid', () => {
    // A structured-data shortcut skips the classifier; a cache hit skips both.
    // Zero is not a small measurement, it is the absence of one.
    const view = buildSpendView([
      row({ gate_input_tokens: 2500 }),
      row({ gate_input_tokens: 2600 }),
      row({ cached: true, gate_input_tokens: null, extract_input_tokens: null,
            gate_cost_usd: null, extract_cost_usd: null, total_cost_usd: '0' }),
    ]);
    expect(view.total.medianTokens.gateInput).toBe(2550);
    expect(view.total.cached).toBe(1);
  });

  it('is null rather than zero when nothing has paid yet', () => {
    // The window has rows but none of them called the model. Reporting 0 would
    // be a measurement claim; null says there is nothing to report.
    const view = buildSpendView([
      row({ cached: true, gate_input_tokens: null, gate_output_tokens: null,
            extract_input_tokens: null, extract_output_tokens: null }),
    ]);
    expect(view.total.medianTokens.gateInput).toBeNull();
    expect(view.total.medianTokens.extractOutput).toBeNull();
  });

  it('has an empty answer for an empty window, not a crash', () => {
    const view = buildSpendView([]);
    expect(view.total.imports).toBe(0);
    expect(view.total.costUsd).toBe(0);
    expect(view.byActor).toEqual({});
  });
});
