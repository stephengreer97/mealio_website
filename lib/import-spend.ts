/**
 * MEAL-222. What imports cost over a window, split by who ran them.
 *
 * The aggregation lives here rather than in the route so it can be tested
 * against rows instead of against HTTP, which is the same split
 * `automation-requests` uses.
 *
 * EVERY FIGURE IS OVER ATTEMPTS, NOT SUCCESSES. A rejection costs money and a
 * summary that quietly counted only the imports that worked would understate
 * spend by exactly the amount that had nothing to show for it -- the part most
 * worth seeing.
 */

export interface SpendRow {
  actor: string | null;
  /** Whose imports these are. Null for a user import, and for a creator row
   *  written before this column was read. */
  creator_id?: string | null;
  outcome: string | null;
  stage: string | null;
  cached: boolean | null;
  gate_cost_usd: number | string | null;
  extract_cost_usd: number | string | null;
  total_cost_usd: number | string | null;
  gate_input_tokens: number | null;
  gate_output_tokens: number | null;
  extract_input_tokens: number | null;
  extract_output_tokens: number | null;
}

export interface SpendBucket {
  imports: number;
  rejected: number;
  /** Answered from cache: no call was made and no money was spent. */
  cached: number;
  costUsd: number;
  gateCostUsd: number;
  extractCostUsd: number;
  /** Median tokens per stage, over the rows that actually paid. */
  medianTokens: {
    gateInput: number | null;
    gateOutput: number | null;
    extractInput: number | null;
    extractOutput: number | null;
  };
}

export interface SpendView {
  total: SpendBucket;
  byActor: Record<string, SpendBucket>;
  /**
   * The same money, split by WHICH CREATOR (MEAL-222 follow-up).
   *
   * `byActor` answers "what do creator imports cost us against user imports",
   * which is the platform question. This answers "what does THIS creator cost",
   * which is the one asked while looking at a creator — and it is asked on their
   * own card, beside the drafts those imports produced.
   *
   * Keyed by `creator_id`, and a row without one is simply absent rather than
   * bucketed under a placeholder: unlike `byActor`, nothing here claims to be a
   * total, so an unattributable row has no home to distort. `total` is still the
   * sum of everything.
   */
  byCreator: Record<string, SpendBucket>;
}

/**
 * `numeric` comes back from PostgREST as a STRING, not a number.
 *
 * Postgres numeric is arbitrary precision and JSON numbers are doubles, so
 * postgres-meta hands it over as text rather than silently rounding it. Adding
 * these with `+` without this would concatenate: "0.0031" + "0.0123" is
 * "0.00310.0123", and a spend dashboard would show a number with no decimal
 * point in it and look merely large rather than broken.
 */
function num(value: number | string | null | undefined): number {
  if (value == null) return 0;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * MEDIAN, not mean. One pathological page with a 40,000-word recipe drags an
 * average and tells you nothing about the import you are about to run, which is
 * the question `TYPICAL_IMPORT_TOKENS` exists to answer.
 */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function emptyBucket(): SpendBucket & { _tokens: Record<string, number[]> } {
  return {
    imports: 0, rejected: 0, cached: 0,
    costUsd: 0, gateCostUsd: 0, extractCostUsd: 0,
    medianTokens: { gateInput: null, gateOutput: null, extractInput: null, extractOutput: null },
    _tokens: { gateInput: [], gateOutput: [], extractInput: [], extractOutput: [] },
  };
}

/** Rounds money to the cent-fraction the rest of the import UI uses. */
const money = (n: number) => Math.round(n * 1e6) / 1e6;

export function buildSpendView(rows: SpendRow[]): SpendView {
  const buckets = new Map<string, ReturnType<typeof emptyBucket>>();
  const creatorBuckets = new Map<string, ReturnType<typeof emptyBucket>>();
  const total = emptyBucket();

  const add = (b: ReturnType<typeof emptyBucket>, row: SpendRow) => {
    b.imports++;
    if (row.outcome === 'rejected') b.rejected++;
    if (row.cached) b.cached++;
    b.costUsd += num(row.total_cost_usd);
    b.gateCostUsd += num(row.gate_cost_usd);
    b.extractCostUsd += num(row.extract_cost_usd);
    // Only rows that PAID feed the medians. A cache hit and a stage that never
    // ran are both nulls, and counting them as zero would drag the typical
    // shape towards a number no real import has ever had.
    if (row.gate_input_tokens != null) b._tokens.gateInput.push(row.gate_input_tokens);
    if (row.gate_output_tokens != null) b._tokens.gateOutput.push(row.gate_output_tokens);
    if (row.extract_input_tokens != null) b._tokens.extractInput.push(row.extract_input_tokens);
    if (row.extract_output_tokens != null) b._tokens.extractOutput.push(row.extract_output_tokens);
  };

  for (const row of rows) {
    // An unknown or missing actor is bucketed under its own name rather than
    // dropped. A row we cannot attribute is still money we spent, and a total
    // that does not match the sum of its parts is worse than an ugly label.
    const key = row.actor && row.actor.trim() ? row.actor : 'unknown';
    let bucket = buckets.get(key);
    if (!bucket) { bucket = emptyBucket(); buckets.set(key, bucket); }
    add(bucket, row);
    add(total, row);

    // Only when there is a creator to attribute it to. See `byCreator`.
    const creatorId = row.creator_id && row.creator_id.trim() ? row.creator_id : null;
    if (creatorId) {
      let mine = creatorBuckets.get(creatorId);
      if (!mine) { mine = emptyBucket(); creatorBuckets.set(creatorId, mine); }
      add(mine, row);
    }
  }

  const finish = (b: ReturnType<typeof emptyBucket>): SpendBucket => {
    const { _tokens, ...rest } = b;
    return {
      ...rest,
      costUsd: money(rest.costUsd),
      gateCostUsd: money(rest.gateCostUsd),
      extractCostUsd: money(rest.extractCostUsd),
      medianTokens: {
        gateInput: median(_tokens.gateInput),
        gateOutput: median(_tokens.gateOutput),
        extractInput: median(_tokens.extractInput),
        extractOutput: median(_tokens.extractOutput),
      },
    };
  };

  const byActor: Record<string, SpendBucket> = {};
  for (const [key, bucket] of buckets) byActor[key] = finish(bucket);
  const byCreator: Record<string, SpendBucket> = {};
  for (const [key, bucket] of creatorBuckets) byCreator[key] = finish(bucket);
  return { total: finish(total), byActor, byCreator };
}
