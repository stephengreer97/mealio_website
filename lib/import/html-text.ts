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
const DROPPED_TAGS = new Set([
  'script', 'style', 'noscript', 'template', 'svg', 'iframe',
  'nav', 'header', 'footer', 'form', 'aside',
]);

/** Tags that imply a line break when flattened to text. */
const BLOCK_TAGS = new Set([
  'p', 'div', 'br', 'li', 'tr', 'section', 'article', 'ul', 'ol', 'table', 'blockquote', 'dd', 'dt',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
]);

/**
 * Hard ceiling on the input to `htmlToText`.
 *
 * The fetcher already caps a response at 2 MB, but that is a *network* budget,
 * not a CPU one, and this runs before the gate and before any model call — so
 * a page that is expensive to strip burns server time on content we may be
 * about to reject anyway. A recipe post's readable content is a few tens of
 * kilobytes; anything past this is markup, inline data blobs and comment
 * threads, and truncating costs us nothing real.
 */
const MAX_HTML_CHARS = 512 * 1024;

/**
 * Flattens HTML to readable plain text.
 *
 * Written as a single left-to-right scan rather than a chain of regex
 * replacements. The obvious version —
 * `/<(script|style|…)\b[^>]*>[\s\S]*?<\/\1>/g` — backtracks quadratically:
 * every *unclosed* opening tag makes the lazy `[\s\S]*?` rescan to end of
 * input looking for a close that never comes. On a 2 MB body full of unclosed
 * `<div>`s that is tens of seconds of blocked event loop, inside the fetcher's
 * own size cap and before the gate has had a chance to reject the page. The
 * scan below touches each character a bounded number of times.
 */
export function htmlToText(html: string): string {
  const input = html.length > MAX_HTML_CHARS ? html.slice(0, MAX_HTML_CHARS) : html;
  const out: string[] = [];

  let i = 0;
  const length = input.length;

  while (i < length) {
    const lt = input.indexOf('<', i);
    if (lt === -1) {
      out.push(input.slice(i));
      break;
    }
    if (lt > i) out.push(input.slice(i, lt));

    // Comment / CDATA / doctype: skip to its terminator, or to end of input.
    if (input.startsWith('<!--', lt)) {
      const end = input.indexOf('-->', lt + 4);
      i = end === -1 ? length : end + 3;
      continue;
    }
    if (input.startsWith('<!', lt) || input.startsWith('<?', lt)) {
      const end = input.indexOf('>', lt + 2);
      i = end === -1 ? length : end + 1;
      continue;
    }

    const gt = input.indexOf('>', lt + 1);
    if (gt === -1) {
      // An unterminated tag at the very end — nothing left worth reading.
      break;
    }

    const raw = input.slice(lt + 1, gt);
    const closing = raw.startsWith('/');
    const nameEnd = (() => {
      const body = closing ? raw.slice(1) : raw;
      const match = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(body);
      return match ? match[0].toLowerCase() : '';
    })();

    if (!closing && DROPPED_TAGS.has(nameEnd)) {
      // Skip the element's contents. A self-closing form has no contents, and a
      // missing close tag drops the remainder rather than rescanning for one.
      if (raw.endsWith('/')) {
        out.push(' ');
        i = gt + 1;
        continue;
      }
      const close = input.toLowerCase().indexOf(`</${nameEnd}`, gt + 1);
      if (close === -1) {
        out.push(' ');
        i = length;
        continue;
      }
      const closeEnd = input.indexOf('>', close);
      out.push(' ');
      i = closeEnd === -1 ? length : closeEnd + 1;
      continue;
    }

    out.push(BLOCK_TAGS.has(nameEnd) ? '\n' : ' ');
    i = gt + 1;
  }

  return decodeEntities(out.join(''))
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
