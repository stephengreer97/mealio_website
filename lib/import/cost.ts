/**
 * What a selection is about to cost (MEAL-90).
 *
 * The checklist can put 200 items one click away from a run, and the guard rail
 * against pressing that by accident is a number on the screen before it happens
 * — far more effective than a confirmation dialog nobody reads.
 *
 * The figure is **derived, not typed in**. What MEAL-71 measured is a token
 * shape — one cheap gate call and one extraction call, with the sizes below —
 * not a price. Multiplying that shape by `MODEL_PRICING` is what let the day
 * `EXTRACTION_MODEL` moved from Opus to Haiku 4.5 carry the estimate with it:
 * ~$0.067 an import became ~$0.016 without anyone editing a number here. A
 * typed-in figure would have rotted into a lie an operator is trusting with
 * someone's budget, which is the whole reason for the indirection.
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
 *
 * THIS IS AN ESTIMATE AND IT IS OLDER THAN IT LOOKS. It was measured when
 * extraction ran on **Opus with adaptive thinking**. Extraction is Haiku now and
 * thinking is off, and nobody has re-measured the SHAPE. The pricing follows the
 * model automatically; these token counts do not, so they are the one number
 * here that can be silently wrong.
 *
 * Since MEAL-222 that is checkable rather than arguable. `recipe_imports` stores
 * the real counts per stage, so a week of rows answers it in one query:
 *
 *     SELECT
 *       percentile_cont(0.5) WITHIN GROUP (ORDER BY gate_input_tokens)     AS gate_in,
 *       percentile_cont(0.5) WITHIN GROUP (ORDER BY gate_output_tokens)    AS gate_out,
 *       percentile_cont(0.5) WITHIN GROUP (ORDER BY extract_input_tokens)  AS ext_in,
 *       percentile_cont(0.5) WITHIN GROUP (ORDER BY extract_output_tokens) AS ext_out,
 *       count(*)                                                           AS n
 *     FROM public.recipe_imports
 *     WHERE occurred_at > now() - interval '7 days'
 *       AND cached = false;
 *
 * MEDIAN, not mean: one pathological page with a 40k-word recipe drags an
 * average and tells you nothing about the import you are about to run. `cached`
 * is excluded because a cache hit paid for neither call and would pull every
 * figure towards zero.
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
 * The line under the checklist: `12 selected · about $0.19`.
 *
 * "about" is load-bearing. The number is an estimate off a measured average and
 * saying so is the difference between an operator sanity-checking an order of
 * magnitude and an operator believing a quote.
 */
export function formatSelectionCost(count: number): string {
  return `${count} selected · about $${estimateSelectionCostUsd(count).toFixed(2)}`;
}
