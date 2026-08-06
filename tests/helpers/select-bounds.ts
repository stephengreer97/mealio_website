import fs from 'fs';
import path from 'path';
import ts from 'typescript';

/**
 * Finds reads that ask PostgREST for "all the rows" and would silently get 1000.
 *
 * WHY THIS IS A STATIC CHECK AND NOT A TEST FIXTURE
 *
 * `tests/helpers/supabase-mock.ts` already models this ceiling exactly
 * (`DEFAULT_PAGE_ROWS`) and has modelled it correctly the whole time. Nine
 * instances of the bug shipped anyway — MEAL-112, MEAL-126, MEAL-127, MEAL-128,
 * MEAL-129, MEAL-131, MEAL-134, MEAL-135 and the funnel runs query — because the
 * mock only judges code a test actually drives through it, and most of these
 * reads had no such test. Every one was caught by a human reading code.
 *
 * So the gap was never knowledge, and another fixture would not have closed it.
 * What closes it is a check that reads *every* select in the repository whether
 * or not anyone wrote a test for it, and that is what this file does.
 *
 * WHY THE TYPESCRIPT AST AND NOT A REGEX OR AN ESLINT RULE
 *
 * A regex over single lines finds almost none of the nine. The real shapes are a
 * chain broken across seven lines, a builder held in a `let` and conditionally
 * narrowed a dozen lines further down, and an `await` in the middle. Those are
 * AST facts, not text facts.
 *
 * WHAT THIS DOES *NOT* COVER — READ BEFORE TRUSTING A GREEN RUN
 *
 * `.rpc()` is not checked, and set-returning RPCs are subject to the same
 * ceiling: PostgREST caps a function's result at `db-max-rows` exactly as it caps
 * a table read. `app/api/admin/storage/cleanup-orphans/route.ts` already says so
 * out loud and reports `objectListMaybeTruncated`, so this is a known property of
 * this codebase rather than a theory.
 *
 * The live exposure at the time of writing is `get_preset_meals_with_trending`,
 * which has no `LIMIT` in its SQL body (`supabase/update-trending-hot-algorithm
 * .sql`) and is read by `lib/trending-cache.ts` and `app/api/admin/meals/route
 * .ts` — so past 1000 published meals the Discover feed's trending scores, and
 * the min/max normalisation the creator portal derives from them, are computed
 * over a silent subset. `get_featured_creators` is fine (`LIMIT 8` in SQL) and
 * `increment_otp_attempts` returns a scalar.
 *
 * RPCs are excluded from the gate ON PURPOSE rather than by oversight. Bounding
 * that function properly means a SQL migration, which only a human can apply to
 * Supabase — so including RPCs here would make this check fail on day one against
 * code nobody could turn green, and a failing gate gets deleted or skipped, which
 * costs more than the coverage gains. Add RPCs to `VERBS` and to `judge()` in the
 * same change that lands the migration.
 *
 * ESLint would be the conventional home for this and is deliberately not used:
 * this repository has no ESLint at all — no config file, no `eslint` dependency,
 * and the `next lint` script in package.json is vestigial because Next 16 removed
 * that command. CI (`.github/workflows/test.yml`) runs exactly one thing, `npm
 * test`. A rule living in a linter nobody installs and CI never invokes is a rule
 * that does not run. `typescript` is already a devDependency, so the compiler's
 * own parser costs nothing to use and the check rides the runner that already
 * gates every pull request.
 */

/** Where production code lives. Tests are excluded: they are the fixtures. */
const ROOTS = ['app', 'lib', 'components'];
const ROOT_FILES = ['middleware.ts'];

/**
 * PostgREST's `db-max-rows` on Supabase, duplicated from the mock's
 * `DEFAULT_PAGE_ROWS` rather than imported.
 *
 * The mock is a test double and this is a static analyser; they share a number
 * but not a purpose, and importing vitest's `vi` (which the mock does at module
 * scope) into a plain file walker would be the wrong dependency direction.
 */
const MAX_ROWS = 1000;

