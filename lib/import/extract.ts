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
import { canonicalizeDifficulty, canonicalizeServes, canonicalizeTags, MAX_MEAL_TAGS, MEAL_TAGS } from './vocab';

/**
 * Drops footnote markers a recipe card left on the end of a line.
 *
 * Budget Bytes' own JSON-LD ends a step "…remove them from the heat and
 * enjoy!**", where the asterisks point at a note printed under their recipe
 * card. Lifted out of that page the marker refers to nothing, so it arrives in
 * a Mealio draft as two characters of noise the creator deletes by hand.
 *
 * Only trailing runs, and only per line. An asterisk inside a line may be doing
 * real work — "1 tbsp butter *or* oil" — and a step that legitimately ends in
 * one is not a thing that happens.
 */
export function stripFootnoteMarkers(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/\s*\*+\s*$/, ''))
    .join('\n');
}
import { nullPhotoResolver, type PhotoResolution, type PhotoResolver } from './photo';
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

/**
 * Asks for a line, not a section.
 *
 * Not expressed as `z.string().max(…)`: the schema goes to the API as
 * `output_config.format` and constrains decoding, so an unsupported keyword
 * there fails every import rather than one span. This is guidance the model
 * follows; the bound that actually holds is `MAX_EVIDENCE_CHARS` in
 * `confidence.ts`, applied to what we store and show.
 */
