import { NextRequest } from 'next/server';
import { startPlatformConnect } from '@/lib/creator-connect';
import { instagramAuthUrl } from '@/lib/instagram';

/**
 * POST /api/creator/instagram/connect — start the Instagram round trip (MEAL-82).
 *
 * Everything about the state cookie, the nonce and the creator lookup lives in
 * `lib/creator-connect.ts`; all this route decides is which consent screen to
 * open. `instagram_business_basic` is the only scope on it.
 */
export async function POST(request: NextRequest) {
  return startPlatformConnect(request, 'instagram', instagramAuthUrl);
}
