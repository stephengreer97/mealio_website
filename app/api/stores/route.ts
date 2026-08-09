import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { fetchAllPages } from '@/lib/paged-select';
import { log } from '@/lib/logger';

// GET /api/stores — the store catalog (MEAL-23)
//
//   { version: number, stores: StoreCatalogEntry[], updatedAt: string | null }
//
// The mobile app's `src/constants/stores.ts` is a hardcoded list, so adding a
// store used to need a release. This serves the same DISPLAY data from the
// database; the app fetches it, caches it, and falls back to its bundled list
// when offline or on a cold start that beats the network.
//
// DISPLAY DATA ONLY. Nothing here says a store can be automated. Whether this
// build can add to a store's cart is answered by KROGER_BRAND_IDS and
// WEBVIEW_STORE_IDS in the app, because those sets assert "this binary contains
// automation code for this store" and no database row can make that true.
//
// WHY `platform` AND `banner_group` ARE COLUMNS BUT NOT FIELDS
//
// Both are on the `stores` table — they are useful to a human reading the table
// and to ops queries — and neither is on the wire.
//
// The test to apply is NOT "can a client reconstruct today's capability sets
// from this payload?" Plenty of fields correlate with capability on 35 seeded
// rows; correlation on a fixed table is cheap and proves little. The test is:
// DOES THE PAYLOAD CARRY A RULE THAT GENERALIZES TO ROWS THE BINARY HAS NEVER
// SEEN? A field fails it when a client can apply it to a brand-new row and get
// an answer about automation — because that is precisely the answer only the
// binary holds, and the row is exactly what this endpoint makes cheap to add.
//
// `platform` fails that test. It reads as the rule "this is the stack we drive",
// so a client would apply it to the next row bearing a familiar value and
// conclude the build can drive it. Nothing about a database row makes that true.
//
// Measured on the seed, so the correlation is stated accurately rather than
// overstated: `platform = 'kroger'` is EXACTLY `KROGER_BRAND_IDS` (set equality,
// empty symmetric difference), and `banner_group = 'Kroger'` partitions
// identically. The complement is `WEBVIEW_STORE_IDS` MINUS `mockstore` — the
// dev/test store has no row here and never will, so the two are equal on all 35
// rows and unequal as sets. That off-by-one is worth stating exactly, because
// "reconstructs it perfectly" is the kind of claim that gets a field served once
// someone finds the counterexample and concludes the warning was overblown.
//
// Note what `platform` is NOT evidence of: `aldi` is `platform = 'instacart'`,
// is in `WEBVIEW_STORE_IDS`, and its adapter (`src/lib/webview-scripts/
// instacart.ts`) ships today. So a value's presence here says nothing either way
// about whether a build can drive it — which is the point. The next Instacart
// banner added as a row will carry the same value as ALDI and have no adapter,
// and a client reading the field could not tell those two rows apart.
//
// Neither field is used by any client today. Add one back when something
// concrete needs it, as one line here plus one in `toEntry`.
//
// PUBLIC, unlike /api/automation/config. That endpoint is authenticated because
// it publishes our store selectors; this one publishes brand names, tile colours
// and hostnames you can read off the stores' own websites. Making it public
// buys two things: the public shared-meal page (`/meal/[token]`) renders a store
// picker for visitors who have no account, and the app can populate its picker
// before it has a token, which removes an ordering hazard at cold start.
//
// Supports conditional GET: send If-None-Match and get a 304 when unchanged.

export const dynamic = 'force-dynamic';

/** One catalog row as the client sees it. Only `id`/`name`/`color`/`slug` are
 *  guaranteed present; the rest are nullable and a client must render without
 *  them. */
export type StoreCatalogEntry = {
  id: string;
  name: string;
  /** `#RRGGBB`. */
  color: string;
  slug: string;
  /** Storefront hostname, no scheme, no `www.`. */
  host: string | null;
  servingArea: string | null;
};

type StoreRow = {
  id: unknown;
  name: unknown;
  color: unknown;
  slug: unknown;
  host: unknown;
  serving_area: unknown;
};

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

const text = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v : null;

/**
 * A row the app can actually render, or null.
 *
 * The database rejects a blank name and a malformed colour outright, so this is
 * defence in depth for the ways a row could still arrive wrong — a column added
 * nullable later, a row written before a constraint existed, a hand-edit in the
 * SQL editor.
 *
 * OMIT, not reject and not serve. Serving a row with no colour puts an invisible
 * tap target in the picker and one with no name puts an unnamed one — visibly
 * broken, and worse than the store simply not being offered. Rejecting the whole
 * response over one bad row would take all 35 good stores down with it, which is
 * the failure this endpoint least wants: no catalog means no store picker.
 *
 * Duplicate ids are not checked here because they cannot occur: `id` is the
 * primary key.
 */
