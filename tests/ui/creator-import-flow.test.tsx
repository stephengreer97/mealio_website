// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ImportRejection, ImportSuccess } from '@/lib/import/types';
import { FLAGGED_FIELD_STYLE } from '@/components/ImportFieldNotice';
import {
  guacamoleExtraction,
  importedBlackBeanSoup,
  importedGuacamole,
  pixabayPhotoResolver,
} from '../helpers/import-ui-fixtures';

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
  /** Pixabay suggestions for the Generate photo button. */
  photos?: string[];
  /** Answers `POST /api/creator/meals`, for the duplicate-link prompt (MEAL-93). */
  publish?: (body: Record<string, unknown>) => Response;
}

let published: Record<string, unknown> | null;

function stubApi(routes: Routes = {}) {
  published = null;
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/auth/verify')) return json({ ok: true });
    if (url.includes('/api/meals/generate-photo')) {
      return json({ thumbs: routes.photos ?? [], fulls: routes.photos ?? [] });
    }
    if (url.includes('/api/creator/meals')) {
      published = JSON.parse(String(init?.body));
      return routes.publish?.(published!) ?? json({ meal: { id: 'm1', name: published!.name } }, 201);
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
    // Before the import check, for the same reason /meals is before /me:
    // '/api/creator/import-drafts'.includes('/api/creator/import'). The portal
    // mounts the creator's review queue (MEAL-89), which reads this on load —
    // routing it to the import pipeline would hand the queue an ImportSuccess
    // and, worse, consume a one-shot import route this test was holding for the
    // creator's own paste-a-link import.
    if (url.includes('/api/creator/import-drafts')) return json({ drafts: [], totals: { waiting: 0, flagged: 0 } });
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
const measures = () =>
  screen.getAllByLabelText(/^Ingredient \d+.* amount$/) as HTMLInputElement[];
const units = () =>
  screen.getAllByLabelText(/^Ingredient \d+.* unit$/) as HTMLSelectElement[];
const notices = () => screen.queryAllByTestId('import-notice');
const unverified = () => notices().filter(n => n.dataset.kind === 'unverified');
const photoInput = () => document.querySelector('input[type="file"]') as HTMLInputElement;

/** WCAG 2.x relative luminance, against Card White. */
function contrastWithWhite(hex: string): number {
  const channel = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = [1, 3, 5].map(i => channel(parseInt(hex.slice(i, i + 2), 16) / 255));
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return 1.05 / (luminance + 0.05);
}

beforeEach(() => {
  localStorage.setItem('accessToken', 'test-token');
  // jsdom has no object URLs, and the photo preview is how "the creator has
  // their own photo" is visible from a test.
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:their-own-photo' }));
});
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
    // This page publishes only a volume yield ("2 1/2 cups guacamole"), which is
    // not a head count, so the pipeline emits nothing and the box stays empty.
    expect(servesBox().value).toBe('');
  });

  it('summarises the import as counts that add up', async () => {
    stubApi({ import: () => json(success, 200) });
    await openPublishForm();
    await importFrom('https://cookieandkate.com/best-guacamole-recipe');

    const summary = await screen.findByTestId('import-summary');
    expect(summary.textContent).toMatch(/Imported from cookieandkate\.com/);

    const [, verified, total] = /(\d+) of (\d+) fields verified/.exec(summary.textContent!)!;
    const needALook = Number(/(\d+) needs? a look/.exec(summary.textContent!)![1]);
    // Every field is in exactly one of the two counts.
    expect(Number(verified) + needALook).toBe(Number(total));

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
    const summary = await screen.findByTestId('import-summary');

    // The fixture has to contain verified fields for this test to mean
    // anything: name, the photo, and the avocados row all came verbatim out of
    // the page's structured data.
    expect(summary.textContent).toContain('3 of 10 fields verified');

    // Seven flagged of ten, and exactly seven notices. Asserted as an equality
    // because "fewer than ten" also holds when nothing rendered at all, which
    // is the failure this test exists to catch. (The fixture is deliberately
    // adversarial, landing a field on every level; a real import is mostly
    // green and mostly silent.)
    expect(notices()).toHaveLength(7);

    // Nothing is said beside any of the three that held up — silence is the
    // signal, and it is the *absence* of a notice, checked directly.
    const flaggedText = notices().map(n => n.textContent).join(' ');
    expect(flaggedText).not.toContain('Best Guacamole');
    expect(flaggedText).not.toContain('4 medium ripe avocados');
    expect(screen.queryByTestId('photo-replace-hint')).toBeNull();

    expect(nameBox().getAttribute('aria-describedby')).toBeNull();
    expect(nameBox().getAttribute('aria-invalid')).toBeNull();
    expect(nameBox().style.borderBottomStyle).not.toBe('dotted');
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
    expect(absent).toHaveLength(2);

    // The fixture's story is absent from the page entirely — no value, no span
    // — so the box stays empty and asks for input, with nothing to quote.
    expect(storyBox().value).toBe('');
    const story = absent.find(n => n.id === 'import-notice-story')!;
    expect(story.textContent).toContain('Not found in the source — add this');
    expect(story.textContent).not.toContain('we read');

    // Serves is the other kind of empty, and it must not read the same. This
    // page publishes a volume yield and no head count, so the pipeline emits
    // nothing rather than reading "2 1/2 cups" as two people — but it did find
    // something, and the span it kept is the sentence that explains the empty
    // box. Saying "not found in the source" here is simply untrue.
    expect(servesBox().value).toBe('');
    const serves = absent.find(n => n.id === 'import-notice-serves')!;
    expect(serves.textContent).toContain('We found this but couldn’t use it');
    expect(serves.textContent).toContain('2 1/2 cups guacamole');
    expect(servesBox().getAttribute('aria-describedby')).toBe('import-notice-serves');
  });

  it('retires a flag as soon as the creator edits that field', async () => {
    stubApi({ import: () => json(success, 200) });
    await openPublishForm();
    await importFrom('https://cookieandkate.com/best-guacamole-recipe');
    await screen.findByTestId('import-summary');

    const before = notices().length;
    expect(before).toBeGreaterThan(0);
    fireEvent.change(rows()[2], { target: { value: 'kosher salt' } });

    expect(notices()).toHaveLength(before - 1);
    expect(notices().filter(n => n.dataset.kind === 'unverified')).toHaveLength(0);
  });

  it('keeps a row’s flag when only its amount or unit changes', async () => {
    // A row's level is computed from its product name alone — that is the part
    // that reaches the cart and the part a hallucination invents. Nudging the
    // amount retired a red flag that never described the amount, and the
    // hallucinated name then published unmarked.
    stubApi({ import: () => json(success, 200) });
    await openPublishForm();
    await importFrom('https://cookieandkate.com/best-guacamole-recipe');
    await screen.findByTestId('import-summary');

    const before = notices().length;
    expect(before).toBe(7);
    expect(unverified()).toHaveLength(1);

    fireEvent.change(measures()[2], { target: { value: '2' } });
    expect(unverified()).toHaveLength(1);
    expect(unverified()[0].textContent).toContain('1 teaspoon smoked paprika');

    fireEvent.change(units()[2], { target: { value: 'tbsp' } });
    expect(unverified()).toHaveLength(1);
    expect(notices()).toHaveLength(before);

    // The name is what the flag is about, so that is what retires it.
    fireEvent.change(rows()[2], { target: { value: 'kosher salt' } });
    expect(unverified()).toHaveLength(0);
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
    // Empty rather than a serving count invented from a volume.
    expect(published!.serves).toBeNull();
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
  // Driven through the real photo resolver rather than by patching the
  // response, so the `generated` derivation and its amber level are the ones
  // the pipeline produces.
  const withGeneratedPhoto = () =>
    importedGuacamole(guacamoleExtraction(), pixabayPhotoResolver);

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

  async function verifiedCount(response: ImportSuccess) {
    stubApi({ import: () => json(response, 200) });
    await openPublishForm();
    await importFrom('https://cookieandkate.com/best-guacamole-recipe');
    const summary = await screen.findByTestId('import-summary');
    const count = Number(/(\d+) of \d+ fields verified/.exec(summary.textContent!)![1]);
    cleanup();
    return count;
  }

  it('does not count it as verified', async () => {
    // The identical import differing only in the photo verifies one field
    // fewer, so a stand-in demonstrably costs a verification rather than
    // earning one.
    const copied = await verifiedCount(await importedGuacamole());
    const generated = await verifiedCount(await withGeneratedPhoto());

    expect(generated).toBe(copied - 1);
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

  it('retires the stand-in notice when the creator picks a suggestion instead', async () => {
    // Generate and Suggest wrote the photo without going through the one door
    // that marks a field as the creator's, so the flag stayed and a second
    // import could publish over their pick.
    const suggestions = ['https://img.example/one.jpg', 'https://img.example/two.jpg'];
    stubApi({ import: async () => json(await withGeneratedPhoto(), 200), photos: suggestions });
    await openPublishForm();
    await importFrom('https://cookieandkate.com/best-guacamole-recipe');
    await screen.findByTestId('import-summary');
    expect(screen.getByTestId('photo-replace-hint')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /generate photo/i }));
    await screen.findByAltText('Suggested photo 1');
    fireEvent.click(screen.getByAltText('Suggested photo 1').closest('button')!);

    expect(screen.getByAltText('Suggested photo 1').closest('button')!.getAttribute('aria-pressed'))
      .toBe('true');
    expect(screen.queryByTestId('photo-replace-hint')).toBeNull();
  });

  it('does not overwrite a suggestion picked while a second import was reading', async () => {
    const suggestions = ['https://img.example/one.jpg'];
    const generated = await withGeneratedPhoto();
    const copied = await importedGuacamole();
    let release: (r: Response) => void = () => {};
    let call = 0;
    stubApi({
      photos: suggestions,
      import: () => (call++ === 0
        ? json(generated, 200)
        : new Promise<Response>(res => { release = res; })),
    });

    await openPublishForm();
    await importFrom('https://cookieandkate.com/best-guacamole-recipe');
    await screen.findByTestId('import-summary');

    // Suggestions fetched *before* the second import starts, so nothing about
    // this is recorded as an in-flight edit — the only thing standing between
    // the creator's pick and the imported photo is reading the live form.
    fireEvent.click(screen.getByRole('button', { name: /generate photo/i }));
    await screen.findByAltText('Suggested photo 1');

    await importFrom('https://cookieandkate.com/best-guacamole-recipe');
    await screen.findByRole('status');

    fireEvent.click(screen.getByAltText('Suggested photo 1').closest('button')!);

    release(json(copied, 200));
    await waitFor(() => expect(call).toBe(2));

    const summary = screen.getByTestId('import-summary');
    expect(summary.textContent).toContain('we kept your own wording for Photo');
    expect(screen.getByAltText('Suggested photo 1').closest('button')!.getAttribute('aria-pressed'))
      .toBe('true');
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
    // And nothing claims provenance over their wording. Asserted alongside the
    // count, because "no notice mentions Nana" also holds when there are no
    // notices at all.
    expect(notices().length).toBeGreaterThan(0);
    expect(notices().some(n => n.textContent?.includes('Nana'))).toBe(false);
  });

  it('keeps a photo chosen while the request was in flight', async () => {
    // The progress copy invites the creator to carry on, and a File they picked
    // cannot be recovered once it is dropped. `handleImported` runs from the
    // closure captured when Import was pressed, so a guard reading render-scope
    // state saw the photo slot as it was a minute earlier — empty — and
    // published the imported photo over their own.
    const success = await importedGuacamole();
    let release: (r: Response) => void = () => {};
    stubApi({ import: () => new Promise<Response>(res => { release = res; }) });
    await openPublishForm();
    await importFrom('https://cookieandkate.com/best-guacamole-recipe');
    await screen.findByRole('status');

    const file = new File(['x'], 'mine.jpg', { type: 'image/jpeg' });
    fireEvent.change(photoInput(), { target: { files: [file] } });

    release(json(success, 200));
    const summary = await screen.findByTestId('import-summary');

    expect(summary.textContent).toContain('we kept your own wording for Photo');
    // Their file is still the one on screen, not the one we imported.
    expect((screen.getByAltText('Photo for this meal') as HTMLImageElement).src)
      .toBe('blob:their-own-photo');
    // And nothing is claimed about a photo we did not put there.
    expect(screen.queryByTestId('photo-replace-hint')).toBeNull();
  });

  it('keeps a Recipe URL the creator typed, on the success path too', async () => {
    // The rejection path already got this right. `setMealSource` on success sat
    // outside the guard entirely, so it overwrote their link with the URL the
    // pipeline finally read — and never mentioned it.
    const success = await importedGuacamole();
    let release: (r: Response) => void = () => {};
    stubApi({ import: () => new Promise<Response>(res => { release = res; }) });
    await openPublishForm();
    await importFrom('https://cookieandkate.com/best-guacamole-recipe');
    await screen.findByRole('status');

    fireEvent.change(sourceBox(), { target: { value: 'https://myblog.example/mine' } });

    release(json(success, 200));
    const summary = await screen.findByTestId('import-summary');

    expect(sourceBox().value).toBe('https://myblog.example/mine');
    expect(summary.textContent).toContain('Recipe URL');
  });

  it('keeps a Recipe URL typed before Import was ever pressed', async () => {
    const success = await importedGuacamole();
    stubApi({ import: () => json(success, 200) });
    await openPublishForm();

    fireEvent.change(sourceBox(), { target: { value: 'https://myblog.example/mine' } });
    await importFrom('https://cookieandkate.com/best-guacamole-recipe');
    await screen.findByTestId('import-summary');

    expect(sourceBox().value).toBe('https://myblog.example/mine');
    expect(nameBox().value).toBe('Best Guacamole');
  });

  it('says how many ingredients it could not give them', async () => {
    // The list is written all or nothing, so one character in row 1 costs every
    // row we read. "We kept your own wording for Measurements" hides the size
    // of that; the count does not.
    const success = await importedBlackBeanSoup();
    let release: (r: Response) => void = () => {};
    stubApi({ import: () => new Promise<Response>(res => { release = res; }) });
    await openPublishForm();
    await importFrom('https://minimalistbaker.com/easy-1-pot-black-bean-soup');
    await screen.findByRole('status');

    fireEvent.change(rows()[0], { target: { value: 'my own beans' } });

    release(json(success, 200));
    await screen.findByTestId('import-summary');

    expect(rows().map(r => r.value)).toEqual(['my own beans']);
    expect(screen.getByTestId('import-kept-ingredients').textContent)
      .toContain('none of the 8 we read');
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

    // And the abandoned import left nothing armed behind it: a fresh one still
    // fills the form, rather than treating everything typed since as an edit
    // made during a request that no longer exists.
    stubApi({ import: () => json(success, 200) });
    fireEvent.change(nameBox(), { target: { value: 'typed after cancelling' } });
    await importFrom('https://cookieandkate.com/best-guacamole-recipe');
    const summary = await screen.findByTestId('import-summary');

    expect(rows().map(r => r.value)).toEqual(['avocados', 'lime juice', 'smoked paprika']);
    expect(summary.textContent).not.toContain('we kept your own wording');
  });
});

