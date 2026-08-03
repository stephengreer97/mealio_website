import { describe, it, expect } from 'vitest';
import {
  detectPlatform,
  extractRecipeJsonLd,
  extractTitle,
  htmlToText,
  metaContent,
  toSourceDocument,
} from '@/lib/import/html';
import { MAX_HTML_CHARS } from '@/lib/import/html-text';
import { extractRecipeMicrodata } from '@/lib/import/microdata';
import { readHtmlFixture } from '../helpers/import-stubs';

/**
 * Recorded-fixture tests for the structured-data readers.
 *
 * The three real pages were captured with curl on 2026-08-01 and are committed
 * byte for byte — a hand-written "looks like a blog post" fixture would not
 * exercise the ad wrappers, inline JSON blobs and comment threads these have.
 * See tests/fixtures/import/README.md.
 */

const GUACAMOLE = readHtmlFixture('cookieandkate-guacamole.html');
const SOUP = readHtmlFixture('minimalistbaker-black-bean-soup.html');
const ABOUT = readHtmlFixture('cookieandkate-about.html');
const NO_JSONLD = readHtmlFixture('synthetic-no-jsonld-recipe.html');

describe('import/html — JSON-LD on real pages', () => {
  it('finds a Recipe nested inside @graph (10 of the spike’s 13 hits looked like this)', () => {
    const recipe = extractRecipeJsonLd(GUACAMOLE);
    expect(recipe).not.toBeNull();
    expect(recipe!.name).toBe('Best Guacamole');
    expect(recipe!.recipeIngredient).toHaveLength(7);
    expect(recipe!.recipeIngredient![0]).toMatch(/avocado/i);
  });

  it('flattens HowToStep instruction objects into plain strings', () => {
    const recipe = extractRecipeJsonLd(SOUP);
    expect(recipe).not.toBeNull();
    expect(recipe!.recipeIngredient).toHaveLength(17);
    expect(recipe!.recipeInstructions!.length).toBeGreaterThan(2);
    for (const step of recipe!.recipeInstructions!) {
      expect(typeof step).toBe('string');
      expect(step.length).toBeGreaterThan(0);
    }
  });

  it('picks the descriptive form out of an array recipeYield', () => {
    // cookieandkate publishes ["2", "2 1/2 cups guacamole"] — the longer one is
    // what a creator wants in the `serves` field.
    expect(extractRecipeJsonLd(GUACAMOLE)!.recipeYield).toBe('2 1/2 cups guacamole');
  });

  it('does not report a Recipe on a food blog’s About page', () => {
    // The page carries JSON-LD — nearly every platform does — but no Recipe.
    // "Has JSON-LD" is ~90% true and useless; the test has to be @type Recipe.
    expect(ABOUT).toMatch(/application\/ld\+json/);
    expect(extractRecipeJsonLd(ABOUT)).toBeNull();
  });
});

describe('import/html — JSON-LD edge cases from the MEAL-69 spike', () => {
  it('matches an unquoted type attribute (Yoast + HTML minifier)', () => {
    const html = `<html><head><script type=application/ld+json>${JSON.stringify({
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'WebPage', name: 'Page' },
        { '@type': 'Recipe', name: 'Minified Pasta', recipeIngredient: ['200 g spaghetti'] },
      ],
    })}</script></head><body>x</body></html>`;

    expect(extractRecipeJsonLd(html)!.name).toBe('Minified Pasta');
  });

  it('matches a single-quoted type attribute', () => {
    const html = `<script type='application/ld+json'>${JSON.stringify({
      '@type': 'Recipe',
      name: 'Single Quoted',
      recipeIngredient: ['1 egg'],
    })}</script>`;
    expect(extractRecipeJsonLd(html)!.name).toBe('Single Quoted');
  });

  it('accepts @type given as an array', () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      '@type': ['Recipe', 'NewsArticle'],
      name: 'Dual Typed',
      recipeIngredient: ['1 onion'],
    })}</script>`;
    expect(extractRecipeJsonLd(html)!.name).toBe('Dual Typed');
  });

  it('ignores Article/BlogPosting blocks and keeps scanning', () => {
    const html = [
      `<script type="application/ld+json">${JSON.stringify({ '@type': 'BlogPosting', headline: 'x' })}</script>`,
      `<script type="application/ld+json">{ this is not json }</script>`,
      `<script type="application/ld+json">${JSON.stringify({
        '@type': 'Recipe',
        name: 'Third Block',
        recipeIngredient: ['2 tbsp butter'],
      })}</script>`,
    ].join('\n');
    expect(extractRecipeJsonLd(html)!.name).toBe('Third Block');
  });

  it('skips a stub Recipe node with no ingredients or instructions', () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      '@graph': [
        { '@type': 'Recipe', name: 'Category stub' },
        { '@type': 'Recipe', name: 'Real one', recipeIngredient: ['1 lemon'] },
      ],
    })}</script>`;
    expect(extractRecipeJsonLd(html)!.name).toBe('Real one');
  });
});

