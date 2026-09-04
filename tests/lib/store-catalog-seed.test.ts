import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * The MEAL-23 seed, checked against itself.
 *
 * Stephen pastes this migration into the Supabase SQL editor by hand, so a row
 * that violates one of the table's own constraints does not fail in CI — it
 * fails halfway through a manual paste, with some of the catalog written and
 * some not. These assertions are cheap and catch the whole class before it gets
 * there.
 *
 * They deliberately do NOT read mealio_app's `src/constants/stores.ts`: that
 * repository is not checked out in this one's CI, so a test that reached across
 * would pass vacuously (or not run) exactly where it was needed. The
 * id/name/colour transcription was verified against that file at authoring time;
 * what is guarded here is everything the SQL can be judged on alone.
 */

const SQL = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260808000001_store_catalog.sql'),
  'utf8',
);

/**
 * Store ids REMOVED by a later migration.
 *
 * The seed is history — it records what the catalog was on 2026-08-08 and must
 * not be rewritten, or the file and a database built from it stop agreeing. The
 * invariant that matters is not "the seed matches the app" but "what the
 * database ENDS UP with matches the app", so removals are read from the
 * migrations that perform them and subtracted here.
 *
 * Read from the SQL rather than listed, so removing a store is one migration
 * and not also an edit to this file.
 */
function removedIds(): Set<string> {
  const out = new Set<string>();
  const dir = join(process.cwd(), 'supabase/migrations');
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith('.sql') || f.startsWith('20260808000001')) continue;
    const sql = readFileSync(join(dir, f), 'utf8');
    for (const m of sql.matchAll(/DELETE\s+FROM\s+stores\s+WHERE\s+id\s*=\s*'([^']+)'/gi)) {
      out.add(m[1]);
    }
  }
  return out;
}

type Seeded = {
  id: string; name: string; color: string; slug: string;
  bannerGroup: string; platform: string; host: string;
};

/** The seed MINUS anything a later migration deletes — i.e. the live catalog. */
function catalogRows(): Seeded[] {
  const gone = removedIds();
  return seededRows().filter((r) => !gone.has(r.id));
}

function seededRows(): Seeded[] {
  const block = SQL.split('host) VALUES')[1]?.split('ON CONFLICT')[0];
  if (!block) throw new Error('could not find the seed INSERT in the migration');
  const row = /\('([^']*)',\s*'((?:[^']|'')*)',\s*'((?:[^']|'')*)',\s*'((?:[^']|'')*)',\s*'((?:[^']|'')*)',\s*'((?:[^']|'')*)',\s*'((?:[^']|'')*)'\)/g;
  const out: Seeded[] = [];
  for (const m of block.matchAll(row)) {
    const [, id, name, color, slug, bannerGroup, platform, host] = m;
    // Postgres escapes a literal apostrophe by doubling it.
    out.push({ id, name: name.replace(/''/g, "'"), color, slug, bannerGroup, platform, host });
  }
  return out;
}

/**
 * The app's bundled list, pinned.
 *
 * Transcribed from mealio_app `src/constants/stores.ts` at authoring time and
 * verified against it character-for-character by script — an id that disagrees
 * silently unlists a store and a colour that disagrees is visible on the tile,
 * and neither shows up as a test failure anywhere else.
 *
 * What this buys and what it does not: because both sides were written from the
 * same reading, it cannot catch a transcription error made in that one sitting.
 * It catches DRIFT, which is the live risk — an edit to the migration, or the
 * two lists diverging as stores are added. When a store is genuinely added to
 * the seed, this table is meant to be updated in the same commit.
 */
