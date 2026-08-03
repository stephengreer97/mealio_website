import { describe, it, expect, beforeEach } from 'vitest';
import { runImport } from '@/lib/import/pipeline';
import { toSourceDocument } from '@/lib/import/html';
import { MemoryImportCache } from '@/lib/import/cache';
import { EXTRACTION_MODEL, GATE_MODEL, type StructuredCaller } from '@/lib/import/anthropic';
import type { ImportTelemetry, SourceDocument } from '@/lib/import/types';
import { formatTelemetry } from '@/lib/import/telemetry';
import {
  brokenCache,
  endlessBody,
  extractionFixture,
  failingCaller,
  publicLookup,
  readHtmlFixture,
  stubCaller,
  stubFetch,
} from '../helpers/import-stubs';

/**
 * End-to-end pipeline: fetch → gate → extract → confidence, against recorded
 * fixtures with a stubbed Anthropic client. No network, no API key.
 */

const GUAC_URL = 'https://cookieandkate.com/best-guacamole-recipe';
const ABOUT_URL = 'https://cookieandkate.com/about';
const CHICKEN_URL = 'https://smallkitchen.example/lemon-butter-chicken';

function routes() {
  return {
    'https://cookieandkate.com/robots.txt': { body: 'User-agent: *\nDisallow: /wp-admin/' },
    'https://smallkitchen.example/robots.txt': { body: '' },
    [GUAC_URL]: { body: readHtmlFixture('cookieandkate-guacamole.html') },
    [ABOUT_URL]: { body: readHtmlFixture('cookieandkate-about.html') },
    [CHICKEN_URL]: { body: readHtmlFixture('synthetic-no-jsonld-recipe.html') },
  };
}

let cache: MemoryImportCache;
let events: ImportTelemetry[];

beforeEach(() => {
  cache = new MemoryImportCache();
  events = [];
});

function options(overrides: Record<string, unknown> = {}) {
  const { impl } = stubFetch(routes());
  return {
    cache,
    telemetry: (event: ImportTelemetry) => events.push(event),
    fetchOptions: { fetchImpl: impl, lookup: publicLookup },
    ...overrides,
  };
}

describe('import/pipeline — the JSON-LD fast path', () => {
  it('produces a draft with the nine fields POST /api/creator/meals accepts', async () => {
    const call = stubCaller(() => extractionFixture());
    const result = await runImport(GUAC_URL, options({ call }));

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');

    expect(Object.keys(result.draft).sort()).toEqual(
      ['difficulty', 'ingredients', 'name', 'photoUrl', 'recipe', 'serves', 'source', 'story', 'tags'].sort(),
    );
    expect(result.draft.name).toBe('Best Guacamole');
    expect(result.draft.source).toBe(GUAC_URL);
    expect(result.draft.ingredients[0]).toEqual({
      ingredientName: 'avocados',
      qty: 4,
      productQty: 4,
      unit: 'qty',
      measure: null,
      searchTerm: null,
    });
    expect(result.meta.path).toBe('json-ld');
    expect(result.meta.usedJsonLd).toBe(true);
  });

  it('skips the gate classifier because the page publishes a Recipe block', async () => {
    const call = stubCaller(() => extractionFixture());
    const result = await runImport(GUAC_URL, options({ call }));

    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.gate.source).toBe('json-ld');
    // Exactly one model call: the extraction. The gate cost nothing.
    expect(call.requests.map((r) => r.model)).toEqual([EXTRACTION_MODEL]);
    expect(result.meta.gateUsage).toBeNull();
  });

  it('assigns confidence server-side per field and per ingredient', async () => {
    const call = stubCaller(() => extractionFixture());
    const result = await runImport(GUAC_URL, options({ call }));

    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.confidence.name.level).toBe('green');     // verbatim json-ld
    expect(result.confidence.recipe.level).toBe('amber');   // normalized
    expect(result.confidence.story.level).toBe('red');      // no span
    // This page's recipeYield is a volume ("2 1/2 cups guacamole"), which is not
    // a serving count — so serves is empty and reads red rather than green.
    expect(result.confidence.serves.level).toBe('red');
    expect(result.draft.serves).toBeNull();
    expect(result.confidence.ingredients).toHaveLength(result.draft.ingredients.length);
    expect(result.confidence.ingredients[0].level).toBe('green');
  });

  it('sends a hallucinated ingredient to red while its neighbours stay green', async () => {
    const call = stubCaller(() =>
      extractionFixture({
        ingredients: [
          {
            productName: 'avocados',
            measure: '4',
            unit: 'qty',
            qty: 4,
            evidence: '4 medium ripe avocados, halved and pitted',
            derivation: 'json-ld',
          },
          {
            // A fabricated product cited to a span that is REAL and verbatim in
            // the page's JSON-LD. Pairing it with an invented span would only
            // prove we can spot an invented span.
            productName: 'smoked paprika',
            measure: '2',
            unit: 'tbsp',
            qty: 1,
            evidence: '4 medium ripe avocados, halved and pitted',
            derivation: 'json-ld',
          },
        ],
      }),
    );

    const result = await runImport(GUAC_URL, options({ call }));
    if (result.status !== 'ok') throw new Error('unreachable');

    // A 14-ingredient recipe with one bad row shows one red row.
    expect(result.confidence.ingredients.map((c) => c.level)).toEqual(['green', 'red']);
    expect(result.draft.ingredients).toHaveLength(2);
  });
});

