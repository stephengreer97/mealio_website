import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { extractDraft } from '@/lib/import/extract';
import { toSourceDocument, serializeJsonLd } from '@/lib/import/html';
import { createStructuredCaller, EXTRACTION_MODEL, MODEL_PRICING } from '@/lib/import/anthropic';
import type { DraftIngredient, RecipeJsonLd, SourceDocument } from '@/lib/import/types';

/**
 * Extraction eval set (MEAL-71).
 *
 * **Not part of `npm test`.** It makes real, billed API calls. Run it with:
 *
 *     npm run test:eval                       # claude-opus-5
 *     EVAL_MODEL=claude-sonnet-5 npm run test:eval
 *
 * Why it exists: extraction quality regressions are invisible without one,
 * because the output always *looks* plausible. Ten real sources with
 * hand-written expected output, re-run on every prompt change. Same argument as
 * MEAL-27 for product matching.
 *
 * `expected` is hand-written and is the contract the model is graded against.
 * It is deliberately not generated from a model run — an eval generated from
 * output agrees with whatever it measures.
 */

const EVAL_DIR = join(process.cwd(), 'tests/fixtures/import/eval');
const HTML_DIR = join(process.cwd(), 'tests/fixtures/import/html');

/** Ingredient normalisation must match hand-written expectations on ≥90% of items. */
const PASS_THRESHOLD = 0.9;

interface ExpectedIngredient {
  ingredientName: string;
  qty?: number;
  unit?: string;
  measure?: string | null;
}

interface EvalItem {
  id: string;
  url: string;
  note: string;
  sourceFrom?: string;
  source?: { title: string; text: string; jsonLd: RecipeJsonLd | null };
  expected: {
    name?: string;
    nameContains?: string;
    serves?: string | null;
    /** The source states a yield but no people count — serves must come back empty. */
    servesMustBeEmpty?: boolean;
    /** Values that would mean the yield was misread as a serving count. */
    servesMustNotBe?: string[];
    ingredients: ExpectedIngredient[];
    ingredientCountRange?: [number, number];
    mustNotContain?: string[];
  };
}

function loadItems(): EvalItem[] {
  return readdirSync(EVAL_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(EVAL_DIR, f), 'utf8')) as EvalItem);
}

/** Builds exactly the SourceDocument production would send for this item. */
function sourceFor(item: EvalItem): SourceDocument {
  if (item.sourceFrom) {
    return toSourceDocument(item.url, readFileSync(join(HTML_DIR, item.sourceFrom), 'utf8'));
  }
  const source = item.source!;
  return {
    url: item.url,
    title: source.title,
    text: source.text,
    jsonLd: source.jsonLd,
    structuredSource: source.jsonLd ? 'json-ld' : null,
    jsonLdRaw: source.jsonLd ? serializeJsonLd(source.jsonLd) : null,
    imageUrl: null,
    platform: 'unknown',
  };
}

const normalise = (value: string) =>
  value.toLowerCase().normalize('NFKC').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/** Two product names match if either contains the other's significant words. */
function nameMatches(actual: string, expected: string): boolean {
  const a = normalise(actual);
  const e = normalise(expected);
  if (a === e) return true;
  if (a.includes(e) || e.includes(a)) return true;
  const expectedWords = e.split(' ').filter((w) => w.length > 2);
  if (expectedWords.length === 0) return false;
  const hit = expectedWords.filter((w) => a.includes(w)).length;
  return hit / expectedWords.length >= 0.6;
}

interface RowScore {
  expected: ExpectedIngredient;
  actual: DraftIngredient | null;
  nameOk: boolean;
  unitOk: boolean;
  amountOk: boolean;
}

function scoreRow(expected: ExpectedIngredient, actual: DraftIngredient | undefined): RowScore {
  if (!actual) return { expected, actual: null, nameOk: false, unitOk: false, amountOk: false };
  const nameOk = nameMatches(actual.ingredientName, expected.ingredientName);
  const unitOk = expected.unit == null || actual.unit === expected.unit;
  const amountOk =
    expected.measure === undefined
      ? true
      : expected.measure === null
        ? actual.measure == null && (expected.qty == null || actual.qty === expected.qty)
        : String(actual.measure) === String(expected.measure);
  return { expected, actual, nameOk, unitOk, amountOk };
}

const hasKey = Boolean(process.env.ANTHROPIC_API_KEY);
const model = process.env.EVAL_MODEL ?? EXTRACTION_MODEL;

