/**
 * The onboarding viability check (MEAL-81).
 *
 * If `primary_source` is set to TikTok for a creator whose captions are not
 * recipes, the engine produces nothing, forever, silently. Same for a Reels
 * creator who never writes the recipe out. Nobody notices, because "no imports
 * yet" and "no imports ever" look identical from the outside.
 *
 * So before a creator is committed to a source, we take their last ~10 items and
 * run each one through the gate that the poller will use anyway (MEAL-70,
 * `classifySource`). It costs pennies and it turns the reviewer's judgement call
 * into a measurement, answered before anything is promised to anyone:
 *
 *   - most pass          → set the source, enable
 *   - none on this one   → try another of their links
 *   - none anywhere      → this creator is **not importable**, and they are told
 *                          so, rather than the feature quietly doing nothing
 *
 * All four sources can be probed. **Only the website can be probed before the
 * creator connects anything**, which moves when the answer is available: a
 * website has a public feed, and Instagram, TikTok and — since MEAL-79 —
 * YouTube hand over nothing without an OAuth grant. Those three report
 * `unavailable` with "not measurable until connected", and say why.
 *
 * That cost is accepted rather than worked around (MEAL-74, 2026-08-02). The
 * alternative was a weaker pre-check off a public page, which is a second,
 * cheaper code path measuring something different from what the poller will
 * later read — and whether a creator posts recipes at all is a thirty-second
 * human judgement an operator makes with their links open in front of them.
 *
 * They are deliberately *not* stubbed to return "viable" when they cannot run. A
 * check that could not run must never look like a check that passed, since that
 * is the exact failure this whole ticket exists to prevent.
 */

import {
  isOnSameSite,
  knownUnsupportedSource,
  unsupportedSourceById,
  SOURCE_LABELS,
  type PlatformSource,
  type UnsupportedSource,
  type ViabilityOutcome,
} from '@/lib/creator-sources';
import { createStructuredCaller, type StructuredCaller } from './anthropic';
import { discoverFeed, readFeed, type DiscoveredFeed } from './feed-discovery';
import { classifySource } from './gate';
import { toSourceDocument } from './html';
import { robotsPerOrigin } from './robots';
import { safeFetch, type SafeFetchOptions } from './ssrf';
import { isChannelId, listUploads, resolveChannelId, youtubeSourceDocument } from '@/lib/youtube';
import {
  fetchInstagramMedia,
  hasRecipeText as hasInstagramText,
  instagramSourceDocument,
  INSTAGRAM_NO_CAPTION_DETAIL,
} from '@/lib/instagram';
import {
  fetchTikTokVideos,
  hasRecipeText as hasTikTokText,
  tiktokSourceDocument,
  TIKTOK_NO_DESCRIPTION_DETAIL,
} from '@/lib/tiktok';
import type { FeedEntry } from './feed';
import type { GateVerdictValue } from './types';

/** How many recent items a check reads. "~10" from the ticket. */
export const VIABILITY_SAMPLE_SIZE = 10;

/**
 * Share of readable items that must pass for a source to count as viable.
 *
 * "Most pass" in the ticket. Half is the reading that fails safe: at 3-in-10 the
 * source technically works, but a creator whose feed is mostly not recipes gets
 * a poller that fires rarely, and an operator should see that number rather than
 * a green tick.
 */
export const VIABLE_PASS_RATIO = 0.5;

/** How many item pages are fetched at once. Ten serial fetches would blow the function budget. */
const FETCH_CONCURRENCY = 4;

/** Per-item fetch budget. Ten of these have to fit inside one admin request. */
const ITEM_TIMEOUT_MS = 8_000;

/**
 * Re-exported from `creator-sources` so callers of the check have one import.
 * It lives there because the admin UI needs the type and the roll-up, and this
 * module pulls in undici — a client bundle must not follow it.
 */
export type { ViabilityOutcome };

