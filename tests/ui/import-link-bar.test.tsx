// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import ImportLinkBar from '@/components/ImportLinkBar';
import type { ImportRejection, ImportSuccess } from '@/lib/import/types';
import { importedGuacamole } from '../helpers/import-ui-fixtures';

/**
 * The paste-a-link bar, including the branch a creator actually hits today:
 * with no ANTHROPIC_API_KEY provisioned the pipeline rejects at `extract`, so
 * the rejection path is the live path and is tested as such.
 */

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

beforeEach(() => {
  localStorage.setItem('accessToken', 'test-token');
});

function harness(fetchImpl: typeof fetch) {
  vi.stubGlobal('fetch', fetchImpl);
  const onImported = vi.fn();
  const onRejected = vi.fn();
  const onClearDraft = vi.fn();
  const onImportStart = vi.fn();
  const view = render(
    <ImportLinkBar
      onImported={onImported}
      onRejected={onRejected}
      onImportStart={onImportStart}
      hasDraft={false}
      onClearDraft={onClearDraft}
    />,
  );
  return { onImported, onRejected, onClearDraft, onImportStart, view };
}

function paste(url: string) {
  fireEvent.change(screen.getByLabelText('Recipe link to import'), { target: { value: url } });
}

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('ImportLinkBar — success', () => {
  let success: ImportSuccess;
  beforeEach(async () => { success = await importedGuacamole(); });

  it('hands the pipeline’s result to the form', async () => {
    const { onImported } = harness((async () => json(success, 200)) as typeof fetch);

    paste('https://cookieandkate.com/best-guacamole-recipe');
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    await waitFor(() => expect(onImported).toHaveBeenCalledTimes(1));
    expect(onImported.mock.calls[0][0].draft.name).toBe('Best Guacamole');
  });

  it('adds a scheme so a bare domain works', async () => {
    const calls: string[] = [];
    const { onImported } = harness((async (_url, init) => {
      calls.push(JSON.parse(String((init as RequestInit).body)).url);
      return json(success, 200);
    }) as typeof fetch);

    paste('cookieandkate.com/best-guacamole-recipe');
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    await waitFor(() => expect(onImported).toHaveBeenCalled());
    expect(calls[0]).toBe('https://cookieandkate.com/best-guacamole-recipe');
  });

  it('shows a progress state naming the site being read', async () => {
    let release: (r: Response) => void = () => {};
    const { onImportStart } = harness((async () => new Promise<Response>(res => { release = res; })) as typeof fetch);

    paste('https://cookieandkate.com/best-guacamole-recipe');
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    expect(onImportStart).toHaveBeenCalledTimes(1);

    const status = await screen.findByRole('status');
    expect(status.textContent).toContain('cookieandkate.com');
    expect(status.textContent).toMatch(/up to a minute/i);
    // It invites the creator to keep working, so it has to promise their
    // typing survives — and the form has to honour that.
    expect(status.textContent).toMatch(/anything you type while we read stays/i);
    expect(screen.getByRole('button', { name: 'Reading…' })).toBeTruthy();

    release(json(success, 200));
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });

  it('imports on Enter, and cannot submit the publish form by doing so', async () => {
    const { onImported } = harness((async () => json(success, 200)) as typeof fetch);
    const input = screen.getByLabelText('Recipe link to import');
    paste('https://cookieandkate.com/best-guacamole-recipe');
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onImported).toHaveBeenCalled());
  });
});

describe('ImportLinkBar — a response that outlives its request', () => {
  let success: ImportSuccess;
  beforeEach(async () => { success = await importedGuacamole(); });

  it('writes nothing after the bar has been unmounted', async () => {
    // The publish modal unmounts on Cancel, but the portal it writes into does
    // not. Without the guard, a late response repopulates a form the creator
    // has already walked away from.
    let release: (r: Response) => void = () => {};
    const { onImported, onRejected, view } =
      harness((async () => new Promise<Response>(res => { release = res; })) as typeof fetch);

    paste('https://cookieandkate.com/best-guacamole-recipe');
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await screen.findByRole('status');

    view.unmount();
    release(json(success, 200));
    await new Promise(r => setTimeout(r, 0));

    expect(onImported).not.toHaveBeenCalled();
    expect(onRejected).not.toHaveBeenCalled();
  });

  it('aborts the in-flight request on unmount', async () => {
    const signals: AbortSignal[] = [];
    const { view } = harness((async (_url, init) => {
      signals.push((init as RequestInit).signal!);
      return new Promise<Response>(() => {});
    }) as typeof fetch);

    paste('https://cookieandkate.com/best-guacamole-recipe');
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await screen.findByRole('status');

    expect(signals[0].aborted).toBe(false);
    view.unmount();
    expect(signals[0].aborted).toBe(true);
  });

  it('will not start a second request while one is in flight', async () => {
    // The single-writer guarantee comes from here first — the stale-request
    // check behind it is defence for anything that gets past this.
    const starts: string[] = [];
    harness((async (_url, init) => {
      starts.push(JSON.parse(String((init as RequestInit).body)).url);
      return new Promise<Response>(() => {});
    }) as typeof fetch);

    paste('https://cookieandkate.com/one');
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await screen.findByRole('status');

    paste('https://cookieandkate.com/two');
    fireEvent.click(screen.getByRole('button', { name: 'Reading…' }));

    expect(starts).toEqual(['https://cookieandkate.com/one']);
  });
});

