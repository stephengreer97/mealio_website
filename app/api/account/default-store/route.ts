import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';
import { moveAccountToStore } from '@/lib/default-store';
import { isSupportedStore } from '@/lib/stores';

/**
 * PATCH /api/account/default-store — `{ storeId }`: the store this account
 * shops at.
 *
 * Every meal comes along. What was chosen at the old store stays saved under
 * it, and at the new store each meal has whatever was chosen there before, or
 * nothing (see lib/default-store.ts). Choosing the store you are already on is
 * harmless: nothing changes.
 */
export async function PATCH(request: NextRequest) {
  const token = extractTokenFromHeader(request.headers.get('authorization'));
  const decoded = token ? await verifyAccessToken(token) : null;
  if (!decoded) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const storeId = (body as { storeId?: unknown }).storeId;
  if (!isSupportedStore(storeId)) {
    return NextResponse.json({ error: 'That is not a store Mealio supports.' }, { status: 400 });
  }

  const result = await moveAccountToStore(createServerSupabaseClient(), decoded.userId, storeId);
  if (result.errors.length > 0) {
    return NextResponse.json(
      { error: 'Some meals could not be moved. Try again; nothing was lost.', defaultStoreId: null },
      { status: 500 },
    );
  }
  return NextResponse.json({ defaultStoreId: storeId, moved: result.changed });
}
