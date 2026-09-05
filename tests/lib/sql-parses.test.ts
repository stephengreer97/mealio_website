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
// Where the parser lives depends on the machine, so LOOK for it rather than
// hardcoding a path. This used to point at a session-scoped scratchpad venv,
// which meant the check evaporated the moment that directory went away -- and
// on CI, which never had it, it went red instead of running. Order: an explicit
// override, a repo-local venv, then whatever python3 is on PATH (how CI gets
// it, via `pip install pglast` in the workflow).
const CANDIDATES = [
  process.env.PGLAST_PYTHON,
  path.join(ROOT, '.venv-sql/bin/python'),
  'python3',
].filter((c): c is string => !!c);

function sqlFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) sqlFiles(full, out);
    else if (e.name.endsWith('.sql')) out.push(full);
  }
  return out;
}

/** The first candidate that can actually `import pglast`, or null. */
const PYTHON = CANDIDATES.find((py) => {
  try {
    execFileSync(py, ['-c', 'import pglast'], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}) ?? null;
const haveParser = PYTHON !== null;

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
      const out = execFileSync(PYTHON!, ['-c', script, path.join(ROOT, rel)], { encoding: 'utf8' }).trim();
      expect(`${rel}: ${out}`).toBe(`${rel}: OK`);
    });

  it('says when it is not actually running', () => {
    // A skipped suite that looks green is the same lie as a vacuous assertion,
    // so this FAILS rather than skips when no parser was found. Install one:
    //   python3 -m venv .venv-sql && .venv-sql/bin/pip install pglast
    // or `pip install pglast` for the python3 already on PATH, which is what
    // the Tests workflow does. PGLAST_PYTHON overrides the search.
    expect(haveParser ? 'parser present' : 'PARSER MISSING - the SQL checks above did not run')
      .toBe('parser present');
  });
});
