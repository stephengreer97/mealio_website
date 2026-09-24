// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { ImportSuccess } from '@/lib/import/types';

// `lib/import-drafts` is imported for `reviewDraft` alone, so the queue payload
// here is built by the code the route builds it with rather than a hand-written
// literal. Its server-only dependencies are mocked away; none is reached.
vi.mock('@/lib/supabase', () => ({ createServerSupabaseClient: () => ({}) }));
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));
vi.mock('@/lib/email', () => ({ sendCreatorSyncPublishedEmail: vi.fn() }));
vi.mock('@/lib/creator-meals', () => ({ publishCreatorMeal: vi.fn() }));
const pushed: string[] = [];
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: (p: string) => { pushed.push(p); } }) }));
vi.mock('@/components/AppHeader', () => ({ default: () => null }));
vi.mock('@/components/AppFooter', () => ({ default: () => null }));

import { reviewDraft, type ImportDraft } from '@/lib/import-drafts';
import { importedGuacamole } from '../helpers/import-ui-fixtures';

const CreatorPortal = (await import('@/app/creator/page')).default;

/**
 * The creator portal's shape.
 *
 * Two things the owner asked for, and this file is the record of both:
 *
 *  1. **Meals and settings are separate places.** The portal was one column —
 *     the review queue, then the profile, then four connection cards, then the
 *     published meals — so the settings a creator touches twice a year sat
 *     between them and the meals they came to edit. Three tabs now, in the same
 *     idiom the admin page uses.
 *  2. **Where a creator reviews their drafts is obvious.** The queue was always
 *     on this page and never in admin; it was simply invisible, one card in a
 *     stack. It now has a tab of its own, that tab carries the count, and the
 *     tab a creator lands on says so first when anything is waiting — and says
 *     nothing at all when nothing is.
 */

let guacamole: ImportSuccess;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function draft(id: string): ImportDraft {
  return {
    id,
    creatorId: 'c1',
    creatorName: 'Chef Sarah',
    sourceUrl: 'https://chefsarah.test/guacamole',
    source: 'website',
    itemId: `guid-${id}`,
    syncRunId: null,
    draft: guacamole.draft,
    confidence: guacamole.confidence,
    status: 'pending_review',
    reviewBy: 'creator',
    editedAt: null,
    decidedAt: null,
    decidedBy: null,
    publishedMealId: null,
    createdAt: '2026-08-02T10:00:00.000Z',
  };
}

/** The queue payload, exactly as `GET /api/creator/import-drafts` answers. */
function queue(drafts: ImportDraft[]) {
  const rows = drafts.map(row => {
    const review = reviewDraft(row);
    return { ...row, summary: review.summary, review };
  });
  return {
    waiting: rows.length,
    drafts: rows,
    totals: { waiting: rows.length, showing: rows.length, flagged: 0 },
  };
}

const MEAL = {
  id: 'm1',
  name: 'Weeknight Chilli',
  photo_url: null,
  difficulty: 2,
  trending_score: 40,
  saves_all: 12,
  ingredients: [{ ingredientName: 'beans', qty: 1, unit: 'qty' }],
  recipe: null,
  source: null,
  story: null,
  serves: '4',
  tags: [],
};

/** The portal, with the two endpoints it reads on load answered. */
function portal({ drafts = [] as ImportDraft[], meals = [MEAL] } = {}) {
  vi.stubGlobal('fetch', (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/auth/verify')) return json({ ok: true });
    // Checked before '/api/creator/me': '/api/creator/import-drafts' contains
    // neither, but '/api/creator/meals' contains '/api/creator/me'.
    if (url.includes('/api/creator/import-drafts')) return json(queue(drafts));
    if (url.includes('/api/creator/me')) {
      return json({
        creator: {
          id: 'c1', display_name: 'Chef Sarah', bio: null, social_handle: null,
          photo_url: null, approved_at: '2026-01-01', handle: null,
          website_url: 'https://chefsarah.test/', youtube_url: null,
          instagram_url: null, tiktok_url: null,
          primary_source: 'website', import_opt_in: true,
        },
        meals,
        stats: null,
      });
    }
    return new Response('nope', { status: 403 });
  }) as typeof fetch);
  render(<CreatorPortal />);
}


beforeEach(() => {
  pushed.length = 0;
  localStorage.clear();
  localStorage.setItem('accessToken', 'test-token');
  window.history.replaceState(null, '', window.location.pathname);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/** The portal with `fetch` behaving however a test says. */
function portalWith(handler: (url: string) => Promise<Response>) {
  vi.stubGlobal('fetch', ((input: RequestInfo | URL) => handler(String(input))) as typeof fetch);
  render(<CreatorPortal />);
}

describe('when the portal cannot be loaded', () => {
  it('says so and offers a retry, instead of spinning for ever', async () => {
    // The connection dropping mid-load: seen on 2026-09-24 when the network
    // blipped as Instagram redirected back, leaving a blank white page.
    let attempt = 0;
    portalWith(async (url) => {
      if (url.includes('/api/auth/verify')) return json({ ok: true });
      attempt += 1;
      if (attempt === 1) throw new TypeError('Failed to fetch');
      return json({ creator: { id: 'c1', display_name: 'Chef Sarah', handle: null, primary_source: 'website', import_opt_in: true }, meals: [], stats: null });
    });

    const msg = await screen.findByTestId('portal-load-error');
    expect(msg.textContent).toMatch(/could not load your Creator Portal/i);
    expect(pushed).toEqual([]);

    // And the retry actually loads it.
    fireEvent.click(screen.getByRole('button', { name: /Try again/i }));
    await waitFor(() => expect(screen.queryByTestId('portal-load-error')).toBeNull());
    await screen.findByRole('tab', { name: /Meals/i });
  });

  it('does not tell an approved creator to go and apply when the server errors', async () => {
    // A 500 used to redirect to /creator/apply, which reads as "you are not a
    // creator" for a problem that has nothing to do with them.
    portalWith(async (url) => {
      if (url.includes('/api/auth/verify')) return json({ ok: true });
      return json({ error: 'boom' }, 500);
    });

    await screen.findByTestId('portal-load-error');
    expect(pushed).toEqual([]);
  });

  it('still sends someone who is not a creator to the application page', async () => {
    portalWith(async (url) => {
      if (url.includes('/api/auth/verify')) return json({ ok: true });
      return json({ error: 'Not a creator' }, 403);
    });

    await waitFor(() => expect(pushed).toContain('/creator/apply'));
    expect(screen.queryByTestId('portal-load-error')).toBeNull();
  });

  it('still sends a signed-out visitor to sign in', async () => {
    portalWith(async () => json({ error: 'Unauthorized' }, 401));
    await waitFor(() => expect(pushed).toContain('/signin'));
  });
});
