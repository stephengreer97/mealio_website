import { describe, it, expect } from 'vitest';
import {
  runViabilityCheck,
  SOURCE_PROBES,
  type ProbeResult,
  type SourceProbe,
} from '@/lib/import/viability';
import type { PlatformSource } from '@/lib/creator-sources';
import { failingCaller, publicLookup, stubCaller, stubFetch, type StubRoute } from '../helpers/import-stubs';

const HOME = 'https://chefsarah.test/';

/**
 * A page with enough readable text to reach the classifier — the gate rejects
 * anything under 250 characters outright as a link-in-bio page.
 */
function page(title: string): string {
  return `<html><head><title>${title}</title></head><body><p>${'Cook the thing slowly and stir often. '.repeat(12)}</p></body></html>`;
}

function feed(...paths: string[]): string {
  const items = paths
    .map((path) => `<item><title>${path}</title><link>https://chefsarah.test${path}</link></item>`)
    .join('');
  return `<rss><channel>${items}</channel></rss>`;
}

function fetchOptions(routes: Record<string, StubRoute>) {
  const { impl, calls } = stubFetch(routes);
  return { calls, fetchOptions: { fetchImpl: impl, lookup: publicLookup } };
}

/** Site with a feed at /feed listing `paths`, each serving a readable page. */
function site(paths: string[], extra: Record<string, StubRoute> = {}) {
  const routes: Record<string, StubRoute> = {
    [HOME]: { body: '<html><head><title>Chef Sarah</title></head></html>' },
    'https://chefsarah.test/feed': { body: feed(...paths) },
    ...Object.fromEntries(paths.map((path) => [`https://chefsarah.test${path}`, { body: page(path) }])),
    ...extra,
  };
  return fetchOptions(routes);
}

/** A gate whose verdict is decided by whether the title is in `recipes`. */
function gateSaying(recipes: string[]) {
  return stubCaller((request) => {
    const isRecipe = recipes.some((path) => request.prompt.includes(`TITLE: ${path}`));
    return isRecipe
      ? { verdict: 'yes', reason: 'Lists ingredients and numbered steps.' }
      : { verdict: 'no', reason: 'Grocery haul: no preparation steps.' };
  });
}

describe('import/viability — known-unsupported comes first', () => {
  it('refuses Medium before a single request is made', async () => {
    const { calls, fetchOptions: opts } = fetchOptions({});
    const call = stubCaller(() => ({ verdict: 'yes', reason: 'x' }));

    const report = await runViabilityCheck('website', 'https://medium.com/@sarah', { call, fetchOptions: opts });

    expect(report.outcome).toBe('unsupported');
    expect(report.unsupported?.id).toBe('medium');
    expect(report.summary).toMatch(/403/);
    // The whole point of measuring this once is not paying to measure it again.
    expect(calls).toEqual([]);
    expect(call.requests).toEqual([]);
  });

  it('recognises the same failure on a custom domain, from the 403 itself', async () => {
    const { fetchOptions: opts } = fetchOptions({ [HOME]: { status: 403, body: 'no' } });
    const report = await runViabilityCheck('website', 'https://chefsarah.test', {
      call: stubCaller(() => ({ verdict: 'yes', reason: 'x' })),
      fetchOptions: opts,
    });
    expect(report.outcome).toBe('unsupported');
    expect(report.unsupported?.id).toBe('medium');
  });
});

describe('import/viability — the three outcomes', () => {
  it('most pass → viable, with the feed carried back for confirmation', async () => {
    const { fetchOptions: opts } = site(['/guacamole', '/soup', '/haul']);
    const report = await runViabilityCheck('website', 'https://chefsarah.test', {
      call: gateSaying(['/guacamole', '/soup']),
      fetchOptions: opts,
    });

    expect(report.outcome).toBe('viable');
    expect([report.passed, report.checked]).toEqual([2, 3]);
    expect(report.feed).toMatchObject({ url: 'https://chefsarah.test/feed', kind: 'rss', via: 'well-known' });
    // Every item carries the gate's own sentence, so a rejection is explainable.
    expect(report.items.find((i) => i.url.endsWith('/haul'))).toMatchObject({
      verdict: 'no',
      reason: 'Grocery haul: no preparation steps.',
    });
  });

  it('none pass → not-viable, and says what that means for the creator', async () => {
    const { fetchOptions: opts } = site(['/haul', '/vlog']);
    const report = await runViabilityCheck('website', 'https://chefsarah.test', {
      call: gateSaying([]),
      fetchOptions: opts,
    });

    expect(report.outcome).toBe('not-viable');
    expect(report.passed).toBe(0);
    expect(report.summary).toMatch(/Try another of their links/i);
    expect(report.summary).toMatch(/not importable/i);
  });

  it('a minority passing is reported as partial, never as viable', async () => {
    // 1-in-4 technically works, and a green tick would hide the fact that the
    // poller will almost never fire for this creator.
    const { fetchOptions: opts } = site(['/guacamole', '/haul', '/vlog', '/tour']);
    const report = await runViabilityCheck('website', 'https://chefsarah.test', {
      call: gateSaying(['/guacamole']),
      fetchOptions: opts,
    });

    expect(report.outcome).toBe('partial');
    expect(report.summary).toMatch(/1 of 4/);
  });

  it('reads at most the requested number of recent items', async () => {
    const paths = Array.from({ length: 8 }, (_, i) => `/post-${i}`);
    const { fetchOptions: opts } = site(paths);
    const report = await runViabilityCheck('website', 'https://chefsarah.test', {
      call: gateSaying(paths),
      fetchOptions: opts,
      maxItems: 3,
    });
    expect(report.checked).toBe(3);
  });
});

