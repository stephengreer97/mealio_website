// Every table ships with RLS on, or is named here with a reason.
//
// MEASURED 2026-09-05: seven tables were readable AND writable by the public
// anon key — the one that ships in mealio.co's JavaScript bundle. Two of them
// mattered a great deal: app_settings holds the broadcast list every app
// renders, and automation_config is the remote config the app fetches and
// obeys.
//
// The failure was not a decision anyone made. It is what happens by default:
// `CREATE TABLE` leaves RLS off, Supabase grants the anon role access to the
// public schema, and nothing in the repository noticed. The dashboard warned;
// a warning outside the codebase is a warning nobody is measured against.
//
// So the rule is enforced here, at the only moment it is cheap: a table added
// to a migration without an ENABLE ROW LEVEL SECURITY line fails this test on
// the day it is written, not months later when someone reads a dashboard.
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SUPABASE = path.resolve(__dirname, '../../supabase');

function sqlFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) sqlFiles(full, out);
    else if (e.name.endsWith('.sql')) out.push(full);
  }
  return out;
}

const sql = sqlFiles(SUPABASE).map((f) => fs.readFileSync(f, 'utf8')).join('\n');

/** Tables created anywhere in supabase/. */
function declaredTables(): string[] {
  const out = new Set<string>();
  for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi)) {
    out.add(m[1].toLowerCase());
  }
  return [...out].sort();
}

/** Tables the migrations turn RLS on for. */
function rlsEnabled(): Set<string> {
  const out = new Set<string>();
  for (const m of sql.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s+enable\s+row\s+level\s+security/gi)) {
    out.add(m[1].toLowerCase());
  }
  return out;
}

/**
 * Tables created BEFORE this repository kept migrations.
 *
 * user_profiles, meals and preset_meals were made in the dashboard and have no
 * CREATE TABLE here, so this test cannot see them. All three were checked by
 * hand against production on 2026-09-05: user_profiles and meals are locked
 * (RLS on, no policy — anon gets an empty set), and preset_meals is RLS-on with
 * a SELECT policy, which is deliberate: the Discover catalogue is public and an
 * anonymous INSERT is correctly refused.
 *
 * Listed rather than ignored, because "the test does not cover it" and "it is
 * fine" are different statements and only one of them is true here.
 */
const CREATED_OUTSIDE_MIGRATIONS = ['user_profiles', 'meals', 'preset_meals'];

describe('RLS is on for every table this repository creates', () => {
  const tables = declaredTables();
  const enabled = rlsEnabled();

  it('found the tables and the RLS statements, so a broken scan cannot pass', () => {
    // Both regexes have to be working. A test that reads nothing passes
    // everything, which is precisely how this went unnoticed for months.
    expect(tables.length).toBeGreaterThan(15);
    expect(enabled.size).toBeGreaterThan(10);
  });

  it.each(declaredTables())('%s has RLS enabled', (table) => {
    expect(`${table}: ${enabled.has(table) ? 'rls on' : 'RLS OFF'}`).toBe(`${table}: rls on`);
  });

  it('keeps the outside-migrations list honest', () => {
    // If one of these ever gains a CREATE TABLE here, it stops needing an
    // exemption and the note above stops being true.
    for (const t of CREATED_OUTSIDE_MIGRATIONS) expect(tables).not.toContain(t);
  });
});
