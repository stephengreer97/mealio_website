import { NextRequest } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { log } from '@/lib/logger';
import { saveConnection } from '@/lib/platform-tokens';
import { backToPortal, readPlatformConnectState } from '@/lib/creator-connect';
import { exchangeInstagramCode, fetchInstagramAccount, INSTAGRAM_BASIC_SCOPE } from '@/lib/instagram';

/**
 * GET /api/creator/instagram/callback — where Instagram sends the creator back
 * (MEAL-82).
 *
 * The cookie is verified and the nonce compared before the code is exchanged, so
 * a forged callback never mints a token. Which creator this is comes from that
 * cookie and from nowhere else.
 *
 * Two failures get their own sentence rather than a generic one, because in both
 * cases the creator can act on the answer and cannot act on "something went
 * wrong": a **personal** account (Instagram grants those no API access at all),
 * and a grant that came back without the basic scope, which happens when someone
 * unticks it on Meta's own screen and would otherwise present as a connection
 * that reads nothing forever.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

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
    return backToPortal('instagram', 'failed', 'Instagram sent us back without an authorization code.');
  }

  const exchanged = await exchangeInstagramCode(code);
  if (!exchanged.ok) {
    log({ event: 'CREATOR:SOURCE_CONNECT', status: 'error', userId, detail: 'platform=instagram', reason: exchanged.detail });
    return backToPortal('instagram', 'failed', exchanged.detail);
  }

  if (!exchanged.grant.scopes.includes(INSTAGRAM_BASIC_SCOPE)) {
    log({ event: 'CREATOR:SOURCE_CONNECT', status: 'failed', userId, detail: 'platform=instagram', reason: 'basic scope not granted' });
    return backToPortal(
      'instagram',
      'failed',
      'That connection came back without permission to read your posts, so there would be nothing to import. ' +
        'Connect again and leave the permission ticked.',
    );
  }

  const account = await fetchInstagramAccount(exchanged.grant.accessToken);
  if (!account.ok) {
    log({ event: 'CREATOR:SOURCE_CONNECT', status: 'error', userId, detail: 'platform=instagram', reason: account.detail });
    return backToPortal('instagram', 'failed', account.detail);
  }

  const supabase = createServerSupabaseClient();

  try {
    await saveConnection(supabase, {
      creatorId,
      platform: 'instagram',
      // From the grant, never typed by a creator and never taken off the link on
      // their application.
      externalId: account.account.id,
      externalName: account.account.username,
      accessToken: exchanged.grant.accessToken,
      // Instagram has no refresh token: the long-lived access token renews
      // itself while it is alive. `refreshInstagramGrant` is what keeps it that
      // way, and `expires_at` is what puts this row in the sweep's sights.
      refreshToken: null,
      scopes: exchanged.grant.scopes,
      expiresAt: exchanged.grant.expiresAt,
    });
  } catch (err) {
    log({ event: 'CREATOR:SOURCE_CONNECT', status: 'error', userId, detail: 'platform=instagram', error: err });
    return backToPortal('instagram', 'failed', 'We could not store that connection. Try again.');
  }

  log({
    event: 'CREATOR:SOURCE_CONNECT',
    status: 'success',
    userId,
    // No tokens, ever. The account id and type are the useful half, and the
    // expiry is the number anyone debugging this in two months will want.
    detail:
      `platform=instagram creator=${creatorId} account=${account.account.id} ` +
      `type=${account.account.accountType ?? 'unknown'} expires=${exchanged.grant.expiresAt ?? 'never'}`,
  });

  return backToPortal('instagram', 'connected');
}