describe('creator portal — a second import', () => {
  /** A draft with no name and no ingredients — reachable, and the case that broke. */
  async function emptyishImport() {
    const result = await importedGuacamole();
    result.draft.name = '';
    result.draft.ingredients = [];
    return result;
  }

  it('leaves the first import’s rows flagged when it has no rows of its own', async () => {
    // `setFieldStates` replaced the whole object while `write` only wrote the
    // fields the new import had values for, so the rows stayed on screen and
    // their callouts did not — the system silently asserting it had verified
    // three ingredients it never looked at.
    const first = await importedGuacamole();
    const second = await emptyishImport();
    let call = 0;
    stubApi({ import: () => json(call++ === 0 ? first : second, 200) });

    await openPublishForm();
    await importFrom('https://cookieandkate.com/best-guacamole-recipe');
    await screen.findByTestId('import-summary');
    expect(unverified()).toHaveLength(1);

    await importFrom('https://cookieandkate.com/best-guacamole-recipe');
    await waitFor(() => expect(call).toBe(2));

    expect(rows().map(r => r.value)).toEqual(['avocados', 'lime juice', 'smoked paprika']);
    expect(unverified()).toHaveLength(1);
    expect(unverified()[0].textContent).toContain('smoked paprika');
  });

  it('does not ask the creator to add a value that is already in the box', async () => {
    const first = await importedGuacamole();
    const second = await emptyishImport();
    let call = 0;
    stubApi({ import: () => json(call++ === 0 ? first : second, 200) });

    await openPublishForm();
    await importFrom('https://cookieandkate.com/best-guacamole-recipe');
    await screen.findByTestId('import-summary');

    await importFrom('https://cookieandkate.com/best-guacamole-recipe');
    await waitFor(() => expect(call).toBe(2));

    expect(nameBox().value).toBe('Best Guacamole');
    // "Not found in the source — add this" under a full box is a lie about a
    // box we never wrote to.
    const nameNotice = notices().find(n => n.id === 'import-notice-name');
    expect(nameNotice).toBeUndefined();
  });

  it('cancels an import still reading when the creator starts over', async () => {
    // The button had no `disabled` and did not abort, so the pending response
    // landed on the form the creator had just emptied and repopulated it
    // underneath them.
    const first = await importedGuacamole();
    const second = await importedBlackBeanSoup();
    let release: (r: Response) => void = () => {};
    let call = 0;
    stubApi({
      import: () => (call++ === 0
        ? json(first, 200)
        : new Promise<Response>(res => { release = res; })),
    });

    await openPublishForm();
    await importFrom('https://cookieandkate.com/best-guacamole-recipe');
    await screen.findByTestId('import-summary');

    await importFrom('https://minimalistbaker.com/easy-1-pot-black-bean-soup');
    await screen.findByRole('status');

    fireEvent.click(screen.getByRole('button', { name: /clear and start over/i }));
    fireEvent.change(nameBox(), { target: { value: 'Something of my own' } });

    release(json(second, 200));
    await new Promise(r => setTimeout(r, 0));

    expect(nameBox().value).toBe('Something of my own');
    expect(rows()).toHaveLength(1);
    expect(screen.queryByTestId('import-summary')).toBeNull();
    expect(notices()).toHaveLength(0);
  });
});

