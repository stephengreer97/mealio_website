/**
 * Tag and difficulty vocabulary for imported drafts.
 *
 * Copied from the creator portal's `ALL_TAGS` (`app/creator/page.tsx`) and the
 * mobile app's `src/constants/tags.ts`, which are already duplicates of each
 * other. The import pipeline must not widen that drift, so a tag the model
 * suggests is dropped unless it appears here — a free-text tag would not match
 * any discover filter and would look like a typo to the creator.
 */

export const MEAL_TAGS = [
  // Time
  'Under 10 Min', 'Under 30 Min', 'Under 45 Min', 'Over 1 Hour',
  // Cooking Method
  'One Pot', 'Sheet Pan', 'Slow Cooker', 'Air Fryer', 'Grilled', 'No Cook',
  'Instant Pot', 'Baked', 'Stovetop', 'Deep Fried', 'Steamed',
  // Meal Type
  'Breakfast', 'Brunch', 'Lunch', 'Dinner', 'Snack', 'Dessert', 'Side Dish',
  'Appetizer', 'Soup', 'Salad', 'Sandwich', 'Wrap', 'Pasta', 'Tacos',
  'Pizza', 'Burger', 'Stir Fry', 'Smoothie', 'Bowl',
  // Dietary
  'Healthy', 'Keto', 'Low Carb', 'High Protein', 'Vegetarian', 'Vegan',
  'Gluten-Free', 'Dairy-Free', 'Paleo', 'Low Calorie', 'High Fiber',
  'Whole30', 'Mediterranean', 'Low Sodium', 'Nut-Free', 'Sugar-Free', 'Low Fat',
  // Protein
  'Chicken', 'Beef', 'Pork', 'Seafood', 'Fish', 'Turkey', 'Tofu', 'Eggs', 'Lamb',
  // Cuisine
  'American', 'Mexican', 'Italian', 'Asian', 'Indian', 'Thai', 'Japanese',
  'Chinese', 'Korean', 'Greek', 'French', 'Middle Eastern', 'Southern', 'Tex-Mex', 'BBQ',
  // Lifestyle
  'Meal Prep', 'Budget Friendly', '5 Ingredients', 'Family Friendly', 'Date Night',
  'Comfort Food', 'Kid Friendly', 'Game Day', 'Freezer Friendly', 'Make Ahead',
  'Quick Cleanup', 'Leftovers Good',
] as const;

/**
 * How many tags one meal carries.
 *
 * Three is what every publish form has always offered — the creator portal, the
 * admin draft editor, the mobile app — and what `MealCard` renders: the card
 * does `tags.slice(0, 3)`. A fourth tag is therefore *invisible on screen and
 * still filterable in Discover*, which is the worst of the two possible
 * outcomes: a meal that turns up under a filter with no sign of why.
 *
 * It lives here, beside the vocabulary itself, because every writer of the
 * `tags` column already imports this module. It was a literal `3` in five
 * places, and the two that enforced nothing at all — `POST /api/creator/meals`
 * and the draft PATCH — are how a six-tag meal reached Discover.
 */
export const MAX_MEAL_TAGS = 3;

/**
 * The refusal for an over-cap tag list, or null when there is nothing to say.
 *
 * Over-cap input is **refused, never trimmed**. Silently keeping the first three
 * throws away a choice somebody made and says nothing about it — the creator
 * publishes six tags, sees three, and has no way to know which three we kept.
 * (The one place that does trim is the *import* fill in `draft-form.ts`, which
 * says so on screen: those tags were a model's suggestion, not a human's pick.)
 */
export function tagCapError(tags: readonly unknown[]): string | null {
  if (tags.length <= MAX_MEAL_TAGS) return null;
  return `That is ${tags.length} tags. A meal takes at most ${MAX_MEAL_TAGS}.`;
}

/**
 * Whether two tag lists are the same list, order included.
 *
 * Order is part of the value, not an implementation detail: the card renders
 * `tags.slice(0, MAX_MEAL_TAGS)`, so reordering an over-cap list changes which
 * tags a saver sees. A reorder is therefore a change, and a change is checked.
 */
