/**
 * What the filter panel can offer, computed over the WHOLE catalogue.
 *
 * The suggestions used to be built from the meals already loaded, which is the
 * same defect the filters themselves had: an author whose meals sat on page 4
 * was not suggested, and a custom tag nobody had scrolled to did not appear in
 * the tag list. The filter would still have worked if you typed the name, so it
 * degraded quietly rather than failing, which is the kind of wrong nobody
 * reports.
 *
 * ORDERED BY FREQUENCY, NOT ALPHABETICALLY. An autocomplete is a ranking
 * problem: the name you are most likely to be typing is the one attached to the
 * most meals, and 400 alphabetical authors puts the busiest creator behind
 * anyone called Aaron. Ties break alphabetically so the order is stable.
 */

export interface PresetMealFacets {
  /** Every tag in USE, which includes ones outside the fixed vocabulary. */
  tags: string[];
  /** Every author or creator display name attached to at least one meal. */
  authors: string[];
}

interface FacetSource {
  tags?: string[] | null;
  author?: string | null;
  creator_name?: string | null;
}

/**
 * A defensive ceiling on each list.
 *
 * Not expected to bite: it is one short string per distinct value. It exists so
 * that a catalogue which grows by an order of magnitude makes the panel slower
 * rather than making the page enormous, and so the failure is a truncated
 * dropdown rather than a timeout.
 */
export const MAX_FACET_VALUES = 500;

function rank(counts: Map<string, number>): string[] {
  return [...counts.entries()]
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .slice(0, MAX_FACET_VALUES)
    .map(([value]) => value);
}

export function buildFacets(meals: FacetSource[]): PresetMealFacets {
  const tags = new Map<string, number>();
  const authors = new Map<string, number>();

  for (const meal of meals) {
    for (const tag of meal.tags ?? []) {
      if (typeof tag === 'string' && tag.trim()) tags.set(tag, (tags.get(tag) ?? 0) + 1);
    }
    // Both names, de-duplicated per meal. A creator whose display name matches
    // the author field must not count twice, or a self-published creator
    // outranks a busier one on nothing but having the field filled in.
    const names = new Set(
      [meal.author, meal.creator_name]
        .filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
        .map((n) => n.trim()),
    );
    for (const name of names) authors.set(name, (authors.get(name) ?? 0) + 1);
  }

  return { tags: rank(tags), authors: rank(authors) };
}
