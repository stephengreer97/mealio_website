import { NextRequest } from 'next/server';
import { startPlatformConnect } from '@/lib/creator-connect';
import { tiktokAuthUrl } from '@/lib/tiktok';

/**
 * POST /api/creator/tiktok/connect — start the TikTok round trip (MEAL-83).
 *
 * The state cookie and nonce live in `lib/creator-connect.ts`; this route only
 * chooses the consent screen. `video.list` is the only scope on the app.
 *
 * The website posts an empty body and gets a state cookie. The mobile app posts
 * `{"client":"app"}` and gets a signed state JWT in the consent URL instead,
 * because a cookie set on this fetch lands in React Native's jar and never
 * reaches the browser doing the consent. The callback bounces that round trip to
 * `mealio://creator/connect` and the app finishes it at `/complete`. See
 * `signAppConnectState` in `lib/creator-connect.ts`.
 */
export async function POST(request: NextRequest) {
  return startPlatformConnect(request, 'tiktok', tiktokAuthUrl);
}
