// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MAX_MEAL_TAGS } from '@/lib/import/vocab';

/**
 * The tag picker on a personal meal.
 *
 * `my-meals` carries a second, hand-rolled tag picker — the one the creator
 * portal's picker is a near-copy of — and it had no test of any kind. That is
 * how it came to count to a literal `3` while the rule it was claiming to
 * enforce lived in `MAX_MEAL_TAGS`: nothing would have noticed if the two
 * disagreed, and nothing did.
 *
 * The rule itself is `toggleTag` in `lib/import/vocab.ts` and is tested there.
 * What these assert is that this picker is wired to it — including the custom
 * tag path, which is this picker's alone: a personal meal deliberately takes a
 * tag no vocabulary knows ("Grandma's"), and it must still land inside the cap
 * that `POST /api/meals` now enforces.
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/components/AppHeader', () => ({ default: () => null }));
vi.mock('@/components/AppFooter', () => ({ default: () => null }));
vi.mock('@/components/CreatorPopup', () => ({ default: () => null }));
vi.mock('@/components/KrogerStorePickerModal', () => ({ default: () => null }));

const MyMealsPage = (await import('@/app/my-meals/page')).default;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** The body of the last POST /api/meals — what the create modal actually sent. */
let created: Record<string, unknown> | null;

function stubApi() {
  created = null;
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/auth/verify')) return json({ user: { id: 'u1', email: 'a@b.co' } });
    if (url.includes('/api/creator/me')) return json({}, 404);
    if (url.includes('/api/kroger/status')) return json({ connected: false, locations: {} });
    if (url.includes('/api/meals') && String(init?.method).toUpperCase() === 'POST') {
      created = JSON.parse(String(init?.body));
      return json({ meal: { id: 'm1', ...created } }, 201);
    }
    if (url.includes('/api/meals')) return json({ meals: [] });
    return json({});
  }) as unknown as typeof fetch;
  vi.stubGlobal('fetch', vi.fn(impl));
}

beforeEach(() => {
  localStorage.setItem('accessToken', 'tok');
  stubApi();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

/** Opens Add Meal and returns once the tag picker is on screen. */
async function openCreateModal() {
  render(<MyMealsPage />);
  fireEvent.click(await screen.findByRole('button', { name: /\+ Add Meal/ }));
  await screen.findByText('Add Meal');
}

const chip = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

describe('my-meals tag picker — the cap', () => {
  it('takes tags up to the cap and disables the rest', async () => {
    await openCreateModal();

    expect(chip('Healthy').disabled).toBe(false);

    fireEvent.click(chip('Mexican'));
    fireEvent.click(chip('No Cook'));
    fireEvent.click(chip('Vegan'));

    // The cap is `MAX_MEAL_TAGS`, not the literal 3 this picker used to carry.
    expect(MAX_MEAL_TAGS).toBe(3);
    expect(chip('Healthy').disabled).toBe(true);
    // A chosen chip stays live — deselecting is the way back.
    expect(chip('Mexican').disabled).toBe(false);

    fireEvent.click(chip('Mexican'));
    expect(chip('Healthy').disabled).toBe(false);
  });

  it('refuses to add a custom tag once the picker is full', async () => {
    await openCreateModal();

    fireEvent.click(chip('Mexican'));
    fireEvent.click(chip('No Cook'));
    fireEvent.click(chip('Vegan'));

    const box = screen.getByPlaceholderText(/Search or add custom tag/);
    fireEvent.change(box, { target: { value: "Grandma's" } });

    // The + Add button is the only way in, and at the cap it is not offered.
    expect(screen.queryByRole('button', { name: '+ Add' })).toBeNull();
    // Enter is the other way in, and it must refuse too — including leaving the
    // text where it is, because clearing it would look like the tag was taken.
    fireEvent.keyDown(box, { key: 'Enter' });
    expect((box as HTMLInputElement).value).toBe("Grandma's");
    expect(screen.queryByRole('button', { name: "Grandma's" })).toBeNull();
  });

  it('takes a custom tag when there is room, and clears the box', async () => {
    await openCreateModal();

    fireEvent.click(chip('Mexican'));
    const box = screen.getByPlaceholderText(/Search or add custom tag/);
    fireEvent.change(box, { target: { value: "Grandma's" } });
    fireEvent.click(screen.getByRole('button', { name: '+ Add' }));

    expect((box as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('button', { name: "Grandma's" })).toBeTruthy();
  });

  it('counts a custom tag against the same cap as a vocabulary one', async () => {
    // The cap is on the column, not on the vocabulary: two custom tags and one
    // from `ALL_TAGS` is three tags, and the fourth is refused whichever kind
    // it is. `POST /api/meals` counts the array it is sent and nothing else.
    await openCreateModal();

    const box = screen.getByPlaceholderText(/Search or add custom tag/);
    const addCustom = (value: string) => {
      fireEvent.change(box, { target: { value } });
      fireEvent.click(screen.getByRole('button', { name: '+ Add' }));
    };

    addCustom("Grandma's");
    addCustom('Tuesday');
    fireEvent.click(chip('Mexican'));

    // Three in, from both sources: the picker is full.
    expect(chip('Vegan').disabled).toBe(true);
    fireEvent.change(box, { target: { value: 'Payday' } });
    expect(screen.queryByRole('button', { name: '+ Add' })).toBeNull();

    // A chosen tag keeps its chip while a search is active, even though no
    // vocabulary lists it and the search matches nothing. That is what makes
    // the cap escapable: the way back under it is to deselect something, and a
    // selection you cannot see is a selection you cannot remove.
    fireEvent.click(chip("Grandma's"));

    fireEvent.change(box, { target: { value: '' } });
    expect(chip('Vegan').disabled).toBe(false);
  });
});