describe('import/pipeline — the raw-HTML path (the common case)', () => {
  it('runs the gate classifier and extracts from page text', async () => {
    const call = stubCaller((request) =>
      request.model === GATE_MODEL
        ? { verdict: 'yes', reason: 'Lists ingredients and numbered steps for a chicken dish.' }
        : extractionFixture({
            name: {
              value: 'Weeknight Lemon Butter Chicken',
              evidence: 'Weeknight Lemon Butter Chicken',
              derivation: 'page-text',
            },
            ingredients: [
              {
                productName: 'butter',
                measure: '2',
                unit: 'tbsp',
                qty: 1,
                evidence: 'a knob of butter',
                derivation: 'normalized',
              },
            ],
            serves: { value: '4', evidence: 'Serves 4.', derivation: 'page-text' },
          }),
    );

    const result = await runImport(CHICKEN_URL, options({ call }));
    if (result.status !== 'ok') throw new Error('unreachable');

    expect(result.meta.path).toBe('raw-html');
    expect(result.meta.usedJsonLd).toBe(false);
    expect(call.requests.map((r) => r.model)).toEqual([GATE_MODEL, EXTRACTION_MODEL]);
    expect(result.gate.source).toBe('classifier');

    expect(result.confidence.name.level).toBe('green');
    expect(result.confidence.serves.level).toBe('green');
    // "a knob of butter" became "2 tbsp" — the span is verbatim, the value isn't.
    expect(result.confidence.ingredients[0].level).toBe('amber');
    expect(result.meta.gateUsage).not.toBeNull();
  });
});