export interface ViabilityItem {
  url: string;
  title: string;
  /** `error` means the item could not be read, so it was never gated. */
  verdict: GateVerdictValue | 'error';
  /** The gate's own sentence, or the fetch failure. Stands on its own in a log. */
  reason: string;
}

export interface ViabilityReport {
  source: PlatformSource;
  outcome: ViabilityOutcome;
  /** One paragraph an operator can act on without reading the item list. */
  summary: string;
  /** Items the gate actually saw a verdict for. */
  checked: number;
  passed: number;
  items: ViabilityItem[];
  /**
   * The feed we would poll, with its most recent entries — shown so a human
   * confirms the discovery before it is stored. Never written here.
   */
  feed: { url: string; kind: DiscoveredFeed['kind']; via: DiscoveredFeed['via']; entries: FeedEntry[] } | null;
  unsupported: UnsupportedSource | null;
  costUsd: number;
}

// ── The probe seam ───────────────────────────────────────────────────────────

/** One item as a probe hands it over: already reduced to what the gate takes. */
export interface ProbedItem {
  url: string;
  title: string;
  /** Cleaned page text for a blog; description + captions for a video. */
  text: string;
  hasRecipeJsonLd: boolean;
  /** Set when the item could not be read. Such items are reported, never gated. */
  error?: string;
}

/**
 * The creator's OAuth grant for this platform, reduced to what a probe needs.
 *
 * Resolved by the caller, which is the only layer with a database: a probe takes
 * a link and returns items, and giving it a Supabase client so it could look a
 * token up itself would make every probe untestable without one.
 */
export interface ProbeGrant {
  /** The platform's own account id — YouTube channel id, IG user id. From the grant, never typed. */
  externalId: string | null;
  /** A token good right now, or null when the creator has not connected. */
  accessToken: string | null;
}

export interface ProbeContext {
  fetchOptions?: SafeFetchOptions;
  /** A feed URL an operator already confirmed. Skips discovery when present. */
  feedUrl?: string | null;
  /** Null when there is no connection — which is ordinary, not a failure. */
  grant?: ProbeGrant | null;
  maxItems: number;
}

export type ProbeResult =
  | { ok: true; items: ProbedItem[]; feed?: DiscoveredFeed }
  | { ok: false; detail: string; unsupportedId?: string };

/**
 * What a platform has to provide to be checkable.
 *
 * The website implementation is here; YouTube, Instagram and TikTok plug in
 * behind the same interface once their OAuth connections land. Everything above
 * this line — the gate loop, the pass ratio, the three outcomes — is written
 * against `SourceProbe` and does not change when they do.
 */
