import { NextRequest } from 'next/server';
import { disconnectPlatform, platformConnectionStatus } from '@/lib/creator-connect';

/**
 * The creator's own view of their Instagram connection (MEAL-82).
 *
 * GET    — is an account connected, which one, and has the grant stopped working.
 * DELETE — disconnect it.
 *
 * There is no PATCH here, unlike YouTube. That route exists to toggle consent to
 * *edit* descriptions, and Instagram exposes no way to edit the caption of a
 * post made in the app — so there is no second permission to hold and none to
 * revoke.
 */

export async function GET(request: NextRequest) {
  return platformConnectionStatus(request, 'instagram');
}

export async function DELETE(request: NextRequest) {
  return disconnectPlatform(request, 'instagram');
}
