import { NextRequest } from 'next/server';
import { startPlatformConnect } from '@/lib/creator-connect';
import { tiktokAuthUrl } from '@/lib/tiktok';

/**
 * POST /api/creator/tiktok/connect — start the TikTok round trip (MEAL-83).
 *
 * The state cookie and nonce live in `lib/creator-connect.ts`; this route only
 * chooses the consent screen. `video.list` is the only scope on the app.
 *
 * The mobile app uses this same endpoint: Expo's `AuthSession` opens the URL in
 * the browser, TikTok redirects to mealio.co, and the app deep-links back. There
 * is no native SDK, which is why the registered app has no mobile platforms.
 */
export async function POST(request: NextRequest) {
  return startPlatformConnect(request, 'tiktok', tiktokAuthUrl);
}