describe('ImportLinkBar — rejection', () => {
  const rejection: ImportRejection = {
    status: 'rejected',
    url: 'https://example.com/vlog',
    stage: 'gate',
    reason: 'not-a-recipe',
    detail: 'This page reads like a vlog write-up rather than a recipe — there is no ingredient list on it.',
    meta: { cached: false },
  };

  it('renders the pipeline’s own detail, word for word', async () => {
    const { onRejected, onImported } = harness((async () => json(rejection, 422)) as typeof fetch);

    paste('https://example.com/vlog');
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(rejection.detail);
    expect(alert.textContent).toContain('That page doesn’t look like a recipe');
    expect(alert.textContent).toMatch(/fill the form in below/i);

    // Nothing is filled in on a rejection.
    expect(onImported).not.toHaveBeenCalled();
    expect(onRejected).toHaveBeenCalledWith(rejection, 'https://example.com/vlog');
  });

  it('handles the no-API-key case the same way, because that is the live case', async () => {
    const noKey: ImportRejection = {
      ...rejection,
      stage: 'extract',
      reason: 'extraction-failed',
      detail: 'The import service is not configured (ANTHROPIC_API_KEY is not set).',
    };
    harness((async () => json(noKey, 422)) as typeof fetch);

    paste('https://cookieandkate.com/best-guacamole-recipe');
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('We couldn’t pull a recipe out of that page');
    expect(alert.textContent).toContain('ANTHROPIC_API_KEY is not set');
  });

  it('turns a non-pipeline failure into the same shape rather than a raw error', async () => {
    const { onRejected } = harness((async () => json({ error: 'Creator account required' }, 403)) as typeof fetch);

    paste('https://cookieandkate.com/best-guacamole-recipe');
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Creator account required');
    expect(onRejected.mock.calls[0][0].status).toBe('rejected');

    // And the heading does not blame their link. A 403 from our own endpoint
    // never touched it, so "We couldn't open that link" sends them off to check
    // a URL that is perfectly fine.
    expect(alert.textContent).toContain('We couldn’t complete that import');
    expect(alert.textContent).not.toContain('couldn’t open that link');
  });

  it('survives the network being down', async () => {
    harness((async () => { throw new Error('offline'); }) as typeof fetch);

    paste('https://cookieandkate.com/best-guacamole-recipe');
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/couldn’t reach the import service/i);
  });

  it('clears the notice as soon as the creator edits the link', async () => {
    harness((async () => json(rejection, 422)) as typeof fetch);

    paste('https://example.com/vlog');
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await screen.findByRole('alert');

    paste('https://example.com/actual-recipe');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('ImportLinkBar — quiet by default', () => {
  it('is a secondary control: no brand red anywhere on it', () => {
    harness((async () => json({}, 200)) as typeof fetch);
    const bar = screen.getByTestId('import-link-bar');
    // The One Tap Rule — Publish keeps the only Signal Red on the screen.
    expect(bar.outerHTML.toLowerCase()).not.toContain('#dd0031');
    expect(bar.outerHTML.toLowerCase()).not.toContain('rgb(221, 0, 49)');
  });

  it('will not fire on an empty box', () => {
    const { onImported } = harness((async () => json({}, 200)) as typeof fetch);
    const button = screen.getByRole('button', { name: 'Import' }) as HTMLButtonElement;
    // `aria-disabled`, not `disabled`: a disabled element cannot hold focus, so
    // the real `disabled` threw a keyboard user back to <body> the moment they
    // pressed Import. The guard is in `runImport`.
    expect(button.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(button);
    expect(onImported).not.toHaveBeenCalled();
  });
});

describe('ImportLinkBar — starting over stops the read', () => {
  it('aborts an in-flight request and refuses its response', async () => {
    // Clearing the form used to leave the request running, so the response
    // landed on the empty form a moment later and repopulated it.
    let release: (r: Response) => void = () => {};
    const signals: AbortSignal[] = [];
    const success = await importedGuacamole();
    const { onImported, onClearDraft } = harness((async (_url, init) => {
      signals.push((init as RequestInit).signal!);
      return new Promise<Response>(res => { release = res; });
    }) as typeof fetch);

    paste('https://cookieandkate.com/best-guacamole-recipe');
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await screen.findByRole('status');

    // Offered mid-read even with no draft yet — it is the only way out of a
    // request the copy warns can take a minute.
    fireEvent.click(screen.getByRole('button', { name: /clear and start over/i }));

    expect(onClearDraft).toHaveBeenCalledTimes(1);
    expect(signals[0].aborted).toBe(true);
    expect(screen.queryByRole('status')).toBeNull();

    release(json(success, 200));
    await new Promise(r => setTimeout(r, 0));
    expect(onImported).not.toHaveBeenCalled();
  });

  it('can start a fresh import straight afterwards', async () => {
    const success = await importedGuacamole();
    let hang = true;
    const { onImported } = harness((async () =>
      (hang ? new Promise<Response>(() => {}) : json(success, 200))) as typeof fetch);

    paste('https://cookieandkate.com/one');
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await screen.findByRole('status');
    fireEvent.click(screen.getByRole('button', { name: /clear and start over/i }));

    hang = false;
    paste('https://cookieandkate.com/two');
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(onImported).toHaveBeenCalledTimes(1));
  });
});
