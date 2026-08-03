/**
 * Microdata / hRecipe reader (MEAL-70, added after the MEAL-69 spike).
 *
 * The spike found two sampled pages carrying a complete Recipe with no JSON-LD
 * at all — smittenkitchen via Jetpack Recipes, and a Squarespace `ccm` block —
 * worth roughly four points of coverage. Reading them costs ~50 lines and no
 * LLM call, so it runs before the raw-HTML path rather than after.
 *
 * Two formats, one output:
 *
 *  - **Microdata** — `itemtype="http://schema.org/Recipe"` with `itemprop`
 *    attributes on descendants.
 *  - **hRecipe** — the older microformat, `class="hrecipe"` with `class="fn"`,
 *    `class="ingredient"`, `class="instructions"`. Jetpack Recipes emits this.
 *
 * Deliberately shallow. It reads attributes off a flat scan of the subtree
 * rather than building a DOM, which is enough for both formats as published and
 * keeps the module dependency-free. A page that nests a second Recipe inside the
 * first will read as one recipe; that is the right answer for a recipe post.
 */

import { attrValue as attr, capHtml, htmlToText, nextStartTag, startTags } from './html-text';
import type { RecipeJsonLd } from './types';

/** Nesting depth one element may reach before we stop counting. */
const MAX_SUBTREE_TAGS = 2_000;

/**
 * How far past an element's opening we will look for its close tag.
 *
 * The whole recipe region gets the document; a single property element gets
 * `MAX_PROPERTY_CHARS`, because `collect` asks for one per matching `itemprop`
 * and each ask is a scan. An ingredient line is a few dozen characters.
 */
const MAX_REGION_CHARS = 1024 * 1024;
const MAX_PROPERTY_CHARS = 64 * 1024;

/**
 * Ceiling on properties read from one region.
 *
 * Bounds the number of subtree scans, which is the other half of what made this
 * module quadratic: the window above bounds each scan, this bounds how many
 * there are. Far past any real recipe — the largest of the recorded pages
 * publishes 17 ingredients.
 */
const MAX_PROPERTY_ELEMENTS = 500;

/**
 * The subtree that starts at `start`, by counting matching open and close tags.
 *
 * Bounded on both axes, because neither bound was there and both mattered. The
 * open-tag scan was `<${tagName}\b[^>]*>`, quadratic on a document that never
 * supplies a `>` — see `nextStartTag`, which is what it uses now. And a missing
 * close tag returned `html.slice(start)`, the entire rest of the document, once
 * per matching property: 262 KB of unclosed `<li itemprop>`s produced 9,039
 * strings totalling 82 MB in 14.8 s, which at the fetcher's 2 MB cap is ~5 GB —
 * an OOM well before any timer fires. An element we cannot delimit yields
 * nothing, which is also the more honest answer: the rest of the page is not
 * this element's text.
 */
function subtree(html: string, tagName: string, start: number, maxChars: number): string {
  const window = html.slice(start, start + maxChars);
  const close = new RegExp(`</${tagName}\\s*>`, 'gi');

  let depth = 1;
  let cursor = 1;
  for (let guard = 0; guard < MAX_SUBTREE_TAGS && depth > 0; guard++) {
    close.lastIndex = cursor;
    const nextClose = close.exec(window);
    if (!nextClose) return '';

    const nextOpen = nextStartTag(window, cursor, tagName);
    if (nextOpen && nextOpen.index < nextClose.index) {
      depth++;
      cursor = nextOpen.index + 1;
      continue;
    }
    depth--;
    cursor = nextClose.index + nextClose[0].length;
    if (depth === 0) return window.slice(0, cursor);
  }
  return '';
}

/** Text content of the element opening at `index`. */
function elementText(html: string, tagName: string, index: number): string {
  const void_ = /^(img|meta|link|br|hr|input|source)$/i.test(tagName);
  if (void_) return '';
  return htmlToText(subtree(html, tagName, index, MAX_PROPERTY_CHARS)).replace(/\s+/g, ' ').trim();
}

/** Value of a property element: `content`/`src`/`href` when present, else its text. */
function propertyValue(html: string, attrs: string, tagName: string, index: number): string {
  if (/^meta$/i.test(tagName)) return attr(attrs, 'content') ?? '';
  if (/^(img|source)$/i.test(tagName)) return attr(attrs, 'content') ?? attr(attrs, 'src') ?? '';
  if (/^(a|link)$/i.test(tagName)) {
    const content = attr(attrs, 'content');
    if (content) return content;
    const text = elementText(html, tagName, index);
    return text || (attr(attrs, 'href') ?? '');
  }
  if (/^time$/i.test(tagName)) return attr(attrs, 'datetime') ?? elementText(html, tagName, index);
  return attr(attrs, 'content') ?? elementText(html, tagName, index);
}

