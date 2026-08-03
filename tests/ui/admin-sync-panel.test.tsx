// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import AdminSyncPanel, { type SyncPanelCreator } from '@/components/AdminSyncPanel';

/**
 * The sync screen (MEAL-90, amended by MEAL-91).
 *
 * What is worth testing here is what stops an expensive mistake: the checklist
 * never arrives pre-ticked with things already imported, the cost of the current
 * selection is on screen before the button can be pressed, and a run that
 * extracts fewer meals than were selected says where the rest went.
 *
 * And one thing worth testing about what the screen *says*: a finished run has
 * published nothing. The old copy claimed otherwise on every path, which is the
 * untruth MEAL-91 was filed about.
 */

const CREATORS: SyncPanelCreator[] = [
  {
    id: 'c1',
    display_name: 'Chef Sarah',
    primary_source: 'website',
    website_url: 'https://chefsarah.test/',
    youtube_url: null,
    instagram_url: null,
    tiktok_url: null,
    feed_url: 'https://chefsarah.test/feed',
  },
];

const CATALOG = {
  ok: true,
  source: 'website',
  feed: { url: 'https://chefsarah.test/feed', kind: 'rss', via: 'link-alternate' },
  truncated: false,
  entries: [
    { itemId: 'a', url: 'https://chefsarah.test/a', title: 'Guacamole', publishedAt: '2026-07-29T09:00:00.000Z', record: null },
    { itemId: 'b', url: 'https://chefsarah.test/b', title: 'Black bean soup', publishedAt: '2026-07-21T09:00:00.000Z', record: null },
    {
      itemId: 'c',
      url: 'https://chefsarah.test/c',
      title: 'Kitchen tour',
      publishedAt: '2026-07-01T09:00:00.000Z',
      record: { status: 'imported', detail: null, at: '2026-07-02T00:00:00.000Z' },
    },
  ],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Routes the three endpoints the panel talks to. `run` is what the worker returns. */
function harness(overrides: { run?: unknown; totals?: unknown } = {}) {
  const calls: string[] = [];
  const bodies: Record<string, any>[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push(url);
    if (init?.body) bodies.push({ endpoint: url, body: JSON.parse(String(init.body)) });
    if (url.includes('/api/admin/sync/catalog')) return json({ catalog: CATALOG });
    if (url.includes('/api/admin/sync/worker')) {
      return json({ run: overrides.run ?? { id: 'r1', status: 'done', items: [] }, totals: overrides.totals ?? { selected: 0, pending: 0, drafted: 0, rejected: 0, failed: 0, skipped: 0, costUsd: 0, needALook: 0 } });
    }
    if (url.includes('/api/admin/sync')) {
      const body = JSON.parse(String(init?.body ?? '{}'));
      return json({ run: { id: 'r1', status: 'queued', items: body.items ?? [] } }, 201);
    }
    return json({}, 404);
  }) as unknown as typeof fetch;

  vi.stubGlobal('fetch', impl);
  const view = render(<AdminSyncPanel creators={CREATORS} />);
  return { view, calls, bodies };
}

const checkbox = (name: string) => screen.getByRole('checkbox', { name }) as HTMLInputElement;

function chooseCreator() {
  fireEvent.change(screen.getByLabelText('Creator'), { target: { value: 'c1' } });
}

async function loadCatalog() {
  chooseCreator();
  fireEvent.click(screen.getByRole('radio', { name: 'Pick from their catalog' }));
  fireEvent.click(screen.getByRole('button', { name: 'List what they publish' }));
  await screen.findByText('3 items published');
}