describe('creator portal — a recipe longer than three lines', () => {
  it('flags four of eight rows and leaves the rest completely alone', async () => {
    // Every other UI test runs on a three-row fixture, which is not the shape
    // the exceptions-only scheme was designed for: a wall of rows is the
    // failure mode it avoids.
    const success = await importedBlackBeanSoup();
    stubApi({ import: () => json(success, 200) });
    await openPublishForm();
    await importFrom('https://minimalistbaker.com/easy-1-pot-black-bean-soup');
    const summary = await screen.findByTestId('import-summary');

    expect(rows()).toHaveLength(8);
    expect(rows().map(r => r.value)).toContain('star anise');

    const rowNotices = notices().filter(n => n.id?.startsWith('import-notice-ingredient-'));
    expect(rowNotices).toHaveLength(4);
    // The four that came verbatim out of the page's structured data say nothing.
    const flaggedText = rowNotices.map(n => n.textContent).join(' ');
    expect(flaggedText).not.toContain('3 cloves garlic');
    expect(flaggedText).not.toContain('2 cups vegetable broth');
    // The one that is nowhere on the page is the only unverified row.
    const unverifiedRows = rowNotices.filter(n => n.dataset.kind === 'unverified');
    expect(unverifiedRows).toHaveLength(1);
    expect(unverifiedRows[0].textContent).toContain('Ingredient 8, star anise');

    // This page's only yield is "4 (Large bowls)", which counts vessels rather
    // than eaters — the same move as reading "12" out of "Makes 12 empanadas".
    // Serves therefore comes back empty rather than 4, and the notice hands the
    // creator the span we rejected so they can type the number themselves.
    expect(servesBox().value).toBe('');
    const servesNotice = notices().find(n => n.id === 'import-notice-serves');
    expect(servesNotice?.textContent).toContain('4 (Large bowls)');
    expect(summary.textContent).toMatch(/of 15 fields verified/);
  });

  it('keeps saying it trimmed the tags after the creator edits them', async () => {
    // The note is about what the *import* did, and no edit can change that.
    // Gating it on the field's state meant touching one tag made it vanish.
    const success = await importedBlackBeanSoup();
    stubApi({ import: () => json(success, 200) });
    await openPublishForm();
    await importFrom('https://minimalistbaker.com/easy-1-pot-black-bean-soup');
    await screen.findByTestId('import-summary');

    expect(screen.getByTestId('tags-trimmed-note').textContent)
      .toContain('We found 4 tags and kept the first 3');

    fireEvent.click(screen.getByRole('button', { name: 'Mexican' }));
    expect(screen.getByTestId('tags-trimmed-note')).toBeTruthy();
  });
});