describe('import/pipeline — rejections', () => {
  it('rejects a non-recipe page at the gate, before any extraction is billed', async () => {
    const call = stubCaller((request) => {
      if (request.model !== GATE_MODEL) throw new Error('extraction must not run');
      return { verdict: 'no', reason: 'About page: describes the author, contains no recipe.' };
    });

    const result = await runImport(ABOUT_URL, options({ call }));

    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('unreachable');
    expect(result.stage).toBe('gate');
    expect(result.detail).toMatch(/About page/);
    expect(result.gate?.reason).toBeTruthy();
    expect(call.requests.map((r) => r.model)).toEqual([GATE_MODEL]);
  });

  it('resolves the same unsure verdict differently for manual and poller callers', async () => {
    const unsure = () => ({ verdict: 'unsure', reason: 'Body is truncated; cannot confirm a recipe.' });
    const call = stubCaller((request) => (request.model === GATE_MODEL ? unsure() : extractionFixture()));

    const manual = await runImport(CHICKEN_URL, { ...options({ call }), mode: 'manual', skipCache: true });
    const poller = await runImport(CHICKEN_URL, { ...options({ call }), mode: 'poller', skipCache: true });

    expect(manual.status).toBe('ok');
    expect(poller.status).toBe('rejected');
    if (poller.status !== 'rejected') throw new Error('unreachable');
    // Silence is the correct output, but it has to be explicable.
    expect(poller.detail).toContain('Body is truncated');
    expect(poller.detail).toMatch(/skipping/i);
  });

  it('reports a bot-blocked fetch as a fetch failure, never as an extraction failure', async () => {
    const { impl } = stubFetch({
      'https://101cookbooks.example/robots.txt': { body: '' },
      'https://101cookbooks.example/soup': {
        status: 403,
        body: '<html><title>Attention Required! | Cloudflare</title></html>',
      },
    });
    const call = stubCaller(() => {
      throw new Error('no model call should happen — we never saw the page');
    });

    const result = await runImport('https://101cookbooks.example/soup', {
      ...options({ call }),
      fetchOptions: { fetchImpl: impl, lookup: publicLookup },
    });

    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('unreachable');
    expect(result.stage).toBe('fetch');
    expect(result.reason).toBe('blocked-by-site');
    expect(result.detail).toMatch(/refused our request/i);
  });

  it('rejects a link-in-bio page deterministically, with no model call at all', async () => {
    const { impl } = stubFetch({
      'https://beacons.ai/robots.txt': { body: '' },
      'https://beacons.ai/superrecipes': {
        body: '<html><title>Super Recipes</title><body><a href="/1">My latest</a></body></html>',
      },
    });
    const call = stubCaller(() => {
      throw new Error('no model call should happen');
    });

    const result = await runImport('https://beacons.ai/superrecipes', {
      ...options({ call }),
      fetchOptions: { fetchImpl: impl, lookup: publicLookup },
    });

    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('unreachable');
    expect(result.reason).toBe('link-in-bio');
    expect(result.detail).toMatch(/paste that link instead/i);
    expect(result.meta.platform).toBe('link-in-bio');
  });

  it('rejects a private address before anything else runs', async () => {
    const result = await runImport('http://169.254.169.254/latest/meta-data/', options());
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('unreachable');
    expect(result.stage).toBe('fetch');
    expect(result.reason).toBe('blocked-private-address');
  });

  it('rejects a path robots.txt disallows', async () => {
    const { impl } = stubFetch({
      'https://blog.example.com/robots.txt': { body: 'User-agent: *\nDisallow: /recipes/' },
      'https://blog.example.com/recipes/x': { body: '<html><title>x</title></html>' },
    });
    const result = await runImport('https://blog.example.com/recipes/x', {
      ...options(),
      fetchOptions: { fetchImpl: impl, lookup: publicLookup },
    });
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('unreachable');
    expect(result.stage).toBe('robots');
  });

  it('turns a missing API key into a clean rejection, not a crash', async () => {
    const result = await runImport(GUAC_URL, options({ call: failingCaller('ANTHROPIC_API_KEY is not set') }));

    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('unreachable');
    expect(result.stage).toBe('extract');
    expect(result.detail).toContain('ANTHROPIC_API_KEY');
    // The fetch and gate stages still did their work, which is what makes this
    // verifiable before a key exists.
    expect(result.gate?.verdict).toBe('yes');
    expect(result.meta.platform).toBeTruthy();
  });

  it('fails a 50 MB page inside the size cap', async () => {
    const { stream } = endlessBody();
    const { impl } = stubFetch({
      'https://big.example.com/robots.txt': { body: '' },
      'https://big.example.com/p': { body: stream },
    });
    const result = await runImport('https://big.example.com/p', {
      ...options(),
      fetchOptions: { fetchImpl: impl, lookup: publicLookup },
    });
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('unreachable');
    expect(result.reason).toBe('response-too-large');
  });
});

