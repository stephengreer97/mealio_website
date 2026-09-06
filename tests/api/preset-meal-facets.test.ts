// GET /api/preset-meals/facets.
//
// The one behaviour worth a route test, beyond the aggregation: a failure here
// must NOT break the page. The filters underneath the panel work perfectly well
// without autocomplete, so a catalogue read that falls over should cost the
// suggestions and nothing else.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: vi.fn() }));
const allMeals = vi.fn();
vi.mock('@/lib/trending-cache', () => ({
  getCachedAllPresetMeals: () => allMeals(),
  getCachedTrendingMeals: vi.fn(),
}));

import { GET } from '@/app/api/preset-meals/facets/route';

beforeEach(() => { vi.clearAllMocks(); });

describe('the facets', () => {
  it('are computed over the whole catalogue, not a page of it', async () => {
    allMeals.mockResolvedValue([
      { tags: ['quick'], author: 'Sarah Lane', creator_name: 'Sarah Lane' },
      { tags: ['air-fryer'], author: null, creator_name: 'Priya' },
    ]);
    const body = await (await GET()).json();
    expect(body.tags).toEqual(expect.arrayContaining(['quick', 'air-fryer']));
    expect(body.authors).toEqual(expect.arrayContaining(['Sarah Lane', 'Priya']));
  });

  it('degrades to empty rather than failing the screen', async () => {
    // A panel with no suggestions is degraded. A panel that 500s is a broken
    // screen, and the filters it sits above do not need it.
    allMeals.mockRejectedValue(new Error('rpc exploded'));
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tags: [], authors: [] });
  });
});
