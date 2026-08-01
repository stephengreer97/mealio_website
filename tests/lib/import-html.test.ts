import { describe, it, expect } from 'vitest';
import { detectPlatform, extractRecipeJsonLd, htmlToText, toSourceDocument } from '@/lib/import/html';
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

  it('drops an image URL long enough to be a payload rather than a link', () => {
    const dataUri = `data:image/png;base64,${'A'.repeat(5000)}`;
    const document = toSourceDocument(
      'https://x.example.com/p',
      `<html><head><meta property="og:image" content="${dataUri}"></head><body><p>hi</p></body></html>`,
    );
    expect(document.imageUrl).toBeNull();
  });
});
