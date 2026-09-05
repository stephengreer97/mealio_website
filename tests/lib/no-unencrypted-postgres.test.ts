// MEAL-216. Nothing may open a Postgres connection without demanding TLS.
//
// Supabase accepts unencrypted connections to the database unless the project
// is told not to, and the toggle (Database -> Settings -> Enforce SSL) is off by
// default. Turning it on is a dashboard action; this is the half that can be
// enforced from here.
//
// THE POINT IS NOT TODAY'S RISK, WHICH IS NEARLY NONE. The app and the website
// reach Postgres through supabase-js, which talks to PostgREST over HTTPS. This
// setting does not touch that path. What it covers is DIRECT connections — psql,
// a GUI client, a pooler, a background job reaching for `pg` because it wants a
// transaction — and there are none. So the risk is not a connection we are
// making; it is that nothing stops one, and the first one will be written by
// someone who is thinking about the query rather than the transport.
//
// A test rather than a comment, because the failure is silent: an unencrypted
// connection works perfectly.
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const SKIP = new Set(['node_modules', '.next', '.git', 'coverage', 'dist', '.vercel']);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Ways of reaching Postgres directly, rather than through PostgREST. */
const DIRECT_CLIENT = /\bfrom\s+['"]pg['"]|require\(['"]pg['"]\)|new\s+Pool\s*\(|new\s+Client\s*\(|postgres:\/\/|postgresql:\/\//;

/** What makes such a connection demand TLS. */
const DEMANDS_TLS = /sslmode=require|sslmode=verify|ssl\s*:\s*(true|\{)/;

describe('nothing connects to Postgres unencrypted', () => {
  const files = sourceFiles(ROOT).filter((f) => !f.includes(`${path.sep}tests${path.sep}`));

  it('has files to scan, so a broken walk cannot pass everything', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('finds no direct Postgres client without an SSL demand', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      src.split('\n').forEach((line, i) => {
        // Comments describe this rule in several places, including the
        // migration that ships with the ticket. They are prose, not a
        // connection.
        if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) return;
        if (!DIRECT_CLIENT.test(line)) return;
        // The whole file gets to answer, not just the line: the options object
        // that carries `ssl` is usually a few lines below the constructor.
        if (DEMANDS_TLS.test(src)) return;
        offenders.push(`${path.relative(ROOT, f)}:${i + 1}  ${line.trim().slice(0, 70)}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('has a scanner that actually recognises a Postgres client', () => {
    // THE GUARD ABOVE IS VACUOUS TODAY -- there are no direct Postgres clients
    // at all, so it passes over an empty set, and it would go on passing if the
    // regex were broken. That is the failure mode worth guarding: a tripwire
    // nobody has stepped on is indistinguishable from one that is not armed.
    //
    // The first version of this test asserted "no direct client exists", which
    // meant it also failed the day someone added a CORRECT one -- punishing the
    // right answer. What matters is that the scanner works, so that is what is
    // checked.
    const armed = [
      "import { Pool } from 'pg';",
      "const { Client } = require('pg')",
      "const pool = new Pool({ connectionString: url })",
      "postgresql://user:pw@host:5432/db",
    ];
    for (const sample of armed) expect(DIRECT_CLIENT.test(sample)).toBe(true);

    // ...and that an SSL demand is recognised in each form we would write it.
    for (const sample of ['?sslmode=require', 'ssl: true', 'ssl: { rejectUnauthorized: true }']) {
      expect(DEMANDS_TLS.test(sample)).toBe(true);
    }
    expect(DEMANDS_TLS.test('const ssl = false')).toBe(false);
  });
});
