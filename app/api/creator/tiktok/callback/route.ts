import { NextRequest } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { log } from '@/lib/logger';
import { saveConnection } from '@/lib/platform-tokens';
import { backToPortal, readPlatformConnectState } from '@/lib/creator-connect';
import { exchangeTikTokCode, TIKTOK_VIDEO_LIST_SCOPE } from '@/lib/tiktok';

/**
 * GET /api/creator/tiktok/callback — where TikTok sends the creator back
 * (MEAL-83).
 *
 * The cookie is verified and the nonce compared before the code is exchanged, so
 * a forged callback never mints a token. Which creator this is comes from the
 * cookie and from nowhere else.
 *
 * The account's `open_id` arrives in the token response, and that is the only
 * place we can get it: without `user.info.basic` there is no profile endpoint,
 * and we are deliberately not requesting that scope for the sake of a prettier
 * label. So the connection stores an id and no display name.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  const verified = await readPlatformConnectState(request, 'tiktok', searchParams.get('state'));
  if (!verified.ok) return verified.response;
  const { userId, creatorId } = verified.state;

  // A creator who changed their mind on TikTok's screen. Not an error, and
  // nothing is stored.
  if (searchParams.get('error')) {
    log({ event: 'CREATOR:SOURCE_CONNECT', status: 'failed', userId, detail: 'platform=tiktok', reason: 'cancelled' });
    return backToPortal('tiktok', 'cancelled');
  }

  const code = searchParams.get('code');
  if (!code) {
    return backToPortal('tiktok', 'failed', 'TikTok sent us back without an authorization code.');
  }

  const exchanged = await exchangeTikTokCode(code);
  if (!exchanged.ok) {
    log({ event: 'CREATOR:SOURCE_CONNECT', status: 'error', userId, detail: 'platform=tiktok', reason: exchanged.detail });
    return backToPortal('tiktok', 'failed', exchanged.detail);
  }

  // A grant without `video.list` cannot list anything, which would present as a
  // connected account that never yields a post — the silent failure this whole
  // area is written around. Refuse it while there is still someone to tell.
  if (!exchanged.grant.scopes.includes(TIKTOK_VIDEO_LIST_SCOPE)) {
    log({ event: 'CREATOR:SOURCE_CONNECT', status: 'failed', userId, detail: 'platform=tiktok', reason: 'video.list not granted' });
    return backToPortal(
      'tiktok',
      'failed',
      'That connection came back without permission to list your videos, so there would be nothing to import. ' +
        'Connect again and leave the permission ticked.',
    );
  }

  if (!exchanged.grant.openId) {
    return backToPortal('tiktok', 'failed', 'TikTok returned no account id for that grant. Try connecting again.');
  }

  const supabase = createServerSupabaseClient();

  try {
    await saveConnection(supabase, {
      creatorId,
      platform: 'tiktok',
      externalId: exchanged.grant.openId,
      // No display name: `user.info.basic` is not on the app, on purpose.
      externalName: null,
      accessToken: exchanged.grant.accessToken,
      // Rotated on every refresh from here on. The stored one is only ever the
      // most recent, because the previous one dies the moment it is used.
      refreshToken: exchanged.grant.refreshToken,
      scopes: exchanged.grant.scopes,
      // The *access* token's expiry, about a day out. That is what puts this row
      // in the daily sweep permanently, which is what keeps the year-long
      // refresh token rotating long before its own expiry.
      expiresAt: exchanged.grant.expiresAt,
    });
  } catch (err) {
    log({ event: 'CREATOR:SOURCE_CONNECT', status: 'error', userId, detail: 'platform=tiktok', error: err });
    return backToPortal('tiktok', 'failed', 'We could not store that connection. Try again.');
  }

  log({
    event: 'CREATOR:SOURCE_CONNECT',
    status: 'success',
    userId,
    // No tokens, ever. `open_id` is app-scoped and is the useful half.
    detail: `platform=tiktok creator=${creatorId} account=${exchanged.grant.openId} expires=${exchanged.grant.expiresAt ?? 'never'}`,
  });

  return backToPortal('tiktok', 'connected');
}
