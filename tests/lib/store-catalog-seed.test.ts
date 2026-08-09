import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
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

type Seeded = {
  id: string; name: string; color: string; slug: string;
  bannerGroup: string; platform: string; host: string;
};

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

describe('the store catalog seed', () => {
  const rows = seededRows();

  it('seeds the 35 stores the app ships today', () => {
    // Not 36. See the mockstore assertion below.
    expect(rows).toHaveLength(35);
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

  it('uses only platform values an adapter exists for', () => {
    // Descriptive lineage, not a capability claim — but a typo here would still
    // be a value nothing recognises.
    const known = new Set(['kroger', 'albertsons', 'instacart', 'heb', 'walmart', 'amazon', 'wegmans']);
    for (const r of rows) expect(known.has(r.platform), `${r.id}: ${r.platform}`).toBe(true);
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
