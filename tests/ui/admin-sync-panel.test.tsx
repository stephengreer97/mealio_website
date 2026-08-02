// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import AdminSyncPanel, { type SyncPanelCreator } from '@/components/AdminSyncPanel';

/**
 * The sync screen (MEAL-90).
 *
 * What is worth testing here is what stops an expensive mistake: the checklist
 * never arrives pre-ticked with things already imported, the cost of the current
 * selection is on screen before the button can be pressed, and a run that
 * publishes fewer meals than were selected says where the rest went.
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
      return json({ run: overrides.run ?? { id: 'r1', status: 'done', items: [], notifyCreator: true, notifiedAt: null, notifyError: null }, totals: overrides.totals ?? { selected: 0, pending: 0, imported: 0, rejected: 0, failed: 0, skipped: 0, costUsd: 0 } });
    }
    if (url.includes('/api/admin/sync')) {
      const body = JSON.parse(String(init?.body ?? '{}'));
      return json({ run: { id: 'r1', status: 'queued', items: body.items ?? [], notifyCreator: body.notifyCreator, notifiedAt: null, notifyError: null } }, 201);
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
    expect(screen.getByTestId('cost-estimate').textContent).toBe('1 selected · about $0.07');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Black bean soup' }));
    expect(screen.getByTestId('cost-estimate').textContent).toBe('2 selected · about $0.13');
  });

  it('reads the feed without opening a single post', async () => {
    const { calls } = harness();
    await loadCatalog();
    // The panel talks to one endpoint to draw the list, and that endpoint is the
    // one that reads feed metadata.
    expect(calls).toEqual(['/api/admin/sync/catalog']);
  });
});

describe('AdminSyncPanel — notification', () => {
  it('defaults to on', async () => {
    harness();
    chooseCreator();
    expect((screen.getByRole('checkbox', { name: /Email Chef Sarah/ }) as HTMLInputElement).checked).toBe(true);
  });

  it('carries the operator’s choice into the run, off only when they turned it off', async () => {
    const { calls, bodies } = harness();
    chooseCreator();
    fireEvent.change(screen.getByLabelText('Recipe link'), { target: { value: 'https://chefsarah.test/a' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Email Chef Sarah/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Sync this link' }));

    await waitFor(() => expect(calls).toContain('/api/admin/sync/worker'));
    const created = bodies.find(b => b.endpoint === '/api/admin/sync');
    expect(created?.body).toMatchObject({ mode: 'link', url: 'https://chefsarah.test/a', notifyCreator: false });
  });
});

describe('AdminSyncPanel — a finished run', () => {
  it('explains why 3 selected produced 1 published', async () => {
    harness({
      run: {
        id: 'r1', status: 'done', notifyCreator: true, notifiedAt: '2026-08-02T11:00:00.000Z', notifyError: null,
        items: [
          { itemId: 'a', url: 'https://chefsarah.test/a', title: 'Guacamole', publishedAt: null, status: 'imported', detail: null, mealId: 'm1', mealName: 'Guacamole', costUsd: 0.067 },
          { itemId: 'b', url: 'https://chefsarah.test/b', title: 'Kitchen tour', publishedAt: null, status: 'rejected', detail: 'Not a recipe: a photo diary of a kitchen.', mealId: null, mealName: null, costUsd: 0 },
          { itemId: 'c', url: 'https://chefsarah.test/c', title: 'Soup', publishedAt: null, status: 'failed', detail: 'The site took too long to answer.', mealId: null, mealName: null, costUsd: 0 },
        ],
      },
      totals: { selected: 3, pending: 0, imported: 1, rejected: 1, failed: 1, skipped: 0, costUsd: 0.067 },
    });

    chooseCreator();
    fireEvent.change(screen.getByLabelText('Recipe link'), { target: { value: 'https://chefsarah.test/a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sync this link' }));

    const summary = await screen.findByTestId('run-summary');
    expect(summary.textContent).toMatch(/Selected 3/);
    expect(summary.textContent).toMatch(/published 1/);
    expect(summary.textContent).toMatch(/1 dropped by the gate \(not a recipe\)/);
    expect(summary.textContent).toMatch(/1 failed/);
    // The gate's own sentence, so a correct run does not look like a bug.
    expect(screen.getByText('Not a recipe: a photo diary of a kitchen.')).toBeTruthy();
    // Only the failure is retryable.
    expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(1);
    expect(screen.getByText(/was emailed the list/)).toBeTruthy();
  });

  it('says plainly when nobody was told', async () => {
    harness({
      run: {
        id: 'r1', status: 'done', notifyCreator: false, notifiedAt: null, notifyError: null,
        items: [{ itemId: 'a', url: 'u', title: 'Guacamole', publishedAt: null, status: 'imported', detail: null, mealId: 'm1', mealName: 'Guacamole', costUsd: 0.067 }],
      },
      totals: { selected: 1, pending: 0, imported: 1, rejected: 0, failed: 0, skipped: 0, costUsd: 0.067 },
    });

    chooseCreator();
    fireEvent.change(screen.getByLabelText('Recipe link'), { target: { value: 'https://chefsarah.test/a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sync this link' }));

    expect(await screen.findByText(/nobody has told this creator/)).toBeTruthy();
  });
});