describe('import/pipeline — idempotency', () => {
  it('serves the same URL from cache the second time', async () => {
    const call = stubCaller(() => extractionFixture());

    const first = await runImport(GUAC_URL, options({ call }));
    const second = await runImport(`${GUAC_URL}/?utm_source=twitter`, options({ call }));

    expect(first.meta.cached).toBe(false);
    expect(second.meta.cached).toBe(true);
    // One extraction call across both, despite the differing tracking params.
    expect(call.requests.filter((r) => r.model === EXTRACTION_MODEL)).toHaveLength(1);
  });

  it('caches a gate verdict so a re-classified URL costs nothing', async () => {
    const call = stubCaller((request) =>
      request.model === GATE_MODEL
        ? { verdict: 'yes', reason: 'Recipe with ingredients and steps.' }
        : extractionFixture(),
    );

    await runImport(CHICKEN_URL, options({ call }));
    await runImport(CHICKEN_URL, { ...options({ call }), skipCache: false });

    expect(call.requests.filter((r) => r.model === GATE_MODEL)).toHaveLength(1);
  });
});

describe('import/pipeline — telemetry', () => {
  it('records platform, path and the confidence spread on success', async () => {
    const call = stubCaller(() => extractionFixture());
    await runImport(GUAC_URL, options({ call }));

    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event.outcome).toBe('ok');
    expect(event.stage).toBe('complete');
    expect(event.path).toBe('json-ld');
    expect(event.platform).toBeTruthy();
    expect(event.gateVerdict).toBe('yes');
    expect(event.gateSource).toBe('json-ld');
    expect(event.confidence).toEqual(expect.objectContaining({ green: expect.any(Number) }));
    expect(event.confidence!.green + event.confidence!.amber + event.confidence!.red).toBe(
      7 + event.ingredientCount!,
    );
    expect(event.costUsd).toBeGreaterThan(0);
  });

  it('records a line for every rejection too, with the reason', async () => {
    await runImport('http://127.0.0.1/admin', options());
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe('rejected');
    expect(events[0].stage).toBe('fetch');
    expect(events[0].reason).toBe('blocked-private-address');
  });
});

/**
 * Regressions from the external review.
 */
describe('import/pipeline — review regressions', () => {
  it('sends a fabricated value paired with a real page sentence to red, end to end', async () => {
    // The span is lifted verbatim out of the recorded page's own JSON-LD; only
    // the values lie. A span-only check reads all of this green.
    const realLine = '4 medium ripe avocados, halved and pitted';
    const call = stubCaller(() =>
      extractionFixture({
        serves: { value: '48', evidence: realLine, derivation: 'json-ld' },
        ingredients: [
          {
            productName: 'saffron threads',
            measure: '2',
            unit: 'tbsp',
            qty: 1,
            evidence: realLine,
            derivation: 'json-ld',
          },
        ],
      }),
    );

    const result = await runImport(GUAC_URL, options({ call }));
    if (result.status !== 'ok') throw new Error('unreachable');

    expect(result.confidence.serves.level).toBe('red');
    expect(result.confidence.ingredients[0].level).toBe('red');
    // The span itself matched — it is the value that failed verification.
    expect(result.confidence.ingredients[0].match).toBe('exact');
  });

  it('degrades to a slow import when the cache backend is down, rather than failing', async () => {
    const call = stubCaller(() => extractionFixture());
    const result = await runImport(GUAC_URL, {
      ...options({ call }),
      cache: brokenCache(),
    });
    expect(result.status).toBe('ok');
    expect(events).toHaveLength(1);
  });

  it('still emits telemetry when something throws unexpectedly', async () => {
    // A caller that throws a non-Anthropic error mid-pipeline: the result is a
    // rejection, and crucially it is still traced.
    const exploding = (async () => {
      throw Object.assign(new Error('kaboom'), { name: 'TypeError' });
    }) as unknown as StructuredCaller;

    const result = await runImport(CHICKEN_URL, options({ call: exploding }));

    expect(result.status).toBe('rejected');
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe('rejected');
    expect(events[0].reason).toBeTruthy();
  });
});

