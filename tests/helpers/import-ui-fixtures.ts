import { runImport } from '@/lib/import/pipeline';
import { MemoryImportCache } from '@/lib/import/cache';
import type { ImportSuccess } from '@/lib/import/types';
import type { PhotoResolver } from '@/lib/import/photo';
import { extractionFixture, publicLookup, readHtmlFixture, stubCaller, stubFetch } from './import-stubs';

/**
 * A real `ImportSuccess`, built by running the real pipeline (MEAL-70/71/72)
 * over a recorded page with a stubbed model.
 *
 * The UI tests consume this rather than a hand-written literal, so they are
 * checking the contract the endpoint actually returns — including the levels
 * MEAL-72 computed, which is the thing the markers claim to show. No network,
 * no API key.
 */

export const GUAC_URL = 'https://cookieandkate.com/best-guacamole-recipe';

/** The image the recorded page publishes, and where a copy of it would live. */
export const GUAC_SOURCE_IMAGE =
  'https://cookieandkate.com/images/2017/04/best-guacamole-recipe-225x225.jpg';
export const GUAC_STORED_IMAGE =
  'https://storage.mealio.co/meal-photos/cookieandkate-guacamole.jpg';

/** What production does for a page that publishes a usable image: copy it to our storage. */
export const copiedPhotoResolver: PhotoResolver = async ({ sourceImageUrl }) => ({
  url: GUAC_STORED_IMAGE,
  origin: 'copied',
  sourceUrl: sourceImageUrl,
  detail: 'Copied the image the page publishes.',
});

/** What production does when the page has no usable image. */
export const pixabayPhotoResolver: PhotoResolver = async () => ({
  url: 'https://storage.mealio.co/meal-photos/stock-guacamole.jpg',
  origin: 'pixabay',
  sourceUrl: null,
  detail: 'No usable image on the page — this is a stock photo we picked.',
});

/**
 * The extraction the stub returns. Chosen to land one field on each level so
 * every notice state is exercised:
 *
 *   green   name, photo, avocados  — verbatim from the page's JSON-LD
 *   amber   recipe, lime juice, difficulty, tags — restated or judged
 *   red     smoked paprika  — a deliberate hallucination, no such span on the page
 *   absent  story, serves   — nothing on the page to take
 *
 * `serves` is worth spelling out. This page's `recipeYield` is
 * `"2 1/2 cups guacamole"` — a volume, and the only yield it publishes. A model
 * that cites that span honestly gets its value dropped by `canonicalizeServes`,
 * because a volume is not a head count, so Serves ends up empty. That is the
 * correct outcome for this page, and the fixture cites the real span rather
 * than a convenient one so the guard is exercised instead of side-stepped.
 */
export function guacamoleExtraction() {
  return extractionFixture({
    name: { value: 'Best Guacamole', evidence: 'Best Guacamole', derivation: 'json-ld' },
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
        productName: 'lime juice',
        measure: '3',
        unit: 'tbsp',
        qty: 1,
        evidence: '3 tablespoons lime juice (from about 1 ½ limes), or more if needed',
        derivation: 'normalized',
      },
      {
        // Nowhere on the page. Must come back red without anyone special-casing it.
        productName: 'smoked paprika',
        measure: '1',
        unit: 'tsp',
        qty: 1,
        evidence: '1 teaspoon smoked paprika',
        derivation: 'page-text',
      },
    ],
    recipe: {
      value: '1. Scoop the avocados into a bowl.\n2. Mash to the texture you like.',
      evidence: 'Using a spoon, scoop the flesh of the avocados into a low serving bowl',
      derivation: 'normalized',
    },
    story: { value: '', evidence: null, derivation: 'absent' },
    difficulty: { value: 1, evidence: 'mash up the avocado until it reaches your desired texture', derivation: 'inferred' },
    tags: { value: ['Mexican', 'No Cook', 'Appetizer'], evidence: 'guacamole', derivation: 'inferred' },
    // The real span from the page's structured data — a volume, not a head count.
    serves: { value: '2', evidence: '2 1/2 cups guacamole', derivation: 'json-ld' },
  });
}

export async function importedGuacamole(
  extraction: Record<string, unknown> = guacamoleExtraction(),
  resolvePhoto: PhotoResolver = copiedPhotoResolver,
): Promise<ImportSuccess> {
  const { impl } = stubFetch({
    'https://cookieandkate.com/robots.txt': { body: 'User-agent: *\nDisallow: /wp-admin/' },
    [GUAC_URL]: { body: readHtmlFixture('cookieandkate-guacamole.html') },
  });

  const result = await runImport(GUAC_URL, {
    cache: new MemoryImportCache(),
    call: stubCaller(() => extraction),
    resolvePhoto,
    fetchOptions: { fetchImpl: impl, lookup: publicLookup },
  });

  if (result.status !== 'ok') {
    throw new Error(`fixture import unexpectedly rejected: ${result.stage} ${result.reason}`);
  }
  return result;
}
