// MEAL-222. Every import attempt leaves a row carrying its tokens and its cost.
//
// Nothing new is measured. `anthropic.ts` already reads input_tokens and
// output_tokens off every response, records the CONCRETE model snapshot the API
// served, and prices it -- per call, gate and extraction separately. Then
// `ImportTelemetry` flattened the lot to one `costUsd` and wrote a log line.
// This is the promotion its own comment asked for.
//
// THE ASSERTIONS THAT MATTER ARE THE ONES ABOUT WHAT IS *KEPT APART*. A single
// total is what we had; per-stage tokens are what makes the questions
// answerable, so a test that only checks "a row was written" would pass on the
// version of this that throws away the interesting half.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeDb } from '../helpers/supabase-mock';

vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());
const logged = vi.fn();
vi.mock('@/lib/logger', () => ({ log: (...a: unknown[]) => logged(...a) }));

import { importRow, recordImport, importLogSink } from '@/lib/import/import-log';
import type { ImportTelemetry } from '@/lib/import/types';

const GATE = { model: 'claude-haiku-4-5-20251001', inputTokens: 2500, outputTokens: 120, costUsd: 0.0031 };
const EXTRACT = { model: 'claude-haiku-4-5-20251001', inputTokens: 6000, outputTokens: 1350, costUsd: 0.0123 };

const event = (over: Partial<ImportTelemetry> = {}): ImportTelemetry => ({
  url: 'https://sarah.example.com/shrimp',
  outcome: 'ok',
  stage: 'complete',
  reason: null,
  platform: 'wordpress-wprm',
  path: 'json-ld',
  gateVerdict: 'yes',
  gateSource: 'classifier',
  cached: false,
  ingredientCount: 11,
  confidence: { green: 8, amber: 2, red: 1 },
  gateUsage: GATE,
  extractUsage: EXTRACT,
  costUsd: GATE.costUsd + EXTRACT.costUsd,
  durationMs: 4210,
  ...over,
});

beforeEach(() => {
  fakeDb.reset();
  // SEEDED EMPTY, and it has to be. The fake silently no-ops a write to a table
  // it has never heard of -- `tables.get(table)` returns undefined and the
  // insert branch returns `{ data: null, error: null }` -- so without this the
  // write tests below would assert against an empty array and pass whether or
  // not the code under test wrote anything at all.
  fakeDb.seed('recipe_imports', []);
  logged.mockClear();
});

describe('the row an import becomes', () => {
  it('keeps the two stages APART, tokens and cost', () => {
    // The whole point. "How often does the gate reject, and what does rejecting
    // cost" cannot be answered from a total, and this is the shape that makes
    // it a query rather than a research project.
    const row = importRow(event(), { actor: 'creator', userId: 'u1', creatorId: 'c1' });
    expect(row.gate_input_tokens).toBe(2500);
    expect(row.gate_output_tokens).toBe(120);
    expect(row.gate_cost_usd).toBe(0.0031);
    expect(row.extract_input_tokens).toBe(6000);
    expect(row.extract_output_tokens).toBe(1350);
    expect(row.extract_cost_usd).toBe(0.0123);
  });

  it('stores the CONCRETE model snapshot, not the alias we asked for', () => {
    // The client goes to the trouble of capturing what the API actually served.
    // That distinction is worthless if it is not persisted.
    const row = importRow(event(), { actor: 'creator' });
    expect(row.gate_model).toBe('claude-haiku-4-5-20251001');
    expect(row.extract_model).toBe('claude-haiku-4-5-20251001');
  });

  it('records TOKENS as well as cost, because tokens are the fact', () => {
    // Prices change and models change. A repricing has to be recomputable over
    // history rather than leaving a column that means something different
    // before and after a date.
    const row = importRow(event(), { actor: 'user' });
    expect(row.gate_input_tokens).not.toBeNull();
    expect(row.extract_input_tokens).not.toBeNull();
  });

  it('splits creator from user, which is the reason this is one table', () => {
    expect(importRow(event(), { actor: 'creator' }).actor).toBe('creator');
    expect(importRow(event(), { actor: 'user' }).actor).toBe('user');
  });

  it('writes nulls, not zeros, for a stage that never ran', () => {
    // A structured-data shortcut makes the classifier unnecessary. Zero would
    // say "the gate ran and was free", which is a different and false claim,
    // and it would drag every average towards nothing.
    const row = importRow(event({ gateUsage: null, gateVerdict: null, gateSource: null }), { actor: 'creator' });
    expect(row.gate_input_tokens).toBeNull();
    expect(row.gate_cost_usd).toBeNull();
    expect(row.extract_input_tokens).toBe(6000);
  });

  it('truncates a pathological URL rather than losing the row', () => {
    // The column is capped at 2048. Failing the insert would cost us the row,
    // and the row is the part with the money in it.
    const row = importRow(event({ url: `https://x.example.com/${'a'.repeat(5000)}` }), { actor: 'user' });
    expect(row.url!.length).toBe(2048);
  });
});

