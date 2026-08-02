import { NextRequest, NextResponse } from 'next/server';
import { jwtVerify } from 'jose';
import { createServerSupabaseClient } from '@/lib/supabase';
import { log } from '@/lib/logger';
import { saveConnection } from '@/lib/platform-tokens';
import { exchangeYouTubeCode, fetchOwnChannel, YOUTUBE_WRITE_SCOPE } from '@/lib/youtube';
import { STATE_COOKIE } from '../connect/route';

/**
 * GET /api/creator/youtube/callback — where Google sends the creator back.
 *
 * Everything that decides what happens comes from the signed state cookie, not
 * from the query string: which creator this is, and whether they ticked the
 * separate consent to have descriptions edited. Google echoes a nonce, and the
 * only thing the nonce proves is that this response belongs to the request that
 * set the cookie.
 *
 * The channel id is read from the grant (`channels.list?mine=true`), never typed
 * by a creator and never taken from the link on their application.
 */

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://mealio.co';
const JWT_SECRET = () => new TextEncoder().encode(process.env.JWT_SECRET || '');

/** Sends the creator back to the portal with something it can render, and drops the state cookie. */
function back(outcome: string, detail?: string): NextResponse {
  const url = new URL(`${APP_URL}/creator`);
  url.searchParams.set('youtube', outcome);
  if (detail) url.searchParams.set('detail', detail);
  const response = NextResponse.redirect(url.toString());
  response.cookies.set(STATE_COOKIE, '', { path: '/', maxAge: 0 });
  return response;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  const stateCookie = request.cookies.get(STATE_COOKIE)?.value;
  if (!stateCookie) {
    return back('failed', 'This connection attempt has expired. Start again from the creator portal.');
  }

  let userId: string;
  let creatorId: string;
  let nonce: string;
  let appendOptIn: boolean;
  try {
    const { payload } = await jwtVerify(stateCookie, JWT_SECRET());
    if (payload.type !== 'youtube_connect') throw new Error('wrong token type');
    userId = String(payload.sub);
    creatorId = String(payload.creatorId);
    nonce = String(payload.nonce);
    appendOptIn = payload.appendOptIn === true;
  } catch {
    log({ event: 'CREATOR:SOURCE_CONNECT', status: 'failed', reason: 'invalid state cookie' });
    return back('failed', 'That connection could not be verified. Start again from the creator portal.');
  }

  if (searchParams.get('state') !== nonce) {
    log({ event: 'CREATOR:SOURCE_CONNECT', status: 'failed', userId, reason: 'state mismatch (csrf)' });
    return back('failed', 'That connection could not be verified. Start again from the creator portal.');
  }

  // A creator who changed their mind on Google's screen. Not an error, and
  // nothing is stored — including the append consent they ticked on ours.
  if (searchParams.get('error')) {
    log({ event: 'CREATOR:SOURCE_CONNECT', status: 'failed', userId, detail: 'platform=youtube', reason: 'cancelled' });
    return back('cancelled');
  }

  const code = searchParams.get('code');
  if (!code) {
    return back('failed', 'Google sent us back without an authorization code.');
  }

  const exchanged = await exchangeYouTubeCode(code);
  if (!exchanged.ok) {
    log({ event: 'CREATOR:SOURCE_CONNECT', status: 'error', userId, detail: 'platform=youtube', reason: exchanged.detail });
    return back('failed', exchanged.detail);
  }

  const channel = await fetchOwnChannel(exchanged.grant.accessToken);
  if (!channel.ok) {
    log({ event: 'CREATOR:SOURCE_CONNECT', status: 'error', userId, detail: 'platform=youtube', reason: channel.detail });
    return back('failed', channel.detail);
  }

  const supabase = createServerSupabaseClient();

  try {
    await saveConnection(supabase, {
      creatorId,
      platform: 'youtube',
      externalId: channel.channel.id,
      externalName: channel.channel.title,
      accessToken: exchanged.grant.accessToken,
      refreshToken: exchanged.grant.refreshToken,
      scopes: exchanged.grant.scopes,
      expiresAt: exchanged.grant.expiresAt,
    });
  } catch (err) {
    log({ event: 'CREATOR:SOURCE_CONNECT', status: 'error', userId, detail: 'platform=youtube', error: err });
    return back('failed', 'We could not store that connection. Try again.');
  }

  // Written from the state cookie, so the flag records what the creator ticked
  // on our own screen — not anything a client could send later. Always written,
  // including the `false` case: re-connecting without ticking the box has to
  // *withdraw* consent given last time, not leave it standing.
  await supabase.from('creators').update({ youtube_append_opt_in: appendOptIn }).eq('id', creatorId);

  log({
    event: 'CREATOR:SOURCE_CONNECT',
    status: 'success',
    userId,
    // No tokens, ever. The channel id is public and is the useful half.
    detail:
      `platform=youtube creator=${creatorId} channel=${channel.channel.id} ` +
      `appendOptIn=${appendOptIn} write=${exchanged.grant.scopes.includes(YOUTUBE_WRITE_SCOPE)}`,
  });

  return back('connected');
}