function toEntry(row: StoreRow): StoreCatalogEntry | null {
  const id = text(row.id);
  const name = text(row.name);
  const slug = text(row.slug);
  const color = typeof row.color === 'string' && COLOR_RE.test(row.color) ? row.color : null;
  if (!id || !name || !slug || !color) return null;
  return {
    id,
    name,
    color,
    slug,
    host: text(row.host),
    servingArea: text(row.serving_area),
  };
}

export async function GET(request: NextRequest) {
  const supabase = createServerSupabaseClient();

  // The version is read BEFORE the rows, and the order is load-bearing.
  //
  // A write that commits between the two reads gives the client rows from V+1
  // labelled V. It caches them, then the next fetch reports V+1, and the client
  // re-fetches and converges. Reading the rows first inverts that: rows from V
  // labelled V+1, which the client caches and then REFUSES to replace when the
  // real V+1 arrives, because its own rule is that a version must not go
  // backwards. Under-labelling self-corrects; over-labelling never does.
  const { data: meta, error: metaError } = await supabase
    .from('store_catalog_version')
    .select('version, updated_at')
    .eq('id', 1)
    .maybeSingle();

  if (metaError) {
    log({ event: 'STORES:CATALOG', status: 'error', error: metaError });
    return NextResponse.json({ error: 'Failed to load store catalog' }, { status: 500 });
  }

  // No version row means the migration has not been run (or was half-applied).
  // Serving the rows anyway would mean inventing a version, and a made-up
  // version is exactly what the client's monotonic rule cannot survive.
  if (!meta || typeof meta.version !== 'number') {
    log({ event: 'STORES:CATALOG', status: 'failed', reason: 'no version row' });
    return NextResponse.json({ error: 'Store catalog unavailable' }, { status: 503 });
  }

  const version = meta.version;
  const etag = `"store-catalog-v${version}"`;

  // The common case — a cold start against an unchanged catalog — costs no body
  // and, because the version alone identifies the payload, no row read either.
  if (request.headers.get('if-none-match') === etag) {
    return new NextResponse(null, { status: 304, headers: { ETag: etag } });
  }

  // Paged rather than bounded. Thirty-five rows is three orders of magnitude
  // short of `db-max-rows`, but an unbounded select stops being correct the
  // moment the catalog grows past 1000 and says nothing when it does — and the
  // symptom would be stores silently missing from the picker, which is the exact
  // bug MEAL-127/128/129/130 keep producing. One page today, still correct at
  // any size. `.order('id')` is on the primary key, so the walk is total and
  // deterministic and cannot repeat or skip a row between pages.
  const read = await fetchAllPages<StoreRow>((from, to) =>
    supabase
      .from('stores')
      // `platform` and `banner_group` are deliberately NOT selected — see the
      // header. Not selecting them means there is no path from the column to the
      // response at all, rather than a mapping someone can re-enable by reflex.
      .select('id, name, color, slug, host, serving_area')
      .eq('is_listed', true)
      .order('id', { ascending: true })
      .range(from, to));

  if (read.error) {
    log({ event: 'STORES:CATALOG', status: 'error', error: read.error });
    return NextResponse.json({ error: 'Failed to load store catalog' }, { status: 500 });
  }

  // A partial read must never be served as a catalog. The client REPLACES its
  // list with this, so a truncated answer unlists real stores with nothing on
  // screen to say why — and a client that fell back to its bundled list instead
  // would be strictly better off. Fail, and let it do that.
  if (!read.complete) {
    log({ event: 'STORES:CATALOG', status: 'error', reason: 'incomplete paged read' });
    return NextResponse.json({ error: 'Failed to load store catalog' }, { status: 500 });
  }

  const stores: StoreCatalogEntry[] = [];
  let dropped = 0;
  for (const row of read.rows) {
    const entry = toEntry(row);
    if (entry) stores.push(entry);
    else dropped++;
  }
  if (dropped > 0) {
    log({ event: 'STORES:CATALOG', status: 'failed', reason: `${dropped} malformed row(s) omitted` });
  }

  // An empty catalog is never a success. If it were a 200 the app would have to
  // carry its own "an empty list is not an answer" rule, and any client that
  // forgot it would render an empty store picker — unusable, and indistinguishable
  // to the user from the app being broken. A 5xx puts every client on its bundled
  // list instead, which is complete by construction.
  if (stores.length === 0) {
    log({ event: 'STORES:CATALOG', status: 'failed', reason: 'catalog is empty' });
    return NextResponse.json({ error: 'Store catalog unavailable' }, { status: 503 });
  }

  return NextResponse.json(
    { version, stores, updatedAt: meta.updated_at ?? null },
    {
      headers: {
        ETag: etag,
        // Public: no per-user variation in this payload at all. A new store
        // should reach clients in minutes rather than hours, and the
        // stale-while-revalidate window keeps a cold-start stampede off the DB.
        'Cache-Control': 'public, max-age=300, stale-while-revalidate=3600',
      },
    },
  );
}
