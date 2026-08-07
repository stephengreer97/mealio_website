import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { SignJWT } from 'jose';
import { createServerSupabaseClient } from '@/lib/supabase';
import { requireAuth } from '@/lib/requireAuth';
import { log } from '@/lib/logger';
import { youtubeAuthUrl } from '@/lib/youtube';

/**
 * POST /api/creator/youtube/connect — start the YouTube OAuth round trip (MEAL-74).
 *
 * Returns the consent URL for the client to navigate to, rather than issuing a
 * redirect itself: the creator portal authenticates with a bearer token out of
 * localStorage, and a `<a href>` to a redirecting endpoint would arrive without
 * one.
 *
 * The state is split deliberately. The `state` parameter Google echoes back is a
 * nonce and nothing else; **who** is connecting travels in an httpOnly, signed
 * cookie. Identity that round-trips through a third party and comes back in a
 * query string is identity anyone can supply, and the thing being attached here
 * is write access to a creator's channel.
 */

export const STATE_COOKIE = 'mealio_youtube_state';

/** Long enough to read a consent screen, short enough that a stale tab is not a key. */
export const STATE_TTL_SECONDS = 900;

const JWT_SECRET = () => new TextEncoder().encode(process.env.JWT_SECRET || '');

export async function POST(request: NextRequest) {
  const user = await requireAuth(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { appendOptIn?: unknown; captions?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    /* an empty body is a connect with no append consent, which is the default */
  }

  /**
   * The creator asked us to be able to read their captions (MEAL-138).
   *
   * The same Google scope as `appendOptIn` and deliberately a different request.
   * It does **not** set `youtube_append_opt_in` — see the three answers below —
   * so a creator who wants transcripts read still has nothing on their channel
   * edited, and the card that offers this says so. Before this existed, the only
   * way to get captions read was to tick description-editing, which coupled two
   * unrelated permissions and quietly under-imported for everyone who declined.
   */
  const captions = body.captions === true;

  /**
   * Consent to have descriptions edited is a separate, explicit choice from
   * consent to have videos read (MEAL-77) — and it has **three** answers, not
   * two.
   *
   *   - `true`      — the creator ticked the box on this screen.
   *   - `false`     — they did not, and any earlier `true` is withdrawn.
   *   - `undefined` — this round trip did not ask the question, so it does not
   *                   answer it either. The callback touches the flag on neither
   *                   side.
   *
   * The third one is the fix for the trap a binary carried. A captions request
   * had to send *something*: `false` silently withdrew a permission the creator
   * had really granted, and `true` — carried through from the stored flag so it
   * would not — meant that clicking "let Mealio read my captions" re-asserted
   * description-editing consent, and, since the trip is what grants `force-ssl`,
   * armed the append. One button, labelled reading, that started writing.
   *
   * Only a captions trip may leave it unanswered. A plain connect with an empty
   * body is still an explicit no, which is what it has always meant.
   */
  const appendOptIn: boolean | undefined =
    captions && body.appendOptIn === undefined ? undefined : body.appendOptIn === true;

  const supabase = createServerSupabaseClient();
  const { data: creator } = await supabase
    .from('creators')
    .select('id')
    .eq('user_id', user.userId)
    .maybeSingle();

  if (!creator) {
    return NextResponse.json({ error: 'Only approved creators can connect a channel.' }, { status: 403 });
  }

  const nonce = randomBytes(16).toString('hex');
  // `force-ssl` rides on one of the two ticks, not on connecting. Either is
  // enough to ask for it, and neither stands in for the other. An unanswered
  // append question is not a request for it: `captions` is what asks here.
  const authUrl = youtubeAuthUrl(nonce, { write: appendOptIn === true, captions });
  if (!authUrl) {
    return NextResponse.json({ error: 'YouTube connection is not configured on this deployment.' }, { status: 500 });
  }

  const state = await new SignJWT({
    sub: user.userId,
    creatorId: (creator as { id: string }).id,
    nonce,
    // Absent rather than `false` when the question was not asked. The claim's
    // absence is the third answer, and the callback reads it as "leave the flag
    // alone" — so it has to be genuinely absent, not a falsy stand-in.
    ...(appendOptIn === undefined ? {} : { appendOptIn }),
    type: 'youtube_connect',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${STATE_TTL_SECONDS}s`)
    .sign(JWT_SECRET());

  log({
    event: 'CREATOR:SOURCE_CONNECT',
    status: 'pending',
    userId: user.userId,
    email: user.email,
    // `captions` is logged beside `appendOptIn` because they are separate
    // requests for one scope, and "why did this creator see that consent screen"
    // is otherwise unanswerable from the log. `unasked` is the third answer, and
    // it is the difference between "they said no" and "nobody asked them" — the
    // distinction the audit trail was missing when a captions trip carried a
    // borrowed `true`.
    detail:
      `platform=youtube appendOptIn=${appendOptIn === undefined ? 'unasked' : appendOptIn} ` +
      `captions=${captions}`,
  });

  const response = NextResponse.json({ url: authUrl });
  response.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: STATE_TTL_SECONDS,
    path: '/',
  });
  return response;
}
