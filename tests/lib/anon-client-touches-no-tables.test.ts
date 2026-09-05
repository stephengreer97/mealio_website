// The anon client may sign people in. It may not read tables.
//
// This is what makes RLS safe to turn on. Enabling RLS with no policies denies
// the anonymous role, and that is harmless ONLY because every table read in
// this codebase goes through the service-role client, which bypasses RLS. The
// moment one route reads a table with `createAnonSupabaseClient()`, enabling
// RLS on that table breaks it silently — and silently is the word: RLS does not
// error, it returns FEWER ROWS.
//
// That failure has already happened here once, in a shape worth remembering:
// `get_preset_meals_with_trending` LEFT JOINs creators and preset_meal_saves.
// Called as anon, with those tables locked, it still returns all 318 rows — the
// same COUNT — but every creator_name is null and every trending_score is 0,
// and the ordering changes. A row count is not evidence. `get_featured_creators`
// carries the scar tissue: it is `SECURITY DEFINER` and its comment says so.
//
// So the rule is enforced rather than remembered.
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const SKIP = new Set(['node_modules', '.next', '.git', 'coverage', 'dist', '.vercel', 'tests']);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(full);
  }
  return out;
}

const files = sourceFiles(ROOT);

/**
 * Assigned names for an anon client, so `const anonClient = createAnon...()`
 * is followed rather than only the direct call.
 */
function anonBindings(src: string): string[] {
  const names = ['createAnonSupabaseClient()'];
  for (const m of src.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*createAnonSupabaseClient\(\)/g)) {
    names.push(m[1]);
  }
  return names;
}

describe('the anon Supabase client never reads a table', () => {
  it('has files to scan, and finds the anon client at all', () => {
    // Both halves matter: a broken walk, or a renamed factory, would make every
    // assertion below pass over nothing.
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => fs.readFileSync(f, 'utf8').includes('createAnonSupabaseClient'))).toBe(true);
  });

  it('uses it only for auth, never for .from()', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      if (!src.includes('createAnonSupabaseClient')) continue;
      for (const name of anonBindings(src)) {
        // `anonClient.from('x')` — a table read on the anon client.
        const re = new RegExp(`${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*\\n?\\s*\\.from\\(`, 'g');
        if (re.test(src)) offenders.push(`${path.relative(ROOT, f)} — ${name}.from(...)`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('recognises a table read when it sees one', () => {
    // The scanner has to actually match, or the test above is decoration. A
    // guard nobody has tripped is indistinguishable from one that is not armed.
    const sample = `
      const anonClient = createAnonSupabaseClient();
      const { data } = await anonClient.from('user_profiles').select('*');
    `;
    const names = anonBindings(sample);
    expect(names).toContain('anonClient');
    expect(new RegExp(`anonClient\\s*\\n?\\s*\\.from\\(`).test(sample)).toBe(true);
  });
});
