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
  it.each<PlatformSource>(['instagram', 'tiktok'])(
    '%s reports unavailable until the creator connects, never a pass',
    async (source) => {
      const call = stubCaller(() => ({ verdict: 'yes', reason: 'x' }));
      // No grant. Unlike a website or a YouTube channel there is no public feed
      // to fall back on, so there is genuinely nothing to measure yet
      // (MEAL-82 / MEAL-83).
      const report = await runViabilityCheck(source, `https://${source}.com/@sarah`, { call });

      // The failure mode this whole ticket exists to prevent is a check that
      // cannot run looking like a check that passed.
      expect(report.outcome).toBe('unavailable');
      expect(report.outcome).not.toBe('viable');
      expect(report.summary).toMatch(/connect/i);
      expect(report.summary).toMatch(/not\* a pass|not a pass/i);
      expect(call.requests).toEqual([]);
    },
  );

  it('says an account is empty rather than that nothing could be read', async () => {
    // An account we reached that has posted nothing is an answer. It used to
    // come back through `ok: false` — which every caller then treated as a
    // failure — and now comes back as a probe that succeeded with nothing in
    // it. Neither a pass nor a verdict on the creator, and it says which.
    const probe: SourceProbe = { source: 'instagram', async probe(): Promise<ProbeResult> { return { ok: true, items: [] }; } };
    const call = stubCaller(() => ({ verdict: 'yes', reason: 'x' }));

    const report = await runViabilityCheck('instagram', 'https://instagram.com/@sarah', {
      call,
      probes: { ...SOURCE_PROBES, instagram: probe },
    });

    expect(report.outcome).toBe('unavailable');
    expect(report.summary).toMatch(/nothing posted/i);
    // The sentence for a set of items we failed to read must not be used for a
    // set of items that does not exist.
    expect(report.summary).not.toMatch(/could not be read/i);
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

describe('import/viability — only the creator’s own pages are read', () => {
  /** A feed on the creator's host whose every entry points somewhere else. */
  function feedOfSomeoneElsesPosts(...paths: string[]): Record<string, StubRoute> {
    const items = paths
      .map((path) => `<item><title>${path}</title><link>https://victim.example${path}</link></item>`)
      .join('');
    return {
      [HOME]: { body: '<html><head><title>Chef Sarah</title></head></html>' },
      'https://chefsarah.test/feed': { body: `<rss><channel>${items}</channel></rss>` },
      ...Object.fromEntries(paths.map((path) => [`https://victim.example${path}`, { body: page(path) }])),
    };
  }

  it('never fetches an entry that is not on the creator’s site', async () => {
    // The host rule guarded `feed_url` and nothing else, so a feed that passed
    // it cleanly could still hand us ten of a stranger's pages — which we
    // fetched, classified, and reported as viable under this creator's name.
    const { calls, fetchOptions: opts } = fetchOptions(feedOfSomeoneElsesPosts('/a', '/b', '/c'));
    const report = await runViabilityCheck('website', 'https://chefsarah.test', {
      call: stubCaller(() => ({ verdict: 'yes', reason: 'Lists ingredients and numbered steps.' })),
      fetchOptions: opts,
    });

    expect(calls.filter((url) => url.startsWith('https://victim.example/'))).toEqual([]);
    expect(report.outcome).not.toBe('viable');
    // Reported rather than silently dropped: "this creator's feed lists someone
    // else's posts" is the single most useful thing an operator could learn here.
    expect(report.items).toHaveLength(3);
    expect(report.items.every((item) => item.verdict === 'error')).toBe(true);
    expect(report.items[0].reason).toMatch(/not on https:\/\/chefsarah\.test/);
  });

  it('refuses a confirmed feed URL that is not on the creator’s site', async () => {
    const { calls, fetchOptions: opts } = fetchOptions({});
    const report = await runViabilityCheck('website', 'https://chefsarah.test', {
      call: stubCaller(() => ({ verdict: 'yes', reason: 'x' })),
      fetchOptions: opts,
      feedUrl: 'https://attacker.test/feed',
    });

    expect(report.outcome).toBe('unavailable');
    expect(report.summary).toMatch(/not on https:\/\/chefsarah\.test/);
    expect(calls).toEqual([]);
  });
});

// ── YouTube (MEAL-74) ────────────────────────────────────────────────────────

describe('import/viability — the YouTube probe measures a channel for free', () => {
  const CHANNEL_ID = 'UCabcdefghijklmnopqrstuv';
  const UPLOADS_FEED = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`;

  /** A description long enough that the gate would judge it rather than call it thin. */
  const RECIPE_DESCRIPTION = `Ingredients:\n2 ripe avocados\n1 lime\n${'Mash them together and season well. '.repeat(8)}`;

  function uploadsFeed(entries: Array<{ id: string; title: string; description: string }>): string {
    const xml = entries
      .map(
        (entry) =>
          `<entry><id>yt:video:${entry.id}</id><yt:videoId>${entry.id}</yt:videoId>` +
          `<title>${entry.title}</title>` +
          `<published>2026-07-29T09:00:00+00:00</published>` +
          `<media:group><media:description>${entry.description}</media:description>` +
          `<media:thumbnail url="https://i.ytimg.com/vi/${entry.id}/hqdefault.jpg"/></media:group></entry>`,
      )
      .join('');
    return `<feed xmlns:yt="y" xmlns:media="m">${xml}</feed>`;
  }

  function channelRoutes(body: string): Record<string, StubRoute> {
    return { [UPLOADS_FEED]: { body, headers: { 'content-type': 'text/xml' } } };
  }

  it('gates each video on its title and description, fetching only the feed', async () => {
    const { calls, fetchOptions: opts } = fetchOptions(
      channelRoutes(
        uploadsFeed([
          { id: 'vid0000000A', title: 'Best Guacamole', description: RECIPE_DESCRIPTION },
          { id: 'vid0000000B', title: 'Grocery haul', description: RECIPE_DESCRIPTION },
        ]),
      ),
    );
    const call = stubCaller((request) =>
      request.prompt.includes('TITLE: Best Guacamole')
        ? { verdict: 'yes', reason: 'Lists ingredients and steps.' }
        : { verdict: 'no', reason: 'A haul, not a recipe.' },
    );

    const report = await runViabilityCheck('youtube', 'https://youtube.com/@sarah', {
      call,
      fetchOptions: opts,
      grant: { externalId: CHANNEL_ID, accessToken: null },
    });

    expect(report.checked).toBe(2);
    expect(report.passed).toBe(1);
    // One request for the whole measurement. No video page, no API quota — which
    // is what lets this run before the creator has connected anything.
    expect(calls).toEqual([UPLOADS_FEED]);
  });

  it('measures a channel with no OAuth grant at all, from the public feed', async () => {
    const { calls, fetchOptions: opts } = fetchOptions({
      'https://youtube.com/@sarah': {
        body: `<html><link rel="canonical" href="https://www.youtube.com/channel/${CHANNEL_ID}"></html>`,
      },
      ...channelRoutes(uploadsFeed([{ id: 'vid0000000A', title: 'Best Guacamole', description: RECIPE_DESCRIPTION }])),
    });

    const report = await runViabilityCheck('youtube', 'https://youtube.com/@sarah', {
      call: stubCaller(() => ({ verdict: 'yes', reason: 'Lists ingredients and steps.' })),
      fetchOptions: opts,
    });

    // Application review happens before anyone has connected a channel, so a
    // probe that needed a grant would never run when it is actually wanted.
    expect(report.outcome).toBe('viable');
    expect(calls).toEqual(['https://youtube.com/robots.txt', 'https://youtube.com/@sarah', UPLOADS_FEED]);
  });

  it('reports a video with no description and no captions rather than gating it', async () => {
    const { fetchOptions: opts } = fetchOptions(
      channelRoutes(uploadsFeed([{ id: 'vid0000000A', title: 'Sunday vlog', description: '' }])),
    );
    const call = stubCaller(() => ({ verdict: 'yes', reason: 'x' }));

    const report = await runViabilityCheck('youtube', 'https://youtube.com/@sarah', {
      call,
      fetchOptions: opts,
      grant: { externalId: CHANNEL_ID, accessToken: null },
    });

    // Counting it as "not a recipe" would measure our access rather than the
    // creator, which is exactly the confusion this whole check exists to avoid.
    expect(report.items[0].verdict).toBe('error');
    expect(report.checked).toBe(0);
    expect(report.outcome).toBe('unavailable');
    expect(call.requests).toEqual([]);
  });

  it('reports unavailable when the channel id cannot be worked out', async () => {
    const { fetchOptions: opts } = fetchOptions({ 'https://youtube.com/@sarah': { body: '<html></html>' } });

    const report = await runViabilityCheck('youtube', 'https://youtube.com/@sarah', {
      call: stubCaller(() => ({ verdict: 'yes', reason: 'x' })),
      fetchOptions: opts,
    });

    expect(report.outcome).toBe('unavailable');
    expect(report.outcome).not.toBe('viable');
    expect(report.summary).toMatch(/did not name a channel id/);
  });
});

// ── Instagram and TikTok (MEAL-82 / MEAL-83) ─────────────────────────────────

/**
 * Both probes read through a grant, so `fetchOptions.fetchImpl` is the seam and
 * `grant.accessToken` is what turns the probe on. Neither can be run against the
 * real API until app review clears; these exercise the documented shapes.
 */
describe('import/viability — the caption is the measurement', () => {
  /** Long enough that the gate would judge it rather than call it thin. */
  const RECIPE_CAPTION = `Guacamole\nIngredients:\n2 ripe avocados\n1 lime\n${'Mash them together and season well. '.repeat(8)}`;

  const jsonRoute = (body: unknown) => ({ body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

  function instagramRoutes(captions: string[]) {
    return {
      'https://graph.instagram.com/me/media?fields=id%2Ccaption%2Cmedia_type%2Cmedia_url%2Cpermalink%2Ctimestamp&limit=10&access_token=IGQ-long': jsonRoute({
        data: captions.map((caption, index) => ({
          id: `m${index}`,
          caption,
          media_type: 'VIDEO',
          permalink: `https://www.instagram.com/reel/m${index}/`,
          timestamp: '2026-07-29T09:00:00+0000',
        })),
      }),
    };
  }

  it('gates each Instagram post on its caption', async () => {
    const { calls, fetchOptions: opts } = fetchOptions(instagramRoutes([RECIPE_CAPTION, RECIPE_CAPTION]));
    const call = stubCaller((request) =>
      request.prompt.includes('TITLE: Guacamole')
        ? { verdict: 'yes', reason: 'Lists ingredients and steps.' }
        : { verdict: 'no', reason: 'Not a recipe.' },
    );

    const report = await runViabilityCheck('instagram', 'https://instagram.com/chefsarah', {
      call,
      fetchOptions: opts,
      grant: { externalId: '178', accessToken: 'IGQ-long' },
    });

    expect(report.checked).toBe(2);
    expect(report.passed).toBe(2);
    expect(report.outcome).toBe('viable');
    // One request for the whole measurement. No video downloaded — transcription
    // is MEAL-85 and is not built.
    expect(calls).toHaveLength(1);
  });

  it('reports a post with no caption rather than gating it', async () => {
    const { fetchOptions: opts } = fetchOptions(instagramRoutes(['']));
    const call = stubCaller(() => ({ verdict: 'yes', reason: 'x' }));

    const report = await runViabilityCheck('instagram', 'https://instagram.com/chefsarah', {
      call,
      fetchOptions: opts,
      grant: { externalId: '178', accessToken: 'IGQ-long' },
    });

    // Calling an empty caption "not a recipe" would measure our access rather
    // than the creator's post — and Instagram exposes no transcript to fall back
    // on, which the reason says out loud.
    expect(report.items[0].verdict).toBe('error');
    expect(report.items[0].reason).toMatch(/MEAL-85/);
    expect(report.checked).toBe(0);
    expect(report.outcome).toBe('unavailable');
    expect(call.requests).toEqual([]);
  });

  it('gates each TikTok video on its description, and says so honestly when they are thin', async () => {
    const { fetchOptions: opts } = fetchOptions({
      'https://open.tiktokapis.com/v2/video/list/?fields=id%2Ctitle%2Cvideo_description%2Cduration%2Ccover_image_url%2Cembed_link%2Cshare_url%2Ccreate_time':
        jsonRoute({
          data: {
            videos: [
              { id: 'v1', title: 'Guacamole', video_description: RECIPE_CAPTION, share_url: 'https://www.tiktok.com/@s/video/v1' },
              { id: 'v2', title: 'Dinner', video_description: 'full recipe on my blog', share_url: 'https://www.tiktok.com/@s/video/v2' },
              { id: 'v3', title: 'Lunch', video_description: 'link in bio', share_url: 'https://www.tiktok.com/@s/video/v3' },
            ],
            has_more: false,
          },
          error: { code: 'ok' },
        }),
    });
    const call = stubCaller((request) =>
      request.prompt.includes('2 ripe avocados')
        ? { verdict: 'yes', reason: 'Lists ingredients and steps.' }
        : { verdict: 'no', reason: 'Points elsewhere for the recipe.' },
    );

    const report = await runViabilityCheck('tiktok', 'https://tiktok.com/@chefsarah', {
      call,
      fetchOptions: opts,
      grant: { externalId: 'open-id-1', accessToken: 'act.tiktok' },
    });

    // "Recipe on my blog" is a real answer about this creator, not a failure of
    // ours — there is no transcription route on TikTok and there cannot be one,
    // so a mostly-red report means TikTok is their link source, not their recipe
    // source.
    expect(report.checked).toBe(3);
    expect(report.passed).toBe(1);
    expect(report.outcome).toBe('partial');
  });

  it('reports the platform’s own refusal rather than an empty account', async () => {
    const { fetchOptions: opts } = fetchOptions({
      'https://graph.instagram.com/me/media?fields=id%2Ccaption%2Cmedia_type%2Cmedia_url%2Cpermalink%2Ctimestamp&limit=10&access_token=IGQ-dead':
        { ...jsonRoute({ error: { message: 'Session has expired' } }), status: 400 },
    });

    const report = await runViabilityCheck('instagram', 'https://instagram.com/chefsarah', {
      call: stubCaller(() => ({ verdict: 'yes', reason: 'x' })),
      fetchOptions: opts,
      grant: { externalId: '178', accessToken: 'IGQ-dead' },
    });

    expect(report.outcome).toBe('unavailable');
    expect(report.outcome).not.toBe('not-viable');
    expect(report.summary).toMatch(/Session has expired/);
  });
});
