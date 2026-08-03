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

interface Harness {
  run?: unknown;
  totals?: unknown;
  /** Catalog responses served in order, so paging can be exercised. */
  catalogs?: unknown[];
  /** `GET /append`: either the list or the refusal, with its status. */
  appendList?: { status?: number; body: unknown };
  appendWrite?: { status?: number; body: unknown };
  /** Defaults to the website creator the older tests are written against. */
  creators?: SyncPanelCreator[];
}

/** Routes the endpoints the panel talks to. `run` is what the worker returns. */
function harness(overrides: Harness = {}) {
  const calls: string[] = [];
  const bodies: Record<string, any>[] = [];
  const catalogs = [...(overrides.catalogs ?? [])];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push(url);
    if (init?.body) bodies.push({ endpoint: url, body: JSON.parse(String(init.body)) });
    // Checked before the generic `/api/admin/sync` branch below, which would
    // otherwise swallow it.
    if (url.includes('/api/admin/sync/append')) {
      const route = init?.method === 'POST'
        ? overrides.appendWrite ?? { body: { written: true, detail: 'The Mealio link was added.' } }
        : overrides.appendList ?? { body: { meals: [] } };
      return json(route.body, route.status ?? 200);
    }
    if (url.includes('/api/admin/sync/catalog')) return json({ catalog: catalogs.length ? catalogs.shift() : CATALOG });
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
  const view = render(<AdminSyncPanel creators={overrides.creators ?? CREATORS} />);
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

describe('AdminSyncPanel — one card, four steps', () => {
  it('folds a settled step down to a summary you can click back into', async () => {
    harness();
    await loadCatalog();

    // Step 1 has an answer, so it is a line of text rather than a form.
    expect(screen.queryByLabelText('Creator')).toBeNull();
    expect(screen.getByText('Chef Sarah')).toBeTruthy();

    // And it is one click away from being a form again, at any point in the
    // sequence — this is not a wizard that has to be restarted.
    fireEvent.click(screen.getByRole('button', { name: /Creator/ }));
    expect(screen.getByLabelText('Creator')).toBeTruthy();
  });

  it('keeps the checklist open when the first item is ticked', async () => {
    harness();
    await loadCatalog();

    // Ticking is the work of this step, not the end of it. A screen that folded
    // the list away on the first tick would be unusable for the 12-item
    // selection it exists to support.
    fireEvent.click(checkbox('Guacamole'));
    expect(checkbox('Black bean soup')).toBeTruthy();
    expect(checkbox('Black bean soup').checked).toBe(false);
  });

  it('keeps the cost on screen while an earlier step is reopened', async () => {
    harness();
    await loadCatalog();
    fireEvent.click(checkbox('Guacamole'));

    fireEvent.click(screen.getByRole('button', { name: /Creator/ }));

    // The guard rail is not a step. Whatever else is expanded or folded, what
    // pressing Sync would spend stays visible beside the button that spends it.
    expect(screen.getByTestId('cost-estimate').textContent).toBe('1 selected · about $0.02');
    expect(screen.getByRole('button', { name: 'Sync selection' })).toBeTruthy();
  });

  it('folds the checklist away once the run has something to report', async () => {
    harness({
      run: { id: 'r1', status: 'done', items: [] },
      totals: { selected: 1, pending: 0, drafted: 1, rejected: 0, failed: 0, skipped: 0, costUsd: 0.067, needALook: 0 },
    });
    await loadCatalog();
    fireEvent.click(checkbox('Guacamole'));
    fireEvent.click(screen.getByRole('button', { name: 'Sync selection' }));
    await screen.findByTestId('run-summary');

    // What the run did is what the screen is now about. A 200-row checklist
    // sitting on top of the result is the pile this card replaced — and the
    // header still says "1 of 3 selected" and still opens on a click.
    expect(screen.queryByRole('checkbox', { name: 'Guacamole' })).toBeNull();
    expect(screen.getByText('1 of 3 selected')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Choose what to import/ }));
    expect(checkbox('Guacamole').checked).toBe(true);
  });

  it('folds the append offer away until an operator asks for it', async () => {
    harness({ creators: YT_CREATORS, appendList: { body: { meals: APPENDABLE } } });
    chooseCreator();

    // It acts on meals already approved, so it is not step 5 of anything, and
    // for most creators the answer is a refusal. It stays out of the way.
    expect(screen.queryByText(/turned on description editing/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Check what can be linked' }));
    expect(await screen.findByText(/turned on description editing/)).toBeTruthy();
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


// ── The back catalogue, paged (MEAL-79) ──────────────────────────────────────

const YT_CREATORS: SyncPanelCreator[] = [
  { ...CREATORS[0], primary_source: 'youtube', youtube_url: 'https://youtube.com/@sarah' },
];

/** One page of a YouTube catalogue. `nextPageToken` is what makes it pageable. */
function ytCatalog(ids: string[], nextPageToken: string | null) {
  return {
    ok: true,
    source: 'youtube',
    feed: null,
    truncated: Boolean(nextPageToken),
    nextPageToken,
    quotaUnits: 2,
    entries: ids.map(id => ({
      itemId: id,
      url: `https://www.youtube.com/watch?v=${id}`,
      title: `Video ${id}`,
      publishedAt: '2026-07-29T09:00:00.000Z',
      record: null,
    })),
  };
}

async function loadYouTubeCatalog(count: number) {
  fireEvent.change(screen.getByLabelText('Creator'), { target: { value: 'c1' } });
  fireEvent.click(screen.getByRole('radio', { name: 'Pick from their catalog' }));
  fireEvent.change(screen.getByLabelText('Source'), { target: { value: 'youtube' } });
  fireEvent.click(screen.getByRole('button', { name: 'List what they publish' }));
  await screen.findByText(`${count} item${count === 1 ? '' : 's'} published`);
}

describe('AdminSyncPanel — a paged back catalogue costs quota, so it is asked for', () => {
  it('lists one page and puts the rest behind a button', async () => {
    const { calls } = harness({ creators: YT_CREATORS, catalogs: [ytCatalog(['vid0000000A', 'vid0000000B'], 'CDIQAA')] });
    await loadYouTubeCatalog(2);

    // Opening the screen buys one page. A 300-video channel is 6 pages of a
    // budget shared with every other creator, and nobody agreed to spend it by
    // opening a tab.
    expect(calls.filter(url => url.includes('/catalog'))).toHaveLength(1);
    expect(screen.getByTestId('quota-spent').textContent).toMatch(
      /2 YouTube quota units spent on this screen, of 10,000\/day/,
    );
    expect(screen.getByRole('button', { name: 'Load 50 more' })).toBeTruthy();
  });

  it('appends the next page and keeps what was already ticked', async () => {
    const { bodies } = harness({
      creators: YT_CREATORS,
      catalogs: [ytCatalog(['vid0000000A'], 'CDIQAA'), ytCatalog(['vid0000000B'], null)],
    });
    await loadYouTubeCatalog(1);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Video vid0000000A' }));
    fireEvent.click(screen.getByRole('button', { name: 'Load 50 more' }));
    await screen.findByText('2 items published');

    // The cursor from the previous window goes back, so the second press reads
    // the next 50 rather than the same 50 again.
    expect(bodies.at(-1)!.body.pageToken).toBe('CDIQAA');
    // An operator who ticked six videos on page one and then asked for page two
    // has not changed their mind about the six.
    expect((screen.getByRole('checkbox', { name: 'Video vid0000000A' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId('cost-estimate').textContent).toBe('1 selected · about $0.02');
    // Two pages, and the running total says so.
    expect(screen.getByTestId('quota-spent').textContent).toMatch(/^4 YouTube quota units/);
    expect(screen.queryByRole('button', { name: 'Load 50 more' })).toBeNull();
  });
});

// ── The append offer (MEAL-79) ───────────────────────────────────────────────

const APPENDABLE = [
  {
    draftId: 'd1',
    mealId: 'meal-1',
    mealName: 'Best Guacamole',
    videoId: 'vid0000000A',
    videoUrl: 'https://www.youtube.com/watch?v=vid0000000A',
    mealUrl: 'https://mealio.co/meal/p/meal-1',
    approvedAt: '2026-08-01T10:00:00.000Z',
  },
];

describe('AdminSyncPanel — offering to write the Mealio link back', () => {
  it('costs nothing until an operator asks', async () => {
    const { calls } = harness({ creators: YT_CREATORS });
    chooseCreator();

    // Most creators have not turned description editing on, so asking on every
    // creator selection is a request spent to be told no.
    expect(calls.some(url => url.includes('/append'))).toBe(false);
    expect(screen.getByTestId('append-panel')).toBeTruthy();
  });

  it('offers an Append button per meal that came from one of their videos', async () => {
    harness({ creators: YT_CREATORS, appendList: { body: { meals: APPENDABLE } } });
    chooseCreator();
    fireEvent.click(screen.getByRole('button', { name: 'Check what can be linked' }));

    const button = await screen.findByRole('button', { name: 'Append the Mealio link for Best Guacamole' });
    expect(button).toBeTruthy();
    // What will be written is on screen before the button can be pressed.
    expect(screen.getByText(/https:\/\/mealio\.co\/meal\/p\/meal-1/)).toBeTruthy();
  });

  it('shows the refusal instead of the list when consent is off', async () => {
    harness({
      creators: YT_CREATORS,
      appendList: {
        status: 403,
        body: { error: 'This creator has not agreed to let Mealio edit their YouTube descriptions.' },
      },
    });
    chooseCreator();
    fireEvent.click(screen.getByRole('button', { name: 'Check what can be linked' }));

    expect((await screen.findByTestId('append-refusal')).textContent).toMatch(/has not agreed/i);
    // The offer must not appear at all when the answer would be no. A screen
    // showing their videos beside an Append button has already implied we may
    // write to them.
    expect(screen.queryByRole('button', { name: /Append the Mealio link/ })).toBeNull();
  });

  it('reports "already there" as an outcome rather than an error', async () => {
    harness({
      creators: YT_CREATORS,
      appendList: { body: { meals: APPENDABLE } },
      appendWrite: { body: { written: false, detail: 'The link was already in this description, so nothing was written.' } },
    });
    chooseCreator();
    fireEvent.click(screen.getByRole('button', { name: 'Check what can be linked' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Append the Mealio link for Best Guacamole' }));

    // Pressing twice is harmless, and the screen says so rather than showing a
    // failure an operator would try to fix.
    expect(await screen.findByText(/already in this description/)).toBeTruthy();
  });

  it('counts what an append spent, which is the expensive half of the budget', async () => {
    harness({
      creators: YT_CREATORS,
      catalogs: [ytCatalog(['vid0000000A'], null)],
      appendList: { body: { meals: APPENDABLE } },
      appendWrite: { body: { written: true, detail: 'The Mealio link was added.', quotaUnits: 51 } },
    });
    await loadYouTubeCatalog(1);
    fireEvent.click(screen.getByRole('button', { name: 'Check what can be linked' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Append the Mealio link for Best Guacamole' }));
    await screen.findByText(/The Mealio link was added/);

    // 2 for the listing, 51 for the write. The counter used to read `data.detail`
    // and discard `data.quotaUnits`, so ten appends could spend 510 units — 25×
    // a listing page each — without the number on screen moving at all. The
    // argument for this screen is that the visible number is the guard rail.
    expect(screen.getByTestId('quota-spent').textContent).toMatch(/^53 YouTube quota units/);
  });

  it('counts what a refused append spent before it refused', async () => {
    harness({
      creators: YT_CREATORS,
      catalogs: [ytCatalog(['vid0000000A'], null)],
      appendList: { body: { meals: APPENDABLE } },
      appendWrite: {
        status: 409,
        body: { error: 'Video vid0000000A is not on this creator’s connected channel.', quotaUnits: 1 },
      },
    });
    await loadYouTubeCatalog(1);
    fireEvent.click(screen.getByRole('button', { name: 'Check what can be linked' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Append the Mealio link for Best Guacamole' }));
    await screen.findByText(/not on this creator’s connected channel/);

    // The `videos.list` in front of the refusal was charged. A total that only
    // counts successes drifts below Google's, in the one direction that matters.
    expect(screen.getByTestId('quota-spent').textContent).toMatch(/^3 YouTube quota units/);
  });

  it('says when there are more linkable meals than the list can reach', async () => {
    harness({ creators: YT_CREATORS, appendList: { body: { meals: APPENDABLE, truncated: true } } });
    chooseCreator();
    fireEvent.click(screen.getByRole('button', { name: 'Check what can be linked' }));

    // There is no cursor past the 200-row ceiling, so saying so is the whole
    // remedy — past it, meals silently became unlinkable with the screen showing
    // nothing at all about it.
    expect((await screen.findByTestId('append-truncated')).textContent).toMatch(/has more/i);
  });

  it('forgets the previous creator’s meals when another is chosen', async () => {
    harness({
      creators: [...YT_CREATORS, { ...YT_CREATORS[0], id: 'c2', display_name: 'Chef Ben' }],
      appendList: { body: { meals: APPENDABLE } },
    });
    chooseCreator();
    fireEvent.click(screen.getByRole('button', { name: 'Check what can be linked' }));
    await screen.findByRole('button', { name: 'Append the Mealio link for Best Guacamole' });

    // Step 1 folds to its summary once a creator is chosen, so switching to
    // another one is: click the header, then pick. The header is on screen at
    // every point of the sequence — changing the creator mid-run must never
    // mean starting the screen again.
    fireEvent.click(screen.getByRole('button', { name: /Creator/ }));
    fireEvent.change(screen.getByLabelText('Creator'), { target: { value: 'c2' } });

    // A stale list of somebody else's videos beside an Append button is the
    // worst possible thing for this screen to leave on it.
    expect(screen.queryByRole('button', { name: /Append the Mealio link/ })).toBeNull();
  });
});
