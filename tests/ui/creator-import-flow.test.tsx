// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ImportRejection, ImportSuccess } from '@/lib/import/types';
import { importedGuacamole } from '../helpers/import-ui-fixtures';

/**
 * Link → published meal, through the real creator portal.
 *
 * The import response is the one the real pipeline produces over a recorded
 * page (see `import-ui-fixtures`), so the levels driving what gets flagged are
 * the ones MEAL-72 actually computed rather than a hand-written guess at them.
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/components/AppHeader', () => ({ default: () => null }));
vi.mock('@/components/AppFooter', () => ({ default: () => null }));

const CreatorPortal = (await import('@/app/creator/page')).default;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Routes {
  import?: () => Response | Promise<Response>;
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
    return new Response('nope', { status: 403 });
  }) as typeof fetch;
  vi.stubGlobal('fetch', impl);
}

async function openPublishForm() {
  render(<CreatorPortal />);
  fireEvent.click(await screen.findByRole('button', { name: /publish new meal/i }));
  return await screen.findByTestId('import-link-bar');
}

async function importFrom(url: string) {
  fireEvent.change(screen.getByLabelText('Recipe link to import'), { target: { value: url } });
  fireEvent.click(screen.getByRole('button', { name: 'Import' }));
}

const nameBox = () => screen.getByPlaceholderText('e.g. Spicy Chicken Ramen') as HTMLInputElement;
const sourceBox = () => screen.getByPlaceholderText('https://yourblog.com/recipe') as HTMLInputElement;
const servesBox = () => screen.getByPlaceholderText('e.g. 4 or 2-4') as HTMLInputElement;
const storyBox = () => screen.getByPlaceholderText(/The story behind the meal/) as HTMLTextAreaElement;
const rows = () => screen.getAllByPlaceholderText('Ingredient name') as HTMLInputElement[];
const notices = () => screen.queryAllByTestId('import-notice');

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

    expect(nameBox().value).toBe('Best Guacamole');
    expect(sourceBox().value).toBe(success.url);
    expect(rows().map(r => r.value)).toEqual(['avocados', 'lime juice', 'smoked paprika']);
    expect(servesBox().value).toBe('2');
  });

  it('summarises the import as counts, and counts verified honestly', async () => {
    stubApi({ import: () => json(success, 200) });
    await openPublishForm();
    await importFrom('https://cookieandkate.com/best-guacamole-recipe');

    const summary = await screen.findByTestId('import-summary');
    expect(summary.textContent).toMatch(/Filled \d+ fields from cookieandkate\.com/);
    expect(summary.textContent).toMatch(/\d+ verified · \d+ need a look/);
    expect(summary.textContent).toMatch(/structured recipe data/);
    // Not a self-reported score. See MEAL-72.
    expect(summary.textContent).not.toMatch(/\d+% confident/);
  });
});

describe('creator portal — only the exceptions are marked', () => {
  let success: ImportSuccess;
  beforeEach(async () => { success = await importedGuacamole(); });

  it('says nothing at all about a field it verified', async () => {
    stubApi({ import: () => json(success, 200) });
    await openPublishForm();
    await importFrom('https://cookieandkate.com/best-guacamole-recipe');
    await screen.findByTestId('import-summary');

    // Name and row 1 both came verbatim out of the page's structured data, so
    // there is nothing beside them — silence is the signal.
    const flaggedText = notices().map(n => n.textContent).join(' ');
    expect(flaggedText).not.toContain('Best Guacamole');
    expect(flaggedText).not.toContain('4 medium ripe avocados');

    // Fewer flags than fields the import touched — seven scalars and three
    // rows here. (This fixture is deliberately adversarial, landing one field
    // on every level; a real import is mostly green and mostly silent.)
    expect(notices().length).toBeLessThan(10);

    // Specifically: the fields whose spans checked out say nothing.
    const flaggedBoxes = notices().map(n => n.previousElementSibling);
    expect(flaggedBoxes).not.toContain(nameBox());
    expect(flaggedBoxes).not.toContain(servesBox());
  });

  it('quotes the source span under an adjusted field', async () => {
    stubApi({ import: () => json(success, 200) });
    await openPublishForm();
    await importFrom('https://cookieandkate.com/best-guacamole-recipe');
    await screen.findByTestId('import-summary');

    const adjusted = notices().filter(n => n.dataset.kind === 'adjusted');
    expect(adjusted.length).toBeGreaterThan(0);
    // The creator reads the evidence directly instead of decoding a symbol.
    const limeRow = adjusted.find(n => n.textContent?.includes('lime'));
    expect(limeRow!.textContent).toContain('we read:');
    expect(limeRow!.textContent).toContain('3 tablespoons lime juice');
  });

  it('flags the hallucinated ingredient, keeps its value, and quotes what failed', async () => {
    stubApi({ import: () => json(success, 200) });
    await openPublishForm();
    await importFrom('https://cookieandkate.com/best-guacamole-recipe');
    await screen.findByTestId('import-summary');

    const unverified = notices().filter(n => n.dataset.kind === 'unverified');
    expect(unverified).toHaveLength(1);
    expect(unverified[0].textContent).toMatch(/couldn’t find this in the source/);
    expect(unverified[0].textContent).toContain('1 teaspoon smoked paprika');

    // Red does not mean deleted — the row is still there and still editable.
    expect(rows()[2].value).toBe('smoked paprika');
  });

  it('asks the creator to add a field the source did not have', async () => {
    stubApi({ import: () => json(success, 200) });
    await openPublishForm();
    await importFrom('https://cookieandkate.com/best-guacamole-recipe');
    await screen.findByTestId('import-summary');

    const absent = notices().filter(n => n.dataset.kind === 'absent');
    expect(absent.length).toBeGreaterThan(0);
    expect(absent[0].textContent).toContain('Not found in the source — add this');
    // The fixture's story is absent, so the box stays empty and asks for input.
    expect(storyBox().value).toBe('');
  });

  it('retires a flag as soon as the creator edits that field', async () => {
    stubApi({ import: () => json(success, 200) });
    await openPublishForm();
    await importFrom('https://cookieandkate.com/best-guacamole-recipe');
    await screen.findByTestId('import-summary');

    const before = notices().length;
    fireEvent.change(rows()[2], { target: { value: 'kosher salt' } });

    expect(notices()).toHaveLength(before - 1);
    expect(notices().filter(n => n.dataset.kind === 'unverified')).toHaveLength(0);
  });

  it('publishes an unverified value untouched — flags inform, they do not validate', async () => {
    stubApi({ import: () => json(success, 200) });
    await openPublishForm();
    await importFrom('https://cookieandkate.com/best-guacamole-recipe');
    await screen.findByTestId('import-summary');

    fireEvent.click(screen.getByRole('button', { name: /^publish meal$/i }));

    await waitFor(() => expect(published).not.toBeNull());
    expect(published!.name).toBe('Best Guacamole');
    expect((published!.ingredients as { ingredientName: string }[]).map(i => i.ingredientName))
      .toContain('smoked paprika');
    expect(published!.serves).toBe('2');
  });

  it('lets a creator fix a flagged row and publish their own value', async () => {
    stubApi({ import: () => json(success, 200) });
    await openPublishForm();
    await importFrom('https://cookieandkate.com/best-guacamole-recipe');
    await screen.findByTestId('import-summary');

    fireEvent.change(rows()[2], { target: { value: 'kosher salt' } });
    fireEvent.click(screen.getByRole('button', { name: /^publish meal$/i }));

    await waitFor(() => expect(published).not.toBeNull());
    expect((published!.ingredients as { ingredientName: string }[]).map(i => i.ingredientName))
      .toEqual(['avocados', 'lime juice', 'kosher salt']);
  });

  it('start-over empties the form completely', async () => {
    stubApi({ import: () => json(success, 200) });
    await openPublishForm();
    await importFrom('https://cookieandkate.com/best-guacamole-recipe');
    await screen.findByTestId('import-summary');

    fireEvent.click(screen.getByRole('button', { name: /clear and start over/i }));

    expect(nameBox().value).toBe('');
    expect(rows()).toHaveLength(1);
    expect(screen.queryByTestId('import-summary')).toBeNull();
    expect(notices()).toHaveLength(0);
  });
});

describe('creator portal — a generated photo is a placeholder, not a finding', () => {
  async function withGeneratedPhoto() {
    const success = await importedGuacamole();
    // What the pipeline emits when the page had no usable image: our own stored
    // URL, marked amber, with a reason written to be shown as-is.
    (success.draft as { photoUrl: string | null }).photoUrl =
      'https://storage.mealio.co/meal-photos/stock-guacamole.jpg';
    success.confidence.photoUrl = {
      level: 'amber',
      derivation: 'generated',
      match: 'none',
      score: 0,
      evidence: null,
      reason: 'No usable image on the page — this is a stock photo we picked.',
    };
    return success;
  }

  it('says the photo is ours, and how to replace it', async () => {
    stubApi({ import: async () => json(await withGeneratedPhoto(), 200) });
    await openPublishForm();
    await importFrom('https://cookieandkate.com/best-guacamole-recipe');
    await screen.findByTestId('import-summary');

    const generated = notices().find(n => n.dataset.kind === 'generated');
    // The pipeline's reason, verbatim.
    expect(generated!.textContent).toContain('No usable image on the page — this is a stock photo we picked.');

    const hint = screen.getByTestId('photo-replace-hint');
    expect(hint.textContent).toMatch(/Choose photo/);
    expect(hint.textContent).toMatch(/Generate photo/);
  });

  it('does not count it as verified', async () => {
    stubApi({ import: async () => json(await withGeneratedPhoto(), 200) });
    await openPublishForm();
    await importFrom('https://cookieandkate.com/best-guacamole-recipe');

    const summary = await screen.findByTestId('import-summary');
    const verified = Number(/(\d+) verified/.exec(summary.textContent!)![1]);
    const needALook = Number(/(\d+) need a look/.exec(summary.textContent!)![1]);
    expect(needALook).toBeGreaterThanOrEqual(2); // the stand-in photo, plus the hallucinated row
    expect(verified).toBeGreaterThan(0);
  });

  it('publishes our stored URL as-is, never a third-party one', async () => {
    stubApi({ import: async () => json(await withGeneratedPhoto(), 200) });
    await openPublishForm();
    await importFrom('https://cookieandkate.com/best-guacamole-recipe');
    await screen.findByTestId('import-summary');

    fireEvent.click(screen.getByRole('button', { name: /^publish meal$/i }));
    await waitFor(() => expect(published).not.toBeNull());
    expect(published!.photoUrl).toBe('https://storage.mealio.co/meal-photos/stock-guacamole.jpg');
  });
});

describe('creator portal — an import never destroys the creator’s own work', () => {
  const rejection: ImportRejection = {
    status: 'rejected',
    url: 'https://cookieandkate.com/best-guacamole-recipe',
    stage: 'extract',
    reason: 'extraction-failed',
    detail: 'The import service is not configured (ANTHROPIC_API_KEY is not set).',
    meta: { cached: false },
  };

  it('keeps a half-typed meal when the import is rejected', async () => {
    // The path every real request takes while there is no API key. Wiping the
    // form here is the exact inverse of "never worse off than without us".
    stubApi({ import: () => json(rejection, 422) });
    await openPublishForm();

    fireEvent.change(nameBox(), { target: { value: 'Nana’s Guacamole' } });
    fireEvent.change(storyBox(), { target: { value: 'The one she made every summer.' } });
    fireEvent.change(rows()[0], { target: { value: 'avocados' } });

    await importFrom('https://cookieandkate.com/best-guacamole-recipe');
    const alert = await screen.findByRole('alert');

    expect(alert.textContent).toContain('ANTHROPIC_API_KEY is not set');
    expect(nameBox().value).toBe('Nana’s Guacamole');
    expect(storyBox().value).toBe('The one she made every summer.');
    expect(rows()[0].value).toBe('avocados');
    expect(notices()).toHaveLength(0);
  });

  it('leaves an empty form empty, with the pasted link kept', async () => {
    stubApi({ import: () => json(rejection, 422) });
    await openPublishForm();
    await importFrom('cookieandkate.com/best-guacamole-recipe');

    await screen.findByRole('alert');
    expect(nameBox().value).toBe('');
    expect(rows()).toHaveLength(1);
    expect(rows()[0].value).toBe('');
    expect(screen.queryByTestId('import-summary')).toBeNull();
    expect(sourceBox().value).toBe('https://cookieandkate.com/best-guacamole-recipe');
  });

  it('does not overwrite a Recipe URL the creator already typed', async () => {
    stubApi({ import: () => json(rejection, 422) });
    await openPublishForm();
    fireEvent.change(sourceBox(), { target: { value: 'https://myblog.example/mine' } });

    await importFrom('https://cookieandkate.com/best-guacamole-recipe');
    await screen.findByRole('alert');
    expect(sourceBox().value).toBe('https://myblog.example/mine');
  });

  it('still publishes a hand-typed meal after a failed import', async () => {
    stubApi({ import: () => json(rejection, 422) });
    await openPublishForm();
    await importFrom('https://cookieandkate.com/best-guacamole-recipe');
    await screen.findByRole('alert');

    fireEvent.change(nameBox(), { target: { value: 'Guacamole' } });
    fireEvent.change(rows()[0], { target: { value: 'avocados' } });
    fireEvent.click(screen.getByRole('button', { name: /^publish meal$/i }));

    await waitFor(() => expect(published).not.toBeNull());
    expect(published!.name).toBe('Guacamole');
  });

  it('leaves a field the creator filled that the import has nothing for', async () => {
    const success = await importedGuacamole();
    stubApi({ import: () => json(success, 200) });
    await openPublishForm();

    // The fixture has no story. A successful import must not blank this out.
    fireEvent.change(storyBox(), { target: { value: 'My own note.' } });
    await importFrom('https://cookieandkate.com/best-guacamole-recipe');
    await screen.findByTestId('import-summary');

    expect(storyBox().value).toBe('My own note.');
    expect(nameBox().value).toBe('Best Guacamole');
  });
});

describe('creator portal — a slow import cannot overwrite what is typed under it', () => {
  it('keeps edits made while the request was in flight, and says which', async () => {
    const success = await importedGuacamole();
    let release: (r: Response) => void = () => {};
    stubApi({ import: () => new Promise<Response>(res => { release = res; }) });
    await openPublishForm();
    await importFrom('https://cookieandkate.com/best-guacamole-recipe');
    await screen.findByRole('status');

    // The progress copy invites exactly this.
    fireEvent.change(nameBox(), { target: { value: 'Nana’s Guacamole' } });

    release(json(success, 200));
    const summary = await screen.findByTestId('import-summary');

    expect(nameBox().value).toBe('Nana’s Guacamole');
    expect(summary.textContent).toContain('we kept your own wording for Meal name');
    // Everything they were not touching still landed.
    expect(rows().map(r => r.value)).toEqual(['avocados', 'lime juice', 'smoked paprika']);
    // And nothing claims provenance over their wording.
    expect(notices().some(n => n.textContent?.includes('Nana'))).toBe(false);
  });

  it('does not repopulate the form after the creator has closed it', async () => {
    const success = await importedGuacamole();
    let release: (r: Response) => void = () => {};
    stubApi({ import: () => new Promise<Response>(res => { release = res; }) });
    await openPublishForm();
    await importFrom('https://cookieandkate.com/best-guacamole-recipe');
    await screen.findByRole('status');

    // Cancel unmounts the modal; the portal underneath outlives it.
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    release(json(success, 200));
    await new Promise(r => setTimeout(r, 0));

    fireEvent.click(screen.getByRole('button', { name: /publish new meal/i }));
    await screen.findByTestId('import-link-bar');

    // A draft they never asked for would be waiting here without the guard.
    expect(nameBox().value).toBe('');
    expect(rows()).toHaveLength(1);
    expect(screen.queryByTestId('import-summary')).toBeNull();
  });
});

describe('creator portal — The One Tap Rule', () => {
  it('keeps Publish as the only accent action, and the flags silent', async () => {
    const success = await importedGuacamole();
    stubApi({ import: () => json(success, 200) });
    await openPublishForm();
    await importFrom('https://cookieandkate.com/best-guacamole-recipe');
    const summary = await screen.findByTestId('import-summary');

    const bar = screen.getByTestId('import-link-bar');
    for (const region of [bar, summary]) {
      expect(region.outerHTML.toLowerCase()).not.toContain('#dd0031');
    }

    // The flags are plain text on a dotted underline — no colour token of their
    // own, so nothing on the form competes with Publish.
    for (const notice of notices()) {
      expect(notice.outerHTML.toLowerCase()).not.toContain('#dd0031');
      expect((notice as HTMLElement).style.color).toBe('rgb(82, 82, 91)'); // Ink Muted
    }

    const publish = screen.getByRole('button', { name: /^publish meal$/i });
    // NOTE: `bg-red-600` is #DC2626 — byte-identical to DESIGN.md's `error`
    // token, so the "act" red and the "something is wrong" red are the same
    // colour on this screen. Pre-existing, not introduced here, recorded on
    // MEAL-73. The flags deliberately use no red at all, so nothing this work
    // added depends on telling the two apart.
    expect(publish.className).toContain('bg-red-600');
  });
});
