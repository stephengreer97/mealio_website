import { NextRequest } from 'next/server';
import { log } from '@/lib/logger';
import { appCallbackRedirect, backToPortal, readPlatformConnectState } from '@/lib/creator-connect';
import { finishTikTokConnect } from '@/lib/creator-connect-finish';

/**
 * GET /api/creator/tiktok/callback — where TikTok sends the creator back
 * (MEAL-83).
 *
 * The cookie is verified and the nonce compared before the code is exchanged, so
 * a forged callback never mints a token. Which creator this is comes from the
 * cookie and from nowhere else.
 *
 * Everything after the state check is `finishTikTokConnect`, shared with the
 * mobile app's `/complete` so the two paths cannot drift.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  // The mobile app's round trip carries a signed state instead of a cookie, and
  // is bounced back into the app unexchanged. See `appCallbackRedirect`.
  const app = await appCallbackRedirect(request, 'tiktok');
  if (app) return app;

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

  const finished = await finishTikTokConnect({ userId, creatorId, code });
  return finished.ok ? backToPortal('tiktok', 'connected') : backToPortal('tiktok', 'failed', finished.reason);
}
