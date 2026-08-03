import { NextRequest } from 'next/server';
import { startPlatformConnect } from '@/lib/creator-connect';
import { tiktokAuthUrl } from '@/lib/tiktok';

/**
 * POST /api/creator/tiktok/connect — start the TikTok round trip (MEAL-83).
 *
 * The state cookie and nonce live in `lib/creator-connect.ts`; this route only
 * chooses the consent screen. `video.list` is the only scope on the app.
 *
 * **Web only. This endpoint does not work from the mobile app**, and an earlier
 * version of this comment claimed the opposite. Two separate reasons, both
 * checked against `mealio_app` rather than assumed:
 *
 *   1. There is no Instagram or TikTok connect surface in the mobile app at all.
 *      Creators there get a free-text "Instagram handle, YouTube, etc." field on
 *      the application form and nothing else.
 *   2. If one were built the way the app's only other OAuth round trip is —
 *      `WebBrowser.openAuthSessionAsync`, in `MyMealsScreen` — it would still
 *      fail every time. `startPlatformConnect` sets the state cookie on the JSON
 *      response to this POST, which puts it in React Native's cookie store;
 *      `openAuthSessionAsync` opens the consent URL in
 *      `ASWebAuthenticationSession` / Chrome Custom Tabs, which use Safari's or
 *      Chrome's jar. The callback would arrive with no `mealio_tiktok_state` and
 *      take the first refusal branch — "This connection attempt has expired."
 *
 * Moving identity out of `state` and into a signed cookie is the right call for
 * the web (see `lib/creator-connect.ts`), and this is its one cost. A mobile
 * flow would need identity to survive a browser it does not share cookies with:
 * `/api/kroger/connect` already solves exactly that, by putting a signed state
 * JWT in the query string and having the callback bounce to a `mealio://` deep
 * link. That is a real piece of work with its own security argument to make, and
 * it is not in MEAL-82/83.
 */
export async function POST(request: NextRequest) {
  return startPlatformConnect(request, 'tiktok', tiktokAuthUrl);
}
