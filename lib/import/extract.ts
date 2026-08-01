/**
 * Extraction service: source document → creator meal draft (MEAL-71).
 *
 * URL → our nine fields is structured extraction, the highest-reliability
 * category of LLM work. With `output_config.format` and a JSON schema the API
 * guarantees schema-valid output, so the "did it return parseable JSON" failure
 * class disappears entirely and what is left is an accuracy problem.
 *
 * Two paths, one output shape:
 *
 *  1. **JSON-LD present** — the model is handed the parsed `schema.org/Recipe`
 *     fields. Its job shrinks to normalising ingredient strings into our shape
 *     and inferring tags and difficulty. Roughly 10× cheaper and materially
 *     more accurate.
 *  2. **No JSON-LD** — full extraction from cleaned page text.
 *
 * Both return the same shape with a `derivation` marker per field, which is what
 * lets MEAL-72 tell them apart mechanically rather than trusting a label.
 *
 * `photoUrl` is deliberately **not** asked of the model. A model inventing an
 * image URL is precisely the failure the confidence indicator exists to catch,
 * and the page already states it in JSON-LD `image` or `og:image` — so our code
 * reads it directly.
 */

import { z } from 'zod';
import {
  EXTRACTION_MODEL,
  type StructuredCaller,
  type StructuredUsage,
} from './anthropic';
import { canonicalizeIngredients } from './ingredients';
import { canonicalizeDifficulty, canonicalizeTags, MEAL_TAGS } from './vocab';
import type {
  CreatorMealDraft,
  Derivation,
  ExtractedField,
  ExtractedIngredient,
  ExtractionOutput,
  ExtractionPath,
  SourceDocument,
} from './types';

const DerivationEnum = z.enum(['json-ld', 'page-text', 'normalized', 'inferred', 'absent']);

const EVIDENCE_DESCRIPTION =
  'The exact span of the supplied source you took this from, copied character for character. ' +
  'null if there is nothing in the source to point at.';

const ExtractionSchema = z.object({
  name: z.object({
    value: z.string().describe('The dish name as a cook would search for it.'),
    evidence: z.string().nullable().describe(EVIDENCE_DESCRIPTION),
    derivation: DerivationEnum,
  }),
  ingredients: z
    .array(
      z.object({
        productName: z
          .string()
          .describe(
            'The grocery product only — no amount, no unit, no preparation. ' +
              '"2 tbsp unsalted butter, melted" gives "unsalted butter".',
          ),
        measure: z
          .string()
          .nullable()
          .describe('The numeric amount as written ("2", "1 1/2", "0.5"), or null if none is given.'),
        unit: z
          .string()
          .describe('The unit as written ("tbsp", "cups", "g", "lb"), or "qty" for countable items.'),
        qty: z.number().describe('Count for countable items; 1 for anything measured by a unit.'),
        evidence: z.string().nullable().describe(EVIDENCE_DESCRIPTION),
        derivation: DerivationEnum,
      }),
    )
    .describe('One entry per ingredient, in the order the source lists them.'),
  recipe: z.object({
    value: z.string().describe('The method as numbered steps separated by newlines. Empty string if absent.'),
    evidence: z.string().nullable().describe(EVIDENCE_DESCRIPTION),
    derivation: DerivationEnum,
  }),
  story: z.object({
    value: z.string().describe("One or two sentences of the creator's own framing. Empty string if absent."),
    evidence: z.string().nullable().describe(EVIDENCE_DESCRIPTION),
    derivation: DerivationEnum,
  }),
  difficulty: z.object({
    value: z.number().nullable().describe('1 Easy, 2 Easy-Medium, 3 Medium, 4 Medium-Hard, 5 Hard. null if unclear.'),
    evidence: z.string().nullable().describe(EVIDENCE_DESCRIPTION),
    derivation: DerivationEnum,
  }),
  tags: z.object({
    value: z.array(z.string()).describe('Up to 8 tags, chosen only from the supplied list.'),
    evidence: z.string().nullable().describe(EVIDENCE_DESCRIPTION),
    derivation: DerivationEnum,
  }),
  serves: z.object({
    value: z.string().describe('Yield as a short phrase, e.g. "4" or "4 large bowls". Empty string if absent.'),
    evidence: z.string().nullable().describe(EVIDENCE_DESCRIPTION),
    derivation: DerivationEnum,
  }),
});

export type ExtractionModelOutput = z.infer<typeof ExtractionSchema>;

const SYSTEM_PROMPT = `You fill out a recipe-publishing form from a page a food creator already wrote.
You are transcribing, not composing. Everything you emit has to be traceable to the source you were given.

## Evidence is the point

For every field you return an "evidence" span and a "derivation" label. A downstream check
verifies, character by character, that your span really appears in the source. A span you
paraphrase, tidy up, or reconstruct from memory will fail that check and the field will be shown
to the creator in red. Copy spans exactly, including their original punctuation and casing.

derivation values:
- "json-ld"    — copied out of the STRUCTURED RECIPE DATA block. evidence must be an exact
                 substring of that block.
- "page-text"  — copied verbatim out of the PAGE TEXT. evidence must be an exact substring of it.
- "normalized" — restated from a span you can point to: a unit converted, "a knob of butter"
                 turned into an amount, instructions renumbered. evidence is the span you
                 restated, quoted exactly.
- "inferred"   — judged from the source as a whole rather than stated outright (tags, difficulty).
                 evidence is the span that most supports the judgement.
- "absent"     — the source does not contain this. evidence is null and value is "" (or null for
                 difficulty, [] for tags).

Never invent a value to fill a field. "absent" is a correct, expected answer, and an empty field
the creator fills in themselves costs far less than a plausible wrong one they don't notice.

## Ingredients

One entry per ingredient line, in source order. Split each line into:
- productName: the grocery item only. Drop amounts, units, and preparation notes.
  "2 tbsp unsalted butter, melted" -> "unsalted butter". "1 (14 oz) can black beans, drained"
  -> "black beans". "3 cloves garlic, minced" -> "garlic".
- measure: the numeric amount exactly as written ("2", "1 1/2", "0.5"), or null when the source
  gives none ("salt to taste", "a handful of parsley").
- unit: the unit as written. Use "qty" for anything counted rather than measured (3 eggs,
  2 onions, 1 lime).
- qty: the count for countable items; 1 for anything measured by a unit.

If a line gives no amount at all, set measure to null and unit to "qty" — do not guess a quantity.
Set derivation to "json-ld" or "page-text" when you split a line without changing any value, and
"normalized" when you converted or estimated one.

Skip section headings ("For the sauce:") and equipment. Do not merge or reorder ingredients.`;

