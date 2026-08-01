/**
 * HTML → text primitives (MEAL-70).
 *
 * Split out from `html.ts` so the microdata reader can use them without a
 * circular import: `html.ts` orchestrates and depends on `microdata.ts`, which
 * depends on these.
 *
 * Regex-based rather than a DOM parser: we need a small, dependency-free
 * transform over untrusted input, we never re-serialise the HTML, and nothing
 * downstream cares about tree structure.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', hellip: '…', deg: '°',
  frac12: '½', frac14: '¼', frac34: '¾', frac13: '⅓', frac23: '⅔',
  eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç', ntilde: 'ñ',
  uuml: 'ü', ouml: 'ö', auml: 'ä', times: '×', middot: '·', bull: '•',
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** Elements whose contents are never page content. */
const DROPPED_ELEMENTS =
  /<(script|style|noscript|template|svg|iframe|nav|header|footer|form|aside)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

/** Tags that imply a line break when flattened to text. */
const BLOCK_TAGS = /<\/?(p|div|br|li|tr|h[1-6]|section|article|ul|ol|table|blockquote|dd|dt)\b[^>]*>/gi;

/** Flattens HTML to readable plain text. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(DROPPED_ELEMENTS, ' ')
      .replace(BLOCK_TAGS, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n[ \n]*/g, '\n')
    .trim();
}

/**
 * Reads a `<meta>` value by `property` or `name`.
 *
 * Attribute values may be double-quoted, single-quoted or unquoted — HTML
 * minifiers strip quotes, and the MEAL-69 spike hit exactly that on Yoast pages.
 */
export function metaContent(html: string, property: string): string | null {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const value = `(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`;
  const key = `(?:property|name)\\s*=\\s*(?:"${escaped}"|'${escaped}'|${escaped}(?=[\\s>]))`;
  const patterns = [
    new RegExp(`<meta[^>]+${key}[^>]*content\\s*=\\s*${value}`, 'i'),
    new RegExp(`<meta[^>]+content\\s*=\\s*${value}[^>]*${key}`, 'i'),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match) {
      const raw = match[1] ?? match[2] ?? match[3] ?? '';
      return decodeEntities(raw).trim();
    }
  }
  return null;
}
