/**
 * What a selection is about to cost (MEAL-90).
 *
 * The checklist can put 200 items one click away from a run, and the guard rail
 * against pressing that by accident is a number on the screen before it happens
 * — far more effective than a confirmation dialog nobody reads.
 *
 * The figure is **derived, not typed in**. MEAL-71 measured ~$0.067 per import;
 * what it actually measured is a token shape — one cheap gate call and one
 * extraction call, with the sizes below. Multiplying that shape by
 * `MODEL_PRICING` means the day a rate changes, or the day `EXTRACTION_MODEL`
 * moves off Opus, the estimate moves with it instead of quietly rotting into a
 * lie an operator is trusting with someone's budget.
 *
 * It is a ceiling, and deliberately so: a cached URL costs nothing, and a page
 * with clean JSON-LD skips the classifier. Being wrong low is what turns a
 * guard rail into a trap.
 *
 * No server-only imports here — the admin screen renders this live against the
 * current selection, so it has to be safe in a client bundle.
 */

import { EXTRACTION_MODEL, GATE_MODEL, estimateCostUsd } from './anthropic';

/**
 * The token shape of one import, as measured in MEAL-71.
 *
 * Gate input is the first ~1,500 words of page text; extraction input is the
 * cleaned document, and its output is the whole draft — name, story, recipe and
 * every ingredient row — which is why the output side dominates at Opus rates.
 */
export const TYPICAL_IMPORT_TOKENS = {
  gate: { inputTokens: 2_500, outputTokens: 120 },
  extract: { inputTokens: 6_000, outputTokens: 1_350 },
} as const;

/** Estimated USD for one import at today's published rates. */
export function importUnitCostUsd(): number {
  return (
    estimateCostUsd(GATE_MODEL, TYPICAL_IMPORT_TOKENS.gate.inputTokens, TYPICAL_IMPORT_TOKENS.gate.outputTokens) +
    estimateCostUsd(EXTRACTION_MODEL, TYPICAL_IMPORT_TOKENS.extract.inputTokens, TYPICAL_IMPORT_TOKENS.extract.outputTokens)
  );
}

export function estimateSelectionCostUsd(count: number): number {
  return Math.max(0, count) * importUnitCostUsd();
}

/**
 * The line under the checklist: `12 selected · about $0.80`.
 *
 * "about" is load-bearing. The number is an estimate off a measured average and
 * saying so is the difference between an operator sanity-checking an order of
 * magnitude and an operator believing a quote.
 */
export function formatSelectionCost(count: number): string {
  return `${count} selected · about $${estimateSelectionCostUsd(count).toFixed(2)}`;
}
