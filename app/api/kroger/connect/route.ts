import { NextRequest, NextResponse } from 'next/server';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';
import { createKrogerStateToken } from '@/lib/kroger';

export const dynamic = 'force-dynamic';

// Maps internal store IDs to Kroger OAuth banner values
const STORE_ID_TO_BANNER: Record<string, string> = {
  kroger:       'kroger',
  ralphs:       'ralphs',
  fred_meyer:   'fredmeyer',
  king_soopers: 'kingsoopers',
  smiths:       'smiths',
  frys:         'frys',
  qfc:          'qfc',
  city_market:  'citymarket',
  dillons:      'dillons',
  bakers:       'bakers',
  marianos:     'marianos',
  pick_n_save:  'picknsave',
  metro_market: 'metromarket',
  pay_less:     'payless',
  harris_teeter:'harristeeter',
};

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
  const storeId: string | undefined = typeof body?.storeId === 'string' ? body.storeId : undefined;

  const state = await createKrogerStateToken(decoded.userId, returnTo, popup, mobile);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: `${APP_URL}/api/kroger/callback`,
    scope: 'cart.basic:write product.compact',
    state,
  });

  const banner = storeId ? (STORE_ID_TO_BANNER[storeId] ?? 'kroger') : 'kroger';
  params.set('banner', banner);

  const redirectUrl = `https://api.kroger.com/v1/connect/oauth2/authorize?${params}`;
  return NextResponse.json({ redirectUrl });
}