const EVIDENCE_DESCRIPTION =
  'The exact span of the supplied source you took this from, copied character for character. ' +
  'Quote the line, not the section — 600 characters is more than enough. ' +
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
    value: z.string().describe(
      "One or two sentences of the creator's own framing — usually the line before the ingredients. "
      + 'Fill it even when the same sentence also supported tags or difficulty. Empty string only if the '
      + 'source really has no framing of its own.',
    ),
    evidence: z.string().nullable().describe(EVIDENCE_DESCRIPTION),
    derivation: DerivationEnum,
  }),
  difficulty: z.object({
    value: z.number().nullable().describe('1 Easy, 2 Easy-Medium, 3 Medium, 4 Medium-Hard, 5 Hard. null if unclear.'),
    evidence: z.string().nullable().describe(EVIDENCE_DESCRIPTION),
    derivation: DerivationEnum,
  }),
  tags: z.object({
    value: z.array(z.string()).describe('At most 3 tags, chosen only from the supplied list.'),
    evidence: z.string().nullable().describe(EVIDENCE_DESCRIPTION),
    derivation: DerivationEnum,
  }),
  serves: z.object({
    value: z
      .string()
      .describe(
        'How many PEOPLE the dish feeds, as digits only: "4", or a range "4-6". ' +
          'Empty string if the source does not say how many people it feeds.',
      ),
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
- "normalized" — restated from a span you can point to without changing what it says: a unit
                 spelled out ("tablespoons" -> "tbsp"), a compound line split, instructions
                 renumbered. evidence is the span you restated, quoted exactly.
- "inferred"   — judged from the source as a whole rather than stated outright (tags, difficulty).
                 evidence is the span that most supports the judgement.
- "absent"     — the source does not contain this. evidence is null and value is "" (or null for
                 difficulty, [] for tags).

Never invent a value to fill a field. "absent" is a correct, expected answer, and an empty field
the creator fills in themselves costs far less than a plausible wrong one they don't notice.

### One span can answer several fields — reuse it

Fields do not divide the source between them. The sentence or two a creator writes before the
ingredients usually carries three things at once: how they'd describe the dish (story), what kind
of dish it is (tags), and how hard it is (difficulty). Using the same span as evidence for all
three is correct and expected. Do not leave a field "absent" because you already pointed another
field at that line.

Worked example. Given:

    Sheet Pan Harissa Chicken & Chickpeas — one tray, no fuss, and the chickpeas go crisp at
    the edges while the chicken finishes. Weeknight food that looks like you tried.

    Serves 3

- story      -> "one tray, no fuss, and the chickpeas go crisp at the edges while the chicken
                finishes. Weeknight food that looks like you tried." (page-text)
- tags       -> Sheet Pan, Chicken, Under 45 Min, judged from the same sentence (inferred)
- difficulty -> 1, "no fuss" and one tray (inferred)

All three point at the same text. That is right, not double-counting.

**The exception, and it is absolute: this never reaches ingredients.** "One tray" is not a tray of
anything, "done in half an hour" is not a measurement, and "mostly tins" is not a can of something.
Framing describes the dish; it never becomes a line in the shopping list. Ingredients come only
from the ingredient list itself — see below.

## Ingredients

**One entry per buyable product**, in source order. Every row becomes a search on a grocery
site, so the test for a row is: could a shopper put this one thing in a basket?

Split each ingredient into:
- productName: the grocery item only. Drop amounts, units, and preparation notes.
  "2 tbsp unsalted butter, melted" -> "unsalted butter". "1 (14 oz) can black beans, drained"
  -> "black beans". "3 cloves garlic, minced" -> "garlic".
- measure: the numeric amount exactly as written ("2", "1 1/2", "0.5"), or null when the source
  gives none.
- unit: the unit as written. Use "qty" for anything counted rather than measured (3 eggs,
  2 onions, 1 lime).
- qty: the count for countable items; 1 for anything measured by a unit.

### One line can name more than one product — split it

"salt and pepper to taste" is two products and must produce two rows, "salt" and "pepper". Nobody
sells "salt and pepper", so a single merged row is a row that will never match anything.

Split on "and", "&", "or", and commas **between distinct products**, and give each row the amount
that belongs to it:
- "salt and pepper to taste" -> "salt" (no amount), "pepper" (no amount)
- "1 tbsp oil and 1 tbsp vinegar" -> "oil" 1 tbsp, "vinegar" 1 tbsp
- "2 tbsp olive or vegetable oil" -> ONE row, "olive oil" — that is one product with an
  alternative, not two ingredients.

Do not split a name that only *reads* like two things: "salt and vinegar crisps", "macaroni and
cheese", "oil and vinegar dressing" are each one product. The question is always whether a shop
sells them separately for this recipe.

Keep split rows adjacent and in the order the line named them, and set derivation to "normalized"
with the whole original line as the evidence span.

### No stated amount means no amount — but keep the word the line used

If a line gives no number, **measure is null**. Never convert a vague amount into a precise one:
"a knob of butter", "a handful of parsley", "a pinch of saffron", "many grinds of black pepper"
are not 1 tbsp and not 2 tbsp. A guessed number reads as fact to the creator reviewing the draft
and to the cook following it, and there is nothing in the source to check it against. An amount
left empty costs a creator one keystroke; an invented one is wrong quietly.

That rule is about the **number**, not the word. If the line names a unit, keep it:

- "a handful of parsley"          -> measure null, unit "handfuls"
- "many grinds of black pepper"   -> measure null, unit "grinds"
- "3 cloves garlic"               -> measure "3",  unit "cloves"
- "1 can chopped tomatoes"        -> measure "1",  unit "cans"

Use "qty" only when the line names **no unit at all** — "salt to taste", "2 onions", "eggs".

Dropping the word loses something the source actually said. "parsley" alone does not tell a cook
they need a handful of it, and there was no guessing involved in reading the word off the page.

Set derivation to "json-ld" or "page-text" when you split a line without changing any value, and
"normalized" when you restated one.

Skip section headings ("For the sauce:") and equipment. Do not reorder ingredients, and do not
merge two products into one row.

## serves is a number of people, not a yield

"serves" means how many PEOPLE the dish feeds. Emit digits only: "4", or a range like "4-6".

Recipe pages usually publish a YIELD instead, and a yield is a different quantity. Do not convert
one into the other:
- "2 1/2 cups guacamole" is a volume. It is NOT "serves 2". Emit "" and mark it absent.
- "Makes 12 pancakes" is a batch of items. It is NOT "serves 12". Emit "" and mark it absent.
- "1 loaf", "500 g", "one 9-inch pie" are all yields, not serving counts. Emit "" and mark absent.
- "Serves 4", "Serves 4-6", "4 servings", "Feeds a family of 6" ARE serving counts. Emit
  "4", "4-6", "4", "6".

If the page gives only a yield and never says how many people it feeds, that is a normal and
correct outcome: emit "" with derivation "absent". Do not estimate a serving count from a volume,
a weight, or a number of items. A creator filling in one number themselves costs far less than a
wrong number they do not notice.`;

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
  /** Copies the page's image into our storage, or finds a stand-in. */
  resolvePhoto?: PhotoResolver;
}

export interface ExtractionResult {
  output: ExtractionOutput;
  draft: CreatorMealDraft;
  /** Indices into `output.ingredients` that survived canonicalisation, aligned with `draft.ingredients`. */
  keptIngredientIndices: number[];
  usedJsonLd: boolean;
  /** Which route was taken — logged for every import. */
  path: ExtractionPath;
  /** How the photo was obtained. */
  photo: PhotoResolution;
  usage: StructuredUsage;
}

function emptyField<T>(value: T): ExtractedField<T> {
  return { value, evidence: null, derivation: 'absent' };
}

/**
 * Turns a resolved photo into a provenance-bearing field.
 *
 * A copied image reports the **source** URL as both value and evidence: what we
 * are attesting is that the page really does publish this image, which is
 * checkable against the page. Re-hosting it on our storage is our own
 * bookkeeping, not a claim about the source, so the storage URL goes in the
 * draft and the source URL goes in the provenance. A Pixabay stand-in makes no
 * claim about the page at all and is marked `generated`.
 */
function photoField(document: SourceDocument, photo: PhotoResolution): ExtractedField<string> {
  if (!photo.url) return emptyField('');
  if (photo.origin === 'copied' && photo.sourceUrl) {
    const derivation: Derivation =
      document.jsonLd?.image === photo.sourceUrl ? 'json-ld' : 'page-text';
    return { value: photo.sourceUrl, evidence: photo.sourceUrl, derivation };
  }
  // `evidence` carries the explanation for a generated value; there is no span.
  return { value: photo.url, evidence: photo.detail, derivation: 'generated' };
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
    purpose: 'extract',
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

  // The photo is resolved by us, never asked of the model: a model inventing an
  // image URL is exactly the failure the confidence indicator exists to catch.
  const photo = await (options.resolvePhoto ?? nullPhotoResolver)({
    sourceImageUrl: document.imageUrl,
    mealName: raw.name.value.trim() || document.title,
  });

  const photoUrl = photoField(document, photo);
  const serves = canonicalizeServes(raw.serves.value, raw.serves.evidence);

  const output: ExtractionOutput = {
    name: raw.name,
    ingredients,
    recipe: { ...raw.recipe, value: stripFootnoteMarkers(raw.recipe.value) },
    story: raw.story,
    photoUrl,
    difficulty: { ...raw.difficulty, value: canonicalizeDifficulty(raw.difficulty.value) },
    // Capped here rather than inside `canonicalizeTags`, which is also what a
    // creator's own edit goes through — and there an over-cap list must be
    // REFUSED, not silently trimmed to the first three. This is the model's
    // proposal, so trimming is the right answer: it asked for at most three and
    // sometimes returns more, and a review card offering six of a three-tag
    // limit makes the creator do arithmetic the extraction should have done.
    tags: { ...raw.tags, value: canonicalizeTags(raw.tags.value).slice(0, MAX_MEAL_TAGS) },
    // A rejected serves keeps its span so the reason can explain what we saw,
    // but carries no value — which reads red, as it should.
    serves: { ...raw.serves, value: serves ?? '' },
  };

  const canonical = canonicalizeIngredients(output.ingredients);

  const draft: CreatorMealDraft = {
    name: output.name.value.trim(),
    ingredients: canonical.ingredients,
    recipe: output.recipe.value.trim() || null,
    source: document.url,
    story: output.story.value.trim() || null,
    // Our storage URL, never the third-party one we read it from.
    photoUrl: photo.url,
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
    photo,
    usage: response.usage,
  };
}

/** Exposed for the eval harness, which asserts on the prompt the model actually sees. */
export const __prompts = { SYSTEM_PROMPT, jsonLdPrompt, pageTextPrompt, ExtractionSchema };
