import { unstable_cache } from 'next/cache';
import { createServerSupabaseClient } from '@/lib/supabase';

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
  trending_score: number;
  tags: string[];
}

export const getCachedTrendingMeals = unstable_cache(
  async (): Promise<TrendingMeal[]> => {
    const supabase = createServerSupabaseClient();
    const { data, error } = await supabase.rpc('get_preset_meals_with_trending', { partner_only: false });
    if (error) throw error;
    return (data ?? []) as TrendingMeal[];
  },
  ['trending-meals'],
  { revalidate: 600, tags: ['trending-meals'] },
);
