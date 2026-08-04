import { canonicalizeIngredient } from './ingredients';
import type { DraftIngredient } from './types';

/**
 * Is this draft the same dish the creator already published? (MEAL-98)
 *
 * A creator posts the full recipe as a long video, then a 45-second Short of the
 * same dish. Those are two posts with two ids, so `creator_source_items` — which
 * stops the *same* post importing twice — does not stop this. Two drafts arrive,
 * and approving both puts one recipe on Discover twice under one name.
 *
 * ## Warn, never block
 *
 * Two similar recipes from one creator are sometimes genuinely different: a
 * variation, a scaled version, a "three ways with…" post. Refusing would be a
 * refusal the reviewer cannot overrule, which this codebase has decided against
 * everywhere else. The reviewer is looking at the draft; give them the fact.
 *
 * ## Ingredients, not titles
 *
 * Titles diverge exactly in the case worth catching — `GARLIC BUTTER SHRIMP 🔥
 * #shorts` against `Weeknight Garlic Butter Shrimp in 15 Minutes` — while the
 * ingredient set barely moves, because it is the same dish. So the comparison is
 * Jaccard overlap on canonicalised ingredient names: no model call, no new API.
 *
 * Scoped to one creator, always. Two creators publishing carbonara is not a
 * duplicate, it is the product working.
 */

/**
 * How much overlap counts as "probably the same dish".
 *
 * **A guess, and deliberately a high one.** Picked against the shape of the two
 * populations rather than measured data:
 *
 *  - A long-form video and its own Short share nearly the whole list — the same
 *    dish written twice — so they land around 0.85 and up.
 *  - Two genuinely different recipes from one creator overlap on pantry staples
 *    — oil, salt, garlic, onion, butter — which puts them nearer 0.2 to 0.5.
 *
 * 0.7 sits in the empty ground between, with room either side. Erring high is
 * the right way to be wrong: a missed duplicate costs one extra row on Discover,
 * while a false positive teaches reviewers that the flag is noise, and a flag
 * nobody trusts is worse than no flag. One line to change once there is real
 * data to change it against.
 */
export const DUPLICATE_THRESHOLD = 0.7;

/**
 * Ingredient lists shorter than this are not compared at all.
 *
 * Jaccard is unstable on tiny sets: two three-ingredient recipes sharing salt,
 * butter and garlic score 1.0 and are not the same dish. Below the floor the
 * honest answer is "cannot tell", which is a false negative — the side this is
 * built to fail on.
 */
export const MIN_INGREDIENTS_TO_COMPARE = 4;

/** A meal or draft this one might be a repeat of. */
export interface DuplicateCandidate {
  /** `preset_meals.id` or `creator_import_drafts.id`. */
  id: string;
  name: string;
  /** Where the reviewer would go to look at it. */
  kind: 'published' | 'draft';
  ingredientNames: string[];
}

export interface DuplicateMatch {
  id: string;
  name: string;
  kind: 'published' | 'draft';
  /** 0–1, rounded to two places so it reads as a figure rather than a float. */
  overlap: number;
}

/**
 * The comparison key for one ingredient.
 *
 * Through `canonicalizeIngredient` so this agrees with the rest of the pipeline
 * rather than inventing a second normalisation — "2 tbsp unsalted butter,
 * melted" and "butter" have to meet somewhere, and that function is already
 * where. Lowercased on the way out because it is a set key here, not display
 * text.
 */
export function ingredientKey(name: string): string {
  const canonical = canonicalizeIngredient({ productName: name, measure: null, unit: 'qty', qty: 1 } as never);
  return (canonical?.ingredientName ?? name).trim().toLowerCase();
}

/** Distinct comparison keys for a list, empty entries dropped. */
export function ingredientKeys(names: readonly string[]): Set<string> {
  const keys = new Set<string>();
  for (const name of names) {
    const key = ingredientKey(String(name ?? ''));
    if (key) keys.add(key);
  }
  return keys;
}

/** Set overlap: shared over combined. 1 is identical, 0 is nothing in common. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const key of a) if (b.has(key)) shared += 1;
  const combined = a.size + b.size - shared;
  return combined === 0 ? 0 : shared / combined;
}

/**
 * Everything this draft looks like a repeat of, worst first.
 *
 * Returns matches rather than a boolean because the reviewer's question is "a
 * repeat of *what*" — a flag that says only "possible duplicate" sends them
 * hunting through their own back catalogue to find out, which is the work this
 * is supposed to save.
 */
export function findDuplicates(
  draftIngredients: readonly (DraftIngredient | { ingredientName: string })[],
  candidates: readonly DuplicateCandidate[],
  threshold: number = DUPLICATE_THRESHOLD,
): DuplicateMatch[] {
  const mine = ingredientKeys(draftIngredients.map((i) => i.ingredientName));
  if (mine.size < MIN_INGREDIENTS_TO_COMPARE) return [];

  const matches: DuplicateMatch[] = [];
  for (const candidate of candidates) {
    const theirs = ingredientKeys(candidate.ingredientNames);
    if (theirs.size < MIN_INGREDIENTS_TO_COMPARE) continue;
    const overlap = jaccard(mine, theirs);
    if (overlap >= threshold) {
      matches.push({
        id: candidate.id,
        name: candidate.name,
        kind: candidate.kind,
        overlap: Math.round(overlap * 100) / 100,
      });
    }
  }

  return matches.sort((a, b) => b.overlap - a.overlap);
}

/**
 * The sentence a reviewer reads, or null when there is nothing to say.
 *
 * Names the meal and says what we compared, because "possible duplicate" on its
 * own is a claim the reviewer cannot check. Hedged on purpose — it is an
 * ingredient overlap, not a judgement about the dish, and the reviewer is the
 * one who knows whether their two shrimp recipes are the same recipe.
 */
export function duplicateNotice(matches: readonly DuplicateMatch[]): string | null {
  if (matches.length === 0) return null;
  const [first] = matches;
  const where = first.kind === 'published' ? 'already published' : 'also waiting in this queue';
  const others = matches.length > 1
    ? ` (and ${matches.length - 1} other${matches.length === 2 ? '' : 's'})`
    : '';
  return `Shares ${Math.round(first.overlap * 100)}% of its ingredients with “${first.name}”, ${where}${others}. `
    + 'If that is the same dish posted twice, decline this one; if it is a different recipe, carry on.';
}