describe('import/telemetry — log lines cannot be forged', () => {
  it('escapes a newline in a submitted URL instead of emitting a second line', () => {
    const line = formatTelemetry({
      url: 'https://x.example.com/p\noutcome=ok stage=complete platform=forged',
      outcome: 'rejected',
      stage: 'fetch',
      reason: 'invalid-url\nreason=something-else',
      platform: null,
      path: null,
      gateVerdict: null,
      gateSource: null,
      cached: false,
      ingredientCount: null,
      confidence: null,
      costUsd: 0,
      durationMs: 1,
    });
    expect(line).not.toContain('\n');
    expect(line).toContain('\\n');
  });
});

/**
 * Photo resolution. We never hotlink: a bare third-party URL makes the
 * creator's server carry our traffic and breaks the meal silently when they
 * move the file. A source image is copied into our bucket, or Pixabay stands
 * in, or there is no photo.
 */
describe('import/pipeline — photos are never hotlinked', () => {
  const stored = 'https://storage.mealio.co/meal-photos/u1/1.jpg';

  it('emits our storage URL and green provenance when the page image is copied', async () => {
    const call = stubCaller(() => extractionFixture());
    const result = await runImport(
      GUAC_URL,
      options({
        call,
        resolvePhoto: async ({ sourceImageUrl }: { sourceImageUrl: string | null }) => ({
          url: stored,
          origin: 'copied' as const,
          sourceUrl: sourceImageUrl,
          detail: 'Copied from the image the page publishes.',
        }),
      }),
    );
    if (result.status !== 'ok') throw new Error('unreachable');

    expect(result.draft.photoUrl).toBe(stored);
    // Green, because the page really does publish this image — the provenance
    // is checked against the source URL, not against our storage URL.
    expect(result.confidence.photoUrl.level).toBe('green');
    expect(result.confidence.photoUrl.evidence).toMatch(/^https?:\/\//);
    expect(result.confidence.photoUrl.evidence).not.toBe(stored);
  });

  it('falls back to a Pixabay stand-in and marks it amber, not green', async () => {
    const call = stubCaller(() => extractionFixture());
    const result = await runImport(
      GUAC_URL,
      options({
        call,
        resolvePhoto: async () => ({
          url: stored,
          origin: 'pixabay' as const,
          sourceUrl: null,
          detail: 'We could not copy the page’s image, so this is a stock photo we picked.',
        }),
      }),
    );
    if (result.status !== 'ok') throw new Error('unreachable');

    expect(result.draft.photoUrl).toBe(stored);
    expect(result.confidence.photoUrl.level).toBe('amber');
    expect(result.confidence.photoUrl.derivation).toBe('generated');
    expect(result.confidence.photoUrl.reason).toMatch(/stock photo/i);
  });

  it('reads red when no photo could be resolved at all', async () => {
    const call = stubCaller(() => extractionFixture());
    const result = await runImport(GUAC_URL, options({ call }));
    if (result.status !== 'ok') throw new Error('unreachable');

    // No userId and no injected resolver — the default resolves nothing.
    expect(result.draft.photoUrl).toBeNull();
    expect(result.confidence.photoUrl.level).toBe('red');
  });

  it('never emits a third-party URL, whatever the page advertises', async () => {
    const call = stubCaller(() => extractionFixture());
    const result = await runImport(GUAC_URL, options({ call }));
    if (result.status !== 'ok') throw new Error('unreachable');
    // null is a correct answer here; a foreign URL never is.
    expect(result.draft.photoUrl ?? '').not.toMatch(/cookieandkate|wp-content/);
  });
});

describe('import/pipeline — serves is a people count', () => {
  it('drops a serving count the model read off a volume', async () => {
    // A model that gets it wrong: "2" cited to "2 1/2 cups guacamole". The span
    // is genuinely on the page, so a span-only check would call this green.
    const call = stubCaller(() =>
      extractionFixture({
        serves: { value: '2', evidence: '2 1/2 cups guacamole', derivation: 'json-ld' },
      }),
    );
    const result = await runImport(GUAC_URL, options({ call }));
    if (result.status !== 'ok') throw new Error('unreachable');

    expect(result.draft.serves).toBeNull();
    expect(result.confidence.serves.level).toBe('red');
  });

  it('keeps a genuine people count in the form’s shape', async () => {
    const call = stubCaller((request) =>
      request.model === GATE_MODEL
        ? { verdict: 'yes', reason: 'recipe' }
        : extractionFixture({
            serves: { value: '4', evidence: 'Serves 4.', derivation: 'page-text' },
          }),
    );
    const result = await runImport(CHICKEN_URL, options({ call }));
    if (result.status !== 'ok') throw new Error('unreachable');

    expect(result.draft.serves).toBe('4');
    expect(result.draft.serves).toMatch(/^\d+(-\d+)?$/);
    expect(result.confidence.serves.level).toBe('green');
  });

  it('accepts a range and normalises prose around it', async () => {
    const call = stubCaller((request) =>
      request.model === GATE_MODEL
        ? { verdict: 'yes', reason: 'recipe' }
        : extractionFixture({
            serves: { value: '4-6 servings', evidence: 'Serves 4-6', derivation: 'page-text' },
          }),
    );
    const result = await runImport(CHICKEN_URL, options({ call }));
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.draft.serves).toBe('4-6');
  });
});

