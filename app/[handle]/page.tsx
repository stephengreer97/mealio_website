import { redirect, notFound } from 'next/navigation';
import { createServerSupabaseClient } from '@/lib/supabase';

const RESERVED = new Set([
  'about', 'account', 'admin', 'api', 'check-email', 'creator', 'discover',
  'fonts', 'forgot-password', 'help', 'meal', 'my-meals', 'pricing', 'privacy',
  'reset-password', 'robots.txt', 'sitemap.xml', 'signout', 'terms', 'verify-email',
]);

export default async function HandlePage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;

  if (RESERVED.has(handle)) notFound();

  const supabase = createServerSupabaseClient();
  const { data } = await supabase
    .from('creators')
    .select('id')
    .eq('handle', handle.toLowerCase())
    .maybeSingle();

  if (!data) notFound();

  redirect(`/discover?creator=${data.id}`);
}
