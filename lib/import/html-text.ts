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
 * Hard ceiling on the input to every reader in this module and in `html.ts`.
 *
 * The fetcher already caps a response at 2 MB, but that is a *network* budget,
 * not a CPU one, and this runs before the gate and before any model call — so
 * a page that is expensive to strip burns server time on content we may be
 * about to reject anyway.
 *
 * It was 512 KB, which is smaller than the recorded pages it was chosen for:
 * cookieandkate is 566 KB and minimalistbaker 667 KB, so every fixture test in
 * the suite ran against a page silently truncated by 8% and 21%, and nothing
 * asserted what was lost. It happened not to matter for those two layouts;
 * nothing would have told us when it started mattering. A megabyte clears both
 * with room, and a test now fails the moment a fixture outgrows it.
 */
export const MAX_HTML_CHARS = 1024 * 1024;

/**
 * Applies `MAX_HTML_CHARS` to one reader's input.
 *
 * Every reader caps its own input rather than trusting the caller to have done
 * it. Each one is exported, each one is a whole-document scan, and "the entry
 * point already truncated" is exactly the assumption that stops holding the
 * first time someone calls one directly — which the pipeline's own telemetry
 * and eval harness both do.
 */
export function capHtml(html: string): string {
  return html.length > MAX_HTML_CHARS ? html.slice(0, MAX_HTML_CHARS) : html;
}

/**
 * Ceiling on one start tag's attribute run.
 *
 * Generous on purpose: a responsive `<img srcset>` on a real recipe page runs
 * to a couple of kilobytes, and skipping the tag that carries an `itemprop`
 * would cost us the ingredient, not just the attribute.
 */
const MAX_ATTRS_CHARS = 16_384;

export interface StartTag {
  /** Lowercased tag name. */
  name: string;
  /** The attribute run verbatim: everything between the name and its `>`. */
  attrs: string;
  /** Index of the opening `<`. */
  index: number;
  /** Index just past the closing `>`. */
  end: number;
}

/** Sticky, so the name is matched at the position we ask about and nowhere else. */
const TAG_NAME = /[a-zA-Z][a-zA-Z0-9-]*/y;

/**
 * The next `<name …>` start tag at or after `from`, found without backtracking.
 *
 * `<meta[^>]*>` reads as bounded and is not. The `[^>]*` is bounded by a `>`
 * that a hostile page simply never supplies, so it runs to end of input and then
 * gives the characters back one at a time — from every one of the document's
 * `<` positions. Measured on inputs as trivial as `'<meta '.repeat(n)`:
 * `metaContent` took 758 ms at 64 KB and 15,160 ms at 256 KB, `detectPlatform`
 * 784 ms and 12,701 ms, a clean 4× per doubling that extrapolates to minutes at
 * the fetcher's 2 MB cap. End to end a 262 KB body took `runImport` 87 s —
 * 8.7× the fetcher's own timeout, past the route's `maxDuration`, and on a
 * single-threaded runtime it stalls every concurrent invocation on the instance
 * rather than only the attacker's.
 *
 * Bounding the quantifier is not enough at that size; the engine still retries
 * from every start position. So nothing here quantifies over content: the tag
 * name is matched by a sticky pattern that cannot backtrack, and `>` is found by
 * `indexOf`. The early `return` when no `>` lies ahead is what makes the
 * pathological case linear — if there is none after this position there is none
 * after any later one either.
 */
export function nextStartTag(html: string, from: number, only?: string): StartTag | null {
  const wanted = only?.toLowerCase();
  let cursor = from;

  for (;;) {
    const lt = html.indexOf('<', cursor);
    if (lt === -1) return null;

    TAG_NAME.lastIndex = lt + 1;
    const name = TAG_NAME.exec(html);
    if (!name) {
      // A close tag, a comment, a doctype, or a bare `<` in prose.
      cursor = lt + 1;
      continue;
    }
    // Read before yielding anything: `TAG_NAME` is shared and these scans nest.
    const attrsFrom = TAG_NAME.lastIndex;

    const gt = html.indexOf('>', attrsFrom);
    if (gt === -1) return null;

    const lowerName = name[0].toLowerCase();
    if ((!wanted || lowerName === wanted) && gt - attrsFrom <= MAX_ATTRS_CHARS) {
      return { name: lowerName, attrs: html.slice(attrsFrom, gt), index: lt, end: gt + 1 };
    }
    cursor = gt + 1;
  }
}

/** Every `<name …>` start tag in source order, or every start tag when `only` is omitted. */
export function* startTags(html: string, only?: string): Generator<StartTag> {
  let cursor = 0;
  for (;;) {
    const tag = nextStartTag(html, cursor, only);
    if (!tag) return;
    yield tag;
    cursor = tag.end;
  }
}

