/**
 * HTML → `{ title, text, jsonLd }` (MEAL-70).
 *
 * Two jobs:
 *
 *  - **Strip markup to text before anything reaches the extractor.** Raw markup
 *    is mostly `<div>` noise and inflates input tokens several-fold for no
 *    accuracy gain.
 *  - **Recover structured recipe data when the page publishes any.** JSON-LD
 *    first, then microdata/hRecipe.
 *
 * The MEAL-69 spike measured **27%** JSON-LD `Recipe` coverage across 49 live
 * creator URLs — the ticket's LOW band. So structured data is a fast-path, not
 * the main road: raw-HTML extraction is the product, and the two readers here
 * exist to make the cheap cases cheap.
 *
 * Three findings from that spike are encoded directly below, each of which was
 * a real bug in someone's first pass:
 *
 *  1. `type=application/ld+json` appears **unquoted** on Yoast + minified pages.
 *     A regex expecting quotes silently misses them.
 *  2. **10 of 13 hits nest Recipe inside `@graph`.** A top-level `@type` check
 *     reports 6% coverage instead of 27%.
 *  3. **"Has JSON-LD" is ~90% true and useless** — nearly every platform emits
 *     `Article`/`BlogPosting`/`SocialMediaPosting`. The test has to be
 *     `@type == "Recipe"` specifically.
 */

import {
  attrValue,
  capHtml,
  decodeEntities,
  elements,
  htmlToText,
  metaContent,
  startTags,
} from './html-text';
import { extractRecipeMicrodata } from './microdata';
import type { Platform, RecipeJsonLd, SourceDocument, StructuredSource } from './types';

export { decodeEntities, htmlToText, metaContent };

/** First element of a kind, or null. Every reader here wants the first only. */
function firstElement(html: string, name: string) {
  for (const element of elements(html, name)) return element;
  return null;
}

export function extractTitle(html: string): string {
  const input = capHtml(html);

  const title = firstElement(input, 'title');
  if (title) return decodeEntities(title.inner).replace(/\s+/g, ' ').trim();

  const ogTitle = metaContent(input, 'og:title');
  if (ogTitle) return ogTitle;

  const h1 = firstElement(input, 'h1');
  return h1 ? htmlToText(h1.inner).replace(/\s+/g, ' ').trim() : '';
}

// ── JSON-LD ──────────────────────────────────────────────────────────────────

function hasType(node: unknown, type: string): boolean {
  if (!node || typeof node !== 'object') return false;
  const value = (node as Record<string, unknown>)['@type'];
  if (typeof value === 'string') return value.toLowerCase() === type.toLowerCase();
  if (Array.isArray(value)) {
    return value.some((v) => typeof v === 'string' && v.toLowerCase() === type.toLowerCase());
  }
  return false;
}

/**
 * Depth-first walk yielding **every** `@type: Recipe` node.
 *
 * Walking into every object value is what finds the `@graph` case, which is
 * where 10 of the spike's 13 hits lived — checking only the top level would have
 * reported 6% coverage instead of 27%.
 *
 * All of them, not the first, because a page can carry a stub Recipe (a card on
 * a category listing, a "related recipe" reference with only a name) ahead of
 * the real one. Taking the first match would find the stub, reject it as
 * unusable, and fall through to the raw-HTML path on a page that had perfectly
 * good structured data.
 */
function* findRecipeNodes(node: unknown, depth = 0): Generator<Record<string, unknown>> {
  if (depth > 8 || !node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) yield* findRecipeNodes(item, depth + 1);
    return;
  }
  if (hasType(node, 'Recipe')) yield node as Record<string, unknown>;
  for (const value of Object.values(node as Record<string, unknown>)) {
    if (value && typeof value === 'object') yield* findRecipeNodes(value, depth + 1);
  }
}

function asStringList(value: unknown, depth = 0): string[] {
  if (depth > 6 || value == null) return [];
  if (typeof value === 'string') {
    const text = htmlToText(value).trim();
    return text ? [text] : [];
  }
  if (typeof value === 'number') return [String(value)];
  if (Array.isArray(value)) return value.flatMap((v) => asStringList(v, depth + 1));
  if (typeof value === 'object') {
    const node = value as Record<string, unknown>;
    // HowToSection nests its steps; HowToStep carries `text` or `name`.
    if (node.itemListElement) return asStringList(node.itemListElement, depth + 1);
    for (const key of ['text', 'name', 'description', 'url', '@id']) {
      if (typeof node[key] === 'string') return asStringList(node[key], depth + 1);
    }
  }
  return [];
}

