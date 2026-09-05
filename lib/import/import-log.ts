/**
 * MEAL-222. Every import attempt, kept as a row rather than as a log line.
 *
 * The telemetry line this sits beside is not going away. It is the thing you
 * grep when one import misbehaved and you want the whole story in one place.
 * This is for the questions a log cannot answer: what did imports cost last
 * month, how much of that was the gate saying no, and what does a KEPT meal
 * cost once the drafts nobody accepted are counted too.
 *
 * A WRITE FAILURE HERE MUST NEVER FAIL AN IMPORT. Same rule the automation
 * telemetry follows: losing a row is always preferable to losing the recipe the
 * creator was waiting for. Every path swallows, and says so in the log so a
 * silent stop is still visible.
 */

import { createServerSupabaseClient } from '@/lib/supabase';
import { log } from '@/lib/logger';
import type { ImportTelemetry, ImportUsage } from './types';

/** Who ran the import. The split Stephen asked for, and MEAL-221's budget key. */
export type ImportActor = 'creator' | 'user';

export interface ImportLogContext {
  actor: ImportActor;
  /** Null for the poller, which imports on a creator's behalf with no request. */
  userId?: string | null;
  creatorId?: string | null;
}

/**
 * The URL column is capped in the database at 2048. Truncating here rather than
 * letting the insert fail means a pathological URL costs us the tail of one
 * field instead of the whole row, and the row is the part with the money in it.
 */
const MAX_URL = 2048;

/** Null-safe reader, so a stage that did not run writes nulls rather than zeros. */
function stage(usage: ImportUsage | null | undefined) {
  return {
    model: usage?.model ?? null,
    input: usage?.inputTokens ?? null,
    output: usage?.outputTokens ?? null,
    cost: usage?.costUsd ?? null,
  };
}

/** The row an event becomes. Exported for the test, which asserts the mapping. */
export function importRow(event: ImportTelemetry, ctx: ImportLogContext) {
  const gate = stage(event.gateUsage);
  const extract = stage(event.extractUsage);
  return {
    actor: ctx.actor,
    user_id: ctx.userId ?? null,
    creator_id: ctx.creatorId ?? null,
    url: event.url ? event.url.slice(0, MAX_URL) : null,
    platform: event.platform,
    path: event.path,
    outcome: event.outcome,
    stage: event.stage,
    reason: event.reason,
    gate_verdict: event.gateVerdict,
    gate_source: event.gateSource,
    cached: event.cached,
    gate_model: gate.model,
    gate_input_tokens: gate.input,
    gate_output_tokens: gate.output,
    gate_cost_usd: gate.cost,
    extract_model: extract.model,
    extract_input_tokens: extract.input,
    extract_output_tokens: extract.output,
    extract_cost_usd: extract.cost,
    // The event's own total, which `finish` derives from the two stages above,
    // so this column can never disagree with its parts.
    total_cost_usd: event.costUsd,
    ingredient_count: event.ingredientCount,
    confidence_green: event.confidence?.green ?? null,
    confidence_amber: event.confidence?.amber ?? null,
    confidence_red: event.confidence?.red ?? null,
    duration_ms: event.durationMs,
  };
}

/**
 * Writes one row. Returns whether it landed, for the tests; callers ignore it.
 *
 * Not awaited by the import path -- see `importLogSink`. The insert is a
 * network round trip and an import is something a creator is watching.
 */
export async function recordImport(event: ImportTelemetry, ctx: ImportLogContext): Promise<boolean> {
  try {
    const supabase = createServerSupabaseClient();
    const { error } = await supabase.from('recipe_imports').insert(importRow(event, ctx));
    if (error) {
      // Named rather than swallowed silently. A missing table or a renamed
      // column stops the accounting dead, and the failure mode of a quiet
      // catch is a dashboard that reads zero and looks like nobody imported.
      log({
        event: 'IMPORT:RECORD_FAILED',
        status: 'error',
        detail: `${error.code ?? '-'} ${error.message}`,
      });
      return false;
    }
    return true;
  } catch (err) {
    log({
      event: 'IMPORT:RECORD_FAILED',
      status: 'error',
      detail: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * A `TelemetrySink` that keeps the existing log line AND stores the row.
 *
 * Both, deliberately. The line stays greppable next to every other server
 * event, and dropping it to avoid duplication would trade a thing that works
 * today for a table with no history in it yet.
 */
export function importLogSink(
  ctx: ImportLogContext,
  alsoLog: (event: ImportTelemetry) => void,
): (event: ImportTelemetry) => void {
  return (event) => {
    alsoLog(event);
    // Fire and forget. Awaiting would put a database round trip in front of the
    // creator's result for a row nobody reads in real time.
    void recordImport(event, ctx);
  };
}