describe('import/microdata — the ~4 points of coverage JSON-LD misses', () => {
  it('reads a schema.org Recipe published as microdata', () => {
    const html = `
      <div itemscope itemtype="http://schema.org/Recipe">
        <h1 itemprop="name">Squarespace Chili</h1>
        <img itemprop="image" src="https://cdn.example/chili.jpg">
        <ul>
          <li itemprop="recipeIngredient">1 lb ground beef</li>
          <li itemprop="recipeIngredient">2 cups kidney beans</li>
        </ul>
        <div itemprop="recipeInstructions">Brown the beef. Add everything else.</div>
        <span itemprop="recipeYield">6 bowls</span>
      </div>`;

    const recipe = extractRecipeMicrodata(html)!;
    expect(recipe.name).toBe('Squarespace Chili');
    expect(recipe.recipeIngredient).toEqual(['1 lb ground beef', '2 cups kidney beans']);
    expect(recipe.recipeYield).toBe('6 bowls');
    expect(recipe.image).toBe('https://cdn.example/chili.jpg');
  });

  it('reads the Jetpack Recipes hRecipe variant (smittenkitchen)', () => {
    const html = `
      <div class="hrecipe jetpack-recipe" itemscope>
        <h3 class="jetpack-recipe-title">Buttered Noodles</h3>
        <ul class="jetpack-recipe-ingredients">
          <li class="jetpack-recipe-ingredient">1 lb egg noodles</li>
          <li class="jetpack-recipe-ingredient">4 tbsp salted butter</li>
        </ul>
        <div class="jetpack-recipe-directions">Boil the noodles. Toss with butter.</div>
      </div>`;

    const recipe = extractRecipeMicrodata(html)!;
    expect(recipe.name).toBe('Buttered Noodles');
    expect(recipe.recipeIngredient).toEqual(['1 lb egg noodles', '4 tbsp salted butter']);
    expect(recipe.recipeInstructions!.length).toBeGreaterThanOrEqual(2);
  });

  it('returns null when neither format is present', () => {
    expect(extractRecipeMicrodata(NO_JSONLD)).toBeNull();
  });
});