describe('import/viability — cannot check is not the same as failed', () => {
  it('a classifier outage reports unavailable, not not-viable', async () => {
    // Reporting "not importable" because our own classifier was down would
    // reject a perfectly good blog on the strength of our outage.
    const { fetchOptions: opts } = site(['/guacamole', '/soup']);
    const report = await runViabilityCheck('website', 'https://chefsarah.test', {
      call: failingCaller(),
      fetchOptions: opts,
    });

    expect(report.outcome).toBe('unavailable');
    expect(report.checked).toBe(0);
    expect(report.summary).toMatch(/says nothing about the creator/i);
  });

  it('no discoverable feed reports unavailable with the ladder it tried', async () => {
    const { fetchOptions: opts } = fetchOptions({ [HOME]: { body: '<html></html>' } });
    const report = await runViabilityCheck('website', 'https://chefsarah.test', {
      call: stubCaller(() => ({ verdict: 'yes', reason: 'x' })),
      fetchOptions: opts,
    });
    expect(report.outcome).toBe('unavailable');
    expect(report.summary).toMatch(/Ask the creator/i);
  });

  it('unreadable items are reported per-item and left out of the ratio', async () => {
    const { fetchOptions: opts } = site(['/guacamole'], {
      // In the feed, but 404s when we go to read it.
      'https://chefsarah.test/feed': { body: feed('/guacamole', '/gone') },
    });
    const report = await runViabilityCheck('website', 'https://chefsarah.test', {
      call: gateSaying(['/guacamole']),
      fetchOptions: opts,
    });

    expect(report.outcome).toBe('viable');
    expect([report.passed, report.checked]).toEqual([1, 1]);
    expect(report.items.find((i) => i.url.endsWith('/gone'))?.verdict).toBe('error');
  });

  it('never reads an item robots.txt disallows', async () => {
    const { calls, fetchOptions: opts } = site(['/guacamole'], {
      'https://chefsarah.test/robots.txt': { body: 'User-agent: *\nDisallow: /guacamole' },
    });
    const report = await runViabilityCheck('website', 'https://chefsarah.test', {
      call: gateSaying(['/guacamole']),
      fetchOptions: opts,
    });

    expect(calls).not.toContain('https://chefsarah.test/guacamole');
    expect(report.items[0].verdict).toBe('error');
    expect(report.items[0].reason).toMatch(/robots\.txt/i);
    // robots.txt is fetched once for the origin, not once per item.
    expect(calls.filter((url) => url.endsWith('/robots.txt'))).toHaveLength(1);
  });
});

describe('import/viability — platforms that are not connected yet', () => {
  it.each<[PlatformSource, string]>([
    ['youtube', 'MEAL-74'],
    ['instagram', 'MEAL-82'],
    ['tiktok', 'MEAL-83'],
  ])('%s reports unavailable and names the ticket', async (source, ticket) => {
    const call = stubCaller(() => ({ verdict: 'yes', reason: 'x' }));
    const report = await runViabilityCheck(source, `https://${source}.com/@sarah`, { call });

    // The failure mode this whole ticket exists to prevent is a check that
    // cannot run looking like a check that passed.
    expect(report.outcome).toBe('unavailable');
    expect(report.outcome).not.toBe('viable');
    expect(report.summary).toContain(ticket);
    expect(report.summary).toMatch(/not\* a pass|not a pass/i);
    expect(call.requests).toEqual([]);
  });

  it('exposes one probe per source, so a new platform is a registry entry', async () => {
    expect(Object.keys(SOURCE_PROBES).sort()).toEqual(['instagram', 'tiktok', 'website', 'youtube']);
  });

  it('accepts an injected probe, which is how the OAuth platforms will land', async () => {
    const probe: SourceProbe = {
      source: 'youtube',
      async probe(): Promise<ProbeResult> {
        return {
          ok: true,
          items: [{ url: 'https://youtube.com/watch?v=1', title: 'Tacos', text: 'x'.repeat(400), hasRecipeJsonLd: false }],
        };
      },
    };

    const report = await runViabilityCheck('youtube', 'https://youtube.com/@sarah', {
      call: stubCaller(() => ({ verdict: 'yes', reason: 'Narrates a taco recipe.' })),
      probes: { ...SOURCE_PROBES, youtube: probe },
    });

    expect(report.outcome).toBe('viable');
    expect(report.items[0].title).toBe('Tacos');
  });
});
