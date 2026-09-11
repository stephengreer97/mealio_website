import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/requireAdmin';
import { walmartIoCall, WALMART_IO_PATHS, type WalmartIoPath } from '@/lib/walmart-io';

/**
 * TEMPORARY, admin-only. A window onto the Walmart IO affiliate API so its
 * feasibility can be measured from the runtime that holds the credentials.
 *
 * The key lives in Vercel as an encrypted variable and cannot be read back out,
 * which is correct and also means a local harness cannot sign anything. Rather
 * than move a private key onto a laptop to test with, the test runs where the
 * key already is.
 *
 * NOT a generic proxy: the path is chosen from a fixed set, so this cannot be
 * pointed at an arbitrary Walmart endpoint by whoever finds it. Admin-gated on
 * top of that. Delete it with the spike.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const params = request.nextUrl.searchParams;
  const path = (params.get('path') ?? 'taxonomy') as WalmartIoPath;
  if (!WALMART_IO_PATHS.includes(path)) {
    return NextResponse.json({ error: `path must be one of ${WALMART_IO_PATHS.join(', ')}` }, { status: 400 });
  }

  const query: Record<string, string> = {};
  for (const key of ['query', 'ids', 'upc', 'start', 'numItems', 'storeId', 'zipCode', 'facet', 'facet.filter', 'sort']) {
    const value = params.get(key);
    if (value) query[key] = value;
  }

  const result = await walmartIoCall(path, query);
  return NextResponse.json(result);
}
