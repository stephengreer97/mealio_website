import { NextRequest } from 'next/server';
import { completeAppConnect } from '@/lib/creator-connect';
import { finishYouTubeConnect } from '@/lib/creator-connect-finish';

/**
 * POST /api/creator/youtube/complete: the mobile app finishes a YouTube
 * connection with the `code` and `state` the callback bounced to
 * `mealio://creator/connect`.
 *
 * The state is matched to the bearer token in `completeAppConnect`; everything
 * after that is `finishYouTubeConnect`, the same function the web callback runs.
 *
 * The append consent is read from the signed state exactly as the web callback
 * reads it from the cookie: absent stays absent (the question was not asked),
 * and only a literal `true` is consent.
 */
export async function POST(request: NextRequest) {
  return completeAppConnect(request, 'youtube', (verified, claims) =>
    finishYouTubeConnect({
      ...verified,
      appendOptIn: claims.appendOptIn === undefined ? undefined : claims.appendOptIn === true,
    }),
  );
}