const TAG_INSTRUCTION = `Choose tags only from this list; anything outside it is dropped:\n${MEAL_TAGS.join(', ')}`;

function jsonLdPrompt(document: SourceDocument): string {
  return [
    'The page publishes structured recipe data. Use it as the authority for name, ingredients,',
    'instructions and yield. Use the page text only for the story and for judging tags and difficulty.',
    '',
    '## STRUCTURED RECIPE DATA',
    document.jsonLdRaw ?? '{}',
    '',
    '## PAGE TITLE',
    document.title || '(none)',
    '',
    '## PAGE TEXT',
    document.text || '(none)',
    '',
    TAG_INSTRUCTION,
  ].join('\n');
}

function pageTextPrompt(document: SourceDocument): string {
  return [
    'This page publishes no structured recipe data, so everything has to come from the text below.',
    'Be strict about evidence: if the page does not state a yield, difficulty or story, mark it absent.',
    '',
    '## PAGE TITLE',
    document.title || '(none)',
    '',
    '## PAGE TEXT',
    document.text || '(none)',
    '',
    TAG_INSTRUCTION,
  ].join('\n');
}

export interface ExtractOptions {
  call: StructuredCaller;
  model?: string;
  maxTokens?: number;
}

export interface ExtractionResult {
  output: ExtractionOutput;
  draft: CreatorMealDraft;
  /** Indices into `output.ingredients` that survived canonicalisation, aligned with `draft.ingredients`. */
  keptIngredientIndices: number[];
  usedJsonLd: boolean;
  /** Which route was taken — logged for every import. */
  path: ExtractionPath;
  usage: StructuredUsage;
}

function emptyField<T>(value: T): ExtractedField<T> {
  return { value, evidence: null, derivation: 'absent' };
}

/**
 * Resolves the photo without asking the model. JSON-LD `image` is structured
 * data and reads green; `og:image` is page metadata and reads verbatim.
 */
function resolvePhoto(document: SourceDocument): ExtractedField<string> {
  if (!document.imageUrl) return emptyField('');
  const derivation: Derivation = document.jsonLd?.image === document.imageUrl ? 'json-ld' : 'page-text';
  return { value: document.imageUrl, evidence: document.imageUrl, derivation };
}

/** Runs extraction against whichever path the source supports. */
export async function extractDraft(
  document: SourceDocument,
  options: ExtractOptions,
): Promise<ExtractionResult> {
  const usedJsonLd = Boolean(document.jsonLd && document.jsonLdRaw);
  const path: ExtractionPath = usedJsonLd ? (document.structuredSource ?? 'json-ld') : 'raw-html';
  const model = options.model ?? EXTRACTION_MODEL;

  const response = await options.call({
    model,
    system: SYSTEM_PROMPT,
    prompt: usedJsonLd ? jsonLdPrompt(document) : pageTextPrompt(document),
    schema: ExtractionSchema,
    // Adaptive thinking, with headroom: max_tokens caps thinking plus response
    // text together, and a 25-ingredient recipe with evidence spans is not small.
    maxTokens: options.maxTokens ?? 12_000,
    thinking: true,
  });

  const raw = response.output;

  const ingredients: ExtractedIngredient[] = raw.ingredients.map((item) => ({
    productName: item.productName,
    measure: item.measure,
    unit: item.unit,
    qty: item.qty,
    evidence: item.evidence,
    derivation: item.derivation,
  }));

  const photoUrl = resolvePhoto(document);

  const output: ExtractionOutput = {
    name: raw.name,
    ingredients,
    recipe: raw.recipe,
    story: raw.story,
    photoUrl,
    difficulty: { ...raw.difficulty, value: canonicalizeDifficulty(raw.difficulty.value) },
    tags: { ...raw.tags, value: canonicalizeTags(raw.tags.value) },
    serves: raw.serves,
  };

  const canonical = canonicalizeIngredients(output.ingredients);

  const draft: CreatorMealDraft = {
    name: output.name.value.trim(),
    ingredients: canonical.ingredients,
    recipe: output.recipe.value.trim() || null,
    source: document.url,
    story: output.story.value.trim() || null,
    photoUrl: output.photoUrl.value.trim() || null,
    difficulty: output.difficulty.value,
    tags: output.tags.value,
    serves: output.serves.value.trim() || null,
  };

  return {
    output,
    draft,
    keptIngredientIndices: canonical.keptIndices,
    usedJsonLd,
    path,
    usage: response.usage,
  };
}

/** Exposed for the eval harness, which asserts on the prompt the model actually sees. */
export const __prompts = { SYSTEM_PROMPT, jsonLdPrompt, pageTextPrompt, ExtractionSchema };
