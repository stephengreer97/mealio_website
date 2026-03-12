import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';
import {
  decryptKrogerToken,
  encryptKrogerToken,
  refreshKrogerAccessToken,
  krogerSearchProduct,
  krogerAddToCart,
} from '@/lib/kroger';
import { log } from '@/lib/logger';

export const dynamic = 'force-dynamic';

/**
 * POST /api/kroger/add-to-cart
 * Body: { ingredients: Array<{ productName: string; quantity?: number }>, locationId?: string }
 *
 * Resolves each ingredient to a Kroger UPC, then adds all found items to the
 * user's cart in a single API call.
 *
 * Returns: { added: string[], notFound: string[], cartAdded: boolean }
 */
export async function POST(request: NextRequest) {
  const token = extractTokenFromHeader(request.headers.get('authorization'));
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const decoded = await verifyAccessToken(token);
  if (!decoded) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!process.env.KROGER_CLIENT_ID) {
    return NextResponse.json({ error: 'Kroger integration not configured' }, { status: 503 });
  }

  const body = await request.json();
  const requestedLocationId: string | undefined = body?.locationId;

  // Direct mode: caller provides pre-resolved {upc, quantity} items (from search-products + user review)
  if (Array.isArray(body?.items)) {
    const directItems: Array<{ upc: string; quantity: number }> = body.items;
    if (!directItems.length) {
      return NextResponse.json({ cartAdded: false, added: [], notFound: [] });
    }

    const supabase = createServerSupabaseClient();
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('kroger_refresh_token, kroger_location_id')
      .eq('id', decoded.userId)
      .single();

    if (!profile?.kroger_refresh_token) {
      return NextResponse.json({ error: 'Kroger account not connected' }, { status: 403 });
    }

    let userAccessToken: string;
    try {
      const decryptedRefresh = decryptKrogerToken(profile.kroger_refresh_token);
      const { accessToken, newRefreshToken } = await refreshKrogerAccessToken(decryptedRefresh);
      userAccessToken = accessToken;
      if (newRefreshToken) {
        await supabase
          .from('user_profiles')
          .update({ kroger_refresh_token: encryptKrogerToken(newRefreshToken) })
          .eq('id', decoded.userId);
      }
    } catch (err) {
      log({ event: 'KROGER:ADD_TO_CART', status: 'error', userId: decoded.userId, reason: 'token_error', error: String(err) });
      return NextResponse.json({ error: 'Failed to authenticate with Kroger' }, { status: 502 });
    }

    const cartAdded = await krogerAddToCart(userAccessToken, directItems);
    if (!cartAdded) {
      log({ event: 'KROGER:ADD_TO_CART', status: 'error', userId: decoded.userId, reason: 'cart_api_error' });
      return NextResponse.json({ error: 'Failed to add items to Kroger cart' }, { status: 502 });
    }

    log({ event: 'KROGER:ADD_TO_CART', status: 'success', userId: decoded.userId, detail: `direct added=${directItems.length}` });
    return NextResponse.json({ cartAdded: true });
  }

  // Search-and-add mode (legacy, used by mobile app)
  const ingredients: Array<{ productName: string; quantity?: number }> = body?.ingredients ?? [];
  if (!ingredients.length) {
    return NextResponse.json({ error: 'No ingredients provided' }, { status: 400 });
  }

  // Load user's stored Kroger credentials
  const supabase = createServerSupabaseClient();
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('kroger_refresh_token, kroger_location_id')
    .eq('id', decoded.userId)
    .single();

  if (!profile?.kroger_refresh_token) {
    return NextResponse.json({ error: 'Kroger account not connected' }, { status: 403 });
  }

  const locationId = requestedLocationId ?? profile.kroger_location_id;
  if (!locationId) {
    return NextResponse.json({ error: 'No Kroger store selected' }, { status: 400 });
  }

  let userAccessToken: string;
  try {
    const decryptedRefresh = decryptKrogerToken(profile.kroger_refresh_token);
    const { accessToken, newRefreshToken } = await refreshKrogerAccessToken(decryptedRefresh);
    userAccessToken = accessToken;
    // Kroger rotates refresh tokens — always persist the new one if returned
    if (newRefreshToken) {
      await supabase
        .from('user_profiles')
        .update({ kroger_refresh_token: encryptKrogerToken(newRefreshToken) })
        .eq('id', decoded.userId);
    }
  } catch (err) {
    log({ event: 'KROGER:ADD_TO_CART', status: 'error', userId: decoded.userId, reason: 'token_error', error: String(err) });
    return NextResponse.json({ error: 'Failed to authenticate with Kroger' }, { status: 502 });
  }

  // Search for each ingredient concurrently (up to 10 at once to be polite to the API)
  const BATCH = 10;
  const added: string[] = [];
  const notFound: string[] = [];
  const cartItems: Array<{ upc: string; quantity: number }> = [];

  for (let i = 0; i < ingredients.length; i += BATCH) {
    const batch = ingredients.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map((ing) =>
        krogerSearchProduct(userAccessToken, ing.productName, locationId).then((result) => ({
          ing,
          result,
        }))
      )
    );

    for (const { ing, result } of results) {
      if (result) {
        cartItems.push({ upc: result.upc, quantity: ing.quantity ?? 1 });
        added.push(result.description);
      } else {
        notFound.push(ing.productName);
      }
    }
  }

  let cartAdded = false;
  if (cartItems.length > 0) {
    cartAdded = await krogerAddToCart(userAccessToken, cartItems);
    if (!cartAdded) {
      log({ event: 'KROGER:ADD_TO_CART', status: 'error', userId: decoded.userId, reason: 'cart_api_error' });
      return NextResponse.json({ error: 'Failed to add items to Kroger cart' }, { status: 502 });
    }
  }

  log({
    event: 'KROGER:ADD_TO_CART',
    status: 'success',
    userId: decoded.userId,
    detail: `added=${added.length} notFound=${notFound.length}`,
  });

  return NextResponse.json({ added, notFound, cartAdded });
}