describe('creator portal — the callouts exist for a screen reader too', () => {
  /**
   * The flags are the entire value of this feature, and none of them reached a
   * screen reader: a bare `<p>` with no id, beside a control with no
   * `aria-describedby`, no `aria-invalid`, and — because no control in this
   * modal had an id — no way to wire one up.
   */
  it('makes every notice the description of the control it is about', async () => {
    const success = await importedGuacamole();
    stubApi({ import: () => json(success, 200) });
    await openPublishForm();
    await importFrom('https://cookieandkate.com/best-guacamole-recipe');
    await screen.findByTestId('import-summary');

    expect(notices().length).toBeGreaterThan(0);
    // Every notice can be pointed at.
    for (const notice of notices()) expect(notice.id).toBeTruthy();

    // And every flagged control points at its own.
    const described = (el: Element) =>
      document.getElementById(el.getAttribute('aria-describedby') ?? '');

    expect(described(servesBox())!.textContent).toContain('2 1/2 cups guacamole');
    expect(servesBox().getAttribute('aria-invalid')).toBe('true');

    const paprika = rows()[2];
    expect(described(paprika)!.textContent).toContain('1 teaspoon smoked paprika');
    expect(paprika.getAttribute('aria-invalid')).toBe('true');

    // The verified row says nothing, and claims nothing.
    expect(rows()[0].getAttribute('aria-describedby')).toBeNull();
    expect(rows()[0].getAttribute('aria-invalid')).toBeNull();
  });

  it('gives every control in the publish form a programmatic name', async () => {
    stubApi();
    await openPublishForm();

    const controls = Array.from(
      document.querySelectorAll<HTMLElement>('input:not([type="file"]), textarea, select'),
    );
    expect(controls.length).toBeGreaterThan(5);

    for (const control of controls) {
      const labelled =
        control.getAttribute('aria-label') ??
        (control.id ? document.querySelector(`label[for="${control.id}"]`) : null);
      expect(labelled, `${control.tagName} ${control.id || control.className} has no label`).toBeTruthy();
    }
  });

  it('announces the summary rather than filling the form in silence', async () => {
    const success = await importedGuacamole();
    stubApi({ import: () => json(success, 200) });
    await openPublishForm();

    // The region exists before the import lands. One that arrives already full
    // has no change to announce.
    const live = document.querySelector('[aria-live="polite"][aria-atomic="true"]')!;
    expect(live).toBeTruthy();
    expect(live.textContent).toBe('');

    await importFrom('https://cookieandkate.com/best-guacamole-recipe');
    await screen.findByTestId('import-summary');
    expect(live.textContent).toContain('fields verified');
  });

  it('is a dialog: labelled, escapable, and it gives focus back', async () => {
    stubApi();
    render(<CreatorPortal />);
    const open = await screen.findByRole('button', { name: /publish new meal/i });
    open.focus();
    fireEvent.click(open);

    const dialog = await screen.findByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)!.textContent)
      .toBe('Publish a New Meal');
    // Focus is inside the dialog, not left on the page behind it.
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(open);
  });

  it('keeps Tab inside the dialog', async () => {
    stubApi();
    await openPublishForm();
    const dialog = screen.getByRole('dialog');

    const focusables = Array.from(dialog.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )).filter(el => el.tabIndex >= 0);
    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    first.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('marks a flagged field with a border a sighted creator can actually see', () => {
    // WCAG 1.4.11 wants 3:1 for a boundary that carries meaning. The dotted
    // underline was Hairline Strong at 1.57:1 against Card White, replacing a
    // `border-gray-200` at 1.47:1 — flagged and unflagged were the same input.
    expect(contrastWithWhite(FLAGGED_FIELD_STYLE.borderBottomColor as string))
      .toBeGreaterThanOrEqual(3);
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

/**
 * The same link, published twice (MEAL-93).
 *
 * A warning and not a wall: two recipes from one page is a real thing, so the
 * prompt has to be answerable. It also has to be *checkable* — the meal we
 * found is linked, because "you already published something" that the creator
 * cannot open is a claim they can only take on faith.
 */
describe('creator portal — already published from this link', () => {
  const DUPLICATE = () =>
    json({ error: 'You already published "Best Guacamole" from this link.', duplicate: { id: 'm7', name: 'Best Guacamole' } }, 409);

  async function publishGuacamole(routes: Routes = {}) {
    const success = await importedGuacamole();
    stubApi({ import: () => json(success, 200), ...routes });
    await openPublishForm();
    await importFrom('https://cookieandkate.com/best-guacamole-recipe');
    await screen.findByTestId('import-summary');
    fireEvent.click(screen.getByRole('button', { name: /^publish meal$/i }));
  }

  it('asks, and links the meal it found, instead of publishing', async () => {
    await publishGuacamole({ publish: DUPLICATE });

    expect(await screen.findByText(/Publish anyway\?/i)).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Best Guacamole' });
    expect(link.getAttribute('href')).toBe('/meal/p/m7');
    // The form is still there to go back to — the prompt is a question asked of
    // a form that has not been thrown away.
    expect(nameBox().value).toBe('Best Guacamole');
  });

  it('publishes on confirmation, saying so explicitly', async () => {
    let calls = 0;
    await publishGuacamole({
      publish: body => {
        calls += 1;
        return body.confirmDuplicate === true
          ? json({ meal: { id: 'm8', name: body.name } }, 201)
          : DUPLICATE();
      },
    });

    fireEvent.click(await screen.findByRole('button', { name: /Publish anyway/i }));

    // The confirmation travels on the request rather than being remembered by
    // the server, so nothing is left standing for the next publish.
    await waitFor(() => expect(calls).toBe(2));
    expect(published!.confirmDuplicate).toBe(true);
    await waitFor(() => expect(screen.queryByText(/Publish anyway\?/i)).toBeNull());
  });

  it('drops the question when the link it was about changes', async () => {
    await publishGuacamole({ publish: DUPLICATE });
    await screen.findByText(/Publish anyway\?/i);

    fireEvent.change(sourceBox(), { target: { value: 'https://cookieandkate.com/other-recipe' } });

    // A different link is a different question.
    expect(screen.queryByText(/Publish anyway\?/i)).toBeNull();
  });

  it('sends confirmDuplicate false on an ordinary publish', async () => {
    await publishGuacamole();

    await waitFor(() => expect(published).not.toBeNull());
    expect(published!.confirmDuplicate).toBe(false);
  });
});
