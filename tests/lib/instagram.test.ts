import { describe, it, expect, beforeEach } from 'vitest';

import {
  exchangeInstagramCode,
  fetchInstagramAccount,
  fetchInstagramMedia,
  hasRecipeText,
  instagramAuthUrl,
  instagramMediaTitle,
  instagramSourceDocument,
  INSTAGRAM_BASIC_SCOPE,
  INSTAGRAM_MEDIA_MAX,
  type InstagramMedia,
} from '@/lib/instagram';

/**
 * Reading a creator's Instagram account (MEAL-82).
 *
 * None of this can be exercised against the real API until Meta's app review
 * clears, so these are written against the documented shapes. The properties
 * worth defending are the ones a wrong guess would silently break: one scope and
 * only one, a *long-lived* token or nothing at all, a personal account refused
 * with the real reason, and a caption that survives with its line breaks intact
 * because that is where the ingredient list is.
 */

const CAPTION = 'Guacamole\n\nIngredients:\n2 ripe avocados\n1 lime, juiced\n\nMash them together.';

function media(overrides: Partial<InstagramMedia> = {}): InstagramMedia {
  return {
    id: '17895695668004550',
    caption: CAPTION,
    mediaType: 'VIDEO',
    mediaUrl: 'https://scontent.cdninstagram.com/v/t50/expiring.mp4',
    permalink: 'https://www.instagram.com/reel/CabcDEFghij/',
    publishedAt: '2026-07-29T09:00:00.000Z',
    ...overrides,
  };
}

/** A fetch that answers by matching the URL against a list of predicates. */
function routed(handlers: Array<[RegExp, () => Response]>) {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const match = handlers.find(([pattern]) => pattern.test(url));
    if (!match) return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    return match[1]();
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  process.env.INSTAGRAM_APP_ID = 'ig-app-id';
  process.env.INSTAGRAM_APP_SECRET = 'ig-app-secret';
  process.env.NEXT_PUBLIC_APP_URL = 'https://mealio.co';
});

// ── The consent screen ───────────────────────────────────────────────────────

describe('instagram — the consent screen asks for one scope', () => {
  it('requests instagram_business_basic and nothing else', () => {
    const url = new URL(instagramAuthUrl('nonce-1')!);

    // A permission the review demo does not exercise is a documented rejection
    // reason, and one we hold but never use is access given for nothing.
    expect(url.searchParams.get('scope')).toBe(INSTAGRAM_BASIC_SCOPE);
    expect(url.searchParams.get('scope')).not.toMatch(/messag|publish|insight/i);
  });

  it('uses the Instagram Login path, not the Facebook Login one', () => {
    const url = new URL(instagramAuthUrl('nonce-1')!);

    // The Facebook path would drag a linked Page and a Business Manager into a
    // flow whose whole job is reading captions.
    expect(url.origin).toBe('https://www.instagram.com');
    expect(url.searchParams.get('redirect_uri')).toBe('https://mealio.co/api/creator/instagram/callback');
    expect(url.searchParams.get('state')).toBe('nonce-1');
    expect(url.searchParams.get('response_type')).toBe('code');
  });

  it('returns null rather than a broken URL when the app is not configured', () => {
    delete process.env.INSTAGRAM_APP_ID;
    expect(instagramAuthUrl('nonce-1')).toBeNull();
  });
});

// ── The grant ────────────────────────────────────────────────────────────────

