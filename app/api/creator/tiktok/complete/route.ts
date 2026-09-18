import { NextRequest } from 'next/server';
import { completeAppConnect } from '@/lib/creator-connect';
import { finishTikTokConnect } from '@/lib/creator-connect-finish';

/**
 * POST /api/creator/tiktok/complete: the mobile app finishes a TikTok connection
 * with the `code` and `state` the callback bounced to `mealio://creator/connect`.
 *
 * The state is matched to the bearer token in `completeAppConnect`; everything
 * after that is `finishTikTokConnect`, the same function the web callback runs.
 */
export async function POST(request: NextRequest) {
  return completeAppConnect(request, 'tiktok', (verified) => finishTikTokConnect(verified));
}
