/**
 * The Discover filters, defined ONCE and applied on the server.
 *
 * WHAT WAS WRONG. Every filter ran in the browser and the phone, over the meals
 * already loaded -- 20 at a time. So "vegetarian" did not mean "vegetarian
 * meals", it meant "vegetarian meals among the first 20 we happened to have",
 * and scrolling revealed more of them. The filter looked broken because it was
 * answering a different question from the one it appears to ask.
 *
 * That is not a bug in the filtering. `matchesMeal` in the browser was correct
 * about the rows it could see. The bug is that FILTERING AND PAGINATION WERE ON
 * OPPOSITE SIDES OF THE NETWORK: the server decided which 20 rows existed, and
 * the client decided which of those 20 to show. Anything that narrows a set has
 * to run before the set is cut into pages, which means it has to run here.
 *
 * ONE DEFINITION, THREE FEEDS. Trending, New and Following each build their
 * candidate rows differently, and each used to be free to disagree about what a
 * filter means. They now share `matchesPresetMeal`, so a change to what
 * "excludes chicken" means cannot land on one feed and not the others.
 *
 * The clients no longer filter at all. A second copy of these rules in the app
 * and a third on the website is how they drift, and the drift is invisible:
 * both sides look right in isolation.
 */

/** The five filters the Filter sheet offers, plus the search box. */
export interface PresetMealFilters {
  /** Any-of. A meal matching one selected tag is in. */
  tags: string[];
  /** Any-of, matched against the numeric difficulty. */
  difficulty: number[];
  /** Any-of, substring, against the meal's author or its creator's display name. */
  authors: string[];
  /** ALL-of. A meal must contain every one of these to be in. */
  ingredients: string[];
  /** NONE-of. A meal containing any of these is out. */
  excludeIngredients: string[];
  /** The search box: name, author, creator or source. */
  q: string;
}

export const NO_FILTERS: PresetMealFilters = {
  tags: [], difficulty: [], authors: [], ingredients: [], excludeIngredients: [], q: '',
};

/** A meal as any of the three feeds produces it. Deliberately loose. */
export interface FilterableMeal {
  name?: string | null;
  author?: string | null;
  source?: string | null;
  creator_name?: string | null;
  difficulty?: number | null;
  tags?: string[] | null;
  ingredients?: unknown;
}

/**
 * An ingredient's name, however its writer spelled the key.
 *
 * Four spellings, because rows have been written by seeds, by the app and by
 * the API across three years: `ingredientName`, `productName`, `product_name`,
 * `name`. This is the same normalisation the clients were doing, moved to the
 * one place that now needs it -- and it is exactly why this could not be pushed
 * into SQL as a simple jsonb path: there is no single path to try.
 */
export function ingredientName(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return '';
  const i = raw as Record<string, unknown>;
  const value = i.ingredientName ?? i.productName ?? i.product_name ?? i.name ?? '';
  return typeof value === 'string' ? value.toLowerCase() : '';
}

function ingredientNames(meal: FilterableMeal): string[] {
  return Array.isArray(meal.ingredients) ? meal.ingredients.map(ingredientName) : [];
}

/** Every filter, in the order the Filter sheet lists them. */
export function matchesPresetMeal(meal: FilterableMeal, filters: PresetMealFilters): boolean {
  const q = filters.q.trim().toLowerCase();
  if (q) {
    const haystack = [meal.name, meal.author, meal.creator_name, meal.source]
      .map((v) => (v ?? '').toLowerCase());
    if (!haystack.some((h) => h.includes(q))) return false;
  }

  if (filters.authors.length > 0) {
    const who = [meal.author, meal.creator_name].map((v) => (v ?? '').toLowerCase());
    if (!filters.authors.some((a) => who.some((w) => w.includes(a.toLowerCase())))) return false;
  }

  if (filters.tags.length > 0) {
    const tags = meal.tags ?? [];
    if (!filters.tags.some((t) => tags.includes(t))) return false;
  }

  // EVERY, not some. "Chicken and rice" means both, which is the only reading
  // that lets someone narrow to what is actually in their kitchen.
  if (filters.ingredients.length > 0) {
    const names = ingredientNames(meal);
    if (!filters.ingredients.every((ing) => names.some((n) => n.includes(ing)))) return false;
  }

  // `?? -1` so a meal with no difficulty is never accidentally swept into a
  // difficulty filter. -1 is not a value the picker can produce.
  if (filters.difficulty.length > 0 && !filters.difficulty.includes(meal.difficulty ?? -1)) return false;

  if (filters.excludeIngredients.length > 0) {
    const names = ingredientNames(meal);
    if (filters.excludeIngredients.some((ex) => names.some((n) => n.includes(ex)))) return false;
  }

  return true;
}

/** True when nothing is selected, so a caller can skip the pass entirely. */
export function isEmpty(filters: PresetMealFilters): boolean {
  return filters.tags.length === 0
    && filters.difficulty.length === 0
    && filters.authors.length === 0
    && filters.ingredients.length === 0
    && filters.excludeIngredients.length === 0
    && filters.q.trim() === '';
}

/** Comma-separated list param, trimmed, empties dropped. */
function list(params: URLSearchParams, key: string): string[] {
  const raw = params.get(key);
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Reads the filters off a request.
 *
 * Lowercased where the match is case-insensitive, so the comparison does not
 * have to remember. Tags are NOT lowercased: they come from a fixed vocabulary
 * and are compared exactly, the way the picker produces them.
 */
export function parsePresetMealFilters(params: URLSearchParams): PresetMealFilters {
  return {
    tags: list(params, 'tags'),
    difficulty: list(params, 'difficulty')
      .map((d) => Number(d))
      .filter((d) => Number.isFinite(d)),
    authors: list(params, 'authors').map((a) => a.toLowerCase()),
    ingredients: list(params, 'ingredients').map((i) => i.toLowerCase()),
    excludeIngredients: list(params, 'excludeIngredients').map((i) => i.toLowerCase()),
    q: params.get('q') ?? '',
  };
}