describe('instagram — the code exchange ends in a long-lived token', () => {
  it('trades the code for a short-lived token and that for a 60-day one', async () => {
    const { impl, calls } = routed([
      [/api\.instagram\.com/, () => json({ data: [{ access_token: 'IGQ-short', user_id: '178', permissions: 'instagram_business_basic' }] })],
      [/graph\.instagram\.com\/access_token/, () => json({ access_token: 'IGQ-long', token_type: 'bearer', expires_in: 5_184_000 })],
    ]);

    const result = await exchangeInstagramCode('the-code', { fetchImpl: impl, now: () => 1_800_000_000_000 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The one-hour token is no use to a daily poller, and there is no second
    // chance to upgrade it once it lapses.
    expect(result.grant.accessToken).toBe('IGQ-long');
    expect(result.grant.expiresAt).toBe(new Date(1_800_000_000_000 + 5_184_000_000).toISOString());
    expect(result.grant.scopes).toEqual([INSTAGRAM_BASIC_SCOPE]);
    expect(calls).toHaveLength(2);
  });

  it('strips the #_ fragment Instagram glues onto the code', async () => {
    const bodies: string[] = [];
    const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.body) bodies.push(String(init.body));
      return String(input).includes('api.instagram.com')
        ? json({ access_token: 'IGQ-short', user_id: '178', permissions: INSTAGRAM_BASIC_SCOPE })
        : json({ access_token: 'IGQ-long', expires_in: 100 });
    }) as unknown as typeof fetch;

    await exchangeInstagramCode('the-code#_', { fetchImpl: impl });

    // Two stray characters fail the exchange with an error that reads exactly
    // like a wrong client secret.
    expect(bodies[0]).toContain('code=the-code');
    expect(bodies[0]).not.toContain('%23_');
  });

  it('accepts the flat response shape as well as the wrapped one', async () => {
    const { impl } = routed([
      [/api\.instagram\.com/, () => json({ access_token: 'IGQ-short', user_id: '178' })],
      [/graph\.instagram\.com/, () => json({ access_token: 'IGQ-long', expires_in: 100 })],
    ]);

    const result = await exchangeInstagramCode('c', { fetchImpl: impl });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // No `permissions` came back, so what we asked for is recorded rather than
    // an empty list, which would read as "granted nothing".
    expect(result.grant.scopes).toEqual([INSTAGRAM_BASIC_SCOPE]);
  });

  it('stores nothing when the long-lived exchange fails', async () => {
    const { impl } = routed([
      [/api\.instagram\.com/, () => json({ access_token: 'IGQ-short', user_id: '178' })],
      [/graph\.instagram\.com/, () => json({ error: { message: 'nope' } }, 400)],
    ]);

    const result = await exchangeInstagramCode('c', { fetchImpl: impl });

    // A one-hour token stored as if it were a connection is a poller that works
    // for an afternoon and then goes quiet.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toMatch(/long-lived/i);
  });
});

// ── The account ──────────────────────────────────────────────────────────────

describe('instagram — the account id comes from the grant', () => {
  it('reads user_id and username off /me', async () => {
    const { impl, calls } = routed([[/\/me\?/, () => json({ user_id: '178', username: 'chefsarah', account_type: 'BUSINESS' })]]);

    const result = await fetchInstagramAccount('IGQ-long', { fetchImpl: impl });

    expect(result).toEqual({ ok: true, account: { id: '178', username: 'chefsarah', accountType: 'BUSINESS' } });
    expect(calls[0]).toContain('fields=user_id%2Cusername%2Caccount_type');
  });

  it('refuses a personal account with the reason a creator can act on', async () => {
    const { impl } = routed([[/\/me\?/, () => json({ user_id: '178', username: 'sarah', account_type: 'PERSONAL' })]]);

    const result = await fetchInstagramAccount('IGQ-long', { fetchImpl: impl });

    // Instagram gives personal accounts no API access at all. Storing the
    // connection would show a green "Connected" badge over something that
    // returns nothing forever.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toMatch(/personal/i);
    expect(result.detail).toMatch(/Professional \(Business or Creator\)/);
  });

  it('accepts an account whose type was not returned', async () => {
    const { impl } = routed([[/\/me\?/, () => json({ id: '178', username: 'chefsarah' })]]);

    const result = await fetchInstagramAccount('IGQ-long', { fetchImpl: impl });

    // `account_type` is not always present, and refusing on a field's absence
    // would reject working accounts.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.account).toEqual({ id: '178', username: 'chefsarah', accountType: null });
  });
});

// ── Media ────────────────────────────────────────────────────────────────────

