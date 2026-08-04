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
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
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

const tab = (name: RegExp) => screen.getByRole('tab', { name });

beforeEach(async () => {
  localStorage.clear();
  localStorage.setItem('accessToken', 'test-token');
  // The portal writes the tab into the hash, and jsdom's location outlives a
  // test. Without this, a test that ended on Settings decides which tab the
  // next one opens on.
  window.history.replaceState(null, '', window.location.pathname);
  guacamole = await importedGuacamole();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

// ── Meals, drafts and settings are three places ──────────────────────────────

describe('the portal separates meals from settings', () => {
  it('opens on the creator’s meals, with settings a tab away rather than in the way', async () => {
    portal();

    // The meals are the landing tab: what they came to do is reachable without
    // passing anything they did not come for.
    expect(await screen.findByText('Weeknight Chilli')).toBeTruthy();
    expect(tab(/^Meals/).getAttribute('aria-selected')).toBe('true');

    // Publishing belongs to no tab and is always there.
    expect(screen.getByRole('button', { name: /publish new meal/i })).toBeTruthy();

    // The settings cards are mounted — they read their own state on load, as
    // they always have — but they are not on screen in front of the meals.
    expect(screen.getByLabelText('Where you publish')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();

    fireEvent.click(tab(/^Settings/));

    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
    expect(tab(/^Settings/).getAttribute('aria-selected')).toBe('true');
    // And the meals list is out of the way rather than gone.
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();

    fireEvent.click(tab(/^Meals/));
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();
  });

  it('keeps every settings card reachable in one place', async () => {
    portal();
    await screen.findByText('Weeknight Chilli');
    fireEvent.click(tab(/^Settings/));

    // The profile, and the one section that replaced the four source cards
    // (MEAL-101). Nothing that was on the old single column has been dropped on
    // the way to a wider layout — the four cards became one dropdown and a body
    // that follows it, and all four sources are still named in it.
    expect(screen.getByRole('button', { name: /edit profile/i })).toBeTruthy();
    expect(screen.getByTestId('sync-source-section')).toBeTruthy();

    const picker = screen.getByLabelText('Where you publish') as HTMLSelectElement;
    const options = Array.from(picker.options).map(option => option.textContent ?? '');
    expect(options.join(' | ')).toMatch(/Website/);
    expect(options.join(' | ')).toMatch(/YouTube/);
    expect(options.join(' | ')).toMatch(/Instagram/);
    expect(options.join(' | ')).toMatch(/TikTok/);
  });
});

// ── Where a creator reviews their drafts ─────────────────────────────────────

describe('a creator with drafts waiting can find them', () => {
  it('says so on the tab they land on, and counts them on the tab that holds them', async () => {
    portal({ drafts: [draft('d1'), draft('d2'), draft('d3')] });

    // Without scrolling and without hunting: the first thing on the landing
    // tab, in the creator's own terms — how many, and what approving means.
    const callout = await screen.findByTestId('drafts-callout');
    expect(callout.textContent).toMatch(/3 recipes are waiting for your review/);
    expect(callout.textContent).toMatch(/Nothing is published under your name until you approve it/);

    // And a permanent home for them, badged with the same number, so the answer
    // to "where do I review my drafts?" survives the callout being dismissed by
    // deciding one.
    expect(screen.getByTestId('drafts-tab-badge').textContent).toBe('3');
    expect(tab(/^Drafts/).textContent).toContain('3');
  });

  it('takes them from the callout to the queue itself', async () => {
    portal({ drafts: [draft('d1')] });
    await screen.findByTestId('drafts-callout');

    // One draft, said as one thing rather than "1 recipes".
    expect(screen.getByTestId('drafts-callout').textContent).toMatch(/A recipe is waiting for your review/);

    fireEvent.click(screen.getByRole('button', { name: /review drafts/i }));

    // The queue, with the decision on it — the thing the owner could not find.
    // One waiting draft opens itself: there is nothing to choose between, and a
    // collapsed row would be a click charged for no decision.
    const queueCard = await screen.findByTestId('creator-review-queue');
    expect(within(queueCard).getByRole('button', { name: /approve & publish/i })).toBeTruthy();
    expect(within(queueCard).getByRole('button', { name: /edit first/i })).toBeTruthy();
    expect(within(queueCard).getByRole('button', { name: /not this one/i })).toBeTruthy();
    expect(tab(/^Drafts/).getAttribute('aria-selected')).toBe('true');
  });

  it('reaches the queue from the tab alone, without the callout', async () => {
    portal({ drafts: [draft('d1')] });
    await screen.findByTestId('drafts-callout');

    fireEvent.click(tab(/^Drafts/));

    expect(within(await screen.findByTestId('creator-review-queue'))
      .getByRole('button', { name: /approve & publish/i })).toBeTruthy();
  });
});

// ── Landing on the right tab ─────────────────────────────────────────────────

describe('the drafts-ready email lands on the drafts', () => {
  it('opens the Drafts tab for /creator#drafts', async () => {
    // The mail's only button says "Review and publish" and used to land on
    // /creator, which is the Meals tab: the creator arrived at a page about
    // publishing new meals having been asked to review the ones we already read.
    window.history.replaceState(null, '', '#drafts');
    portal({ drafts: [draft('d1')] });

    await waitFor(() => expect(tab(/^Drafts/).getAttribute('aria-selected')).toBe('true'));
    expect(await screen.findByTestId('creator-review-queue')).toBeTruthy();
  });

  it('follows the hash when the same link is clicked with the portal already open', async () => {
    portal({ drafts: [draft('d1')] });
    await screen.findByText('Weeknight Chilli');
    expect(tab(/^Meals/).getAttribute('aria-selected')).toBe('true');

    window.history.replaceState(null, '', '#drafts');
    window.dispatchEvent(new HashChangeEvent('hashchange'));

    await waitFor(() => expect(tab(/^Drafts/).getAttribute('aria-selected')).toBe('true'));
  });

  it('writes the hash when a creator switches tabs, without stacking history', async () => {
    // Assigning `location.hash` would push an entry per tab click, so Back walks
    // a creator through every tab they touched instead of leaving the portal.
    portal();
    await screen.findByText('Weeknight Chilli');
    const before = window.history.length;

    fireEvent.click(tab(/^Settings/));

    expect(window.location.hash).toBe('#settings');
    expect(window.history.length).toBe(before);
  });

  it('keeps today’s default for a hash that names no tab', async () => {
    // `#anything` from anywhere must not be able to blank the page.
    window.history.replaceState(null, '', '#nonsense');
    portal();

    expect(await screen.findByText('Weeknight Chilli')).toBeTruthy();
    expect(tab(/^Meals/).getAttribute('aria-selected')).toBe('true');
  });
});

describe('a creator with no drafts is not shouted at', () => {
  it('draws no callout and no count', async () => {
    portal();
    await screen.findByText('Weeknight Chilli');

    // The portal does not grow a box to say there is nothing to do.
    await waitFor(() => expect(screen.queryByTestId('drafts-callout')).toBeNull());
    expect(screen.queryByTestId('drafts-tab-badge')).toBeNull();
    expect(screen.queryByTestId('creator-review-queue')).toBeNull();
  });

  it('still answers the question quietly, on the tab they went looking on', async () => {
    portal();
    await screen.findByText('Weeknight Chilli');
    fireEvent.click(tab(/^Drafts/));

    // A creator who wonders where imported recipes turn up gets an answer
    // rather than a blank panel — but only because they went and asked.
    expect(screen.getByText(/Recipes Mealio read from the posts you publish wait here/i)).toBeTruthy();
    expect(await screen.findByTestId('drafts-empty')).toBeTruthy();
  });

  it('does not claim an empty queue when the queue could not be read', async () => {
    // The count only ever comes from a read that succeeded. Printing "nothing
    // is waiting" under "we could not load your queue" would be the more
    // reassuring of two contradictory sentences, and the wrong one.
    vi.stubGlobal('fetch', (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/auth/verify')) return json({ ok: true });
      if (url.includes('/api/creator/import-drafts')) return json({ error: 'nope' }, 500);
      if (url.includes('/api/creator/me')) {
        return json({ creator: { id: 'c1', display_name: 'Chef Sarah', approved_at: '2026-01-01' }, meals: [], stats: null });
      }
      return new Response('nope', { status: 403 });
    }) as typeof fetch);
    render(<CreatorPortal />);

    fireEvent.click(await screen.findByRole('tab', { name: /^Drafts/ }));

    expect(await screen.findByTestId('queue-unreadable')).toBeTruthy();
    expect(screen.queryByTestId('drafts-empty')).toBeNull();
  });
});
