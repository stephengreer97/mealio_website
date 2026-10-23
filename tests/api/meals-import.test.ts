import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeDb } from '../helpers/supabase-mock';
import { jsonRequest } from '../helpers/request';

vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));

const runImport = vi.fn();
vi.mock('@/lib/import/pipeline', async () => {
  const real = await vi.importActual<typeof import('@/lib/import/pipeline')>('@/lib/import/pipeline');
  return { ...real, runImport: (...args: unknown[]) => runImport(...args) };
});

import { POST } from '@/app/api/meals/import/route';
import { createAccessToken } from '@/lib/tokens';
import { PASTED_TEXT_MAX } from '@/lib/import/pipeline';
import { USER_DAILY_IMPORT_CAP } from '@/lib/import/user-budget';

const URL_ = 'https://blog.example.com/pasta';

const OK_RESULT = {
  status: 'ok',
  url: URL_,
  draft: { name: 'Pasta', ingredients: [], recipe: null, source: URL_, story: null, photoUrl: null, difficulty: null, tags: [], serves: null },
  confidence: { name: { level: 'green' }, ingredients: [] },
  gate: { verdict: 'yes', reason: 'r', source: 'json-ld' },
  meta: { usedJsonLd: true, path: 'json-ld', platform: 'wordpress', cached: false, redirects: [], usage: null, gateUsage: null },
};

const REJECTED = (stage: string) => ({
  status: 'rejected', url: URL_, stage, reason: 'blocked-by-site', detail: 'The site refused us.', meta: { cached: false },
});

const RECIPE_TEXT = 'Pasta. 200 g spaghetti, 2 cloves garlic, olive oil. Boil the pasta, fry the garlic, toss.';