const BUNDLED: Array<[id: string, name: string, color: string]> = [
  ['acme', 'Acme Markets', '#F04035'],
  ['albertsons', 'Albertsons', '#009ee5'],
  ['aldi', 'ALDI', '#02205F'],
  ['bakers', "Baker's", '#EE3124'],
  ['balduccis', "Balducci's", '#8D2B1E'],
  ['carrs', 'Carrs', '#E5171D'],
  ['city_market', 'City Market', '#EE3124'],
  ['dillons', 'Dillons', '#CA2128'],
  ['fred_meyer', 'Fred Meyer', '#D7282F'],
  ['frys', "Fry's Food", '#E1251B'],
  ['haggen', 'Haggen', '#025635'],
  ['harris_teeter', 'Harris Teeter', '#A32036'],
  ['heb', 'H-E-B', '#dd0031'],
  ['jewel_osco', 'Jewel-Osco', '#E12C47'],
  ['king_soopers', 'King Soopers', '#005DAA'],
  ['kings', 'Kings Food Markets', '#417EC0'],
  ['kroger', 'Kroger', '#0E51A1'],
  ['marianos', "Mariano's", '#64433D'],
  ['metro_market', 'Metro Market', '#63463E'],
  ['pavilions', 'Pavilions', '#2D2B29'],
  ['pay_less', 'Pay-Less', '#D8232A'],
  ['pick_n_save', "Pick 'n Save", '#243444'],
  ['qfc', 'QFC', '#006BB6'],
  ['ralphs', 'Ralphs', '#EA0029'],
  ['randalls', 'Randalls', '#02365E'],
  ['safeway', 'Safeway', '#E5161E'],
  ['shaws', "Shaw's", '#F48424'],
  ['smiths', "Smith's Food & Drug", '#D51E48'],
  ['star_market', 'Star Market', '#7AC142'],
  ['tom_thumb', 'Tom Thumb', '#0435A6'],
  ['united', 'United Supermarkets', '#003087'],
  ['vons', 'Vons', '#E41720'],
  ['walmart', 'Walmart', '#0053E2'],
  ['wegmans', 'Wegmans', '#000000'],
];

