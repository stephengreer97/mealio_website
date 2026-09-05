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
//
// THE RULE IS ABOUT PUNCTUATION, NOT ABOUT THE CHARACTER. Stephen, on the first
// pass of this sweep: "You can put those two emdashes back." A lone em dash in
// a table cell is not punctuating a sentence, it is the VALUE -- "no value" is
// what a dash has meant in a table for longer than this app has existed. The
// admin tables and the digest emails use it that way in about forty places, and
// changing the character there fixed nothing and cost a convention.
//
// So a string that is nothing but the glyph is allowed, and a string that uses
// one to join two clauses is not. Prose that QUOTES the glyph while explaining
// it is allowed too, because the incomplete-data banner has to show the reader
// the character it is describing. Quoting is the tell: punctuation is never in
// quote marks, and a character being named almost always is.
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
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
 * A string that IS the dash rather than one that contains it.
 *
 * Deliberately this strict. Not "starts with a dash", not "is short" -- a
 * string with any other character in it is a sentence, and a sentence with an
 * em dash in it is exactly what this file exists to find.
 */
function isGlyphNotPunctuation(text: string): boolean {
  return text.trim() === EM_DASH;
}

/**
 * Prose that contains the glyph because it is ABOUT the glyph.
 *
 * The incomplete-data banner explains what the dash in the table means, so it
 * has to show one. Quoting is the tell: a dash used as PUNCTUATION is never
 * wrapped in quote marks, and a dash being NAMED almost always is.
 *
 * This started as an allowlist of one exact sentence and that was wrong within
 * a minute: the same sentence exists twice on the admin page, once as a string
 * literal and once as JSX text with different whitespace and a neighbouring
 * clause, so matching the text caught one and missed the other. A rule about
 * the shape catches both and does not need editing when the wording changes.
 */
function isQuotedGlyph(text: string): boolean {
  // Strip every quoted occurrence, then see whether any dash is left over. A
  // sentence that quotes the glyph AND uses one as punctuation still fails,
  // which is the right answer.
  const withoutQuoted = text.replace(/[\u201c\u2018"']\s*\u2014\s*[\u201d\u2019"']/g, '');
  return !withoutQuoted.includes(EM_DASH);
}

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
    if (STRING_KINDS.has(n.kind) && typeof text === 'string' && text.includes(EM_DASH)
        && !isGlyphNotPunctuation(text) && !isQuotedGlyph(text)) {
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

  it('allows the glyph and still catches a sentence, so the exception is not a hole', () => {
    // Written as a fixture rather than asserted against the live source,
    // because what has to hold is the RULE. A repo that happens to have no
    // offending string in it today would make an assertion about the source
    // pass either way.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emdash-'));
    const fixture = path.join(dir, 'fixture.ts');
    try {
      fs.writeFileSync(fixture, [
        "export const CELL = '\u2014';",                        // the value: allowed
        "export const PADDED = '  \u2014  ';",                  // still just the value
        "export const PROSE = 'No orphans \u2014 storage is clean.';",
        "export const SHORT = '\u2014 removed';",               // short, but a sentence
      ].join('\n'));
      const found = offenders(fixture);
      expect(found.join('\n')).toContain('No orphans');
      expect(found.join('\n')).toContain('removed');
      expect(found).toHaveLength(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('allows a QUOTED glyph, and still fails a sentence that also uses one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emdash-'));
    const fixture = path.join(dir, 'fixture.ts');
    try {
      fs.writeFileSync(fixture, [
        // Naming the character: allowed, and the wording is free to change.
        "export const A = 'Figures are shown as \u201c\u2014\u201d rather than as a number.';",
        "export const B = 'The \"\u2014\" means no value.';",
        // Naming it AND using one. Still an offender, which is the point: the
        // exception is about the quoted occurrence, not about the sentence.
        "export const C = 'A \u201c\u2014\u201d means no value \u2014 check the log.';",
      ].join('\n'));
      const found = offenders(fixture);
      expect(found).toHaveLength(1);
      expect(found[0]).toContain('check the log');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('finds none', () => {
    // Replace it rather than swapping in a hyphen. An em dash is doing one of
    // three jobs and each has a plain form: a parenthetical becomes commas or
    // brackets, a pause before a conclusion becomes a full stop, and a range or
    // label becomes a colon or the word "to".
    expect(files.flatMap(offenders)).toEqual([]);
  });
});
