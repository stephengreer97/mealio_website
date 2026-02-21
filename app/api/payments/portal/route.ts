import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const token = extractTokenFromHeader(request.headers.get('authorization'));
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const decoded = await verifyAccessToken(token);
  if (!decoded) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createServerSupabaseClient();
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('lemonsqueezy_customer_id')
    .eq('id', decoded.userId)
    .single();

  if (!profile?.lemonsqueezy_customer_id) {
    // Account was manually granted paid tier (no LS subscription yet).
    // Send them to the general LS orders page where they can manage billing.
    return NextResponse.json({ portalUrl: 'https://app.lemonsqueezy.com/my-orders' });
  }

  const lsRes = await fetch(
    `https://api.lemonsqueezy.com/v1/customers/${profile.lemonsqueezy_customer_id}`,
    {
      headers: {
        Accept: 'application/vnd.api+json',
        Authorization: `Bearer ${process.env.LEMONSQUEEZY_API_KEY}`,
      },
    }
  );

  if (!lsRes.ok) {
    console.error('LS customer fetch failed:', lsRes.status, await lsRes.text());
    return NextResponse.json({ error: 'Failed to reach billing portal' }, { status: 502 });
  }

  const lsData = await lsRes.json();
  const portalUrl = lsData.data?.attributes?.urls?.customer_portal as string | undefined;

  if (!portalUrl) {
    return NextResponse.json({ error: 'Portal URL not available' }, { status: 502 });
  }

  return NextResponse.json({ portalUrl });
}
