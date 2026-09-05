// NO EM DASH IN TEXT A USER READS. The website half; mealio_app carries the
// same check as tests/unit/no-emdash-in-user-facing-text.test.ts.
//
// Stephen, 2026-09-05: "remember to never put an emdash into user facing text
// ever again." A one-time clean decays, so this is the part that lasts.
//
// WHY AN AST AND NOT A GREP. A grep for U+2014 across app/, components/ and
// lib/ returns ~2300 hits and almost all of them are COMMENTS, which the rule
// deliberately does not touch. The TypeScript parser knows the difference
// between a comment and a string, so it is the thing that should decide.
//
// WHAT COUNTS AS USER-FACING. Everything in a string, EXCEPT the exclusions
// below. That direction matters. A rule that lists what to check has to be
// extended for every new page and silently misses the ones nobody remembered; a
// rule that lists what to SKIP fails loudly on anything new, which is the error
// worth having.
//
// THE ADMIN PAGES ARE IN SCOPE. They are only ever read by Stephen, so there is
// an argument for exempting them. Not taken: they are still a person reading a
// sentence in a browser, and a carve-out for "internal UI" is the kind of hole
// that quietly widens. One rule is easier to keep than one rule with a border.
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const EM_DASH = '—';
const ROOT = path.resolve(__dirname, '../..');
const ROOTS = ['app', 'components', 'lib'].map((d) => path.join(ROOT, d));

/**
 * Files whose strings are not prose anybody reads.
 *
 * html-text.ts holds the HTML entity table. Its em dash is the DECODED VALUE of
 * `&mdash;`, so removing it would stop the decoder decoding.
 */
const EXCLUDED_FILES = (rel: string) => rel === 'lib/import/html-text.ts';

/**
 * Call targets and constants whose text is not read by a person.
 *
 * console/logger are obvious. The prompt constants and the zod `.describe()`
 * hints are INSTRUCTIONS TO A MODEL, not copy: they are shipped to Claude as
 * part of the extraction and gating prompts, and rewording them for punctuation
 * would change a prompt that has been tuned against real pages.
 */
const EXCLUDED_CALLS = /(^console\.|^logger\.|\.describe$)/;
const EXCLUDED_VARS = new Set(['SYSTEM_PROMPT', 'GATE_SYSTEM', 'EVIDENCE_DESCRIPTION']);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
}

const STRING_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.JsxText,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
]);

/** Every em dash that sits in a string rather than a comment. */
function offenders(file: string): string[] {
  const src = fs.readFileSync(file, 'utf8');
  if (!src.includes(EM_DASH)) return [];
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kind);
  const found: string[] = [];

  const visit = (n: ts.Node): void => {
    const text = (n as ts.LiteralLikeNode).text;
    if (STRING_KINDS.has(n.kind) && typeof text === 'string' && text.includes(EM_DASH)) {
      let p: ts.Node | undefined = n.parent;
      let skip = false;
      while (p && !skip) {
        if (ts.isCallExpression(p) && EXCLUDED_CALLS.test(p.expression.getText(sf))) skip = true;
        else if (ts.isVariableDeclaration(p) && EXCLUDED_VARS.has(p.name.getText(sf))) skip = true;
        p = p.parent;
      }
      if (!skip) {
        const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
        found.push(`${path.relative(ROOT, file)}:${line + 1}  ${text.replace(/\s+/g, ' ').trim().slice(0, 80)}`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

describe('no em dash in user-facing text', () => {
  const files = ROOTS.flatMap((r) => sourceFiles(r))
    .filter((f) => !EXCLUDED_FILES(path.relative(ROOT, f).split(path.sep).join('/')));

  it('has files to scan, so a broken walk cannot pass everything', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('still sees em dashes it is meant to skip, so the filter is not why it passes', () => {
    // If the exclusions grew to cover everything, or the walk stopped finding
    // strings, this suite would go green for the wrong reason. The prompt
    // constants are known to carry em dashes the walk CAN see.
    const promptFile = path.join(ROOT, 'lib/import/extract.ts');
    const raw = fs.readFileSync(promptFile, 'utf8');
    expect(raw).toContain(EM_DASH);
    expect(offenders(promptFile)).toEqual([]);   // excluded, so silent
    // ...and the same walk without the exclusions WOULD report it.
    const sf = ts.createSourceFile(promptFile, raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    let anyString = false;
    const look = (n: ts.Node): void => {
      const t = (n as ts.LiteralLikeNode).text;
      if (STRING_KINDS.has(n.kind) && typeof t === 'string' && t.includes(EM_DASH)) anyString = true;
      ts.forEachChild(n, look);
    };
    look(sf);
    expect(anyString).toBe(true);
  });

  it('finds none', () => {
    // Replace it rather than swapping in a hyphen. An em dash is doing one of
    // three jobs and each has a plain form: a parenthetical becomes commas or
    // brackets, a pause before a conclusion becomes a full stop, and a range or
    // label becomes a colon or the word "to".
    expect(files.flatMap(offenders)).toEqual([]);
  });
});