function firstString(value: unknown): string | null {
  const list = asStringList(value);
  return list.length > 0 ? list[0] : null;
}

function normaliseRecipeNode(node: Record<string, unknown>): RecipeJsonLd | null {
  const ingredients = asStringList(node.recipeIngredient ?? node.ingredients);
  const instructions = asStringList(node.recipeInstructions);

  // A Recipe node with neither ingredients nor instructions is a stub (some
  // sites emit one on category pages) — not a usable hit.
  if (ingredients.length === 0 && instructions.length === 0) return null;

  const yieldValues = asStringList(node.recipeYield);
  return {
    name: firstString(node.name) ?? undefined,
    description: firstString(node.description) ?? undefined,
    image: firstString(node.image),
    recipeIngredient: ingredients,
    recipeInstructions: instructions,
    // recipeYield is commonly ["4", "4 servings"] — the longer form is useful.
    recipeYield: yieldValues.sort((a, b) => b.length - a.length)[0] ?? null,
    totalTime: firstString(node.totalTime),
    author: firstString(node.author),
    keywords: asStringList(node.keywords).flatMap((k) =>
      k.split(',').map((s) => s.trim()).filter(Boolean),
    ),
  };
}

/**
 * The `type` a JSON-LD block declares. Reading it off the tag's attribute run
 * covers the double-quoted, single-quoted **and unquoted** forms in one go —
 * Yoast plus an HTML minifier emits the unquoted one — without a pattern that
 * has to span the whole document to find it.
 */
const LD_JSON_TYPE = /^application\/ld\+json$/i;

/** Extracts and normalises a schema.org/Recipe from a page's JSON-LD blocks. */
export function extractRecipeJsonLd(html: string): RecipeJsonLd | null {
  for (const block of elements(capHtml(html), 'script')) {
    if (!LD_JSON_TYPE.test(attrValue(block.attrs, 'type') ?? '')) continue;

    let parsed: unknown;
    try {
      // JSON-LD is raw JSON, but some CMSes still entity-escape it.
      const body = block.inner.trim().replace(/^<!\[CDATA\[|\]\]>$/g, '');
      parsed = JSON.parse(body.includes('&quot;') ? decodeEntities(body) : body);
    } catch {
      continue; // A malformed block is not a reason to fail the whole import.
    }

    for (const node of findRecipeNodes(parsed)) {
      const recipe = normaliseRecipeNode(node);
      if (recipe) return recipe;
    }
  }

  return null;
}

/**
 * Serialised form of the structured recipe as it is handed to the model.
 * MEAL-72 verifies `json-ld`-derived evidence spans against *this* string, so it
 * must be the post-parse text (escapes already resolved), not the raw markup.
 */
export function serializeJsonLd(recipe: RecipeJsonLd): string {
  return JSON.stringify(recipe, null, 2);
}

// ── Platform detection (telemetry) ───────────────────────────────────────────

const LINK_IN_BIO_HOSTS =
  /(^|\.)(beacons\.ai|linktr\.ee|lnk\.bio|bio\.link|linkin\.bio|campsite\.bio|koji\.to|solo\.to|carrd\.co|milkshake\.app|taplink\.cc)$/i;

/**
 * Detects the publishing platform from page markers.
 *
 * Recorded on every import so the MEAL-69 coverage question can be re-answered
 * against our own creators' URLs in a few weeks rather than re-argued. Best
 * effort by design — an unrecognised platform is `unknown`, never an error.
 */
/**
 * True when the page carries a `<meta>` whose `content` starts with `prefix`,
 * optionally restricted to one `name`.
 *
 * Replaces `<meta[^>]+content=["']?Medium/`, which is the quadratic shape: the
 * `[^>]+` runs to end of input on a page with no `>` in it, from every `<meta`
 * position. Same reading, one linear pass over the start tags.
 */