beforeEach(() => { localStorage.setItem('accessToken', 'test-token'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('AdminSyncPanel — the checklist', () => {
  it('opens with nothing selected, and prices the empty selection at nothing', async () => {
    harness();
    await loadCatalog();
    expect(screen.getByTestId('cost-estimate').textContent).toBe('0 selected · about $0.00');
    for (const box of screen.getAllByRole('checkbox', { name: /Guacamole|Black bean soup|Kitchen tour/ })) {
      expect((box as HTMLInputElement).checked).toBe(false);
    }
  });

  it('marks what is already imported and leaves it out of select-all', async () => {
    harness();
    await loadCatalog();

    expect(screen.getByText('Already imported')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Select all not yet imported (2)' }));

    expect(checkbox('Guacamole').checked).toBe(true);
    expect(checkbox('Black bean soup').checked).toBe(true);
    // The expensive mistake — select-all on a catalog half of which is already
    // in — is deliberately not one click away.
    expect(checkbox('Kitchen tour').checked).toBe(false);
  });

  it('prices the live selection', async () => {
    harness();
    await loadCatalog();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Guacamole' }));
    expect(screen.getByTestId('cost-estimate').textContent).toBe('1 selected · about $0.02');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Black bean soup' }));
    expect(screen.getByTestId('cost-estimate').textContent).toBe('2 selected · about $0.03');
  });

  it('reads the feed without opening a single post', async () => {
    const { calls } = harness();
    await loadCatalog();
    // The panel talks to one endpoint to draw the list, and that endpoint is the
    // one that reads feed metadata.
    expect(calls).toEqual(['/api/admin/sync/catalog']);
  });
});

describe('AdminSyncPanel — a finished run', () => {
  it('explains why 3 selected produced 1 draft', async () => {
    harness({
      run: {
        id: 'r1', status: 'done',
        items: [
          { itemId: 'a', url: 'https://chefsarah.test/a', title: 'Guacamole', publishedAt: null, status: 'drafted', detail: null, draftId: 'd1', mealName: 'Guacamole', needALook: 2, costUsd: 0.067 },
          { itemId: 'b', url: 'https://chefsarah.test/b', title: 'Kitchen tour', publishedAt: null, status: 'rejected', detail: 'Not a recipe: a photo diary of a kitchen.', draftId: null, mealName: null, needALook: null, costUsd: 0 },
          { itemId: 'c', url: 'https://chefsarah.test/c', title: 'Soup', publishedAt: null, status: 'failed', detail: 'The site took too long to answer.', draftId: null, mealName: null, needALook: null, costUsd: 0 },
        ],
      },
      totals: { selected: 3, pending: 0, drafted: 1, rejected: 1, failed: 1, skipped: 0, costUsd: 0.067, needALook: 2 },
    });

    chooseCreator();
    fireEvent.change(screen.getByLabelText('Recipe link'), { target: { value: 'https://chefsarah.test/a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sync this link' }));

    const summary = await screen.findByTestId('run-summary');
    expect(summary.textContent).toMatch(/Selected 3/);
    expect(summary.textContent).toMatch(/queued for review 1/);
    expect(summary.textContent).toMatch(/1 dropped by the gate \(not a recipe\)/);
    expect(summary.textContent).toMatch(/1 failed/);
    // The gate's own sentence, so a correct run does not look like a bug.
    expect(screen.getByText('Not a recipe: a photo diary of a kitchen.')).toBeTruthy();
    // Only the failure is retryable.
    expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(1);
  });

  it('says nothing is live, and points at where the decision is made', async () => {
    // The screen used to say "published 1" and offer a link to the live meal.
    // Neither was true of a queued draft, and both would put an operator off
    // ever opening the Review tab.
    harness({
      run: {
        id: 'r1', status: 'done',
        items: [{ itemId: 'a', url: 'u', title: 'Guacamole', publishedAt: null, status: 'drafted', detail: null, draftId: 'd1', mealName: 'Guacamole', needALook: 3, costUsd: 0.067 }],
      },
      totals: { selected: 1, pending: 0, drafted: 1, rejected: 0, failed: 0, skipped: 0, costUsd: 0.067, needALook: 3 },
    });

    chooseCreator();
    fireEvent.change(screen.getByLabelText('Recipe link'), { target: { value: 'https://chefsarah.test/a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sync this link' }));

    expect(await screen.findByText(/Nothing is live yet/)).toBeTruthy();
    expect(screen.getByText(/3 fields flagged for a look/)).toBeTruthy();
    // No link to a published meal, because there is no published meal.
    expect(screen.queryByRole('link', { name: 'View' })).toBeNull();
  });

  it('offers no per-run notification, because a run announces nothing', async () => {
    harness();
    chooseCreator();
    expect(screen.queryByRole('checkbox', { name: /Email Chef Sarah/ })).toBeNull();

    fireEvent.change(screen.getByLabelText('Recipe link'), { target: { value: 'https://chefsarah.test/a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sync this link' }));
    await waitFor(() => expect(screen.getByTestId('run-summary')).toBeTruthy());
  });
});