/**
 * End to end against the recorded page, driving the whole pipeline rather than
 * unit-testing `assessField`. The recorded cookieandkate fixture carries 345
 * reader comments; while they counted as "the source", anything quoted from one
 * read green — and green renders as no marker at all.
 */
describe('import/pipeline — reader comments cannot launder a hallucination', () => {
  /** Lifted verbatim from the comment thread of the recorded fixture. */
  const COMMENT_SPANS = {
    tomato: 'roma tomatoes',
    cayenne: 'cayenne',
  };

  it('does not read green for an ingredient quoted out of the comment thread', async () => {
    const document = toSourceDocument(GUAC_URL, readHtmlFixture('cookieandkate-guacamole.html'));

    // Find a sentence that really is in the comments and really is not in the
    // recipe, so the test cannot pass by accident.
    const commentSentence = document.text
      .split('\n')
      .find(
        (line) =>
          line.toLowerCase().includes(COMMENT_SPANS.tomato) &&
          !document.recipeText.toLowerCase().includes(line.toLowerCase().trim()) &&
          line.trim().length > 25,
      );
    expect(commentSentence, 'fixture should contain a tomato comment').toBeTruthy();

    const call = stubCaller(() =>
      extractionFixture({
        ingredients: [
          {
            productName: 'roma tomatoes',
            measure: '2',
            unit: 'qty',
            qty: 2,
            evidence: commentSentence!.trim(),
            derivation: 'page-text',
          },
        ],
      }),
    );

    const result = await runImport(GUAC_URL, options({ call }));
    if (result.status !== 'ok') throw new Error('unreachable');

    // The recipe says to skip the tomato; a reader suggested adding one. This
    // must never be presented as verified.
    expect(result.confidence.ingredients[0].level).not.toBe('green');
    expect(result.confidence.ingredients[0].reason).toMatch(/outside the recipe/i);
  });

  it('drops the comment thread from the verification corpus entirely', () => {
    const document = toSourceDocument(GUAC_URL, readHtmlFixture('cookieandkate-guacamole.html'));
    // Present on the page…
    expect(document.text.toLowerCase()).toContain(COMMENT_SPANS.tomato);
    expect(document.text.toLowerCase()).toContain(COMMENT_SPANS.cayenne);
    // …absent from the recipe region.
    expect(document.recipeText.toLowerCase()).not.toContain(COMMENT_SPANS.tomato);
    expect(document.recipeText.toLowerCase()).not.toContain(COMMENT_SPANS.cayenne);
    // …while the recipe itself survives.
    expect(document.recipeText.toLowerCase()).toContain('avocado');
    expect(document.recipeText.length).toBeGreaterThan(2000);
  });

  it('keeps a genuine recipe-body value green', async () => {
    const call = stubCaller(() => extractionFixture());
    const result = await runImport(GUAC_URL, options({ call }));
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.confidence.name.level).toBe('green');
    expect(result.confidence.ingredients[0].level).toBe('green');
  });
});

