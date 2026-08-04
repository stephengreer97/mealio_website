import { NextRequest } from 'next/server';
import { disconnectPlatform, platformConnectionStatus } from '@/lib/creator-connect';
import { tiktokConfigured } from '@/lib/tiktok';

/**
 * The creator's own view of their TikTok connection (MEAL-83).
 *
 * GET    — is an account connected, which one, and has the grant stopped working.
 * DELETE — disconnect it.
 *
 * No PATCH, for the same reason as Instagram: there is no write permission to
 * hold. MEAL-80 records that a TikTok description locks permanently seven days
 * after posting, so even a hypothetical append would only ever work on the most
 * recent week of a creator's back catalog.
 */

export async function GET(request: NextRequest) {
  // `configured` travels with the status because TikTok is the one platform
  // whose credentials might not be there: `tiktokAuthUrl` returns null without a
  // client key, and a Connect button that only reveals that after it is pressed
  // is indistinguishable from one that is broken.
  return platformConnectionStatus(request, 'tiktok', tiktokConfigured());
}

export async function DELETE(request: NextRequest) {
  return disconnectPlatform(request, 'tiktok');
}
