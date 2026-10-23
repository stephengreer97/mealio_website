// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor, within } from '@testing-library/react';

/**
 * "Import a recipe" on Add Meal: a link or pasted text fills the form, and
 * every answer that is not a draft leaves the user a next step.
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/components/AppHeader', () => ({ default: () => null }));
vi.mock('@/components/AppFooter', () => ({ default: () => null }));
vi.mock('@/components/CreatorPopup', () => ({ default: () => null }));
vi.mock('@/components/KrogerStorePickerModal', () => ({ default: () => null }));

const MyMealsPage = (await import('@/app/my-meals/page')).default;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const URL_ = 'https://blog.example.com/pasta';

const green = { level: 'green', derivation: 'page-text', match: 'exact', score: 1, evidence: 'x', reason: 'ok' };
const OK = {
  status: 'ok',
  url: URL_,
  freeImportsLeft: null,
  draft: {
    name: 'Garlic Pasta',
    ingredients: [
      { ingredientName: 'spaghetti', measure: '200', unit: 'g', qty: 1, searchTerm: null },
      { ingredientName: 'garlic', measure: '', unit: 'qty', qty: 2, searchTerm: null },
    ],
    recipe: 'Boil the pasta. Fry the garlic. Toss.',
    source: URL_,
    story: null,
    photoUrl: null,
    difficulty: null,
    tags: [],
    serves: '2',
  },
  confidence: {
    name: green, recipe: green, story: green, photoUrl: green, difficulty: green, tags: green,
    serves: { ...green, level: 'amber', derivation: 'inferred', evidence: null, reason: 'Inferred from the portions.' },
    ingredients: [green, green],
  },
  gate: { verdict: 'yes', reason: 'r', source: 'json-ld' },
  meta: { usedJsonLd: true, path: 'json-ld', platform: 'wordpress', cached: false, redirects: [], usage: null, gateUsage: null },
};

let importReplies: Array<() => Response>;
let importBodies: Array<Record<string, unknown>>;

function stubApi() {
  importBodies = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/auth/verify')) return json({ user: { id: 'u1', email: 'a@b.co' } });
    if (url.includes('/api/creator/me')) return json({}, 404);
    if (url.includes('/api/kroger/status')) return json({ connected: false, locations: {} });
    if (url.includes('/api/meals/import')) {
      importBodies.push(JSON.parse(String(init?.body)));
      return (importReplies.shift() ?? (() => json(OK)))();
    }
    if (url.includes('/api/meals')) return json({ meals: [] });
    return json({});
  }) as unknown as typeof fetch;
  vi.stubGlobal('fetch', vi.fn(impl));
}

beforeEach(() => {
  localStorage.setItem('accessToken', 'tok');
  importReplies = [];
  stubApi();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

async function openCreateModal() {
  render(<MyMealsPage />);
  fireEvent.click(await screen.findByRole('button', { name: /\+ Add Meal/ }));
  await screen.findByText('Add Meal');
  return screen.getByTestId('meal-import');
}

const importLink = (panel: HTMLElement, url = URL_) => {
  fireEvent.change(within(panel).getByLabelText('Recipe link'), { target: { value: url } });
  fireEvent.click(within(panel).getByRole('button', { name: 'Import' }));
};

describe('Add Meal — import a recipe', () => {
  it('fills the form from a link and flags only what needs a look', async () => {
    const panel = await openCreateModal();
    importLink(panel);

    expect(await screen.findByTestId('meal-import-done')).toBeTruthy();
    expect((screen.getByPlaceholderText('e.g., Taco Tuesday') as HTMLInputElement).value).toBe('Garlic Pasta');
    expect((screen.getByPlaceholderText('https://…') as HTMLInputElement).value).toBe(URL_);
    expect(screen.getByDisplayValue('spaghetti')).toBeTruthy();
    expect(screen.getByDisplayValue('Boil the pasta. Fry the garlic. Toss.')).toBeTruthy();
    // Serves was inferred, so it carries a note; nothing else does, and empty
    // optional fields say nothing at all.
    expect(screen.getByText(/Inferred from the portions/)).toBeTruthy();
    expect(screen.queryByText(/Not found in the source/)).toBeNull();
    expect(importBodies[0]).toEqual({ url: URL_ });
  });

  it('says so when that was the free import', async () => {
    importReplies.push(() => json({ ...OK, freeImportsLeft: 0 }));
    const panel = await openCreateModal();
    importLink(panel);
    expect((await screen.findByTestId('meal-import-done')).textContent).toMatch(/free import/);
  });

  it('imports pasted text, counting characters against the limit', async () => {
    const panel = await openCreateModal();
    fireEvent.click(within(panel).getByRole('button', { name: 'Paste text' }));
    const box = within(panel).getByLabelText('Recipe text');
    const text = 'Garlic pasta. 200 g spaghetti and 2 cloves of garlic, fried and tossed.';
    fireEvent.change(box, { target: { value: text } });
    expect(within(panel).getByTestId('meal-import-count').textContent).toMatch(`${text.length} / 20,000`);

    fireEvent.click(within(panel).getByRole('button', { name: 'Import' }));
    await screen.findByTestId('meal-import-done');
    expect(importBodies[0]).toEqual({ text });
  });

  it('offers the creator’s version, or a private copy on request', async () => {
    importReplies.push(() => json({ status: 'creator-match', meal: { id: 'p1', name: 'Garlic Pasta', creatorName: 'Chef Sarah' } }, 409));
    const panel = await openCreateModal();
    importLink(panel);

    const prompt = await screen.findByTestId('meal-import-creator-match');
    expect(within(prompt).getByRole('link', { name: 'See Chef Sarah’s version' }).getAttribute('href')).toBe('/meal/p/p1');

    fireEvent.click(within(prompt).getByRole('button', { name: 'Import my own copy' }));
    await screen.findByTestId('meal-import-done');
    expect(importBodies[1]).toEqual({ url: URL_, ignoreCreatorMatch: true });
  });

  it('asks before importing a link the user already has', async () => {
    importReplies.push(() => json({ status: 'duplicate', meal: { id: 'm1', name: 'My pasta' } }, 409));
    const panel = await openCreateModal();
    importLink(panel);

    const prompt = await screen.findByTestId('meal-import-duplicate');
    expect(prompt.textContent).toMatch('My pasta');
    fireEvent.click(within(prompt).getByRole('button', { name: 'Import it again' }));
    await screen.findByTestId('meal-import-done');
    expect(importBodies[1]).toMatchObject({ ignoreDuplicate: true });
  });

  it('sends a free user who has used their import to Full Access', async () => {
    importReplies.push(() => json({ status: 'upgrade-required', error: 'You have used your free import.' }, 402));
    const panel = await openCreateModal();
    importLink(panel);

    const prompt = await screen.findByTestId('meal-import-upgrade');
    expect(within(prompt).getByRole('link', { name: 'See Full Access' }).getAttribute('href')).toBe('/pricing');
  });

  it('offers the paste box when the site would not let us read it', async () => {
    importReplies.push(() =>
      json({ status: 'rejected', url: URL_, stage: 'fetch', reason: 'blocked-by-site', detail: 'The site refused us.', suggestPaste: true, meta: { cached: false } }, 422));
    const panel = await openCreateModal();
    importLink(panel);

    const prompt = await screen.findByTestId('meal-import-error');
    expect(prompt.textContent).toMatch('The site refused us.');
    fireEvent.click(within(prompt).getByRole('button', { name: 'Paste the recipe text instead' }));
    await waitFor(() => expect(within(panel).getByLabelText('Recipe text')).toBeTruthy());
  });

  it('drops a field’s note once the user edits it', async () => {
    const panel = await openCreateModal();
    importLink(panel);
    await screen.findByText(/Inferred from the portions/);

    fireEvent.change(screen.getByPlaceholderText('e.g. 4 or 2-4'), { target: { value: '3' } });
    expect(screen.queryByText(/Inferred from the portions/)).toBeNull();
  });
});