/** One `<name …>…</name>` element: its attribute run and its raw content. */
export interface Element {
  attrs: string;
  inner: string;
}

/**
 * Every `<name …>…</name>` element in source order.
 *
 * Same discipline as `nextStartTag`, plus a forward search for the close tag —
 * and the same early `return` when there is none, for the same reason.
 */
export function* elements(html: string, name: string): Generator<Element> {
  const close = new RegExp(`</${name}\\s*>`, 'gi');
  let cursor = 0;

  for (;;) {
    const tag = nextStartTag(html, cursor, name);
    if (!tag) return;

    close.lastIndex = tag.end;
    const closing = close.exec(html);
    if (!closing) return;

    yield { attrs: tag.attrs, inner: html.slice(tag.end, closing.index) };
    cursor = closing.index + closing[0].length;
  }
}

/**
 * Reads one attribute out of a start tag's attribute run.
 *
 * Values may be double-quoted, single-quoted or unquoted — HTML minifiers strip
 * quotes, and the MEAL-69 spike hit exactly that on Yoast pages. The name has to
 * start at a token boundary rather than a `\b` one, or `data-name="x"` answers a
 * request for `name`.
 */
export function attrValue(attrs: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(
    `(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`,
    'i',
  ).exec(attrs);
  if (!match) return null;
  return decodeEntities(match[1] ?? match[2] ?? match[3] ?? '').trim();
}

/**
 * Page furniture that is not the recipe: reader comments, related-post rails,
 * share widgets, newsletter forms, author bios, affiliate disclosures.
 *
 * Matched on `id` and `class`, which is how every CMS in the MEAL-69 sample
 * marks these regions. Deliberately broad — over-stripping costs a little
 * context, under-stripping means a reader comment can be quoted as evidence
 * and read as verified.
 */
const BOILERPLATE_MARKERS = [
  'comment', 'respond', 'disqus', 'livefyre',
  'related', 'jp-relatedposts', 'yarpp', 'recirc', 'more-from',
  'sidebar', 'widget', 'share', 'sharedaddy', 'social',
  'subscribe', 'newsletter', 'signup', 'optin', 'popup', 'modal', 'consent',
  'disclosure', 'disclaimer', 'affiliate',
  'author-bio', 'about-author', 'breadcrumb', 'pagination',
  'post-navigation', 'nav-links', 'entry-footer',
];

/**
 * Markers that say an element *is* the recipe. These beat the boilerplate list,
 * because the markers above are substrings and recipe cards collide with them —
 * a `<div class="recipe-widget">` or a cookie recipe on a baking blog must not
 * be mistaken for page furniture. Losing the recipe is far worse than keeping a
 * share button.
 */
const RECIPE_MARKERS = [
  'wprm-recipe', 'tasty-recipe', 'recipe-card', 'hrecipe', 'jetpack-recipe',
  'recipe-container', 'recipe-summary', 'entry-content', 'post-content',
  'ingredient', 'instruction', 'directions', 'method',
];

/**
 * Structural containers that are never page furniture, whatever their classes.
 *
 * `<body class="content-sidebar">` is a layout class on the recorded
 * cookieandkate page — matching "sidebar" there dropped the entire document and
 * left a 52-character corpus, which would have verified nothing at all.
 */
const NEVER_DROPPED_TAGS = new Set(['html', 'body', 'main', 'article']);

/** Attribute values that mark an element as page furniture. */
function isBoilerplate(tagName: string, tagAttributes: string): boolean {
  if (NEVER_DROPPED_TAGS.has(tagName)) return false;

  const match = /\b(?:id|class)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
  const values: string[] = [];
  let found: RegExpExecArray | null;
  while ((found = match.exec(tagAttributes)) !== null) {
    values.push((found[1] ?? found[2] ?? found[3] ?? '').toLowerCase());
  }

  if (values.some((v) => RECIPE_MARKERS.some((marker) => v.includes(marker)))) return false;
  return values.some((v) => BOILERPLATE_MARKERS.some((marker) => v.includes(marker)));
}

/**
 * Elements the page itself hides from a reader.
 *
 * Hidden text is still text: it lands in the corpus, so a value cited to a
 * `display:none` block satisfies value ⊆ span ⊆ source and reads green — while
 * the creator, checking the page that badge points at, cannot find the sentence
 * anywhere on it. The page is attacker-controlled and is interpolated into the
 * extraction prompt, so planting evidence there is a move available to whoever
 * wrote the page, not a curiosity.
 *
 * Dropped from the recipe region only. A hit in hidden text still matches the
 * whole-page corpus and so caps at amber with a "check it" marker, which is the
 * honest answer: the text really is on the page, just not where anyone would see
 * it. Deliberately narrow — only what the markup states outright. Hiding driven
 * by a stylesheet class is invisible to us, and this is a demotion mechanism
 * rather than a guarantee.
 */