export interface SourceProbe {
  source: PlatformSource;
  probe(link: string, context: ProbeContext): Promise<ProbeResult>;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Website probe: discover (or re-read) the feed, then read the most recent
 * entries.
 *
 * robots.txt is loaded once per origin and consulted for every URL, including
 * each item page — ten requests to a creator's own site should not involve ten
 * requests for the same robots.txt.
 *
 * Everything fetched here has to be on the creator's own site. That is what
 * `feed_url` means, and it is the check that was missing: the *feed's* host was
 * being policed while the item URLs inside it — the pages actually fetched,
 * classified and reported — were not policed anywhere at all.
 */
export const websiteProbe: SourceProbe = {
  source: 'website',

  async probe(link, context) {
    let origin: string;
    try {
      origin = new URL(link).origin;
    } catch {
      return { ok: false, detail: `"${link}" is not a URL we can fetch.` };
    }

    if (context.feedUrl && !isOnSameSite(link, context.feedUrl)) {
      return {
        ok: false,
        detail:
          `${context.feedUrl} is not on ${origin}. A feed on someone else's host would have us read ` +
          "and report a stranger's posts under this creator's name.",
      };
    }

    const robots = robotsPerOrigin(context.fetchOptions);
    const discoveryOptions = {
      robots,
      fetchOptions: context.fetchOptions,
      maxEntries: context.maxItems,
    };

    // A confirmed feed is used as given. Re-deriving a feed that a human already
    // approved would make the approval meaningless.
    const discovery = context.feedUrl
      ? await readFeed(context.feedUrl, discoveryOptions)
      : await discoverFeed(link, discoveryOptions);

    if (!discovery.ok) {
      // A site that 403s our fetcher is the Medium failure mode, whether or not
      // it is on a medium.com host — worth saying so, because the operator's
      // next move is the same either way.
      return discovery.reason === 'blocked-by-site'
        ? { ok: false, detail: discovery.detail, unsupportedId: 'medium' }
        : { ok: false, detail: discovery.detail };
    }

    const entries = discovery.feed.entries.slice(0, context.maxItems);
    if (entries.length === 0) {
      return { ok: false, detail: `${discovery.feed.url} is a valid feed but lists no entries.` };
    }

    const items = await mapWithConcurrency(entries, FETCH_CONCURRENCY, async (entry): Promise<ProbedItem> => {
      // The feed is the creator's; the URLs it lists are only theirs by
      // convention. A feed on their host whose ten `<link>`s all point at
      // somewhere else reads as perfectly viable otherwise — we would fetch a
      // stranger's pages, classify them, and report them as this creator's work.
      if (!isOnSameSite(link, entry.url)) {
        return {
          url: entry.url,
          title: entry.title ?? entry.url,
          text: '',
          hasRecipeJsonLd: false,
          error: `Not fetched: this entry is not on ${origin}, so it is not this creator's own post.`,
        };
      }

      const allowed = (await robots.for(entry.url)).check(entry.url);
      if (!allowed.allowed) {
        return { url: entry.url, title: entry.title ?? entry.url, text: '', hasRecipeJsonLd: false, error: allowed.detail };
      }

      const fetched = await safeFetch(entry.url, {
        timeoutMs: ITEM_TIMEOUT_MS,
        ...context.fetchOptions,
      });
      if (!fetched.ok) {
        return { url: entry.url, title: entry.title ?? entry.url, text: '', hasRecipeJsonLd: false, error: fetched.detail };
      }

      const document = toSourceDocument(fetched.url, fetched.html);
      return {
        url: entry.url,
        title: document.title || entry.title || entry.url,
        text: document.text,
        hasRecipeJsonLd: Boolean(document.jsonLd),
      };
    });

    return { ok: true, items, feed: discovery.feed };
  },
};

/**
 * YouTube probe: list the channel's uploads and gate each video on its title and
 * description (MEAL-74, amended by MEAL-79).
 *
 * **This used to run before a creator connected anything, and no longer can.**
 * The free lister was the uploads feed, and `youtube.com/robots.txt` disallows
 * it; `playlistItems.list` is the sanctioned replacement and it is an
 * authenticated call. So YouTube joins Instagram and TikTok: approve, ask them
 * to connect, *then* measure.
 *
 * Decided 2026-08-02 rather than papered over with a cheaper pre-check off the
 * channel page. The check stops being "should I approve this person" — a
 * thirty-second human judgement an operator makes with the creator's links open
 * in front of them — and becomes "is this connected source going to produce
 * anything", which is asked against the credential the poller will actually use
 * rather than a public proxy for it.
 *
 * Captions are the fallback for a video whose description is too thin to judge.
 * A vlog is rejected on title and description before its captions are ever
 * downloaded, which is the quota control that ordering exists for.
 *
 * No `feed` is returned. That field exists so an operator can confirm a
 * discovered feed URL before it is stored, and nothing is stored here: the
 * channel id comes from the OAuth grant, and offering a `youtube.com` URL to a
 * button that writes `creators.feed_url` would only invite an error.
 */
export const youtubeProbe: SourceProbe = {
  source: 'youtube',

  async probe(link, context) {
    const accessToken = context.grant?.accessToken;
    if (!accessToken) return notConnectedYet('youtube');

    const granted = context.grant?.externalId;
    const channelId = isChannelId(granted)
      ? { ok: true as const, channelId: granted }
      : await resolveChannelId(link, context.fetchOptions);
    if (!channelId.ok) return { ok: false, detail: channelId.detail };

    const listed = await listUploads(accessToken, channelId.channelId, {
      limit: context.maxItems,
      fetchImpl: context.fetchOptions?.fetchImpl as typeof fetch | undefined,
    });
    if (!listed.ok) return { ok: false, detail: listed.detail };

    const videos = listed.videos.slice(0, context.maxItems);
    const items = await mapWithConcurrency(videos, FETCH_CONCURRENCY, async (video): Promise<ProbedItem> => {
      const document = await youtubeSourceDocument(video, {
        accessToken,
        fetchImpl: context.fetchOptions?.fetchImpl as typeof fetch | undefined,
        lookup: context.fetchOptions?.lookup,
      });
      return {
        url: document.url,
        title: document.title || video.url,
        text: document.text,
        // There is no JSON-LD on YouTube. Title, description and captions are
        // the only material the gate gets for a video.
        hasRecipeJsonLd: false,
        // A video with neither a description nor captions was never read, so it
        // is reported rather than gated — counting it as "not a recipe" would
        // measure our access, not the creator.
        ...(document.text.trim()
          ? {}
          : {
              error:
                'Not gated: this video has no description, and no captions were available. ' +
                'Connecting the channel lets us read captions for videos like this one.',
            }),
      };
    });

    return { ok: true, items };
  },
};

/**
 * The sentence for a platform that cannot be measured until its owner connects
 * it (MEAL-82 / MEAL-83, and MEAL-79 for YouTube).
 *
 * Three of the four sources now read this way, and only the website can still be
 * measured during application review. Instagram and TikTok hand over nothing at
 * all without a grant; YouTube's one free lister was the uploads feed, and
 * `youtube.com/robots.txt` disallows it, so the compliant call is authenticated
 * too. For all three the order is: approve the creator, ask them to connect,
 * *then* measure.
 *
 * It fails loudly rather than returning no items, because "no items" reads as
 * "nothing passed", which is the one thing it must never be confused with. This
 * is the sentence the admin Sources tab shows in place of a verdict — **not
 * measurable until connected**, never "not viable".
 */
function notConnectedYet(source: PlatformSource): ProbeResult {
  return {
    ok: false,
    detail:
      `Not measurable until connected. ${SOURCE_LABELS[source]} cannot be checked until this creator ` +
      `connects their account: there is nothing ${SOURCE_LABELS[source]} lets us read without a grant. ` +
      'Ask them to connect it from the creator portal, then run this again. Until then this is *not* a ' +
      'pass and *not* a failure — do not set it as the source of truth, and do not rule the creator out ' +
      'on the strength of it.',
  };
}

/**
 * Instagram probe: gate each recent post on its caption (MEAL-82).
 *
 * The caption is the only text this API exposes. A Reel whose recipe is spoken
 * aloud arrives here as a caption saying "recipe in the video", and the gate
 * will correctly call that not-a-recipe — which is a true statement about the
 * post and a misleading one about the creator. So a post with **no** caption at
 * all is reported rather than gated, the same distinction the YouTube probe
 * makes for a video with neither description nor captions. A creator whose
 * report comes back mostly red is telling us something real: their recipes are
 * not in text, and no amount of prompt tuning changes that.
 */
export const instagramProbe: SourceProbe = {
  source: 'instagram',

  async probe(_link, context) {
    const accessToken = context.grant?.accessToken;
    if (!accessToken) return notConnectedYet('instagram');

    const listed = await fetchInstagramMedia(accessToken, {
      limit: context.maxItems,
      fetchImpl: context.fetchOptions?.fetchImpl as typeof fetch | undefined,
    });
    if (!listed.ok) return { ok: false, detail: listed.detail };

    const items = listed.media.slice(0, context.maxItems).map((media): ProbedItem => {
      const document = instagramSourceDocument(media);
      return {
        url: document.url,
        title: document.title,
        text: document.text,
        // No structured data on Instagram. The caption is all there is.
        hasRecipeJsonLd: false,
        ...(hasInstagramText(media) ? {} : { error: INSTAGRAM_NO_CAPTION_DETAIL }),
      };
    });

    // No `feed`: nothing here is a URL an operator could confirm and store.
    return { ok: true, items };
  },
};

/**
 * TikTok probe: gate each recent video on its title and description (MEAL-83).
 *
 * Structurally the same as Instagram's and with a harder ceiling. The Display
 * API returns an embed link and a share URL and never a file, so there is no
 * transcription fallback here and there cannot be one — MEAL-85 could rescue an
 * Instagram Reel and could never rescue a TikTok. If this report comes back
 * mostly red, the useful conclusion is that TikTok is this creator's *link*
 * source rather than their recipe source, and MEAL-80's share link already
 * serves that better than an import would.
 */
export const tiktokProbe: SourceProbe = {
  source: 'tiktok',

  async probe(_link, context) {
    const accessToken = context.grant?.accessToken;
    if (!accessToken) return notConnectedYet('tiktok');

    const listed = await fetchTikTokVideos(accessToken, {
      limit: context.maxItems,
      fetchImpl: context.fetchOptions?.fetchImpl as typeof fetch | undefined,
    });
    if (!listed.ok) return { ok: false, detail: listed.detail };

    const items = listed.videos.slice(0, context.maxItems).map((video): ProbedItem => {
      const document = tiktokSourceDocument(video);
      return {
        url: document.url,
        title: document.title,
        text: document.text,
        hasRecipeJsonLd: false,
        ...(hasTikTokText(video) ? {} : { error: TIKTOK_NO_DESCRIPTION_DETAIL }),
      };
    });

    return { ok: true, items };
  },
};

export const SOURCE_PROBES: Record<PlatformSource, SourceProbe> = {
  website: websiteProbe,
  youtube: youtubeProbe,
  instagram: instagramProbe,
  tiktok: tiktokProbe,
};

// ── The check ────────────────────────────────────────────────────────────────

export interface ViabilityOptions {
  /** Anthropic seam. Defaults to the real client, which needs `ANTHROPIC_API_KEY`. */
  call?: StructuredCaller;
  fetchOptions?: SafeFetchOptions;
  /** A feed URL already confirmed by an operator. Website only. */
  feedUrl?: string | null;
  /** The creator's OAuth grant for this source, when they have connected one. */
  grant?: ProbeGrant | null;
  maxItems?: number;
  /** Overridable probe registry, so a future platform (or a test) can slot in. */
  probes?: Record<PlatformSource, SourceProbe>;
}

function report(partial: Partial<ViabilityReport> & Pick<ViabilityReport, 'source' | 'outcome' | 'summary'>): ViabilityReport {
  return {
    checked: 0,
    passed: 0,
    items: [],
    feed: null,
    unsupported: null,
    costUsd: 0,
    ...partial,
  };
}

/**
 * Runs the check for one creator on one source. Reads only — the operator
 * commits the result themselves, including the discovered feed URL.
 */
export async function runViabilityCheck(
  source: PlatformSource,
  link: string,
  options: ViabilityOptions = {},
): Promise<ViabilityReport> {
  // ── Known-unsupported, before anything is fetched ─────────────────────────
  const unsupported = knownUnsupportedSource(link);
  if (unsupported) {
    return report({
      source,
      outcome: 'unsupported',
      summary: `${unsupported.label} is a known-unsupported source. ${unsupported.detail}`,
      unsupported,
    });
  }

  const probes = options.probes ?? SOURCE_PROBES;
  const maxItems = options.maxItems ?? VIABILITY_SAMPLE_SIZE;

  const probed = await probes[source].probe(link, {
    fetchOptions: options.fetchOptions,
    feedUrl: options.feedUrl,
    grant: options.grant,
    maxItems,
  });

  if (!probed.ok) {
    const matched = probed.unsupportedId ? unsupportedSourceById(probed.unsupportedId) : null;
    return report({
      source,
      outcome: matched ? 'unsupported' : 'unavailable',
      summary: matched
        ? `${probed.detail}\n\nThis is the ${matched.label} failure mode. ${matched.detail}`
        : `${SOURCE_LABELS[source]} could not be checked: ${probed.detail}`,
      unsupported: matched,
    });
  }

  // ── Gate every readable item ──────────────────────────────────────────────
  const call = options.call ?? createStructuredCaller();
  let costUsd = 0;
  const items: ViabilityItem[] = [];
  let checked = 0;
  let passed = 0;
  let unavailableVerdicts = 0;

  for (const item of probed.items) {
    if (item.error) {
      items.push({ url: item.url, title: item.title, verdict: 'error', reason: item.error });
      continue;
    }

    const result = await classifySource(
      { title: item.title, text: item.text, hasRecipeJsonLd: item.hasRecipeJsonLd },
      { call },
    );
    costUsd += result.usage?.costUsd ?? 0;

    // A classifier outage is not evidence about the creator. Counting it as a
    // failed item would report "not importable" for a working blog.
    if (result.verdict.source === 'classifier-unavailable') {
      unavailableVerdicts++;
      items.push({ url: item.url, title: item.title, verdict: 'error', reason: result.verdict.reason });
      continue;
    }

    checked++;
    if (result.verdict.verdict === 'yes') passed++;
    items.push({
      url: item.url,
      title: item.title,
      verdict: result.verdict.verdict,
      reason: result.verdict.reason,
    });
  }

  const feed = probed.feed
    ? { url: probed.feed.url, kind: probed.feed.kind, via: probed.feed.via, entries: probed.feed.entries }
    : null;
  const base = { source, checked, passed, items, feed, costUsd, unsupported: null };

  if (checked === 0) {
    // An account we reached that has posted nothing gets its own sentence. The
    // probe returns `ok: true` with an empty list for that case — reporting it
    // as a *failure* is what used to make an empty Instagram or TikTok account
    // read as `unreachable` — and "None of the 0 most recent items could be
    // read" is not what happened, so it does not get said.
    const emptyAccount = probed.items.length === 0;
    return report({
      ...base,
      outcome: 'unavailable',
      summary: emptyAccount
        ? `We reached this ${SOURCE_LABELS[source]} source and it has nothing posted, so there was nothing to ` +
          'measure. That is an answer rather than a failure — this is not a verdict on the creator, and it ' +
          'is not a pass either.'
        : unavailableVerdicts > 0
          ? `The classifier could not be reached for any of the ${probed.items.length} items, so nothing was ` +
            'measured. This says nothing about the creator — retry once the classifier is back.'
          : `None of the ${probed.items.length} most recent items could be read, so nothing was measured. ` +
            'Check the item list for what each one returned.',
    });
  }

  const ratio = passed / checked;
  if (passed === 0) {
    return report({
      ...base,
      outcome: 'not-viable',
      summary:
        `None of the ${checked} most recent ${SOURCE_LABELS[source]} items read as a recipe. ` +
        'Try another of their links. If every link they gave us comes back like this, this creator ' +
        'is not importable — tell them so rather than onboarding them into a feature that will ' +
        'silently do nothing.',
    });
  }
  if (ratio < VIABLE_PASS_RATIO) {
    return report({
      ...base,
      outcome: 'partial',
      summary:
        `${passed} of ${checked} recent ${SOURCE_LABELS[source]} items read as a recipe. The source works, ` +
        'but most of what they publish is not a recipe, so imports will be infrequent. Check their ' +
        'other links before committing to this one.',
    });
  }

  return report({
    ...base,
    outcome: 'viable',
    summary:
      `${passed} of ${checked} recent ${SOURCE_LABELS[source]} items read as a recipe. This source is ` +
      'importable — confirm the feed below, set it as the source of truth, and turn import on.',
  });
}

