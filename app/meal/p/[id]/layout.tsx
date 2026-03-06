import type { Metadata } from 'next';
import { createServerSupabaseClient } from '@/lib/supabase';

export async function generateMetadata(
  { params }: { params: Promise<{ id: string }> }
): Promise<Metadata> {
  const { id } = await params;
  const supabase = createServerSupabaseClient();

  const { data: meal } = await supabase
    .from('preset_meals')
    .select('name, photo_url')
    .eq('id', id)
    .single();

  if (!meal) {
    return { title: 'Meal' };
  }

  return {
    title: meal.name,
    description: `Add ${meal.name} to your grocery cart in one click with Mealio.`,
    openGraph: meal.photo_url ? { images: [{ url: meal.photo_url }] } : undefined,
    twitter: meal.photo_url ? { images: [meal.photo_url] } : undefined,
  };
}

export default function PresetMealLayout({ children }: { children: React.ReactNode }) {
  return children;
}
