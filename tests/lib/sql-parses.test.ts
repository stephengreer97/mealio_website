// Every .sql file in this repo must actually parse as Postgres.
//
// WHY THIS EXISTS: I handed Stephen a migration with `PRIMARY KEY (day, ...,
// coalesce(rail, ''), ...)` in it. Postgres allows expressions in an INDEX and
// only bare column names in a PRIMARY KEY, so it failed on his first attempt to
// run it — a syntax error that a parser catches in milliseconds and that
// reading had already missed twice.
//
// There is no Postgres server on this box (only the client) and no Docker, so
// nothing could execute the file. `pglast` wraps libpg_query — the real
// Postgres grammar — so it catches exactly this class without a database.
//
// WHAT THIS DOES NOT DO, said plainly so nobody trusts it further than it goes:
// it proves the SQL is well-FORMED, not that it is correct. A migration that
// parses can still reference a column that does not exist, deadlock, or destroy
// data. It closes the cheapest failure, not the worst one.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const SUPABASE = path.join(ROOT, 'supabase');
const VENV = '/tmp/claude-1000/-home-sgreer-mealio-app/51938f1f-f69d-4a0f-b144-0e4ac1c3d9a7/scratchpad/venv/bin/python';

function sqlFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) sqlFiles(full, out);
    else if (e.name.endsWith('.sql')) out.push(full);
  }
  return out;
}

/** pglast is not a repo dependency; skip rather than fail where it is absent. */
const haveParser = fs.existsSync(VENV) && (() => {
  try {
    execFileSync(VENV, ['-c', 'import pglast'], { stdio: 'ignore' });
    return true;
  } catch { return false; }
})();

describe('every .sql file parses as Postgres', () => {
  const files = sqlFiles(SUPABASE);

  it('found the SQL, so a broken walk cannot pass everything', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  (haveParser ? it.each(files.map((f) => path.relative(ROOT, f))) : it.skip.each(
    files.map((f) => path.relative(ROOT, f))))('%s', (rel) => {
      const script = `
import sys, pglast
sql = open(sys.argv[1]).read()
try:
    pglast.parse_sql(sql)
    print("OK")
except pglast.parser.ParseError as e:
    loc = getattr(e, "location", None)
    line = sql[:loc].count("\\n") + 1 if isinstance(loc, int) else "?"
    print(f"FAIL line {line}: {e}")
`;
      const out = execFileSync(VENV, ['-c', script, path.join(ROOT, rel)], { encoding: 'utf8' }).trim();
      expect(`${rel}: ${out}`).toBe(`${rel}: OK`);
    });

  it('says when it is not actually running', () => {
    // A skipped suite that looks green is the same lie as a vacuous assertion.
    // If this ever fails, the parser is missing and the checks above did
    // nothing — reinstall with: python3 -m venv <venv> && <venv>/bin/pip install pglast
    expect(haveParser ? 'parser present' : 'PARSER MISSING — the SQL checks above did not run')
      .toBe('parser present');
  });
});
