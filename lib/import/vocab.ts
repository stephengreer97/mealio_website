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
