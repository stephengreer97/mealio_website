// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';

/**
 * Does the operator see what the sweep is about to do? (MEAL-133)
 *
 * The route already answers this — `ageFilterAvailable`, a `warnings` entry and
 * `objectsTooNewToDelete` are all on the dry-run response. But the Storage tab
 * typed that response as five fields and rendered those five, so the answer went
 * nowhere. The window it matters in is real and open right now: the
 * `list_storage_objects` migration is applied by hand, and until it is, the sweep
 * cannot tell a photo uploaded ten seconds ago from one abandoned last year.
 *
 * The delete decision itself is tested against the route in
 * `tests/api/admin-storage-cleanup-orphans.test.ts`. What is asserted here is only
 * that the sentence reaches the screen the red button is on.
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/components/AdminSyncPanel', () => ({ default: () => null }));
vi.mock('@/components/AdminReviewQueue', () => ({ default: () => null }));

const AdminPage = (await import('@/app/admin/page')).default;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** The pre-migration warning, verbatim as the route composes it. */
const AGE_WARNING =
  'The bucket listing carried no created_at, so `list_storage_objects` has not been migrated yet ' +
  '(supabase/migrations/20260807000002_list_storage_objects_created_at.sql). Objects uploaded seconds ' +
  'ago cannot be told from abandoned ones, so a photo a user is part-way through attaching can still ' +
  'be deleted (MEAL-133). Apply the migration to enable the 60-minute grace window.';

/** Opens the Storage tab and runs a dry run that answers with `body`. */
async function dryRun(body: Record<string, unknown>) {
  vi.stubGlobal('fetch', (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/auth/verify')) return json({ user: { isAdmin: true } });
    if (url.includes('/api/admin/applications')) return json({ applications: [] });
    if (url.includes('cleanup-orphans')) return json(body);
    return json({}, 404);
  }) as typeof fetch);
  render(<AdminPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Storage' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Dry Run' }));
  await screen.findByText(/Dry run:/);
}

beforeEach(() => { localStorage.setItem('accessToken', 'admin-token'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('admin Storage tab — the dry run says whether the age filter is on', () => {
  it('warns, before the delete button, that the migration is still outstanding', async () => {
    await dryRun({
      dryRun: true,
      orphanCount: 2,
      estimatedBytes: 2048,
      paths: ['user-1/a.jpg', 'user-1/b.jpg'],
      tooNewPaths: [],
      warnings: [AGE_WARNING],
      wouldBlock: false,
      ageFilterAvailable: false,
      objectsTooNewToDelete: 0,
    });

    const warned = screen.getByTestId('storage-dry-run-warnings');
    // In the operator's terms, not the field name's.
    expect(warned.textContent).toMatch(/uploaded moments ago/i);
    expect(warned.textContent).toMatch(/can still be deleted/i);
    // And the route's own detail, which is what names the file to apply.
    expect(warned.textContent).toContain('20260807000002_list_storage_objects_created_at.sql');
    expect(warned.textContent).toContain('MEAL-133');
    // The button is still offered — this is a warning, not a lockout — but nobody
    // presses it without having read the line above it.
    expect(screen.getByRole('button', { name: 'Delete 2 Orphans' })).toBeTruthy();
  });

  it('says nothing about the age filter once the migration is in', async () => {
    await dryRun({
      dryRun: true,
      orphanCount: 1,
      estimatedBytes: 1024,
      paths: ['user-1/old.jpg'],
      tooNewPaths: ['user-1/fresh.jpg'],
      wouldBlock: false,
      ageFilterAvailable: true,
      objectsTooNewToDelete: 1,
    });

    expect(screen.queryByTestId('storage-dry-run-warnings')).toBeNull();
    // The held-back count still shows, because "why is that object not in the list"
    // is a question the dry run should answer rather than leave to guesswork.
    expect(screen.getByText(/held back as too new/i).textContent).toMatch(/1 unreferenced object/);
  });
});
