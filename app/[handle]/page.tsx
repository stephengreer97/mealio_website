import { redirect, notFound } from 'next/navigation';
import { createServerSupabaseClient } from '@/lib/supabase';
import { RESERVED_HANDLES, normalizeHandle } from '@/lib/handles';

export default async function HandlePage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle: raw } = await params;
  const handle = normalizeHandle(raw);

  if (!handle || RESERVED_HANDLES.has(handle)) notFound();

  const supabase = createServerSupabaseClient();
  const { data } = await supabase
    .from('creators')
    .select('id')
    .eq('handle', handle)
    .maybeSingle();

  if (!data) notFound();

  redirect(`/discover?creator=${data.id}`);
}