describe('instagram — listing media', () => {
  function mediaRow(id: string, caption = CAPTION) {
    return {
      id,
      caption,
      media_type: 'VIDEO',
      media_url: `https://scontent.cdninstagram.com/${id}.mp4`,
      permalink: `https://www.instagram.com/reel/${id}/`,
      timestamp: '2026-07-29T09:00:00+0000',
    };
  }

  it('keeps the caption’s line breaks, which is where the ingredients are', async () => {
    const { impl } = routed([[/\/me\/media/, () => json({ data: [mediaRow('m1')] })]]);

    const result = await fetchInstagramMedia('IGQ-long', { fetchImpl: impl, limit: 10 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.media[0].caption.split('\n')).toContain('2 ripe avocados');
    expect(result.media[0].publishedAt).toBe('2026-07-29T09:00:00.000Z');
    expect(result.media[0].permalink).toBe('https://www.instagram.com/reel/m1/');
  });

  it('pages by cursor and stops at the limit', async () => {
    let page = 0;
    const { impl, calls } = routed([
      [
        /\/me\/media/,
        () => {
          page++;
          return json({
            data: [mediaRow(`m${page}a`), mediaRow(`m${page}b`)],
            paging: { cursors: { after: `cursor-${page}` }, next: 'https://graph.instagram.com/next' },
          });
        },
      ],
    ]);

    const result = await fetchInstagramMedia('IGQ-long', { fetchImpl: impl, limit: 4 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.media).toHaveLength(4);
    expect(result.truncated).toBe(true);
    // Cursor paging, not offset: an offset walk over a feed being posted to
    // skips and duplicates items.
    expect(calls[1]).toContain('after=cursor-1');
  });

  it('stops when the last page carries no next link, however many pages remain', async () => {
    const { impl, calls } = routed([
      [/\/me\/media/, () => json({ data: [mediaRow('m1')], paging: { cursors: { after: 'cursor-1' } } })],
    ]);

    const result = await fetchInstagramMedia('IGQ-long', { fetchImpl: impl, limit: INSTAGRAM_MEDIA_MAX });

    expect(result.ok).toBe(true);
    // A cursor with no `next` beside it is the end of the feed, not an
    // invitation to ask again — and asking again is how this loops.
    expect(calls).toHaveLength(1);
  });

  it('reports Meta’s own sentence rather than an empty account', async () => {
    const { impl } = routed([
      [/\/me\/media/, () => json({ error: { message: 'Error validating access token: Session has expired' } }, 400)],
    ]);

    const result = await fetchInstagramMedia('IGQ-long', { fetchImpl: impl });

    // "This account posted nothing" and "our token died" must never look the
    // same to whoever reads the result.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toMatch(/Session has expired/);
  });
});

// ── The source document ──────────────────────────────────────────────────────

describe('instagram — the caption is the whole document', () => {
  it('reduces a post to what the gate takes, with no photo from a link that expires', () => {
    const document = instagramSourceDocument(media());

    expect(document.platform).toBe('instagram');
    expect(document.text).toContain('2 ripe avocados');
    // `media_url` is a time-limited CDN link. A draft pointing at one 404s
    // tomorrow, which is worse than having no photo.
    expect(document.imageUrl).toBeNull();
    expect(document.jsonLd).toBeNull();
    // No comment rails on a caption, so MEAL-72 verifies against the same text.
    expect(document.recipeText).toBe(document.text);
  });

  it('titles a post by the first line of its caption', () => {
    expect(instagramMediaTitle(media())).toBe('Guacamole');
    // Nothing to name it by leaves the row identifiable rather than blank.
    expect(instagramMediaTitle(media({ caption: '' }))).toBe('https://www.instagram.com/reel/CabcDEFghij/');
  });

  it('distinguishes an empty caption from a short one', () => {
    // An empty caption means we read nothing, and gating that would measure our
    // access rather than the creator's post. A short caption is still evidence.
    expect(hasRecipeText(media({ caption: '   ' }))).toBe(false);
    expect(hasRecipeText(media({ caption: 'recipe below' }))).toBe(true);
  });
});
