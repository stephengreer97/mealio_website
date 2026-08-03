import { describe, it, expect, afterEach } from 'vitest';
import { EXTRACTION_MODEL, MODEL_PRICING } from '@/lib/import/anthropic';
import { estimateSelectionCostUsd, formatSelectionCost, importUnitCostUsd } from '@/lib/import/cost';

/**
 * The cost line is the guard rail against an accidental bulk run, so what is
 * tested here is that it stays honest: the right order of magnitude today, and
 * derived from the pricing table rather than a number that will rot in it.
 *
 * The absolute figures moved once already, when `EXTRACTION_MODEL` went from
 * Opus to Haiku and a 200-post archive went from ~$13 to ~$3. That is the
 * behaviour these tests exist to notice, so they assert the current number
 * rather than a band wide enough to sleep through the change.
 */

describe('import/cost', () => {
  const originalRates = { ...MODEL_PRICING[EXTRACTION_MODEL] };
  afterEach(() => {
    MODEL_PRICING[EXTRACTION_MODEL] = originalRates;
  });

  it('lands on the ~$0.016 per import measured on Haiku', () => {
    // MEAL-71's A/B, re-run 2026-08-03: gate + extraction, both Haiku 4.5.
    // The eval measured $0.0090 per extraction on real pages; this figure is
    // the planning profile in `TYPICAL_IMPORT_TOKENS`, which is deliberately
    // more pessimistic than the average page.
    expect(importUnitCostUsd()).toBeCloseTo(0.0159, 3);
  });

  it('follows the pricing table rather than a hardcoded figure', () => {
    // The whole point of deriving it: the day a rate moves, the estimate an
    // operator is trusting with someone's budget moves with it.
    const before = importUnitCostUsd();
    MODEL_PRICING[EXTRACTION_MODEL] = {
      inputPerMTok: originalRates.inputPerMTok * 2,
      outputPerMTok: originalRates.outputPerMTok * 2,
    };
    expect(importUnitCostUsd()).toBeGreaterThan(before * 1.8);
  });

  it('quotes a 200-post archive at about $3 — the number worth being shown', () => {
    // Was ~$13 on Opus. Still worth surfacing before an operator presses the
    // button: cheaper is not free, and a back-catalogue run is the one place
    // a single click spends real money.
    expect(estimateSelectionCostUsd(200)).toBeGreaterThan(2.5);
    expect(estimateSelectionCostUsd(200)).toBeLessThan(4);
  });

  it('reads the way the ticket asks for', () => {
    expect(formatSelectionCost(12)).toBe('12 selected · about $0.19');
    expect(formatSelectionCost(0)).toBe('0 selected · about $0.00');
  });
});