describe.skipIf(!hasKey)(`extraction eval — ${model}`, () => {
  const items = loadItems();
  const perItem: { id: string; rate: number; costUsd: number; ingredients: number }[] = [];

  beforeAll(() => {
    if (!MODEL_PRICING[model]) {
      throw new Error(`EVAL_MODEL=${model} has no pricing entry; add it to MODEL_PRICING first.`);
    }
  });

  for (const item of items) {
    it(
      `${item.id} — ${item.note}`,
      async () => {
        const document = sourceFor(item);
        const result = await extractDraft(document, {
          call: createStructuredCaller(),
          model,
        });

        // The API guarantees schema-valid output, so this is about content.
        expect(result.draft.name.length).toBeGreaterThan(0);
        expect(result.draft.source).toBe(item.url);

        if (item.expected.nameContains) {
          expect(result.draft.name.toLowerCase()).toContain(item.expected.nameContains.toLowerCase());
        }
        // `serves` is a people count in the form's shape, never a yield.
        if (result.draft.serves) {
          expect(result.draft.serves).toMatch(/^\d+(-\d+)?$/);
        }
        if (item.expected.servesMustBeEmpty) {
          // The page states a volume or a batch of items and no serving count.
          // Empty is the correct answer; a number here is invented data.
          expect(result.draft.serves).toBeNull();
        }
        if (item.expected.serves) {
          expect(result.draft.serves).toBe(item.expected.serves);
        }
        for (const forbidden of item.expected.servesMustNotBe ?? []) {
          expect(result.draft.serves).not.toBe(forbidden);
        }
        if (item.expected.ingredientCountRange) {
          const [lo, hi] = item.expected.ingredientCountRange;
          expect(result.draft.ingredients.length).toBeGreaterThanOrEqual(lo);
          expect(result.draft.ingredients.length).toBeLessThanOrEqual(hi);
        }
        for (const forbidden of item.expected.mustNotContain ?? []) {
          const names = result.draft.ingredients.map((i) => normalise(i.ingredientName));
          expect(names).not.toContain(normalise(forbidden));
        }

        // Score each expected ingredient against its best-matching output row.
        const remaining = [...result.draft.ingredients];
        const rows: RowScore[] = item.expected.ingredients.map((expected) => {
          const index = remaining.findIndex((a) => nameMatches(a.ingredientName, expected.ingredientName));
          const actual = index >= 0 ? remaining.splice(index, 1)[0] : undefined;
          return scoreRow(expected, actual);
        });

        const passed = rows.filter((r) => r.nameOk && r.unitOk && r.amountOk).length;
        const rate = rows.length === 0 ? 1 : passed / rows.length;

        perItem.push({
          id: item.id,
          rate,
          costUsd: result.usage.costUsd,
          ingredients: result.draft.ingredients.length,
        });

        for (const row of rows) {
          if (row.nameOk && row.unitOk && row.amountOk) continue;
          // eslint-disable-next-line no-console
          console.log(
            `  ${item.id}: expected ${JSON.stringify(row.expected)} got ${JSON.stringify(row.actual)}`,
          );
        }

        expect(rate).toBeGreaterThanOrEqual(PASS_THRESHOLD);
      },
      180_000,
    );
  }

  it('reports the aggregate match rate and cost per import', () => {
    const totalRate = perItem.reduce((sum, i) => sum + i.rate, 0) / (perItem.length || 1);
    const totalCost = perItem.reduce((sum, i) => sum + i.costUsd, 0);

    // eslint-disable-next-line no-console
    console.log(
      [
        '',
        `model:                ${model}`,
        `items:                ${perItem.length}`,
        `ingredient match:     ${(totalRate * 100).toFixed(1)}%`,
        `cost per import:      $${(totalCost / (perItem.length || 1)).toFixed(4)}`,
        `cost for the set:     $${totalCost.toFixed(4)}`,
        '',
        ...perItem.map(
          (i) => `  ${i.id.padEnd(36)} ${(i.rate * 100).toFixed(0).padStart(3)}%  $${i.costUsd.toFixed(4)}  ${i.ingredients} ingredients`,
        ),
        '',
      ].join('\n'),
    );

    expect(totalRate).toBeGreaterThanOrEqual(PASS_THRESHOLD);
  });
});

describe.skipIf(hasKey)('extraction eval', () => {
  it('is skipped without ANTHROPIC_API_KEY', () => {
    // eslint-disable-next-line no-console
    console.log(
      'ANTHROPIC_API_KEY is not set, so the eval set did not run. Per MEAL-68 this needs an ' +
        'Anthropic API key billed through the Console — set it and re-run `npm run test:eval`.',
    );
    expect(loadItems().length).toBeGreaterThanOrEqual(12);
  });
});