export function sameTags(a: readonly unknown[] | null | undefined, b: readonly unknown[] | null | undefined): boolean {
  const left = Array.isArray(a) ? a : [];
  const right = Array.isArray(b) ? b : [];
  return left.length === right.length && left.every((tag, i) => tag === right[i]);
}

/**
 * The refusal for a tag list an edit is *changing*, or null when there is
 * nothing to say — the grandfathering rule.
 *
 * A cap enforced on every field that arrives, rather than on every field that
 * changed, is a cap on *editing* rather than on tags: both editors post `tags`
 * and `serves` on every save, so a creator fixing a typo in the name of a meal
 * published before the cap existed got a 400 and lost the edit, on two fields
 * they never opened. Sixteen `preset_meals` rows carry more than three tags, and
 * every one of them was legal when it was written.
 *
 * So the rule is: an unchanged over-cap list saves, and any change to it must
 * land at or under the cap. That makes those rows editable with no migration and
 * no trimming — trimming would throw away a choice somebody made without saying
 * so, which is the thing `tagCapError` exists to refuse.
 */
export function tagChangeError(
  incoming: readonly unknown[],
  stored: readonly unknown[] | null | undefined,
): string | null {
  if (sameTags(incoming, stored)) return null;
  return tagCapError(incoming);
}

/**
 * A `serves` as the column holds it: trimmed text, or '' for absent.
 *
 * The column is text and every writer stores text, so a numeric `4` becomes
 * `"4"` here rather than at three separate call sites. `0` becomes `"0"`, which
 * `SERVES_PATTERN` accepts — see the note on the pattern.
 */
export function servesTextOf(value: unknown): string {
  return value == null ? '' : String(value).trim();
}

/**
 * The refusal for a `serves` an edit is *changing*, or null. Grandfathered for
 * the same reason as `tagChangeError`: the field arrives on every save whether
 * or not the creator touched it.
 */
export function servesChangeError(incoming: string, stored: unknown): string | null {
  // Compared as the column holds it, so a client posting the numeric `4` it was
  // handed the string "4" for is not read as a change to a field it echoed back.
  if (incoming === servesTextOf(stored)) return null;
  if (incoming && !SERVES_PATTERN.test(incoming)) return SERVES_ERROR;
  return null;
}

/**
 * A tag picker's click, wherever the picker is drawn.
 *
 * Selected → deselected; unselected → selected if there is room; at the cap →
 * nothing at all. Three hand-written copies of that rule existed (the creator
 * portal, `my-meals`, the admin draft editor) and one of them counted to a
 * literal `3`. It is the client half of a rule the server refuses on, so it is
 * worth having exactly once and testing exactly once — the copies were the only
 * guard in the tag-cap change with no failing test behind it.
 *
 * Returns the selection unchanged when there is no room, so a caller can tell
 * "added" from "refused" by comparing lengths.
 */
export function toggleTag(selected: readonly string[], tag: string, max: number = MAX_MEAL_TAGS): string[] {
  if (selected.includes(tag)) return selected.filter((t) => t !== tag);
  if (selected.length >= max) return [...selected];
  return [...selected, tag];
}

/** Index matches the `difficulty` column: 1–5, 0 unused. */
export const DIFFICULTY_LABELS = ['', 'Easy', 'Easy-Medium', 'Medium', 'Medium-Hard', 'Hard'];

const TAG_LOOKUP = new Map(MEAL_TAGS.map((tag) => [tag.toLowerCase(), tag]));

/** Keeps only tags in the vocabulary, case-insensitively, preserving order and dropping duplicates. */
export function canonicalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of tags) {
    const canonical = TAG_LOOKUP.get(String(tag).trim().toLowerCase());
    if (canonical && !seen.has(canonical)) {
      seen.add(canonical);
      out.push(canonical);
    }
  }
  return out;
}

