import { NextRequest } from 'next/server';
import { completeAppConnect } from '@/lib/creator-connect';
import { finishInstagramConnect } from '@/lib/creator-connect-finish';

/**
 * POST /api/creator/instagram/complete: the mobile app finishes an Instagram
 * connection with the `code` and `state` the callback bounced to
 * `mealio://creator/connect`.
 *
 * The state is matched to the bearer token in `completeAppConnect`; everything
 * after that is `finishInstagramConnect`, the same function the web callback
 * runs.
 */
export async function POST(request: NextRequest) {
  return completeAppConnect(request, 'instagram', (verified) => finishInstagramConnect(verified));
}