/**
 * The `document` seam (MEAL-74). Not every source is a page: a YouTube video's
 * document is its title, description and captions, and fetching `watch?v=…`
 * gets a JavaScript shell with no recipe in it.
 */
describe('import/pipeline — a caller-supplied document', () => {
  const WATCH_URL = 'https://www.youtube.com/watch?v=abc12345678';
  const SHELL = '<html><head><title>Perfect Guacamole</title></head><body><div id="app">Loading…</div></body></html>';

  // Past the gate's 250-character thin-content floor, the way a real
  // description with an ingredient list in it is.
  const videoText = [
    'Ingredients:',
    '4 medium ripe avocados, halved and pitted',
    '1 lime, juiced',
    '1/2 small white onion, finely chopped',
    '2 tablespoons chopped fresh cilantro',
    '1/2 teaspoon fine sea salt, plus more to taste',
    '',
    'Scoop the avocados into a bowl and mash them with a fork until mostly smooth.',
    'Stir through the lime juice, onion, cilantro and salt, then taste and adjust.',
    'Serve straight away with tortilla chips.',
  ].join('\n');

  const videoDocument = (): SourceDocument => ({
    url: WATCH_URL,
    title: 'Perfect Guacamole',
    text: videoText,
    recipeText: videoText,
    jsonLd: null,
    structuredSource: null,
    jsonLdRaw: null,
    imageUrl: null,
    platform: 'youtube',
  });

  function videoOptions(overrides: Record<string, unknown> = {}) {
    const { impl } = stubFetch({
      'https://www.youtube.com/robots.txt': { body: '' },
      [WATCH_URL]: { body: SHELL },
    });
    return {
      cache,
      telemetry: (event: ImportTelemetry) => events.push(event),
      fetchOptions: { fetchImpl: impl, lookup: publicLookup },
      ...overrides,
    };
  }

  const recipeCaller = () =>
    stubCaller((request) =>
      request.model === GATE_MODEL
        ? { verdict: 'yes', reason: 'Ingredients and a method.' }
        : extractionFixture(),
    );

  it('is gated on its own content, not on the shell already cached for that URL', async () => {
    const call = recipeCaller();

    const shell = await runImport(WATCH_URL, videoOptions({ call }));
    expect(shell.status).toBe('rejected');

    const supplied = await runImport(WATCH_URL, videoOptions({ call, document: videoDocument() }));

    // Both keys were the URL alone, and the cache read came before the
    // `document` branch — so the shell's "not a recipe" was served straight
    // back for the real document, `call` was never reached, and the seam that
    // exists to prevent exactly this failure reproduced it.
    expect(supplied.meta.cached).toBe(false);
    expect(supplied.status).toBe('ok');
  });

  it('does not let a verdict earned from a document decide for the page', async () => {
    const call = recipeCaller();

    const supplied = await runImport(WATCH_URL, videoOptions({ call, document: videoDocument() }));
    expect(supplied.status).toBe('ok');

    const page = await runImport(WATCH_URL, videoOptions({ call }));

    // The other direction of the same collision: a video gated "yes" from its
    // description used to make a later shell fetch skip the gate and extract a
    // recipe from an empty page.
    expect(page.status).toBe('rejected');
  });

  it('still serves an identical document from cache the second time', async () => {
    const call = recipeCaller();

    const first = await runImport(WATCH_URL, videoOptions({ call, document: videoDocument() }));
    const second = await runImport(WATCH_URL, videoOptions({ call, document: videoDocument() }));

    // The admin sync re-reads the same feed; keying on content must not cost
    // idempotency for the case the cache was built for.
    expect(first.meta.cached).toBe(false);
    expect(second.meta.cached).toBe(true);
  });
});
