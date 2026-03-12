/*
 * Required DB migration (run once in Supabase SQL editor):
 *
 *   ALTER TABLE user_profiles
 *     ADD COLUMN IF NOT EXISTS kroger_refresh_token TEXT,
 *     ADD COLUMN IF NOT EXISTS kroger_location_id TEXT,
 *     ADD COLUMN IF NOT EXISTS kroger_location_name TEXT,
 *     ADD COLUMN IF NOT EXISTS kroger_connected_at TIMESTAMPTZ;
 */

import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { exchangeKrogerCode, encryptKrogerToken, verifyKrogerStateToken } from '@/lib/kroger';
import { log } from '@/lib/logger';

export const dynamic = 'force-dynamic';

/**
 * GET /api/kroger/callback?code=...&state=...
 * Kroger redirects here after the user authorizes Mealio.
 * Exchanges the code for tokens, encrypts and stores the refresh token,
 * then redirects to /account?kroger=connected.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const error = searchParams.get('error');

  const host = request.headers.get('host') ?? 'mealio.co';
  const proto = host.startsWith('localhost') ? 'http' : 'https';
  const APP_URL = `${proto}://${host}`;

  if (error) {
    return NextResponse.redirect(`${APP_URL}/account?kroger=denied`);
  }

  if (!code || !state) {
    return NextResponse.redirect(`${APP_URL}/account?kroger=error`);
  }

  const stateData = await verifyKrogerStateToken(state);
  if (!stateData) {
    return NextResponse.redirect(`${APP_URL}/account?kroger=error`);
  }

  const { userId } = stateData;

  try {
    const redirectUri = `${APP_URL}/api/kroger/callback`;
    const { refreshToken } = await exchangeKrogerCode(code, redirectUri);

    const encryptedRefreshToken = encryptKrogerToken(refreshToken);

    const supabase = createServerSupabaseClient();
    const { error: dbError } = await supabase
      .from('user_profiles')
      .update({
        kroger_refresh_token: encryptedRefreshToken,
        kroger_connected_at: new Date().toISOString(),
        // Clear any previously saved location so user picks a fresh one
        kroger_location_id: null,
        kroger_location_name: null,
      })
      .eq('id', userId);

    if (dbError) {
      log({ event: 'KROGER:CALLBACK', status: 'error', userId, reason: 'db_error', error: dbError.message });
      return NextResponse.redirect(`${APP_URL}/account?kroger=error&detail=${encodeURIComponent('db:' + dbError.message)}`);
    }

    log({ event: 'KROGER:CALLBACK', status: 'success', userId });
    return NextResponse.redirect(`${APP_URL}/account?kroger=connected`);
  } catch (err) {
    const errMsg = encodeURIComponent(String(err).slice(0, 200));
    log({ event: 'KROGER:CALLBACK', status: 'error', userId, error: String(err) });
    return NextResponse.redirect(`${APP_URL}/account?kroger=error&detail=${errMsg}`);
  }
}