/**
 * The form's `serves` shape: a people count, or a range of them.
 *
 * `serves` is **how many people the dish feeds** — not a yield. Recipe pages
 * overwhelmingly publish `recipeYield`, which is a different quantity and is
 * frequently a *volume* ("2 1/2 cups guacamole") or a count of items
 * ("12 pancakes", "1 loaf"). Reading "2 1/2 cups" as `serves: 2` is not a
 * formatting mismatch, it is wrong data — and the span really is on the page,
 * so the confidence model would mark it green. The only safe answer when a
 * source states a volume and no people count is nothing at all.
 */
export const SERVES_PATTERN = /^\d+(-\d+)?$/;

/**
 * The refusal for a `serves` that is not a head count, worded once.
 *
 * Every route that accepts a `serves` says this same sentence, because they are
 * all enforcing the same `SERVES_PATTERN` and a creator who hits it on the
 * mobile form and again in the admin editor should not have to work out that
 * the two rules are the same rule.
 */
export const SERVES_ERROR = 'Serves must be a number or a range, like 4 or 2-4.';

/**
 * Words that mark a number as a count of people or portions.
 *
 * This is an allowlist, and it used to be a denylist of yield nouns — units of
 * volume and weight, plus a list of things a batch comes in. A denylist is the
 * wrong shape for the question, because the set of things a recipe can yield is
 * open and the set of ways to say "people" is not. Every noun nobody thought of
 * passed: `Makes 12 empanadas` came back as `serves: 12`, and the span really is
 * on the page, so it read green. So did `4 (Large bowls)` and every arepa,
 * dumpling, tamale and blini after them.
 *
 * The imperative `Serve` is deliberately not in it. "Serve with tortilla chips
 * at your next party" is a serving *suggestion*, and matching it is how a number
 * lifted from a sentence about a party becomes a head count.
 */
const PEOPLE_SIGNAL = /\b(serves|serving|servings|people|persons?|portions?|guests?|feeds|diners?)\b/i;

/**
 * Coerces a model-supplied `serves` into the form's shape, or drops it.
 *
 * `evidence` is the span the value was taken from, and it is load-bearing: it
 * is the only way to tell "2" meaning two people from "2" lifted out of
 * "2 1/2 cups". The span has to *say* people. A number that does not is
 * discarded and the field reads red — "we looked and didn't find it" is the
 * correct answer, and inventing a serving count from a yield is exactly the
 * hallucination class MEAL-72 exists to catch.
 *
 * That is stricter than it was, and it drops real numbers: a page publishing
 * `recipeYield: "4 (Large bowls)"` no longer produces `serves: 4`. It is the
 * trade the prompt already asks the model to make — "If the page gives only a
 * yield and never says how many people it feeds, that is a normal and correct
 * outcome" — and the code was the lax half of a pair that was supposed to agree.
 * A creator filling in one number costs far less than a wrong number they never
 * look at.
 *
 * No span means no evidence, which means no serves. A value we cannot place
 * against anything is the case this function exists to refuse.
 */
export function canonicalizeServes(
  value: string | null | undefined,
  evidence?: string | null,
): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  // A leading sign means the value is malformed, not merely wrapped in prose.
  if (/^[-–—+]/.test(text)) return null;

  // Tolerate "4 servings" / "Serves 4-6" and reduce to the digits the form wants.
  const range = /(\d+)\s*(?:-|–|—|to)\s*(\d+)/.exec(text);
  const single = /(\d+)/.exec(text);
  let normalized: string | null = null;
  if (range) {
    const low = Number(range[1]);
    const high = Number(range[2]);
    if (low > 0 && high >= low) normalized = `${low}-${high}`;
  } else if (single) {
    const count = Number(single[1]);
    if (count > 0) normalized = String(count);
  }
  if (!normalized || !SERVES_PATTERN.test(normalized)) return null;

  // A fractional amount is never a head count: "2 1/2" is a volume talking.
  if (/\d+\s*\/\s*\d+|\d+\.\d+/.test(text)) return null;

  if (!PEOPLE_SIGNAL.test(String(evidence ?? ''))) return null;

  return normalized;
}

/** Clamps a suggested difficulty to the 1–5 the portal renders, or null. */
export function canonicalizeDifficulty(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  if (rounded < 1 || rounded > 5) return null;
  return rounded;
}
