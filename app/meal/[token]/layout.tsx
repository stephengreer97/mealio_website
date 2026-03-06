import type { Metadata } from 'next';
import { createServerSupabaseClient } from '@/lib/supabase';

export async function generateMetadata(
  { params }: { params: Promise<{ token: string }> }
): Promise<Metadata> {
  const { token } = await params;
  const supabase = createServerSupabaseClient();

  const { data: meal } = await supabase
    .from('meals')
    .select('name, photo_url')
    .eq('share_token', token)
    .single();

  if (!meal) {
    return { title: 'Shared Meal' };
  }

  return {
    title: meal.name,
    description: `Check out this meal on Mealio — save it to your account and add ingredients to your grocery cart in one click.`,
    openGraph: meal.photo_url ? { images: [{ url: meal.photo_url }] } : undefined,
    twitter: meal.photo_url ? { images: [meal.photo_url] } : undefined,
  };
}

export default function SharedMealLayout({ children }: { children: React.ReactNode }) {
  return children;
}