/** The calls that decide what kind of statement a chain is. */
const VERBS = new Set(['select', 'insert', 'update', 'delete', 'upsert']);

/**
 * Receivers whose `.from()` is not a table.
 *
 * Kept as a belt-and-braces list only. The load-bearing filter is the verb
 * requirement below — `Buffer.from(x).toString()` has no `.select()` in its
 * chain, so it is excluded on structure rather than on a name that a local
 * variable could shadow.
 */
const NOT_A_CLIENT = new Set([
  'Buffer', 'Array', 'Object', 'String', 'Number', 'Date', 'Set', 'Map',
  'JSON', 'Promise', 'Uint8Array', 'Int8Array', 'Float64Array',
]);

/**
 * The opt-out. Greppable on purpose:
 *
 *   grep -rn 'unbounded-select-ok' app lib components
 *
 * A marker with no reason after the colon is itself a failure, so the token
 * cannot be pasted in to silence the check without saying why. The reason has to
 * be long enough to be a sentence rather than a shrug.
 */
const OPT_OUT_TOKEN = /unbounded-select-ok:/;
/**
 * The reason, captured separately from the token on purpose.
 *
 * Presence and justification are two different questions. Folding them into one
 * regex means a bare `// unbounded-select-ok:` fails to match at all, the marker
 * is never seen, and the select is reported as though nobody had tried to exempt
 * it — which hides the fact that someone reached for the opt-out and did not
 * finish the sentence. That is the one case where the author is definitely
 * looking at this code and is worth telling precisely what is wrong.
 */
const OPT_OUT_REASON = /unbounded-select-ok:[ \t]*([^\n]*)/;
const MIN_REASON_CHARS = 12;

export type Finding = {
  file: string;
  line: number;
  /** The chain as source text, trimmed — enough to identify it in a report. */
  snippet: string;
  table: string;
  /** Why it failed: no bound at all, a bound that does not bound, or a bare marker. */
  kind: 'unbounded' | 'ceiling-limit' | 'ceiling-range' | 'reason-missing';
  detail: string;
};

export type Exemption = { file: string; line: number; table: string; reason: string };

export type Report = { findings: Finding[]; exemptions: Exemption[]; selectsChecked: number };

function collectFiles(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      collectFiles(full, out);
      continue;
    }
    if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
}

/** The nearest enclosing statement — the unit an opt-out comment attaches to. */
function enclosingStatement(node: ts.Node): ts.Node {
  let current: ts.Node = node;
  while (current.parent && !ts.isStatement(current)) current = current.parent;
  return current;
}

/** The nearest enclosing function-ish body, for scoping a variable's uses. */
function enclosingBody(node: ts.Node): ts.Node {
  let current: ts.Node = node;
  while (current.parent) {
    if (
      ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current) ||
      ts.isArrowFunction(current) || ts.isFunctionExpression(current) ||
      ts.isSourceFile(current)
    ) return current;
    current = current.parent;
  }
  return current;
}

type Applied = { name: string; call: ts.CallExpression };

/**
 * Walks forward along one method chain from a `.from(...)` call.
 *
 * Steps through `await`, parentheses, `!` and `as T`, because all four appear
 * mid-chain in this repository and none of them ends a chain. Stops at the first
 * property access that is not itself called — `.data`, `.error` — which is where
 * the builder stops being a builder.
 */
function walkChain(start: ts.CallExpression): { applied: Applied[]; terminal: ts.Node } {
  const applied: Applied[] = [];
  let node: ts.Node = start;
  for (;;) {
    const parent: ts.Node | undefined = node.parent;
    if (!parent) break;
    if (
      ts.isAwaitExpression(parent) || ts.isParenthesizedExpression(parent) ||
      ts.isNonNullExpression(parent) || ts.isAsExpression(parent)
    ) {
      node = parent;
      continue;
    }
    if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
      const grand = parent.parent;
      if (grand && ts.isCallExpression(grand) && grand.expression === parent) {
        applied.push({ name: parent.name.text, call: grand });
        node = grand;
        continue;
      }
    }
    break;
  }
  return { applied, terminal: node };
}

