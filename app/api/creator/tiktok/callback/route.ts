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

  const error = searchParams.get('error');
  if (error) {
    // What TikTok actually said, kept in the log and never put on screen —
    // `ConnectFailure` exists because a callback that hands prose to the client
    // lets anyone who can get a creator to open a link choose the sentence
    // rendered in our error styling on our own domain.
    //
    // It is worth keeping *because* of the split below. `access_denied` is
    // TikTok's documented code for the creator pressing Cancel; anything else is
    // TikTok refusing rather than the creator declining. Reporting that as "you
    // cancelled on TikTok's screen" is the dead end this branch exists to avoid:
    // it blames the creator for something they did not do and tells them nothing
    // to do next.
    //
    // The app moved to production credentials on 2026-08-06. Under sandbox the
    // likely cause was the tester allow-list; now it is a real refusal, and this
    // log line is the only place the actual code is recorded — which is what
    // makes a pattern in production diagnosable at all.
    log({
      event: 'CREATOR:SOURCE_CONNECT',
      status: 'failed',
      userId,
      detail: `platform=tiktok error=${JSON.stringify(error)} description=${JSON.stringify(searchParams.get('error_description') ?? '')}`,
      reason: error === 'access_denied' ? 'cancelled' : 'refused',
    });
    if (error === 'access_denied') return backToPortal('tiktok', 'cancelled');
    return backToPortal('tiktok', 'failed', 'unavailable');
  }

  const code = searchParams.get('code');
  if (!code) {
    return backToPortal('tiktok', 'failed', 'no-code');
  }

  const exchanged = await exchangeTikTokCode(code);
  if (!exchanged.ok) {
    log({ event: 'CREATOR:SOURCE_CONNECT', status: 'error', userId, detail: 'platform=tiktok', reason: exchanged.detail });
    // TikTok's own sentence stays in the log line above. See `ConnectFailure`.
    return backToPortal('tiktok', 'failed', 'exchange');
  }

  // A grant without `video.list` cannot list anything, which would present as a
  // connected account that never yields a post — the silent failure this whole
  // area is written around. Refuse it while there is still someone to tell.
  if (!exchanged.grant.scopes.includes(TIKTOK_VIDEO_LIST_SCOPE)) {
    log({ event: 'CREATOR:SOURCE_CONNECT', status: 'failed', userId, detail: 'platform=tiktok', reason: 'video.list not granted' });
    return backToPortal('tiktok', 'failed', 'scope');
  }

  if (!exchanged.grant.openId) {
    return backToPortal('tiktok', 'failed', 'account');
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
    return backToPortal('tiktok', 'failed', 'store');
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
