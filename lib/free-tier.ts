import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { log, type EventType } from '@/lib/logger';

/** How many active meals a free account may hold. */
export const FREE_MEAL_LIMIT = 3;

/** What the client shows when the limit is hit. Clients key the paywall off `tierLimitReached`. */
export const FREE_LIMIT_MESSAGE = 'Free plan is limited to 3 meals. Upgrade to Full Access to add more.';

/**
 * The free-tier gate for any path that makes a meal ACTIVE: creating one, and
 * restoring one from Deleted Meals. Returns the 403 to send back, or null when the
 * user may go ahead.
 *
 * One copy on purpose. The restore route used to set `is_active = true` with no
 * check at all, so a free user could delete three meals, add three more, and
 * restore the first three: six active meals on a plan that allows three. Both
 * paths now answer with the same body, so the app's paywall handling (which reads
 * `tierLimitReached`) works the same for either.
 */
export async function freeTierLimitResponse(
  supabase: SupabaseClient,
  userId: string,
  event: EventType,
): Promise<NextResponse | null> {
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('subscription_tier')
    .eq('id', userId)
    .single();

  const tier = profile?.subscription_tier ?? 'free';
  if (tier !== 'free') return null;

  const { count } = await supabase
    .from('meals')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('is_active', true);

  if ((count ?? 0) < FREE_MEAL_LIMIT) return null;

  log({ event, status: 'failed', userId, reason: 'tier limit reached' });
  return NextResponse.json(
    { error: FREE_LIMIT_MESSAGE, tierLimitReached: true },
    { status: 403 },
  );
}
