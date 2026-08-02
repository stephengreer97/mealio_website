import { describe, it, expect, afterEach } from 'vitest';
import { EXTRACTION_MODEL, MODEL_PRICING } from '@/lib/import/anthropic';
import { estimateSelectionCostUsd, formatSelectionCost, importUnitCostUsd } from '@/lib/import/cost';

/**
 * The cost line is the guard rail against an accidental $13 run, so what is
 * tested here is that it stays honest: the right order of magnitude today, and
 * derived from the pricing table rather than a number that will rot in it.
 */

describe('import/cost', () => {
  const originalOpus = { ...MODEL_PRICING[EXTRACTION_MODEL] };
  afterEach(() => {
    MODEL_PRICING[EXTRACTION_MODEL] = originalOpus;
  });

  it('lands on the ~$0.067 per import MEAL-71 measured', () => {
    expect(importUnitCostUsd()).toBeCloseTo(0.067, 3);
  });

  it('follows the pricing table rather than a hardcoded figure', () => {
    // The whole point of deriving it: the day a rate moves, the estimate an
    // operator is trusting with someone's budget moves with it.
    const before = importUnitCostUsd();
    MODEL_PRICING[EXTRACTION_MODEL] = {
      inputPerMTok: originalOpus.inputPerMTok * 2,
      outputPerMTok: originalOpus.outputPerMTok * 2,
    };
    expect(importUnitCostUsd()).toBeGreaterThan(before * 1.8);
  });

  it('quotes a 200-post archive at about $13 — the number worth being scared of', () => {
    expect(estimateSelectionCostUsd(200)).toBeGreaterThan(12);
    expect(estimateSelectionCostUsd(200)).toBeLessThan(15);
  });

  it('reads the way the ticket asks for', () => {
    expect(formatSelectionCost(12)).toBe('12 selected · about $0.80');
    expect(formatSelectionCost(0)).toBe('0 selected · about $0.00');
  });
});