describe('import/html — text extraction', () => {
  it('drops script, style and nav content', () => {
    const text = htmlToText(
      '<nav>Home Archive</nav><script>var x = "ingredients";</script>' +
        '<style>.a{color:red}</style><p>Real content here.</p>',
    );
    expect(text).toBe('Real content here.');
  });

  it('decodes entities including fractions', () => {
    expect(htmlToText('<p>1&frac12; cups caf&eacute; cr&egrave;me &amp; sugar</p>')).toBe(
      '1½ cups café crème & sugar',
    );
    expect(htmlToText('<p>&#8531; cup &#x2014; done</p>')).toBe('⅓ cup — done');
  });

  it('keeps recipe text from a real page and caps runaway length', () => {
    const document = toSourceDocument('https://cookieandkate.com/best-guacamole-recipe', GUACAMOLE);
    expect(document.text).toMatch(/guacamole/i);
    expect(document.text.length).toBeLessThanOrEqual(24_000);
    expect(document.text).not.toMatch(/<div|function\s*\(/);
  });
});

describe('import/html — toSourceDocument', () => {
  it('marks the structured source as json-ld and exposes a verification corpus', () => {
    const document = toSourceDocument('https://cookieandkate.com/best-guacamole-recipe', GUACAMOLE);
    expect(document.structuredSource).toBe('json-ld');
    expect(document.jsonLdRaw).toContain('Best Guacamole');
    expect(document.title).toMatch(/guacamole/i);
    expect(document.imageUrl).toMatch(/^https?:\/\//);
  });

  it('falls through to the raw-HTML path when a page publishes no structured data', () => {
    const document = toSourceDocument('https://smallkitchen.example/lemon-butter-chicken', NO_JSONLD);
    expect(document.structuredSource).toBeNull();
    expect(document.jsonLd).toBeNull();
    expect(document.jsonLdRaw).toBeNull();
    // og:image still gives us a photo candidate.
    expect(document.imageUrl).toBe('https://cdn.smallkitchen.example/lemon-butter-chicken.jpg');
    expect(document.text).toMatch(/a knob of butter/);
  });
});

describe('import/html — platform detection (telemetry)', () => {
  it('identifies the platform of the recorded pages', () => {
    expect(detectPlatform(SOUP, 'https://minimalistbaker.com/x')).toMatch(/wordpress|jetpack/);
    expect(detectPlatform(GUACAMOLE, 'https://cookieandkate.com/x')).toMatch(/wordpress|jetpack/);
  });

  it('identifies link-in-bio hosts by hostname', () => {
    expect(detectPlatform('<html></html>', 'https://beacons.ai/superrecipes')).toBe('link-in-bio');
    expect(detectPlatform('<html></html>', 'https://linktr.ee/someone')).toBe('link-in-bio');
  });

  it('falls back to unknown rather than erroring', () => {
    expect(detectPlatform('<html><body>hi</body></html>', 'not a url')).toBe('unknown');
  });
});

/**
 * Regressions from the external review.
 */
describe('import/html — bounded stripping (CPU DoS)', () => {
  it('strips a 1.5 MB body of unclosed tags in well under a second', () => {
    // The regex version — /<(script|style|…)\b[^>]*>[\s\S]*?<\/\1>/g — backtracks
    // quadratically here: every unclosed opening tag rescans to end of input for
    // a close that never comes. Measured at 23.4s for a body inside the
    // fetcher's own 2 MB cap, blocking the event loop before the gate ran.
    const html = `<html><body>${'<div><span>hello world '.repeat(70_000)}</body></html>`;
    expect(html.length).toBeGreaterThan(1_000_000);

    const startedAt = Date.now();
    const text = htmlToText(html);
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(1000);
    expect(text).toContain('hello world');
  });

  it('does not rescan for a close tag that never arrives', () => {
    const html = '<script>'.repeat(20_000) + 'x'.repeat(500_000);
    const startedAt = Date.now();
    htmlToText(html);
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  it('stays linear in the number of dropped elements, not just input size', () => {
    // The shape the previous timing test missed. Many *closed* dropped
    // elements — inline SVG icons are the everyday case — used to cost one
    // full-string toLowerCase() each: 64KB was 28ms, 512KB was 20.9 seconds,
    // and 512KB is inside MAX_HTML_CHARS. Input length was bounded; the number
    // of walks over it was not.
    const timings = [64, 512].map((kb) => {
      const html = '<svg></svg>'.repeat(Math.floor((kb * 1024) / 11));
      const startedAt = Date.now();
      htmlToText(html);
      return Date.now() - startedAt;
    });

    expect(timings[1]).toBeLessThan(1000);
    // 8x the input must not cost anything like 8^2 the time.
    expect(timings[1]).toBeLessThan(Math.max(timings[0], 5) * 20);
  });

  it('caps its own input regardless of what the fetcher allowed through', () => {
    const html = `<p>start</p>${'<p>filler</p>'.repeat(200_000)}`;
    const startedAt = Date.now();
    const text = htmlToText(html);
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(text.length).toBeLessThan(html.length);
  });

  it('still drops the contents of an element it is skipping', () => {
    expect(htmlToText('<p>before</p><script>var secret = 1;</script><p>after</p>')).toBe(
      'before\nafter',
    );
  });

  it('handles a self-closing dropped element and an unterminated tag', () => {
    expect(htmlToText('<p>a</p><svg/><p>b</p>')).toBe('a\nb');
    expect(htmlToText('<p>a</p><div')).toBe('a');
  });
});

/**
 * The third occurrence of the quadratic-parser class, and the tests that were
 * missing when it shipped twice before.
 *
 * `html-text.ts` documented two previously-found CPU stalls in prose and
 * asserted neither, so the same bug came back in five more regexes: every
 * `[^>]*` in `metaContent`, `extractTitle`, `extractRecipeJsonLd` and
 * `detectPlatform` is bound by a `>` a hostile page simply never supplies, and
 * each of ~44k start positions rescans the tail. Measured before the fix, on
 * inputs as trivial as `'<meta '.repeat(n)`:
 *
 *   metaContent          64 KB    758 ms → 256 KB  15,160 ms
 *   detectPlatform       64 KB    784 ms → 256 KB  12,701 ms
 *   extractTitle         64 KB    337 ms → 256 KB   5,387 ms
 *   extractRecipeJsonLd  64 KB    265 ms → 256 KB   7,196 ms
 *
 * A clean 4× per doubling in all four, extrapolating to minutes at the
 * fetcher's 2 MB cap. End to end, a 262,140-byte body took `runImport` 87,585 ms
 * — 8.7× the fetcher's own 10 s timeout, past the route's `maxDuration = 60`,
 * and on a single-threaded runtime that stalls every concurrent invocation on
 * the instance rather than only the attacker's.
 *
 * These assert wall-clock so a fourth occurrence fails CI instead of shipping.
 * The thresholds are ~60× the measured cost after the fix (1–16 ms), which is
 * loose enough for a busy CI box and nowhere near a quadratic regression.
 */
describe('import/html — no reader is quadratic in document length', () => {
  function elapsed(fn: () => void): number {
    const startedAt = Date.now();
    fn();
    return Date.now() - startedAt;
  }

  // A document with no `>` anywhere: every `[^>]*` runs to the end of it.
  const UNCLOSED_TAGS = '<meta '.repeat(Math.floor((256 * 1024) / 6));

  it('reads a meta tag off 256 KB of unclosed tags in milliseconds', () => {
    expect(elapsed(() => metaContent(UNCLOSED_TAGS, 'og:image'))).toBeLessThan(1000);
  });

  it('detects the platform of 256 KB of unclosed tags in milliseconds', () => {
    expect(elapsed(() => detectPlatform(UNCLOSED_TAGS, 'https://x.example.com/p'))).toBeLessThan(1000);
  });

  it('reads the title off 256 KB of unclosed <title openings in milliseconds', () => {
    const html = '<title '.repeat(Math.floor((256 * 1024) / 7));
    expect(elapsed(() => extractTitle(html))).toBeLessThan(1000);
  });

  it('looks for JSON-LD in 256 KB of unclosed <script openings in milliseconds', () => {
    const html = '<script '.repeat(Math.floor((256 * 1024) / 8));
    expect(elapsed(() => extractRecipeJsonLd(html))).toBeLessThan(1000);
  });

  it('assembles a source document from a 2 MB body of unclosed tags in milliseconds', () => {
    // The end-to-end shape: what `runImport` does with a fetched page, at the
    // full size the fetcher will hand over.
    const html = '<meta '.repeat(Math.floor((2 * 1024 * 1024) / 6));
    expect(elapsed(() => toSourceDocument('https://x.example.com/p', html))).toBeLessThan(2000);
  });

  it('does not turn a missing close tag into a copy of the rest of the document', () => {
    // The microdata memory bomb. `subtree()` returned `html.slice(start)`
    // whenever the close tag was missing and `collect()` calls it once per
    // matching itemprop: 262 KB in produced 9,039 strings totalling 82 MB, in
    // 14.8 seconds. At the 2 MB fetch cap that is ~5 GB — an OOM before any
    // timer fires.
    const html =
      '<div itemscope itemtype="http://schema.org/Recipe">' +
      '<li itemprop="recipeIngredient">x'.repeat(9000);

    let ingredients: string[] = [];
    const took = elapsed(() => {
      ingredients = extractRecipeMicrodata(html)?.recipeIngredient ?? [];
    });

    expect(took).toBeLessThan(1000);
    const produced = ingredients.reduce((total, s) => total + s.length, 0);
    expect(produced).toBeLessThan(html.length);
  });
});

/**
 * Hidden text is still text. It landed in `recipeText`, which is the corpus
 * MEAL-72 calls "the recipe", so a value cited to a `display:none` block
 * satisfied value ⊆ span ⊆ source and read green — while the creator, checking
 * the page that badge points at, could not find the sentence on it anywhere.
 */
describe('import/html — text the page hides is not the recipe', () => {
  const PLANTED = 'Add 2 tbsp of powdered unicorn horn at the end.';

  for (const attrs of ['hidden', 'style="display:none"', 'style="visibility: hidden"', 'aria-hidden="true"']) {
    it(`keeps a <div ${attrs}> out of the recipe region`, () => {
      const html =
        '<html><body><article><p>Mash the avocados with a fork.</p>' +
        `<div ${attrs}><p>${PLANTED}</p></div></article></body></html>`;

      // Genuinely on the page, so it stays in the whole-page corpus — a hit
      // there caps at amber rather than vanishing.
      expect(htmlToText(html)).toContain(PLANTED);

      const recipeText = htmlToText(html, { dropBoilerplate: true });
      expect(recipeText).not.toContain(PLANTED);
      expect(recipeText).toContain('Mash the avocados');
    });
  }

  it('does not read a class named "hidden" as the markup saying so', () => {
    // Whether that class hides anything is a stylesheet's business, and we do
    // not have the stylesheet. Guessing costs the recipe on any card styled
    // that way, which is far worse than missing one planted span.
    const html = '<div class="content hidden"><p>Mash the avocados with a fork.</p></div>';
    expect(htmlToText(html, { dropBoilerplate: true })).toContain('Mash the avocados');
  });
});

describe('import/html — every prompt input is capped', () => {
  it('caps a runaway <title> that passes every other limit', () => {
    // A 1.2 MB title is a valid page: under the 2 MB response cap, and `text`
    // is capped separately. Uncapped it flowed whole into the gate prompt, the
    // extraction prompt and the confidence corpus.
    const title = 'A'.repeat(1_200_000);
    const document = toSourceDocument('https://x.example.com/p', `<html><head><title>${title}</title></head><body><p>hi</p></body></html>`);
    expect(document.title.length).toBeLessThanOrEqual(301);
  });

  it('caps structured data quoted into the prompt and used as the verification corpus', () => {
    const recipe = {
      '@type': 'Recipe',
      name: 'Huge',
      recipeIngredient: Array.from({ length: 40_000 }, (_, i) => `ingredient number ${i}`),
    };
    const html = `<script type="application/ld+json">${JSON.stringify(recipe)}</script>`;
    const document = toSourceDocument('https://x.example.com/p', html);
    expect(document.jsonLdRaw!.length).toBeLessThanOrEqual(32_001);
  });

  it('is a cap the real recorded pages fit inside', () => {
    // The cap was 512 KB while both fixtures were larger — 566 KB and 667 KB —
    // so every test in this suite ran against a page silently truncated by 8%
    // and 21%, and nothing said what was lost. It happened not to matter for
    // these two layouts; nothing told you when it would start mattering. This
    // fails the moment a fixture outgrows the cap again.
    expect(GUACAMOLE.length).toBeLessThan(MAX_HTML_CHARS);
    expect(SOUP.length).toBeLessThan(MAX_HTML_CHARS);
  });

  it('truncates a body past the cap rather than walking it', () => {
    const recipe = '<script type="application/ld+json">' +
      JSON.stringify({ '@type': 'Recipe', name: 'Buried', recipeIngredient: ['1 lemon'] }) +
      '</script>';
    // Structured data past the cap is genuinely lost, which is the trade the cap
    // makes. What must not happen is reading it *and* charging a page's CPU
    // budget for the megabytes in front of it.
    const html = `<html><body><p>x</p>${'<p>filler</p>'.repeat(90_000)}${recipe}</body></html>`;
    expect(html.length).toBeGreaterThan(MAX_HTML_CHARS);
    expect(extractRecipeJsonLd(html)).toBeNull();
    expect(extractRecipeJsonLd(recipe)!.name).toBe('Buried');
  });

  it('drops an image URL long enough to be a payload rather than a link', () => {
    const dataUri = `data:image/png;base64,${'A'.repeat(5000)}`;
    const document = toSourceDocument(
      'https://x.example.com/p',
      `<html><head><meta property="og:image" content="${dataUri}"></head><body><p>hi</p></body></html>`,
    );
    expect(document.imageUrl).toBeNull();
  });
});