function isHidden(tagName: string, tagAttributes: string): boolean {
  if (NEVER_DROPPED_TAGS.has(tagName)) return false;
  if (/(?:^|\s)hidden(?=[\s=>/]|$)/i.test(tagAttributes)) return true;
  if (/(?:^|\s)aria-hidden\s*=\s*["']?true/i.test(tagAttributes)) return true;
  const style = attrValue(tagAttributes, 'style');
  return style !== null && /display\s*:\s*none|visibility\s*:\s*hidden/i.test(style);
}

/**
 * Index just past the close tag matching an element opened at `openEnd`.
 *
 * Counts depth rather than taking the first close tag, because the regions we
 * skip are `<div>`s full of nested `<div>`s — a first-match scan would stop at
 * the first inner close and leave the rest of a 345-comment thread in the
 * output, which is exactly the bug this is here to prevent.
 */
function skipElement(lower: string, tagName: string, openEnd: number): number {
  const open = `<${tagName}`;
  const close = `</${tagName}`;
  let depth = 1;
  let cursor = openEnd;

  while (depth > 0) {
    const nextOpen = lower.indexOf(open, cursor);
    const nextClose = lower.indexOf(close, cursor);
    if (nextClose === -1) return lower.length;
    if (nextOpen !== -1 && nextOpen < nextClose) {
      // Only a real tag opening counts: `<divider>` is not a nested `<div>`.
      const after = lower[nextOpen + open.length];
      if (after === '>' || after === ' ' || after === '\n' || after === '\t' || after === '/') depth++;
      cursor = nextOpen + open.length;
      continue;
    }
    depth--;
    cursor = nextClose + close.length;
  }

  const end = lower.indexOf('>', cursor - 1);
  return end === -1 ? lower.length : end + 1;
}

export interface HtmlToTextOptions {
  /**
   * Also drop comment threads, related-post rails, disclosure blocks, and
   * anything the markup states is hidden from a reader.
   *
   * Used to build the corpus that `value ⊆ span ⊆ source` is verified against:
   * without it, a reader comment counts as "the source", and an ingredient
   * lifted from one verifies as green.
   *
   * Best effort, and the caller has to treat it as such. Both lists are pattern
   * matches against `id`/`class`, so a layout that names its furniture something
   * we do not recognise comes back unnarrowed — see `assessField`, which
   * compares the two corpora rather than assuming this worked.
   */
  dropBoilerplate?: boolean;
}

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
export function htmlToText(html: string, options: HtmlToTextOptions = {}): string {
  const input = capHtml(html);
  const dropBoilerplate = options.dropBoilerplate === true;
  const out: string[] = [];

  let i = 0;
  const length = input.length;
  // Lowercased once, not once per dropped tag. Building it inside the loop made
  // the scan quadratic again by a different route: `MAX_HTML_CHARS` bounds the
  // input length but not the number of times we walk it, so a page of inline
  // `<svg>` icons — 512 KB of them, well inside the cap — cost 21 seconds.
  // Allocating one lowercase copy up front makes close-tag lookup O(1) amortised.
  const lower = input.toLowerCase();

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

    const drop =
      !closing && nameEnd !== '' &&
      (DROPPED_TAGS.has(nameEnd) ||
        (dropBoilerplate && (isBoilerplate(nameEnd, raw) || isHidden(nameEnd, raw))));

    if (drop) {
      // Skip the element's contents. A self-closing form has no contents.
      if (raw.endsWith('/')) {
        out.push(' ');
        i = gt + 1;
        continue;
      }
      out.push('\n');
      i = skipElement(lower, nameEnd, gt + 1);
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
 * Reading the attribute run of each tag, rather than matching a pattern across
 * the whole document, makes attribute order a non-question — the two regexes
 * this replaces existed only to cover both orderings — and it is what keeps the
 * scan linear. See `nextStartTag`.
 */
export function metaContent(html: string, property: string): string | null {
  const wanted = property.toLowerCase();
  for (const tag of startTags(capHtml(html), 'meta')) {
    const key = attrValue(tag.attrs, 'property') ?? attrValue(tag.attrs, 'name');
    if (key?.toLowerCase() !== wanted) continue;
    const content = attrValue(tag.attrs, 'content');
    if (content !== null) return content;
  }
  return null;
}