/**
 * Methods applied to a builder that was parked in a variable.
 *
 * This is the shape a regex cannot see and the one the codebase actually uses:
 *
 *   let query = supabase.from('preset_meals').select(FIELDS);
 *   if (tag) query = query.contains('tags', [tag]);
 *   query = query.order('created_at').limit(pageSize);
 *
 * The `.limit()` that makes this read safe is nowhere near the `.from()`. So
 * every later mention of the identifier inside the same function body is scanned
 * and its methods folded into the chain. `escaped` records the case this cannot
 * reason about — the builder handed to something else — so the caller can decide
 * to report rather than silently pass it.
 */
function followVariable(
  terminal: ts.Node,
  sf: ts.SourceFile,
): { applied: Applied[]; escaped: boolean } {
  const applied: Applied[] = [];
  let escaped = false;

  const parent = terminal.parent;
  let name: string | undefined;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    name = parent.name.text;
  } else if (
    parent && ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isIdentifier(parent.left)
  ) {
    name = parent.left.text;
  }
  if (!name) return { applied, escaped };

  const scope = enclosingBody(terminal);
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === name && node !== (parent as any).name) {
      const up = node.parent;
      if (up && ts.isPropertyAccessExpression(up) && up.expression === node) {
        const grand = up.parent;
        if (grand && ts.isCallExpression(grand) && grand.expression === up) {
          applied.push({ name: up.name.text, call: grand });
          // A chain can continue past the variable: `query.order(...).limit(...)`.
          for (const step of walkChain(grand).applied) applied.push(step);
        }
        // `.data` / `.error` on the awaited result: not a builder method.
      } else if (up && ts.isCallExpression(up) && up.arguments.includes(node as ts.Expression)) {
        // Passed to a helper — the bound could be applied in there.
        escaped = true;
      } else if (up && ts.isReturnStatement(up)) {
        escaped = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(scope, visit);
  return { applied, escaped };
}

/**
 * The name of the builder-returning factory a chain is the body of, if it is one.
 *
 * `app/api/admin/storage/cleanup-orphans/route.ts` writes the shape this exists
 * for, and it is a good shape rather than a bad one:
 *
 *   const rowsWithPhotos = () =>
 *     supabase.from(table).select('photo_url').not('photo_url', 'is', null);
 *   …
 *   const { data } = await rowsWithPhotos().order('id').range(from, from + PAGE_ROWS - 1);
 *
 * The filter is written once so the count and the pages cannot drift apart, and
 * the bound belongs at the call site because each call is a different page. A
 * checker that cannot see through this reports the safest paging code in the
 * repository as a defect, which is how a checker gets deleted.
 */
function factoryName(terminal: ts.Node): { name: string; scope: ts.Node } | null {
  const parent = terminal.parent;
  if (!parent) return null;

  // `const f = () => <chain>` — a concise arrow body.
  if (ts.isArrowFunction(parent) && parent.body === terminal) {
    const decl = parent.parent;
    if (decl && ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name)) {
      return { name: decl.name.text, scope: enclosingBody(decl) };
    }
    return null;
  }

  // `return <chain>;` inside a named function or a function held in a const.
  if (ts.isReturnStatement(parent)) {
    const fn = enclosingBody(parent);
    if (ts.isFunctionDeclaration(fn) && fn.name) {
      return { name: fn.name.text, scope: fn.parent };
    }
    const decl = fn.parent;
    if (decl && ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name)) {
      return { name: decl.name.text, scope: enclosingBody(decl) };
    }
  }
  return null;
}

/** Every `name(...)` call in `scope`, with the chain hung off each one. */
function factoryCallSites(name: string, scope: ts.Node): Applied[][] {
  const sites: Applied[][] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
      node.expression.text === name
    ) {
      sites.push(walkChain(node).applied);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(scope, visit);
  return sites;
}

function numericArg(arg: ts.Expression | undefined): number | null {
  if (!arg) return null;
  if (ts.isNumericLiteral(arg)) return Number(arg.text);
  // `-1` and friends arrive as a prefix unary.
  if (
    ts.isPrefixUnaryExpression(arg) && arg.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(arg.operand)
  ) return -Number(arg.operand.text);
  return null;
}