describe('/api/meals/import', () => {
  let token: string;

  const profile = (tier: string) => fakeDb.seed('user_profiles', [{ id: 'user-1', subscription_tier: tier, tokens_invalidated_at: null }]);
  const post = (body: Record<string, unknown>) => POST(jsonRequest('/api/meals/import', { token, body }));

  beforeEach(async () => {
    fakeDb.reset();
    runImport.mockReset();
    token = await createAccessToken('user-1', 'a@b.test');
  });

  it('401 without a token, and fetches nothing', async () => {
    const res = await POST(jsonRequest('/api/meals/import', { body: { url: URL_ } }));
    expect(res.status).toBe(401);
    expect(runImport).not.toHaveBeenCalled();
  });

  it('400 for both a link and text, or neither', async () => {
    profile('paid');
    expect((await post({ url: URL_, text: RECIPE_TEXT })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect(runImport).not.toHaveBeenCalled();
  });

  it('400 for text over the limit or too short to be a recipe', async () => {
    profile('paid');
    expect((await post({ text: 'x'.repeat(PASTED_TEXT_MAX + 1) })).status).toBe(400);
    expect((await post({ text: 'pasta' })).status).toBe(400);
    expect(runImport).not.toHaveBeenCalled();
  });

  it('imports a link for Full Access, as a user, with no copied photo and no shared cache', async () => {
    profile('paid');
    runImport.mockResolvedValue(OK_RESULT);

    const res = await post({ url: URL_ });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.draft.name).toBe('Pasta');
    expect(body.freeImportsLeft).toBeNull();
    const [url, options] = runImport.mock.calls[0];
    expect(url).toBe(URL_);
    expect(options).toMatchObject({ mode: 'manual', skipCache: true });
    expect(typeof options.resolvePhoto).toBe('function');
    expect(options.document).toBeUndefined();
  });

  it('imports pasted text with no URL', async () => {
    profile('paid');
    runImport.mockResolvedValue({ ...OK_RESULT, url: '', draft: { ...OK_RESULT.draft, source: '' } });

    const res = await post({ text: RECIPE_TEXT });

    expect(res.status).toBe(200);
    const [url, options] = runImport.mock.calls[0];
    expect(url).toBe('');
    expect(options.pasted).toBe(true);
    expect(options.document).toMatchObject({ url: '', text: RECIPE_TEXT, recipeText: RECIPE_TEXT, imageUrl: null });
  });

  it('gives a free user one import, and reports it as used', async () => {
    profile('free');
    runImport.mockResolvedValue(OK_RESULT);

    const res = await post({ url: URL_ });

    expect(res.status).toBe(200);
    expect((await res.json()).freeImportsLeft).toBe(0);
  });

  it('402 once a free user has a successful import, before anything is fetched', async () => {
    profile('free');
    fakeDb.seed('recipe_imports', [{ id: 1, user_id: 'user-1', actor: 'user', outcome: 'ok', occurred_at: new Date().toISOString() }]);

    const res = await post({ url: URL_ });

    expect(res.status).toBe(402);
    expect((await res.json()).status).toBe('upgrade-required');
    expect(runImport).not.toHaveBeenCalled();
  });

  it('a rejected attempt does not use up the free import', async () => {
    profile('free');
    fakeDb.seed('recipe_imports', [{ id: 1, user_id: 'user-1', actor: 'user', outcome: 'rejected', occurred_at: new Date().toISOString() }]);
    runImport.mockResolvedValue(OK_RESULT);

    expect((await post({ url: URL_ })).status).toBe(200);
  });

  it('429 at the monthly spend cap for Full Access', async () => {
    profile('paid');
    fakeDb.seed('recipe_imports', [{ id: 1, user_id: 'user-1', actor: 'user', outcome: 'ok', total_cost_usd: 2.5, occurred_at: new Date().toISOString() }]);

    const res = await post({ url: URL_ });

    expect(res.status).toBe(429);
    expect(runImport).not.toHaveBeenCalled();
  });

  it('429 at the daily count for Full Access', async () => {
    profile('paid');
    fakeDb.seed('recipe_imports', Array.from({ length: USER_DAILY_IMPORT_CAP }, (_, i) => ({
      id: i + 1, user_id: 'user-1', actor: 'user', outcome: 'ok', total_cost_usd: 0.001, occurred_at: new Date().toISOString(),
    })));

    expect((await post({ url: URL_ })).status).toBe(429);
  });

  it('a creator\'s own import rows do not count against the user', async () => {
    profile('paid');
    fakeDb.seed('recipe_imports', [{ id: 1, user_id: 'user-1', actor: 'creator', outcome: 'ok', total_cost_usd: 5, occurred_at: new Date().toISOString() }]);
    runImport.mockResolvedValue(OK_RESULT);

    expect((await post({ url: URL_ })).status).toBe(200);
  });

  it('offers the creator\'s version when the link is a published Mealio meal, however it is spelled', async () => {
    profile('paid');
    fakeDb.seed('preset_meals', [{ id: 'p1', name: 'Pasta', creator_id: 'c1', source: 'http://www.blog.example.com/pasta/', creators: { display_name: 'Chef Sarah' } }]);

    const res = await post({ url: URL_ });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ status: 'creator-match', meal: { id: 'p1', creatorName: 'Chef Sarah' } });
    expect(runImport).not.toHaveBeenCalled();
  });

  it('imports anyway once the user has dismissed the creator prompt', async () => {
    profile('paid');
    fakeDb.seed('preset_meals', [{ id: 'p1', name: 'Pasta', creator_id: 'c1', source: URL_ }]);
    runImport.mockResolvedValue(OK_RESULT);

    expect((await post({ url: URL_, ignoreCreatorMatch: true })).status).toBe(200);
  });

  it('warns about a meal the user already has from this link', async () => {
    profile('paid');
    fakeDb.seed('meals', [{ id: 'm1', name: 'My pasta', user_id: 'user-1', is_active: true, website: 'https://www.blog.example.com/pasta' }]);

    const res = await post({ url: URL_ });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ status: 'duplicate', meal: { id: 'm1' } });

    runImport.mockResolvedValue(OK_RESULT);
    expect((await post({ url: URL_, ignoreDuplicate: true })).status).toBe(200);
  });

  it('suggests pasting the text when the site would not let us read it', async () => {
    profile('paid');
    runImport.mockResolvedValue(REJECTED('fetch'));

    const res = await post({ url: URL_ });

    expect(res.status).toBe(422);
    expect((await res.json()).suggestPaste).toBe(true);
  });

  it('does not suggest pasting when the page was read and is not a recipe', async () => {
    profile('paid');
    runImport.mockResolvedValue(REJECTED('gate'));

    expect((await (await post({ url: URL_ })).json()).suggestPaste).toBe(false);
  });
});
