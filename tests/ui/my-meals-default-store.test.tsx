// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * My Meals with one store per account: a switcher instead of store pills, every
 * meal shown, and Add Meal asking for a store only before the account has one.
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/components/AppHeader', () => ({ default: () => null }));
vi.mock('@/components/AppFooter', () => ({ default: () => null }));
vi.mock('@/components/CreatorPopup', () => ({ default: () => null }));
vi.mock('@/components/KrogerStorePickerModal', () => ({ default: () => null }));

const MyMealsPage = (await import('@/app/my-meals/page')).default;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let defaultStoreId: string | null;
let meals: Array<Record<string, unknown>>;
let calls: Array<{ url: string; method: string; body?: any }>;

function stubApi() {
  calls = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = String(init?.method ?? 'GET').toUpperCase();
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.includes('/api/auth/verify')) return json({ user: { id: 'u1', email: 'a@b.co' } });
    if (url.includes('/api/creator/me')) return json({}, 404);
    if (url.includes('/api/kroger/status')) return json({ connected: false, locations: {} });
    if (url.includes('/api/account/default-store') && method === 'PATCH') {
      defaultStoreId = JSON.parse(String(init?.body)).storeId;
      meals = meals.map((m) => ({ ...m, store_id: defaultStoreId }));
      return json({ defaultStoreId, moved: meals.length });
    }
    if (url.includes('/api/meals') && method === 'POST') {
      const body = JSON.parse(String(init?.body));
      return json({ meal: { id: 'new', ...body, store_id: body.storeId ?? defaultStoreId, ingredients: body.ingredients } }, 201);
    }
    if (url.includes('/api/meals')) return json({ meals, defaultStoreId });
    return json({});
  }) as unknown as typeof fetch;
  vi.stubGlobal('fetch', vi.fn(impl));
}

const meal = (id: string, name: string, store: string) => ({
  id, name, store_id: store, ingredients: [{ ingredientName: 'milk', qty: 1, unit: 'qty' }], tags: [], created_at: '2026-10-01',
});

beforeEach(() => {
  localStorage.setItem('accessToken', 'tok');
  defaultStoreId = 'heb';
  meals = [meal('m1', 'Cereal', 'heb'), meal('m2', 'Tacos', 'heb')];
  stubApi();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('My Meals — the account’s store', () => {
  it('shows the store in a switcher, with every meal under it', async () => {
    render(<MyMealsPage />);
    const store = (await screen.findByTestId('my-store')) as HTMLSelectElement;
    expect(store.value).toBe('heb');
    expect((await screen.findAllByText('Cereal')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Tacos').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /H-E-B \(2\)/ })).toBeNull();
  });

  it('asks before switching, then moves the account and reloads', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<MyMealsPage />);
    const store = (await screen.findByTestId('my-store')) as HTMLSelectElement;

    fireEvent.change(store, { target: { value: 'kroger' } });

    expect(confirm.mock.calls[0][0]).toMatch(/Products you chose at H-E-B stay saved for H-E-B/);
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH' && c.body?.storeId === 'kroger')).toBe(true));
    await waitFor(() => expect((screen.getByTestId('my-store') as HTMLSelectElement).value).toBe('kroger'));
  });

  it('does nothing when the switch is cancelled', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<MyMealsPage />);
    const store = (await screen.findByTestId('my-store')) as HTMLSelectElement;

    fireEvent.change(store, { target: { value: 'kroger' } });

    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });
});

describe('Add Meal — the store', () => {
  async function openAdd() {
    render(<MyMealsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /\+ Add Meal/ }));
    await screen.findByText('Add Meal');
  }

  it('has no store field once the account has a store, and saves there', async () => {
    await openAdd();
    expect(screen.queryByTestId('create-meal-store')).toBeNull();

    fireEvent.change(screen.getByPlaceholderText('e.g., Taco Tuesday'), { target: { value: 'Soup' } });
    fireEvent.change(screen.getAllByPlaceholderText('Ingredient')[0], { target: { value: 'broth' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Meal' }));

    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/meals'))).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body.storeId).toBe('heb');
  });

  it('does not tell a user with a store to pick one after an import', async () => {
    const realFetch = global.fetch as unknown as (i: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes('/api/meals/import')
        ? json({
            status: 'ok', url: 'https://blog.example.com/x', freeImportsLeft: null,
            draft: { name: 'Soup', ingredients: [], recipe: null, source: 'https://blog.example.com/x', story: null, photoUrl: null, difficulty: null, tags: [], serves: null },
            confidence: Object.fromEntries(
              ['name', 'recipe', 'story', 'photoUrl', 'difficulty', 'tags', 'serves']
                .map((f) => [f, { level: 'green', derivation: 'page-text', match: 'exact', score: 1, evidence: null, reason: '' }])
                .concat([['ingredients', []]]),
            ),
          })
        : realFetch(input, init)));
    await openAdd();
    fireEvent.change(screen.getByLabelText('Recipe link'), { target: { value: 'https://blog.example.com/x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    const done = await screen.findByTestId('meal-import-done');
    expect(done.textContent).toMatch(/Check the form and press Create Meal/);
    expect(done.textContent).not.toMatch(/pick a store/);
  });

  it('asks for a store before the account has one', async () => {
    defaultStoreId = null;
    meals = [];
    await openAdd();
    expect(screen.getByTestId('create-meal-store')).toBeTruthy();
    expect(screen.getByText(/Every meal goes to this store/)).toBeTruthy();
  });
});