const MICRODATA_PROPS: Record<string, keyof RecipeJsonLd> = {
  name: 'name',
  headline: 'name',
  description: 'description',
  image: 'image',
  photo: 'image',
  recipeingredient: 'recipeIngredient',
  ingredients: 'recipeIngredient',
  ingredient: 'recipeIngredient',
  recipeinstructions: 'recipeInstructions',
  instructions: 'recipeInstructions',
  recipeyield: 'recipeYield',
  yield: 'recipeYield',
  totaltime: 'totalTime',
  duration: 'totalTime',
  author: 'author',
  keywords: 'keywords',
};

/** Reads a schema.org Recipe published as microdata. */
function readMicrodata(html: string): RecipeJsonLd | null {
  let scope: { name: string; index: number } | null = null;
  for (const tag of startTags(html)) {
    const itemtype = attr(tag.attrs, 'itemtype');
    if (itemtype && /schema\.org\/recipe\b/i.test(itemtype)) {
      scope = { name: tag.name, index: tag.index };
      break;
    }
  }
  if (!scope) return null;

  const region = subtree(html, scope.name, scope.index, MAX_REGION_CHARS);
  return collect(region, (attrs) => attr(attrs, 'itemprop'), MICRODATA_PROPS);
}

const HRECIPE_CLASSES: Record<string, keyof RecipeJsonLd> = {
  fn: 'name',
  summary: 'description',
  photo: 'image',
  ingredient: 'recipeIngredient',
  instructions: 'recipeInstructions',
  instruction: 'recipeInstructions',
  yield: 'recipeYield',
  duration: 'totalTime',
  totaltime: 'totalTime',
  author: 'author',
  // Jetpack Recipes' own class names.
  'jetpack-recipe-title': 'name',
  'jetpack-recipe-ingredient': 'recipeIngredient',
  'jetpack-recipe-directions': 'recipeInstructions',
  'jetpack-recipe-servings': 'recipeYield',
  'jetpack-recipe-time': 'totalTime',
};

/** Reads the older hRecipe microformat, including Jetpack's variant. */
function readHRecipe(html: string): RecipeJsonLd | null {
  let scope: { name: string; index: number } | null = null;
  for (const tag of startTags(html)) {
    const className = attr(tag.attrs, 'class');
    if (className && /\b(hrecipe|jetpack-recipe)\b/i.test(className)) {
      scope = { name: tag.name, index: tag.index };
      break;
    }
  }
  if (!scope) return null;

  const region = subtree(html, scope.name, scope.index, MAX_REGION_CHARS);
  return collect(
    region,
    (attrs) => {
      const className = attr(attrs, 'class');
      if (!className) return null;
      const classes = className.toLowerCase().split(/\s+/);
      return classes.find((c) => HRECIPE_CLASSES[c]) ?? null;
    },
    HRECIPE_CLASSES,
  );
}

function collect(
  region: string,
  readKey: (attrs: string) => string | null,
  mapping: Record<string, keyof RecipeJsonLd>,
): RecipeJsonLd | null {
  const ingredients: string[] = [];
  const instructions: string[] = [];
  const single: Partial<Record<keyof RecipeJsonLd, string>> = {};
  let read = 0;

  for (const tag of startTags(region)) {
    const raw = readKey(tag.attrs);
    if (!raw) continue;
    const field = mapping[raw.toLowerCase()];
    if (!field) continue;
    if (++read > MAX_PROPERTY_ELEMENTS) break;

    const value = propertyValue(region, tag.attrs, tag.name, tag.index).trim();
    if (!value) continue;

    if (field === 'recipeIngredient') {
      if (!ingredients.includes(value)) ingredients.push(value);
    } else if (field === 'recipeInstructions') {
      // A single blob of directions is common; split it into steps.
      const steps = value.split(/(?<=[.!?])\s+(?=[A-Z0-9])/).map((s) => s.trim()).filter(Boolean);
      for (const step of steps.length > 1 ? steps : [value]) {
        if (!instructions.includes(step)) instructions.push(step);
      }
    } else if (single[field] == null) {
      single[field] = value;
    }
  }

  if (ingredients.length === 0 && instructions.length === 0) return null;

  return {
    name: single.name as string | undefined,
    description: single.description as string | undefined,
    image: (single.image as string | undefined) ?? null,
    recipeIngredient: ingredients,
    recipeInstructions: instructions,
    recipeYield: (single.recipeYield as string | undefined) ?? null,
    totalTime: (single.totalTime as string | undefined) ?? null,
    author: (single.author as string | undefined) ?? null,
    keywords: single.keywords
      ? String(single.keywords).split(',').map((s) => s.trim()).filter(Boolean)
      : [],
  };
}

/** Extracts a Recipe from microdata or hRecipe markup, in that order. */
export function extractRecipeMicrodata(html: string): RecipeJsonLd | null {
  const input = capHtml(html);
  return readMicrodata(input) ?? readHRecipe(input);
}
