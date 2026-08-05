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
 * Chosen as a guess and then measured, which moved it from a hopeful number to
 * a safe one — the two populations sit further apart than expected:
 *
 *  - A long-form video and its own Short: **0.83**. The same dish plus a herb:
 *    **0.86**. It is one recipe written twice, so almost the whole list agrees.
 *  - Two different chicken dinners from one creator: **0.33**. A curry against a
 *    carbonara: **0.27**. What they share is a kitchen — oil, garlic, onion.
 *
 * Nothing observed lands between 0.33 and 0.83, so the threshold sits in a gap
 * half the scale wide and is not finely balanced. Set at 0.75 rather than 0.70
 * — still comfortably under the 0.83 floor of the duplicates, and further from
 * the recipes that merely share a pantry. Numbers from `tests/lib/import-
 * duplicates.test.ts`, which is where to re-measure if this ever seems wrong. Erring high is
 * the right way to be wrong: a missed duplicate costs one extra row on Discover,
 * while a false positive teaches reviewers that the flag is noise, and a flag
 * nobody trusts is worse than no flag. One line to change once there is real
 * data to change it against.
 */
export const DUPLICATE_THRESHOLD = 0.75;

/**
 * Ingredient lists shorter than this are not compared at all.
 *
 * Jaccard is unstable on tiny sets: two three-ingredient recipes sharing salt,
 * butter and garlic score 1.0 and are not the same dish. Below the floor the
 * honest answer is "cannot tell", which is a false negative — the side this is
 * built to fail on.
 */
export const MIN_INGREDIENTS_TO_COMPARE = 4;

/**
 * A title reduced to what two posts of one dish would still share.
 *
 * Case, surrounding whitespace, punctuation and the decoration a platform title
 * carries — emoji, and the trailing hashtags a Short is titled with. What is
 * left is the words. This is deliberately *not* the fuzzy matcher: it exists to
 * catch a creator posting under the same title twice, which the ingredient
 * overlap can miss when a Short lists three ingredients and the long form lists
 * nine.
 */
export function titleKey(title: string): string {
  return String(title ?? '')
    .toLowerCase()
    // Hashtags first: "#shorts" is a tag on the title rather than part of it.
    .replace(/#[\p{L}\p{N}_]+/gu, ' ')
    // Anything that is not a letter, a number or a space — emoji, punctuation,
    // the vertical bars and dashes titles are padded with.
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

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
  /**
   * The titles are the same once decoration is stripped.
   *
   * Its own signal rather than a tiebreak. The ingredient overlap can miss a
   * pair the title makes obvious: a Short whose description lists three
   * ingredients against a long form that lists nine scores badly on Jaccard —
   * few shared over many combined — while both are plainly "Garlic Butter
   * Shrimp". A creator who titled two posts identically has told us something
   * no amount of list comparison would.
   */
  sameTitle: boolean;
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
  draft: { name?: string | null; ingredients?: readonly (DraftIngredient | { ingredientName: string })[] },
  candidates: readonly DuplicateCandidate[],
  threshold: number = DUPLICATE_THRESHOLD,
): DuplicateMatch[] {
  const mine = ingredientKeys((draft.ingredients ?? []).map((i) => i.ingredientName));
  const myTitle = titleKey(draft.name ?? '');
  const comparable = mine.size >= MIN_INGREDIENTS_TO_COMPARE;

  const matches: DuplicateMatch[] = [];
  for (const candidate of candidates) {
    // Titles first, and independently. This holds even for a list too short to
    // compare — the ingredient floor exists because Jaccard is unreliable down
    // there, which is a reason to distrust the *overlap*, not a reason to ignore
    // a creator having used the same title twice.
    const sameTitle = myTitle.length > 0 && titleKey(candidate.name) === myTitle;

    const theirs = ingredientKeys(candidate.ingredientNames);
    const overlap = comparable && theirs.size >= MIN_INGREDIENTS_TO_COMPARE
      ? jaccard(mine, theirs)
      : 0;

    if (sameTitle || overlap >= threshold) {
      matches.push({
        id: candidate.id,
        name: candidate.name,
        kind: candidate.kind,
        overlap: Math.round(overlap * 100) / 100,
        sameTitle,
      });
    }
  }

  // An identical title first whatever the overlap says, then by overlap. It is
  // the more certain of the two signals, so it is the one a reviewer should read
  // before the rest.
  return matches.sort((a, b) =>
    (a.sameTitle === b.sameTitle ? 0 : a.sameTitle ? -1 : 1) || b.overlap - a.overlap);
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
  // Led by whichever signal fired, because they are different claims: one is
  // "you titled two posts the same", the other "these lists barely differ", and
  // a reviewer checks them in different ways.
  const because = first.sameTitle
    ? `Has the same title as “${first.name}”, ${where}${others}`
    : `Shares ${Math.round(first.overlap * 100)}% of its ingredients with “${first.name}”, ${where}${others}`;
  return `${because}. `
    + 'If that is the same dish posted twice, decline this one; if it is a different recipe, carry on.';
}

/**
 * What this creator has already published, and what is already in their queue.
 *
 * Both, because they are different mistakes with the same cause: approving a
 * repeat of something live puts two copies on Discover, and approving two
 * drafts of one dish in a single sitting does the same thing without either
 * ever having been live. The second is the more likely one — a long video and
 * its Short arrive on the same poll.
 *
 * Two queries, scoped to the one creator. `excludeDraftId` keeps a draft from
 * matching itself, which it would do perfectly.
 */
export async function duplicateCandidates(
  supabase: { from: (table: string) => any },
  creatorId: string,
  excludeDraftId?: string | null,
): Promise<DuplicateCandidate[]> {
  const [publishedRes, draftRes] = await Promise.all([
    supabase.from('preset_meals').select('id, name, ingredients').eq('creator_id', creatorId),
    supabase.from('creator_import_drafts').select('id, draft').eq('creator_id', creatorId).eq('status', 'pending_review'),
  ]);

  const out: DuplicateCandidate[] = [];

  for (const row of ((publishedRes?.data ?? []) as Array<Record<string, any>>)) {
    const ingredients = Array.isArray(row.ingredients) ? row.ingredients : [];
    out.push({
      id: String(row.id),
      name: String(row.name ?? 'a published meal'),
      kind: 'published',
      // The same three spellings the rest of the product tolerates — see
      // `normalizeIngredients`. A list read under the wrong key is an empty set,
      // which scores zero and silently never matches.
      ingredientNames: ingredients.map((i: any) =>
        String(i?.ingredientName ?? i?.productName ?? i?.product_name ?? i?.name ?? '')),
    });
  }

  for (const row of ((draftRes?.data ?? []) as Array<Record<string, any>>)) {
    if (excludeDraftId && String(row.id) === excludeDraftId) continue;
    const ingredients = Array.isArray(row.draft?.ingredients) ? row.draft.ingredients : [];
    out.push({
      id: String(row.id),
      name: String(row.draft?.name ?? 'another draft'),
      kind: 'draft',
      ingredientNames: ingredients.map((i: any) =>
        String(i?.ingredientName ?? i?.productName ?? i?.product_name ?? i?.name ?? '')),
    });
  }

  return out;
}
