// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { ImportRejection, ImportSuccess } from '@/lib/import/types';
import { importedGuacamole } from '../helpers/import-ui-fixtures';

/**
 * Link → published meal, through the real creator portal.
 *
 * The import response is the one the real pipeline produces over a recorded
 * page (see `import-ui-fixtures`), so the markers under test are the levels
 * MEAL-72 actually computed rather than a hand-written guess at them.
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/components/AppHeader', () => ({ default: () => null }));
vi.mock('@/components/AppFooter', () => ({ default: () => null }));

const CreatorPortal = (await import('@/app/creator/page')).default;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Routes {
  import?: () => Response;
}

let published: Record<string, unknown> | null;

function stubApi(routes: Routes = {}) {
  published = null;
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/auth/verify')) return json({ ok: true });
    if (url.includes('/api/creator/meals')) {
      published = JSON.parse(String(init?.body));
      return json({ meal: { id: 'm1', name: published!.name } }, 201);
    }
    // Checked after /meals: '/api/creator/meals'.includes('/api/creator/me').
    if (url.includes('/api/creator/me')) {
      return json({
        creator: {
          id: 'c1', display_name: 'Kate', bio: null, social_handle: null,
          photo_url: null, approved_at: '2026-01-01', handle: null,
        },
        meals: [],
        stats: null,
      });
    }
    if (url.includes('/api/creator/import')) {
      return routes.import?.() ?? json({ error: 'no route' }, 500);
    }
    // Everything else (the cross-origin photo re-upload attempt) fails the way
    // a real cross-origin image read would.
    return new Response('nope', { status: 403 });
  }) as typeof fetch;
  vi.stubGlobal('fetch', impl);
}

async function openPublishForm() {
  render(<CreatorPortal />);
  const openButton = await screen.findByRole('button', { name: /publish new meal/i });
  fireEvent.click(openButton);
  return await screen.findByTestId('import-link-bar');
}

async function importFrom(url: string) {
  fireEvent.change(screen.getByLabelText('Recipe link to import'), { target: { value: url } });
  fireEvent.click(screen.getByRole('button', { name: 'Import' }));
}

beforeEach(() => { localStorage.setItem('accessToken', 'test-token'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('creator portal — link to published meal', () => {
  let success: ImportSuccess;
  beforeEach(async () => { success = await importedGuacamole(); });

  it('fills the publish form from a pasted link', async () => {
    stubApi({ import: () => json(success, 200) });
    await openPublishForm();
    await importFrom('https://cookieandkate.com/best-guacamole-recipe');

    await screen.findByTestId('import-summary');

    expect((screen.getByPlaceholderText('e.g. Spicy Chicken Ramen') as HTMLInputElement).value)
      .toBe('Best Guacamole');
    expect((screen.getByPlaceholderText('https://yourblog.com/recipe') as HTMLInputElement).value)
      .toBe(success.url);

    const rows = screen.getAllByPlaceholderText('Ingredient name') as HTMLInputElement[];
    expect(rows.map(r => r.value)).toEqual(['avocados', 'lime juice', 'smoked paprika']);
    expect((screen.getByPlaceholderText('e.g. 4 or 2-4') as HTMLInputElement).value).toBe('2');
  });

  it('summarises the import as counts a creator can act on', async () => {
    stubApi({ import: () => json(success, 200) });
    await openPublishForm();
    await importFrom('https://cookieandkate.com/best-guacamole-recipe');

    const summary = await screen.findByTestId('import-summary');
    expect(summary.textContent).toContain('Filled from cookieandkate.com');
    expect(summary.textContent).toMatch(/from the source/);
    expect(summary.textContent).toMatch(/to check/);
    expect(summary.textContent).toMatch(/structured recipe data/);
    // Not a self-reported score. See MEAL-72.
    expect(summary.textContent).not.toMatch(/\d+% confident/);
  });

  it('gives every filled field a marker, and every marker its evidence', async () => {
    stubApi({ import: () => json(success, 200) });
    await openPublishForm();
    await importFrom('https://cookieandkate.com/best-guacamole-recipe');
    await screen.findByTestId('import-summary');

    for (const name of ['Meal name', 'Serves', 'Recipe instructions', 'Tags', 'Difficulty', 'Story']) {
      const marker = screen.getByRole('button', { name: new RegExp(`^${name}:`) });
      fireEvent.click(marker);
      const panel = await screen.findByRole('note');
      // Either the span it came from, or an honest statement that there isn't one.
      expect(panel.textContent).toMatch(/We got this from:|Nothing on the page backed this up/);
      fireEvent.click(marker);
    }
  });

  it('marks the hallucinated ingredient red, per row, and quotes what failed', async () => {
    stubApi({ import: () => json(success, 200) });
    await openPublishForm();
    await importFrom('https://cookieandkate.com/best-guacamole-recipe');
    await screen.findByTestId('import-summary');

    // Row 3 is "smoked paprika", which appears nowhere on the recorded page.
    const marker = screen.getByRole('button', { name: /Ingredient 3, smoked paprika/ });
    expect(marker.getAttribute('aria-label')).toContain('Unverified');
    fireEvent.click(marker);
    expect((await screen.findByRole('note')).textContent).toContain('1 teaspoon smoked paprika');

    // …while row 1 came straight out of the page's structured data.
    expect(screen.getByRole('button', { name: /Ingredient 1, avocados/ }).getAttribute('aria-label'))
      .toContain('From the source');
  });

  it('publishes with a red field left in place — markers inform, they do not validate', async () => {
    stubApi({ import: () => json(success, 200) });
    await openPublishForm();
    await importFrom('https://cookieandkate.com/best-guacamole-recipe');
    await screen.findByTestId('import-summary');

    fireEvent.click(screen.getByRole('button', { name: /^publish meal$/i }));

    await waitFor(() => expect(published).not.toBeNull());
    expect(published!.name).toBe('Best Guacamole');
    expect((published!.ingredients as { ingredientName: string }[]).map(i => i.ingredientName))
      .toContain('smoked paprika');
    expect(published!.source).toBe(success.url);
    expect(published!.serves).toBe('2');
  });

  it('lets a creator fix a red field and publish their own value', async () => {
    stubApi({ import: () => json(success, 200) });
    await openPublishForm();
    await importFrom('https://cookieandkate.com/best-guacamole-recipe');
    await screen.findByTestId('import-summary');

    const rows = screen.getAllByPlaceholderText('Ingredient name') as HTMLInputElement[];
    fireEvent.change(rows[2], { target: { value: 'kosher salt' } });

    // Editing the row retires its marker — the value is the creator's now.
    expect(screen.queryByRole('button', { name: /Ingredient 3, smoked paprika/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Ingredient 3, kosher salt/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^publish meal$/i }));
    await waitFor(() => expect(published).not.toBeNull());
    expect((published!.ingredients as { ingredientName: string }[]).map(i => i.ingredientName))
      .toEqual(['avocados', 'lime juice', 'kosher salt']);
  });

  it('retires a scalar field’s marker when it is edited', async () => {
    stubApi({ import: () => json(success, 200) });
    await openPublishForm();
    await importFrom('https://cookieandkate.com/best-guacamole-recipe');
    await screen.findByTestId('import-summary');

    expect(screen.queryByRole('button', { name: /^Meal name:/ })).not.toBeNull();
    fireEvent.change(screen.getByPlaceholderText('e.g. Spicy Chicken Ramen'), {
      target: { value: 'Kate’s Guacamole' },
    });
    expect(screen.queryByRole('button', { name: /^Meal name:/ })).toBeNull();
  });

  it('start-over empties the form completely', async () => {
    stubApi({ import: () => json(success, 200) });
    await openPublishForm();
    await importFrom('https://cookieandkate.com/best-guacamole-recipe');
    await screen.findByTestId('import-summary');

    fireEvent.click(screen.getByRole('button', { name: /clear and start over/i }));

    expect((screen.getByPlaceholderText('e.g. Spicy Chicken Ramen') as HTMLInputElement).value).toBe('');
    expect(screen.getAllByPlaceholderText('Ingredient name')).toHaveLength(1);
    expect(screen.queryByTestId('import-summary')).toBeNull();
  });
});

describe('creator portal — a failed import leaves the creator no worse off', () => {
  const rejection: ImportRejection = {
    status: 'rejected',
    url: 'https://cookieandkate.com/best-guacamole-recipe',
    stage: 'extract',
    reason: 'extraction-failed',
    detail: 'The import service is not configured (ANTHROPIC_API_KEY is not set).',
    meta: { cached: false },
  };

  it('returns an empty form with an explanation, never a half-filled one', async () => {
    stubApi({ import: () => json(rejection, 422) });
    await openPublishForm();
    await importFrom('https://cookieandkate.com/best-guacamole-recipe');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('ANTHROPIC_API_KEY is not set');

    expect((screen.getByPlaceholderText('e.g. Spicy Chicken Ramen') as HTMLInputElement).value).toBe('');
    expect(screen.getAllByPlaceholderText('Ingredient name')).toHaveLength(1);
    expect((screen.getAllByPlaceholderText('Ingredient name')[0] as HTMLInputElement).value).toBe('');
    expect(screen.queryByTestId('import-summary')).toBeNull();
    // No markers at all — nothing on screen came from us.
    expect(screen.queryAllByRole('button', { name: /: (From the source|Adjusted|Unverified|Not found)/ }))
      .toHaveLength(0);
  });

  it('keeps the pasted link in Recipe URL so nothing is retyped', async () => {
    stubApi({ import: () => json(rejection, 422) });
    await openPublishForm();
    await importFrom('cookieandkate.com/best-guacamole-recipe');

    await screen.findByRole('alert');
    expect((screen.getByPlaceholderText('https://yourblog.com/recipe') as HTMLInputElement).value)
      .toBe('https://cookieandkate.com/best-guacamole-recipe');
  });

  it('still publishes a hand-typed meal after a failed import', async () => {
    stubApi({ import: () => json(rejection, 422) });
    await openPublishForm();
    await importFrom('https://cookieandkate.com/best-guacamole-recipe');
    await screen.findByRole('alert');

    fireEvent.change(screen.getByPlaceholderText('e.g. Spicy Chicken Ramen'), { target: { value: 'Guacamole' } });
    fireEvent.change(screen.getAllByPlaceholderText('Ingredient name')[0], { target: { value: 'avocados' } });
    fireEvent.click(screen.getByRole('button', { name: /^publish meal$/i }));

    await waitFor(() => expect(published).not.toBeNull());
    expect(published!.name).toBe('Guacamole');
  });
});

describe('creator portal — The One Tap Rule', () => {
  it('keeps Publish as the only Signal Red action while a draft is on screen', async () => {
    const success = await importedGuacamole();
    stubApi({ import: () => json(success, 200) });
    await openPublishForm();
    await importFrom('https://cookieandkate.com/best-guacamole-recipe');
    const summary = await screen.findByTestId('import-summary');

    const bar = screen.getByTestId('import-link-bar');
    for (const region of [bar, summary]) {
      expect(region.outerHTML.toLowerCase()).not.toContain('#dd0031');
    }

    // The markers are status, not actions: none of them is a filled accent control.
    const markers = screen.getAllByRole('button', { name: /: (From the source|Adjusted|Unverified|Not found)/ });
    expect(markers.length).toBeGreaterThan(0);
    for (const marker of markers) {
      expect((marker as HTMLElement).style.background).not.toBe('rgb(221, 0, 49)');
    }

    const publish = screen.getByRole('button', { name: /^publish meal$/i });
    expect(within(publish.parentElement!).getByRole('button', { name: /^publish meal$/i })).toBeTruthy();
    expect(publish.className).toContain('bg-red-600');
  });
});