describe('a rejection is a row too', () => {
  it('stores the gate cost of an import that was refused', () => {
    // A rejection costs money -- about $0.0031 when the gate says no -- and an
    // import that failed AFTER paying for extraction is exactly the row worth
    // finding. Filtering to successes would hide the spend with nothing to show
    // for it, which is the spend most worth seeing.
    const row = importRow(
      event({
        outcome: 'rejected', stage: 'gate', reason: 'gate-no',
        gateVerdict: 'no', extractUsage: null, ingredientCount: null,
        confidence: null, costUsd: GATE.costUsd,
      }),
      { actor: 'user', userId: 'u9' },
    );
    expect(row.outcome).toBe('rejected');
    expect(row.gate_cost_usd).toBe(0.0031);
    expect(row.extract_cost_usd).toBeNull();
    expect(row.total_cost_usd).toBe(0.0031);
  });
});

describe('writing it', () => {
  it('lands in recipe_imports', async () => {
    const ok = await recordImport(event(), { actor: 'creator', userId: 'u1', creatorId: 'c1' });
    expect(ok).toBe(true);
    const rows = fakeDb.rows('recipe_imports');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: 'creator', creator_id: 'c1', gate_input_tokens: 2500 });
  });

  it('NAMES a rejected insert, not only a thrown one', async () => {
    // TWO failure paths, and they are not the same code. supabase-js RETURNS
    // `{ error }` for a constraint violation or a missing column and THROWS for
    // a transport failure. The first version of this file only exercised the
    // throw, and a mutant that turned the returned-error branch into a success
    // survived it -- which is the branch a renamed column actually takes.
    fakeDb.unique('recipe_imports', ['url']);
    await recordImport(event(), { actor: 'creator' });
    const ok = await recordImport(event(), { actor: 'creator' });
    expect(ok).toBe(false);
    expect(logged).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'IMPORT:RECORD_FAILED', status: 'error' }),
    );
  });

  it('NAMES a write failure instead of swallowing it', async () => {
    // The failure mode of a quiet catch is a dashboard that reads zero and
    // looks like nobody imported. A missing table or a renamed column has to be
    // visible, and this is exactly how MEAL-219 lost a day.
    vi.spyOn(fakeDb, 'from').mockImplementationOnce((() => {
      throw new Error('relation "recipe_imports" does not exist');
    }) as never);
    const ok = await recordImport(event(), { actor: 'user' });
    expect(ok).toBe(false);
    expect(logged).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'IMPORT:RECORD_FAILED', status: 'error' }),
    );
  });

  it('keeps the log line as well as the row', async () => {
    // Both, deliberately. The line is what you grep when one import misbehaved;
    // dropping it would trade something that works today for a table with no
    // history in it yet.
    const alsoLog = vi.fn();
    importLogSink({ actor: 'creator', creatorId: 'c1' }, alsoLog)(event());
    expect(alsoLog).toHaveBeenCalledTimes(1);
    // The insert is fire-and-forget, so let the microtask that issues it run.
    await new Promise((r) => setTimeout(r, 0));
    expect(fakeDb.rows('recipe_imports')).toHaveLength(1);
  });
});