describe('the store catalog seed', () => {
  // The LIVE catalog: the seed minus anything a later migration removes. The
  // seed itself is history and is checked on its own below.
  const rows = catalogRows();

  it('still seeds every row it always did, removals included', () => {
    // The seed is not to be rewritten when a store leaves — a database built
    // from scratch runs it and then runs the removal, which is self-consistent.
    // This is what stops someone "tidying" the row out of it.
    expect(seededRows().length).toBeGreaterThanOrEqual(rows.length);
    expect(seededRows().map((r) => r.id)).toContain('amazon');
  });

  it('matches the app\'s bundled list exactly, id for id and colour for colour', () => {
    // Case-sensitive on the colour: the app writes `#dd0031` for H-E-B and
    // `#D7282F` for Fred Meyer, and a normalising comparison would let the seed
    // drift from the literal the app ships.
    expect(rows.map((r) => [r.id, r.name, r.color])).toEqual(BUNDLED);
  });

  it('leaves the 34 stores the app ships today', () => {
    // Thirty-four: the seed's 35 minus Amazon Fresh, removed on 2026-09-04
    // because it was the last store with no network rail and could not be added
    // to at all. Not thirty-five, and not thirty-six either — `mockstore` is
    // pushed by the app conditionally under MOCK_STORE_ENABLED and has never
    // had a row here. See the mockstore assertion below.
    expect(rows).toHaveLength(34);
    expect(seededRows()).toHaveLength(35);
  });

  it('parsed real rows, so none of the checks below can pass vacuously', () => {
    expect(rows.map((r) => r.id)).toContain('heb');
    expect(rows.find((r) => r.id === 'heb')?.name).toBe('H-E-B');
    expect(rows.find((r) => r.id === 'smiths')?.name).toBe("Smith's Food & Drug");
  });

  it('does not seed mockstore', () => {
    // Dev/e2e only. The app appends it itself under MOCK_STORE_ENABLED, and a
    // row here would put "Mock Store" in every production store picker.
    expect(rows.map((r) => r.id)).not.toContain('mockstore');
  });

  it('gives every row a unique id and a unique slug', () => {
    // The PK and `stores_slug_key` both abort the whole INSERT on a collision.
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    expect(new Set(rows.map((r) => r.slug)).size).toBe(rows.length);
  });

  it('satisfies stores_id_format_check', () => {
    for (const r of rows) expect(r.id, r.id).toMatch(/^[a-z0-9_]+$/);
  });

  it('satisfies stores_slug_format_check, and derives the slug from the id', () => {
    for (const r of rows) {
      expect(r.slug, r.id).toMatch(/^[a-z0-9-]+$/);
      expect(r.slug, r.id).toBe(r.id.replace(/_/g, '-'));
    }
  });

  it('satisfies stores_color_format_check', () => {
    // A colour the endpoint would drop must not be writable in the first place.
    for (const r of rows) expect(r.color, r.id).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  it('satisfies stores_name_not_blank_check', () => {
    for (const r of rows) expect(r.name.trim(), r.id).not.toBe('');
  });

  it('gives every row a bare hostname — no scheme, no path, no www', () => {
    for (const r of rows) expect(r.host, r.id).toMatch(/^[a-z0-9.-]+\.[a-z]{2,}$/);
  });

  it('keeps united on the storefront host, not the marketing one', () => {
    // MEAL-136: unitedsupermarkets.com 301s to the storefront DISCARDING the
    // path, so every URL built from it lands on a marketing home page and
    // nothing fails loudly.
    expect(rows.find((r) => r.id === 'united')?.host).toBe('shopunitedsupermarkets.com');
  });

  it('spells the storefront-stack column consistently across the seed', () => {
    // A spelling check on a column nobody dispatches on, and the name says so
    // deliberately. `platform` is NOT served by GET /api/stores — it
    // reconstructs KROGER_BRAND_IDS exactly, so it stays off the wire — and it
    // exists for humans reading the table and for ops queries. Naming this test
    // after adapters or support, as an earlier version did, is exactly how the
    // column starts being read as a capability claim again.
    const spellings = new Set(['kroger', 'albertsons', 'instacart', 'heb', 'walmart', 'wegmans']);
    for (const r of rows) expect(spellings.has(r.platform), `${r.id}: ${r.platform}`).toBe(true);
  });

  it('leaves serving_area unset, because there is no source to transcribe it from', () => {
    // Every other seeded value comes out of the codebase. Region strings do not,
    // and 35 half-remembered ones rendered as authoritative subtitles is worse
    // than an absent field. Filled by a plain UPDATE once someone checks them.
    expect(SQL).toContain('host) VALUES');
    expect(SQL.split('host) VALUES')[1].split('ON CONFLICT')[0]).not.toMatch(/serving/i);
  });
});

/**
 * The migration with its whole-line `--` comments removed.
 *
 * Structural assertions must count STATEMENTS, not prose. This file explains
 * itself heavily and the header note "Postgres has no ADD CONSTRAINT IF NOT
 * EXISTS…" is itself an `ADD CONSTRAINT` match — counting it made the guard
 * check disagree with reality by exactly one.
 */
const CODE = SQL.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');

describe('the store catalog migration', () => {
  it('is re-runnable: every object is guarded', () => {
    // It is pasted by hand. A migration that fails halfway leaves the catalog
    // half-written, which is the worst outcome available here.
    expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS stores\b/);
    expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS store_catalog_version\b/);
    expect(SQL).toMatch(/ON CONFLICT \(id\) DO NOTHING/);
    for (const trigger of ['stores_bump_catalog_version', 'set_stores_updated_at']) {
      expect(SQL, trigger).toContain(`DROP TRIGGER IF EXISTS ${trigger} ON stores;`);
    }
    // Postgres has no ADD CONSTRAINT IF NOT EXISTS; each one needs its own guard.
    const added = CODE.match(/ADD CONSTRAINT/g) ?? [];
    const guards = CODE.match(/EXCEPTION WHEN duplicate_object THEN NULL/g) ?? [];
    expect(added.length).toBeGreaterThan(0);
    expect(guards.length).toBe(added.length);
  });

  it('bumps the version once per statement, not once per row', () => {
    // FOR EACH ROW would make seeding 35 stores 35 catalog changes.
    expect(CODE).toMatch(/AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON stores\s+FOR EACH STATEMENT/);
  });

  it('bumps the version on DELETE, which is why it cannot go backwards', () => {
    // The reason this is a counter and not max(updated_at): deleting the
    // newest-updated row would make that fall back to an earlier value, and a
    // client that already applied the higher version refuses the correction.
    expect(SQL).toMatch(/DELETE OR TRUNCATE ON stores/);
    expect(SQL).toMatch(/SET version = version \+ 1/);
  });
});
