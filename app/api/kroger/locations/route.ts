import { NextRequest, NextResponse } from 'next/server';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';

export const dynamic = 'force-dynamic';

const KROGER_BASE = 'https://api.kroger.com/v1';

const CHAIN_TO_STORE_ID: Record<string, string> = {
  'KROGER': 'kroger',
  'RALPHS': 'ralphs',
  'FRED MEYER': 'fred_meyer',
  'KING SOOPERS': 'king_soopers',
  "SMITH'S": 'smiths',
  "FRY'S FOOD STORES": 'frys',
  'QFC': 'qfc',
  'CITY MARKET': 'city_market',
  'DILLONS': 'dillons',
  "BAKER'S": 'bakers',
  "MARIANO'S": 'marianos',
  "PICK 'N SAVE": 'pick_n_save',
  'METRO MARKET': 'metro_market',
  'PAY-LESS': 'pay_less',
  'HARRIS TEETER': 'harris_teeter',
  "CARR'S": 'carrs',
};

async function getClientToken(): Promise<string> {
  const clientId = process.env.KROGER_CLIENT_ID;
  const clientSecret = process.env.KROGER_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Kroger not configured');
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await fetch(`${KROGER_BASE}/connect/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials&scope=product.compact',
    cache: 'no-store',
  });
  if (!res.ok) throw new Error('Failed to get Kroger client token');
  const data = await res.json();
  return data.access_token;
}

/**
 * GET /api/kroger/locations?lat=&lon=&term=
 * Returns nearby Kroger-family stores.
 * Requires either lat+lon or a search term.
 */
export async function GET(request: NextRequest) {
  const token = extractTokenFromHeader(request.headers.get('authorization'));
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const decoded = await verifyAccessToken(token);
  if (!decoded) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!process.env.KROGER_CLIENT_ID) {
    return NextResponse.json({ error: 'Kroger not configured' }, { status: 503 });
  }

  const { searchParams } = new URL(request.url);
  const lat = searchParams.get('lat');
  const lon = searchParams.get('lon');
  const term = searchParams.get('term');

  const params = new URLSearchParams({ 'filter.limit': '10' });
  if (lat && lon) {
    params.set('filter.lat.near', lat);
    params.set('filter.lon.near', lon);
    params.set('filter.radiusInMiles', '25');
  } else if (term) {
    params.set('filter.zipCode.near', term);
  } else {
    return NextResponse.json({ error: 'Provide lat+lon or term' }, { status: 400 });
  }

  try {
    const clientToken = await getClientToken();
    const res = await fetch(`${KROGER_BASE}/locations?${params}`, {
      headers: { Authorization: `Bearer ${clientToken}`, Accept: 'application/json' },
      cache: 'no-store',
    });

    if (!res.ok) {
      return NextResponse.json({ error: 'Kroger API error' }, { status: 502 });
    }

    const data = await res.json();
    const locations = (data.data ?? []).map((loc: any) => ({
      locationId: loc.locationId,
      name: loc.name,
      chain: loc.chain,
      storeId: CHAIN_TO_STORE_ID[loc.chain?.toUpperCase() ?? ''] ?? 'kroger',
      address: loc.address
        ? `${loc.address.addressLine1}, ${loc.address.city}, ${loc.address.state} ${loc.address.zipCode}`
        : '',
    }));

    return NextResponse.json({ locations });
  } catch (err) {
    return NextResponse.json({ error: 'Failed to fetch locations' }, { status: 500 });
  }
}
