import { NextRequest } from 'next/server';
import { log } from '@/lib/logger';
import { appCallbackRedirect, backToPortal, readPlatformConnectState } from '@/lib/creator-connect';
import { finishInstagramConnect } from '@/lib/creator-connect-finish';

/**
 * GET /api/creator/instagram/callback — where Instagram sends the creator back
 * (MEAL-82).
 *
 * The cookie is verified and the nonce compared before the code is exchanged, so
 * a forged callback never mints a token. Which creator this is comes from that
 * cookie and from nowhere else.
 *
 * Everything after the state check (exchange, scope and account checks, storing
 * the grant) is `finishInstagramConnect`, shared with the mobile app's
 * `/complete` so the two paths cannot drift.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  // The mobile app's round trip carries a signed state instead of a cookie, and
  // is bounced back into the app unexchanged. See `appCallbackRedirect`.
  const app = await appCallbackRedirect(request, 'instagram');
  if (app) return app;

  const verified = await readPlatformConnectState(request, 'instagram', searchParams.get('state'));
  if (!verified.ok) return verified.response;
  const { userId, creatorId } = verified.state;

  // A creator who changed their mind on Instagram's screen. Not an error, and
  // nothing is stored.
  if (searchParams.get('error') || searchParams.get('error_reason')) {
    log({ event: 'CREATOR:SOURCE_CONNECT', status: 'failed', userId, detail: 'platform=instagram', reason: 'cancelled' });
    return backToPortal('instagram', 'cancelled');
  }

  const code = searchParams.get('code');
  if (!code) {
    return backToPortal('instagram', 'failed', 'no-code');
  }

  const finished = await finishInstagramConnect({ userId, creatorId, code });
  return finished.ok ? backToPortal('instagram', 'connected') : backToPortal('instagram', 'failed', finished.reason);
}
