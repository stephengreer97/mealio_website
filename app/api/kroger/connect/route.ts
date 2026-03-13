import { NextRequest, NextResponse } from 'next/server';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';
import { createKrogerStateToken } from '@/lib/kroger';

export const dynamic = 'force-dynamic';

/**
 * POST /api/kroger/connect
 * Returns a { redirectUrl } pointing to Kroger's OAuth authorization page.
 * The caller (web/mobile) should redirect/open the returned URL.
 */
export async function POST(request: NextRequest) {
  const clientId = process.env.KROGER_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json({ error: 'Kroger integration not configured' }, { status: 503 });
  }

  const token = extractTokenFromHeader(request.headers.get('authorization'));
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const decoded = await verifyAccessToken(token);
  if (!decoded) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const host = request.headers.get('host') ?? 'mealio.co';
  const proto = host.startsWith('localhost') ? 'http' : 'https';
  const APP_URL = `${proto}://${host}`;

  const body = await request.json().catch(() => ({}));
  const returnTo: string | undefined = typeof body?.returnTo === 'string' ? body.returnTo : undefined;
  const popup: boolean = body?.popup === true;
  const mobile: boolean = body?.mobile === true;

  const state = await createKrogerStateToken(decoded.userId, returnTo, popup, mobile);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: `${APP_URL}/api/kroger/callback`,
    scope: 'cart.basic:write product.compact',
    state,
  });

  const redirectUrl = `https://api.kroger.com/v1/connect/oauth2/authorize?${params}`;
  return NextResponse.json({ redirectUrl });
}
