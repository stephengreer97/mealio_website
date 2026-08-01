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

import { decodeEntities, htmlToText } from './html-text';
import type { RecipeJsonLd } from './types';

/** Attribute value readers that tolerate unquoted, single- and double-quoted forms. */
function attr(tag: string, name: string): string | null {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');
  const match = pattern.exec(tag);
  if (!match) return null;
  return decodeEntities(match[1] ?? match[2] ?? match[3] ?? '').trim();
}

/** All `<tag ...>` openings in source order, with their offsets. */
function* openTags(html: string): Generator<{ tag: string; name: string; index: number; end: number }> {
  const pattern = /<([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    yield { tag: match[0], name: match[1].toLowerCase(), index: match.index, end: pattern.lastIndex };
  }
}

/** Extracts the subtree that starts at `start`, by counting matching open/close tags. */
function subtree(html: string, tagName: string, start: number): string {
  const open = new RegExp(`<${tagName}\\b[^>]*>`, 'gi');
  const close = new RegExp(`</${tagName}\\s*>`, 'gi');
  open.lastIndex = start + 1;
  close.lastIndex = start + 1;

  let depth = 1;
  let cursor = start + 1;
  for (let guard = 0; guard < 2000 && depth > 0; guard++) {
    open.lastIndex = cursor;
    close.lastIndex = cursor;
    const nextOpen = open.exec(html);
    const nextClose = close.exec(html);
    if (!nextClose) return html.slice(start);
    if (nextOpen && nextOpen.index < nextClose.index) {
      depth++;
      cursor = nextOpen.index + 1;
    } else {
      depth--;
      cursor = nextClose.index + 1;
      if (depth === 0) return html.slice(start, nextClose.index + nextClose[0].length);
    }
  }
  return html.slice(start);
}

/** Text content of the element opening at `index`. */
function elementText(html: string, tagName: string, index: number): string {
  const void_ = /^(img|meta|link|br|hr|input|source)$/i.test(tagName);
  if (void_) return '';
  return htmlToText(subtree(html, tagName, index)).replace(/\s+/g, ' ').trim();
}

/** Value of a property element: `content`/`src`/`href` when present, else its text. */
function propertyValue(html: string, tag: string, tagName: string, index: number): string {
  if (/^meta$/i.test(tagName)) return attr(tag, 'content') ?? '';
  if (/^(img|source)$/i.test(tagName)) return attr(tag, 'content') ?? attr(tag, 'src') ?? '';
  if (/^(a|link)$/i.test(tagName)) {
    const content = attr(tag, 'content');
    if (content) return content;
    const text = elementText(html, tagName, index);
    return text || (attr(tag, 'href') ?? '');
  }
  if (/^time$/i.test(tagName)) return attr(tag, 'datetime') ?? elementText(html, tagName, index);
  return attr(tag, 'content') ?? elementText(html, tagName, index);
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
  for (const tag of openTags(html)) {
    const itemtype = attr(tag.tag, 'itemtype');
    if (itemtype && /schema\.org\/recipe\b/i.test(itemtype)) {
      scope = { name: tag.name, index: tag.index };
      break;
    }
  }
  if (!scope) return null;

  const region = subtree(html, scope.name, scope.index);
  return collect(region, (tag) => attr(tag, 'itemprop'), MICRODATA_PROPS);
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
  for (const tag of openTags(html)) {
    const className = attr(tag.tag, 'class');
    if (className && /\b(hrecipe|jetpack-recipe)\b/i.test(className)) {
      scope = { name: tag.name, index: tag.index };
      break;
    }
  }
  if (!scope) return null;

  const region = subtree(html, scope.name, scope.index);
  return collect(
    region,
    (tag) => {
      const className = attr(tag, 'class');
      if (!className) return null;
      const classes = className.toLowerCase().split(/\s+/);
      return classes.find((c) => HRECIPE_CLASSES[c]) ?? null;
    },
    HRECIPE_CLASSES,
  );
}

function collect(
  region: string,
  readKey: (tag: string) => string | null,
  mapping: Record<string, keyof RecipeJsonLd>,
): RecipeJsonLd | null {
  const ingredients: string[] = [];
  const instructions: string[] = [];
  const single: Partial<Record<keyof RecipeJsonLd, string>> = {};

  for (const tag of openTags(region)) {
    const raw = readKey(tag.tag);
    if (!raw) continue;
    const field = mapping[raw.toLowerCase()];
    if (!field) continue;

    const value = propertyValue(region, tag.tag, tag.name, tag.index).trim();
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
  return readMicrodata(html) ?? readHRecipe(html);
}
