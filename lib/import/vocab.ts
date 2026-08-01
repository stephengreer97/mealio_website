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

/** Clamps a suggested difficulty to the 1–5 the portal renders, or null. */
export function canonicalizeDifficulty(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  if (rounded < 1 || rounded > 5) return null;
  return rounded;
}
