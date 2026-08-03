// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import PlatformLinksCard, { type CreatorLinks } from '@/components/PlatformLinksCard';

/**
 * The creator's own link editor (MEAL-94).
 *
 * The property under test is that this card can only ever say "here is where I
 * publish". It cannot start an import, it cannot choose a source, and it cannot
 * quietly remove the link Mealio is currently reading — those are an operator's
 * to decide (MEAL-81), and a card that could reverse one of them by accident is
 * the failure this ticket is written around.
 */

const CREATOR: CreatorLinks = {
  website_url: 'https://chefsarah.test/',
  youtube_url: null,
  instagram_url: null,
  tiktok_url: null,
  primary_source: 'none',
  import_opt_in: false,
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function harness(creator: CreatorLinks = CREATOR, response: () => Response = () => json({ ok: true, notices: [] })) {
  const calls: Array<{ url: string; method: string; body: any }> = [];
  const saved: Array<Record<string, string | null>> = [];
  vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return response();
  }) as typeof fetch);
  render(<PlatformLinksCard creator={creator} onSaved={links => { saved.push(links); }} />);
  return { calls, saved };
}

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const save = () => fireEvent.click(screen.getByRole('button', { name: /Save links/i }));

beforeEach(() => { localStorage.setItem('accessToken', 'test-token'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('PlatformLinksCard', () => {
  it('shows the links a creator already has, and saves a new one', async () => {
    const { calls, saved } = harness();

    expect(field('Website').value).toBe('https://chefsarah.test/');
    expect(field('YouTube').value).toBe('');

    // The whole ticket in one interaction: joined without YouTube, started a
    // channel, said so without an operator touching the row.
    fireEvent.change(field('YouTube'), { target: { value: 'youtube.com/@chefsarah' } });
    save();

    await waitFor(() => expect(calls.some(call => call.method === 'PATCH')).toBe(true));
    const sent = calls.find(call => call.method === 'PATCH');
    expect(sent?.url).toBe('/api/creator/me');
    expect(sent?.body.links.youtube).toBe('youtube.com/@chefsarah');
    // Nothing that could start an import travels with it.
    expect(Object.keys(sent?.body ?? {})).toEqual(['links']);
    expect(JSON.stringify(sent?.body)).not.toMatch(/primary|opt/i);

    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0].youtube).toBe('https://youtube.com/@chefsarah');
  });

  it('catches a link on the wrong platform before the round trip', async () => {
    const { calls } = harness();

    fireEvent.change(field('Instagram'), { target: { value: 'https://youtube.com/@chefsarah' } });
    save();

    // Same validator as the application form and the route, so the three cannot
    // disagree about what a YouTube URL in the Instagram box is.
    expect(await screen.findByText(/not on Instagram/i)).toBeTruthy();
    expect(calls.some(call => call.method === 'PATCH')).toBe(false);
  });

  it('says which link is being polled, before they try to clear it', async () => {
    harness({ ...CREATOR, primary_source: 'website', import_opt_in: true });

    // The refusal is legible only if they already know why. A creator who reads
    // this never meets it.
    expect(screen.getByText(/importing your recipes from your Website/i)).toBeTruthy();
  });

  it('says nothing about polling when nothing is polled', () => {
    harness({ ...CREATOR, primary_source: 'website', import_opt_in: false });
    expect(screen.queryByText(/importing your recipes/i)).toBeNull();
  });

  it('shows the server’s refusal rather than claiming a save', async () => {
    harness(
      { ...CREATOR, primary_source: 'website', import_opt_in: true },
      () => json({ error: 'Mealio is currently importing your recipes from your Website, so that link can\'t be removed.' }, 400),
    );

    fireEvent.change(field('Website'), { target: { value: '' } });
    save();

    expect(await screen.findByText(/can't be removed/i)).toBeTruthy();
    expect(screen.queryByText(/^Saved$/)).toBeNull();
  });

  it('passes on what happens to a connected account, rather than swallowing it', async () => {
    harness(
      { ...CREATOR, youtube_url: 'https://youtube.com/@chefsarah' },
      () => json({ ok: true, notices: ['Your connected YouTube account is still connected — removing the link here does not disconnect it.'] }),
    );

    fireEvent.change(field('YouTube'), { target: { value: '' } });
    save();

    // Removing a link is not a revocation, and a creator who believes it was
    // would never go back and check.
    expect(await screen.findByText(/still connected/i)).toBeTruthy();
  });
});