/** Does `select(cols, { head: true, count })` ask for a count and no rows? */
function isHeadCount(call: ts.CallExpression): boolean {
  const options = call.arguments[1];
  if (!options || !ts.isObjectLiteralExpression(options)) return false;
  let head = false;
  let count = false;
  for (const prop of options.properties) {
    if (!ts.isPropertyAssignment(prop) || !prop.name) continue;
    const key = prop.name.getText();
    if (key === 'head' && prop.initializer.kind === ts.SyntaxKind.TrueKeyword) head = true;
    if (key === 'count') count = true;
  }
  return head && count;
}

export function analyseFile(file: string, text: string): Report {
  const sf = ts.createSourceFile(
    file, text, ts.ScriptTarget.Latest, /* setParentNodes */ true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const findings: Finding[] = [];
  const exemptions: Exemption[] = [];
  let selectsChecked = 0;

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'from'
    ) {
      const receiver = node.expression.expression;
      const receiverName = ts.isIdentifier(receiver) ? receiver.text : '';
      if (!NOT_A_CLIENT.has(receiverName)) {
        const direct = walkChain(node);
        const flow = followVariable(direct.terminal, sf);
        const applied = [...direct.applied, ...flow.applied];
        const names = applied.map((a) => a.name);

        // Structural client test: a supabase table chain always names a verb.
        // `storage.from('bucket').list()` and `Buffer.from(b).toString()` do not.
        const verb = names.find((n) => VERBS.has(n));
        if (verb === 'select') {
          // A `.select()` that FOLLOWS a write returns the rows just written, so
          // it is bounded by the payload, not by the table. Only a chain whose
          // first verb is `select` is a read of the table.
          selectsChecked++;
          const table = ts.isStringLiteralLike(node.arguments[0])
            ? (node.arguments[0] as ts.StringLiteral).text
            : node.arguments[0]?.getText(sf) ?? '?';
          const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

          const stmt = enclosingStatement(node);
          const leading = ts.getLeadingCommentRanges(text, stmt.getFullStart()) ?? [];
          const commentText = leading.map((r) => text.slice(r.pos, r.end)).join('\n');
          const inner = text.slice(stmt.getStart(sf), stmt.getEnd());
          const haystack = OPT_OUT_TOKEN.test(commentText) ? commentText
            : OPT_OUT_TOKEN.test(inner) ? inner : null;
          const marker = haystack ? OPT_OUT_REASON.exec(haystack) : null;

          let bound = judge(applied);

          // A builder this chain only BUILDS is bounded by whoever calls it. Every
          // call site has to bound it — one that forgets is the bug, and it is
          // reported against the factory because that is the line a reader of the
          // report needs to look at first.
          if (bound.kind !== 'ok') {
            const factory = factoryName(direct.terminal);
            if (factory) {
              const sites = factoryCallSites(factory.name, factory.scope);
              if (sites.length > 0) {
                const verdicts = sites.map((site) => judge([...applied, ...site]));
                bound = verdicts.every((v) => v.kind === 'ok')
                  ? { kind: 'ok', detail: `bounded at ${sites.length} call site(s) of ${factory.name}()` }
                  : verdicts.find((v) => v.kind !== 'ok')!;
              }
            }
          }

          if (marker) {
            const reason = marker[1].trim().replace(/\s*\*\/\s*$/, '').trim();
            if (reason.length < MIN_REASON_CHARS) {
              findings.push({
                file, line, table, kind: 'reason-missing',
                snippet: firstLine(inner),
                detail: `opt-out marker with no usable reason (${reason.length} chars)`,
              });
            } else {
              exemptions.push({ file, line, table, reason });
            }
          } else if (bound.kind !== 'ok') {
            findings.push({ file, line, table, kind: bound.kind, snippet: firstLine(inner), detail: bound.detail });
          } else if (flow.escaped && bound.kind === 'ok') {
            // Bounded, and the escape did not matter. Nothing to say.
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return { findings, exemptions, selectsChecked };
}

function firstLine(text: string): string {
  return text.split('\n')[0].trim().slice(0, 110);
}

/**
 * Decides whether the applied methods actually bound the number of rows.
 *
 * The interesting part is what is NOT accepted. `.limit(1000)` is exactly
 * `db-max-rows`, so it returns precisely what no limit at all returns and
 * changes nothing except that the read now looks deliberate — the "easy escape"
 * that would let this whole class of bug survive with a bound bolted on. Same for
 * a `.range()` window wider than the ceiling: `.range(0, 4999)` asks for 5000
 * rows and gets 1000, silently, which is the original bug with extra steps.
 *
 * A `.range()` of exactly the ceiling IS accepted, because that is the first page
 * of the repository's paging idiom (`.range(page * 1000, page * 1000 + 999)`) and
 * a page that size is a real page. The asymmetry with `.limit()` is the point: a
 * range says "this window of a longer list", a limit says "this is the answer".
 *
 * Non-literal arguments are accepted throughout. `.limit(pageSize)` cannot be
 * judged here and guessing would produce exactly the false positives that get a
 * check like this switched off.
 */
function judge(applied: Applied[]): { kind: Finding['kind'] | 'ok'; detail: string } {
  let sawCeilingLimit: string | null = null;
  let sawCeilingRange: string | null = null;

  for (const { name, call } of applied) {
    if (name === 'single' || name === 'maybeSingle') {
      return { kind: 'ok', detail: 'at most one row' };
    }
    if (name === 'select' && isHeadCount(call)) {
      return { kind: 'ok', detail: 'head + count returns no rows' };
    }
    if (name === 'limit') {
      const n = numericArg(call.arguments[0]);
      if (n === null) return { kind: 'ok', detail: 'limit with a computed value' };
      if (n < MAX_ROWS) return { kind: 'ok', detail: `limit(${n})` };
      sawCeilingLimit = `limit(${n}) is at or above db-max-rows (${MAX_ROWS}), so it bounds nothing`;
      continue;
    }
    if (name === 'range') {
      const from = numericArg(call.arguments[0]);
      const to = numericArg(call.arguments[1]);
      if (from === null || to === null) return { kind: 'ok', detail: 'range with computed bounds (paging)' };
      const width = to - from + 1;
      if (width <= MAX_ROWS) return { kind: 'ok', detail: `range window of ${width}` };
      sawCeilingRange = `range(${from}, ${to}) asks for ${width} rows and would receive ${MAX_ROWS}`;
      continue;
    }
  }

  if (sawCeilingLimit) return { kind: 'ceiling-limit', detail: sawCeilingLimit };
  if (sawCeilingRange) return { kind: 'ceiling-range', detail: sawCeilingRange };
  return {
    kind: 'unbounded',
    detail: 'no .limit(), .range(), .single(), .maybeSingle() or { head: true, count } — ' +
      `PostgREST will return at most ${MAX_ROWS} rows and will not say that it truncated`,
  };
}

/** Analyses the whole repository. `cwd` is the repo root. */
export function analyseRepo(cwd: string): Report {
  const files: string[] = [];
  for (const root of ROOTS) collectFiles(path.join(cwd, root), files);
  for (const file of ROOT_FILES) {
    const full = path.join(cwd, file);
    if (fs.existsSync(full)) files.push(full);
  }

  const findings: Finding[] = [];
  const exemptions: Exemption[] = [];
  let selectsChecked = 0;
  for (const file of files.sort()) {
    const rel = path.relative(cwd, file);
    const report = analyseFile(rel, fs.readFileSync(file, 'utf8'));
    findings.push(...report.findings);
    exemptions.push(...report.exemptions);
    selectsChecked += report.selectsChecked;
  }
  return { findings, exemptions, selectsChecked };
}

/** A findings list a human can act on straight from CI output. */
export function formatFindings(findings: Finding[]): string {
  return findings
    .map((f) => `  ${f.file}:${f.line}  [${f.table}] ${f.kind}\n      ${f.snippet}\n      ${f.detail}`)
    .join('\n\n');
}