function metaContentStartsWith(html: string, prefix: string, name?: string): boolean {
  const wanted = prefix.toLowerCase();
  for (const tag of startTags(html, 'meta')) {
    if (name && attrValue(tag.attrs, 'name')?.toLowerCase() !== name) continue;
    if (attrValue(tag.attrs, 'content')?.toLowerCase().startsWith(wanted)) return true;
  }
  return false;
}

export function detectPlatform(html: string, url: string): Platform {
  const input = capHtml(html);
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    /* fall through to markup sniffing */
  }

  if (LINK_IN_BIO_HOSTS.test(host)) return 'link-in-bio';
  if (/(^|\.)medium\.com$/i.test(host) || metaContentStartsWith(input, 'Medium')) return 'medium';
  if (/(^|\.)substack\.com$/i.test(host) || /substackcdn\.com/i.test(input)) return 'substack';

  if (/\bwprm-recipe(-container)?\b/i.test(input)) return 'wordpress-wprm';
  if (/\btasty-recipes\b/i.test(input)) return 'wordpress-tasty';
  if (/\bjetpack-recipe\b/i.test(input)) return 'jetpack-recipes';
  if (/yoast\s+seo|<!--\s*This site is optimized with the Yoast/i.test(input)) return 'wordpress-yoast';
  if (/\/wp-content\/|\/wp-includes\//i.test(input)) return 'wordpress';

  if (/static1\.squarespace\.com|squarespace\.com\/universal|\bsqs-block\b/i.test(input)) return 'squarespace';
  if (/static\.parastorage\.com|\bwix-?(code|site)\b/i.test(input)) return 'wix';
  if (metaContentStartsWith(input, 'Ghost', 'generator')) return 'ghost';

  return 'unknown';
}

// ── Assembly ─────────────────────────────────────────────────────────────────

const MAX_TEXT_CHARS = 24_000;

/**
 * Every field on a `SourceDocument` is attacker-controlled and every one of them
 * reaches a prompt, so each needs its own ceiling — capping `text` alone leaves
 * the others as uncapped paths to the same place.
 *
 * A 1.2 MB `<title>` is a valid page and passes every documented limit: 2 MB
 * response, 24k of text. It then flows into the gate prompt (which truncates
 * `text` but passed the title through whole), the extraction prompt, and the
 * confidence corpus — turning a page that looks compliant into a ~300k-token
 * request against the cheap classifier.
 */
const MAX_TITLE_CHARS = 300;

/**
 * Structured data is quoted into the extraction prompt in full and is the
 * corpus `json-ld` evidence spans are verified against. A page can publish an
 * arbitrarily large `Recipe` block — 900 ingredients, a novel in `description`
 * — so it is capped like everything else. Well past any real recipe.
 */
const MAX_JSONLD_CHARS = 32_000;

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

/**
 * Turns fetched HTML into the source-agnostic document the rest of the pipeline
 * consumes. Structured data is read JSON-LD first, then microdata/hRecipe.
 */
export function toSourceDocument(url: string, html: string): SourceDocument {
  // Capped once here as well as inside each reader: seven whole-document scans
  // follow, and there is no point handing each of them a megabyte to discard.
  const input = capHtml(html);

  let structuredSource: StructuredSource | null = null;
  let jsonLd = extractRecipeJsonLd(input);
  if (jsonLd) {
    structuredSource = 'json-ld';
  } else {
    jsonLd = extractRecipeMicrodata(input);
    if (jsonLd) structuredSource = 'microdata';
  }

  const text = htmlToText(input);
  const recipeText = htmlToText(input, { dropBoilerplate: true });
  const imageUrl = jsonLd?.image ?? metaContent(input, 'og:image');
  return {
    url,
    title: truncate(extractTitle(input), MAX_TITLE_CHARS),
    // Recipe blogs bury the recipe under a long preamble but never past 24k chars;
    // the cap bounds token spend on pages with huge comment sections.
    text: truncate(text, MAX_TEXT_CHARS),
    recipeText: truncate(recipeText, MAX_TEXT_CHARS),
    jsonLd,
    structuredSource,
    jsonLdRaw: jsonLd ? truncate(serializeJsonLd(jsonLd), MAX_JSONLD_CHARS) : null,
    // A URL is a prompt input too, and a data: URI can carry a megabyte.
    imageUrl: imageUrl && imageUrl.length <= 2048 ? imageUrl : null,
    platform: detectPlatform(input, url),
  };
}
