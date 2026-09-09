import { unstable_cache } from 'next/cache';
import { createServerSupabaseClient } from '@/lib/supabase';
import { fetchAllPages } from '@/lib/paged-select';

export interface TrendingMeal {
  id: string;
  name: string;
  source: string;
  recipe: string;
  story: string;
  ingredients: unknown;
  photo_url: string;
  author: string;
  difficulty: number;
  serves: string;
  creator_id: string;
  creator_name: string;
  creator_social: string;
  /** The creator's own photo, for the face on a meal card. Null when there is
   *  no creator (an author-only meal) or the creator has not uploaded one. */
  creator_photo: string | null;
  trending_score: number;
  tags: string[];
}

/**
 * Attaches each row's creator photo, read once for the whole feed.
 *
 * The trending RPC returns `creator_name` and `creator_social` but no photo, and
 * widening its signature is a migration someone has to run by hand before the
 * deploy that needs it. One read of `creators` avoids that, and it runs inside
 * the same 10-minute cache as the rows it decorates, so a feed pays for it once
 * per revalidate rather than once per request.
 *
 * Paged, because an unbounded select stops at PostgREST's `db-max-rows` and says
 * nothing about the rest: the visible symptom would be that creators past the
 * ceiling lose the face on every one of their cards, which looks like a missing
 * upload rather than a truncated read. A failed or short read degrades to no
 * photo rather than failing the feed: a card without a face still works.
 */
async function withCreatorPhotos<T extends { creator_id?: string | null }>(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  rows: T[],
): Promise<(T & { creator_photo: string | null })[]> {
  const wanted = rows.some((r) => !!r.creator_id);
  const byId = new Map<string, string | null>();
  if (wanted) {
    const read = await fetchAllPages<{ id: string; photo_url: string | null }>((from, to) =>
      supabase
        .from('creators')
        .select('id, photo_url')
        .order('id', { ascending: true })
        .range(from, to));
    for (const c of read.rows) byId.set(c.id, c.photo_url ?? null);
  }
  return rows.map((r) => ({
    ...r,
    creator_photo: r.creator_id ? byId.get(r.creator_id) ?? null : null,
  }));
}

export const getCachedTrendingMeals = unstable_cache(
  async (): Promise<TrendingMeal[]> => {
    const supabase = createServerSupabaseClient();
    const { data, error } = await supabase.rpc('get_preset_meals_with_trending', { partner_only: false });
    if (error) throw error;
    return withCreatorPhotos(supabase, (data ?? []) as TrendingMeal[]);
  },
  ['trending-meals'],
  { revalidate: 600, tags: ['trending-meals'] },
);

/**
 * Every preset meal, newest first, cached the same way trending is.
 *
 * WHY THIS EXISTS. The New and Following feeds used to page in SQL with
 * `.range()`, which meant the server decided which 20 rows existed and the
 * client decided which of those 20 to show. A filter cannot run after the set
 * has been cut into pages, so those feeds needed the whole candidate set in
 * memory the way trending has always had it.
 *
 * The cost is a full read of preset_meals, and it is not a new cost: the
 * trending RPC has always returned every row, and this shares its 10-minute
 * cache and its `trending-meals` tag, so creator meal create/update/delete
 * already invalidates both. When MEAL-130 bounds the RPC, this wants bounding
 * with it, and the two should stay the same shape.
 *
 * Paged with `fetchAllPages` rather than a bare select: PostgREST returns the
 * first 1000 rows of an unbounded select and says nothing about the rest, so a
 * plain read would silently cap the catalogue at 1000 meals and every feed
 * would go quietly incomplete.
 */
export const getCachedAllPresetMeals = unstable_cache(
  async (): Promise<TrendingMeal[]> => {
    const supabase = createServerSupabaseClient();
    const read = await fetchAllPages<Record<string, unknown>>((from, to) =>
      supabase
        .from('preset_meals')
        .select(`
          id, name, source, recipe, story, ingredients, photo_url, author, difficulty, serves, creator_id, created_at, tags,
          creators!creator_id ( display_name, social_handle, photo_url )
        `)
        .order('created_at', { ascending: false })
        .range(from, to));
    if (read.error) throw read.error;
    return read.rows.map((m) => {
      const creators = m.creators as { display_name?: string; social_handle?: string; photo_url?: string } | null;
      return {
        ...m,
        creator_name: creators?.display_name ?? null,
        creator_social: creators?.social_handle ?? null,
        // Embedded rather than read through withCreatorPhotos: this select is
        // already joining the creator, so the photo rides along for free.
        creator_photo: creators?.photo_url ?? null,
        creators: undefined,
      } as unknown as TrendingMeal;
    });
  },
  ['all-preset-meals'],
  { revalidate: 600, tags: ['trending-meals'] },
);
