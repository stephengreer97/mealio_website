import { describe, it, expect } from 'vitest';
import {
  checkPollingInvariants,
  describeSourceHealth,
  isOnSameSite,
  knownUnsupportedSource,
  normalizePlatformUrl,
  normalizePlatformUrls,
  summariseCreatorViability,
  toSourceColumns,
} from '@/lib/creator-sources';

describe('creator-sources — link normalisation', () => {
  it('accepts a bare hostname and a trailing slash', () => {
    // The two things a real applicant types. Rejecting either loses us a
    // creator over punctuation.
    expect(normalizePlatformUrl('website', 'chefsarah.com')).toEqual({ ok: true, url: 'https://chefsarah.com/' });
    expect(normalizePlatformUrl('website', ' https://chefsarah.com/recipes/ ')).toEqual({
      ok: true,
      url: 'https://chefsarah.com/recipes/',
    });
  });

  it('treats a blank optional field as absent, not invalid', () => {
    expect(normalizePlatformUrl('youtube', '')).toEqual({ ok: true, url: null });
    expect(normalizePlatformUrl('youtube', '   ')).toEqual({ ok: true, url: null });
    expect(normalizePlatformUrl('youtube', undefined)).toEqual({ ok: true, url: null });
  });

  it('refuses a value that is not text at all', () => {
    // Not the same thing as blank. Folding these to blank made them *clear* the
    // link, so a client sending `null` for a field nobody touched deleted it and
    // was told the write succeeded.
    for (const input of [null, 42, {}, [], true]) {
      expect(normalizePlatformUrl('website', input).ok, JSON.stringify(input)).toBe(false);
    }
  });

  it('accepts every shape of a platform URL that platform actually serves', () => {
    for (const input of ['youtube.com/@sarah', 'https://www.youtube.com/c/sarah', 'https://youtu.be/abc123', 'm.youtube.com/@sarah']) {
      expect(normalizePlatformUrl('youtube', input).ok, input).toBe(true);
    }
    for (const input of ['instagram.com/sarah', 'https://www.instagram.com/sarah/']) {
      expect(normalizePlatformUrl('instagram', input).ok, input).toBe(true);
    }
    for (const input of ['tiktok.com/@sarah', 'https://vm.tiktok.com/ZM123/']) {
      expect(normalizePlatformUrl('tiktok', input).ok, input).toBe(true);
    }
  });

  it('rejects a link typed into the wrong platform box', () => {
    // Otherwise the mistake surfaces much later, as a viability check that
    // finds no items on a platform the creator never used.
    const wrong = normalizePlatformUrl('instagram', 'https://youtube.com/@sarah');
    expect(wrong.ok).toBe(false);
    expect(wrong.ok === false && wrong.error).toMatch(/not on Instagram/i);

    const social = normalizePlatformUrl('website', 'https://instagram.com/sarah');
    expect(social.ok).toBe(false);
    expect(social.ok === false && social.error).toMatch(/Instagram box/i);
  });

  it('refuses non-public and non-http links', () => {
    for (const input of ['localhost:3000', 'http://192.168.1.5/blog', 'javascript:alert(1)', 'mailto:a@b.com']) {
      expect(normalizePlatformUrl('website', input).ok, input).toBe(false);
    }
  });

  it('strips credentials, which only ever disguise the real host', () => {
    const result = normalizePlatformUrl('website', 'https://user:pw@chefsarah.com/blog');
    expect(result).toEqual({ ok: true, url: 'https://chefsarah.com/blog' });
  });

  it('refuses a link too long to be a link', () => {
    // Stored once, then read back into server-side fetches, log lines and the
    // admin UI forever after. A 200 KB "URL" normalised perfectly well.
    const result = normalizePlatformUrl('website', `https://chefsarah.com/${'a'.repeat(200_000)}`);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/characters long/i);
  });

  it('normalises away the DNS root’s trailing dot', () => {
    // `chefsarah.com.` and `chefsarah.com` are the same host, but they compare
    // as different strings — and this value is later matched against a feed's
    // host, so storing the dotted form made the creator unconfirmable forever.
    expect(normalizePlatformUrl('website', 'chefsarah.com.')).toEqual({ ok: true, url: 'https://chefsarah.com/' });
    expect(normalizePlatformUrl('website', 'https://.').ok).toBe(false);
  });

  it('normalises all four at once and fails on the first bad one', () => {
    const ok = normalizePlatformUrls({ website: 'chefsarah.com', tiktok: 'tiktok.com/@sarah' });
    expect(ok.ok && ok.urls).toEqual({
      website: 'https://chefsarah.com/',
      youtube: null,
      instagram: null,
      tiktok: 'https://tiktok.com/@sarah',
    });

    const bad = normalizePlatformUrls({ website: 'chefsarah.com', youtube: 'not a link at all' });
    expect(bad.ok).toBe(false);
  });

  it('maps onto the columns both tables share', () => {
    expect(toSourceColumns({ website: 'https://x.test/', tiktok: null })).toEqual({
      website_url: 'https://x.test/',
      youtube_url: null,
      instagram_url: null,
      tiktok_url: null,
    });
  });
});

describe('creator-sources — known-unsupported', () => {
  it('flags Medium on any of its hosts, before anything is fetched', () => {
    expect(knownUnsupportedSource('https://medium.com/@sarah')?.id).toBe('medium');
    expect(knownUnsupportedSource('https://sarah.medium.com/post')?.id).toBe('medium');
  });

  it('does not flag a site that merely mentions medium', () => {
    expect(knownUnsupportedSource('https://mediumrare.example.com/')).toBeNull();
    expect(knownUnsupportedSource(null)).toBeNull();
  });

  it('explains itself in terms an operator can act on', () => {
    const detail = knownUnsupportedSource('https://medium.com/@sarah')!.detail;
    expect(detail).toMatch(/403/);
    expect(detail).toMatch(/another of their links/i);
  });
});

describe('creator-sources — creator-level roll-up', () => {
  const links = { website: 'https://a.test/', tiktok: 'https://tiktok.com/@a', youtube: null, instagram: null };

  it('is importable as soon as one source works', () => {
    const verdict = summariseCreatorViability(links, { website: 'viable' });
    expect(verdict.importable).toBe(true);
    expect(verdict.summary).toMatch(/Website/);
  });

  it('counts a partial source as workable — it imports, just rarely', () => {
    expect(summariseCreatorViability(links, { website: 'partial', tiktok: 'not-viable' }).importable).toBe(true);
  });

  it('withholds the verdict while links are still unchecked', () => {
    const verdict = summariseCreatorViability(links, { website: 'not-viable' });
    expect(verdict.importable).toBeNull();
    expect(verdict.unchecked).toEqual(['tiktok']);
  });

  it('treats a source that could not be checked as unchecked, not failed', () => {
    // A platform whose OAuth connection does not exist yet says nothing about
    // the creator, and must never be counted as evidence against them.
    const verdict = summariseCreatorViability(links, { website: 'not-viable', tiktok: 'unavailable' });
    expect(verdict.importable).toBeNull();
    expect(verdict.unchecked).toEqual(['tiktok']);
  });

  it('says "not importable" only once every link has been tried', () => {
    const verdict = summariseCreatorViability(links, { website: 'not-viable', tiktok: 'not-viable' });
    expect(verdict.importable).toBe(false);
    expect(verdict.summary).toMatch(/not importable/i);
  });

  it('counts an unsupported platform as tried', () => {
    const verdict = summariseCreatorViability(
      { website: 'https://medium.com/@a', tiktok: 'https://tiktok.com/@a' },
      { website: 'unsupported', tiktok: 'not-viable' },
    );
    expect(verdict.importable).toBe(false);
  });

  it('has nothing to say about a creator with no links', () => {
    expect(summariseCreatorViability({}, {}).importable).toBeNull();
  });

  it('does not claim a link was checked when nothing was ever fetched', () => {
    // The whole PR turns on "cannot check is never none passed", and this is
    // the sentence an operator relays to the creator. Medium is refused on the
    // hostname before a single request — saying it was "checked" is false.
    const verdict = summariseCreatorViability(
      { website: 'https://medium.com/@a' },
      { website: 'unsupported' },
    );
    expect(verdict.importable).toBe(false);
    expect(verdict.summary).not.toMatch(/was checked/i);
    expect(verdict.summary).toMatch(/without fetching anything/i);
  });
});

describe('creator-sources — is this on the creator\u2019s own site?', () => {
  it('accepts the host itself, a subdomain, and the apex of a www. site', () => {
    expect(isOnSameSite('https://chefsarah.test/', 'https://chefsarah.test/feed')).toBe(true);
    expect(isOnSameSite('https://chefsarah.test/', 'https://feeds.chefsarah.test/rss')).toBe(true);
    expect(isOnSameSite('https://www.chefsarah.test/', 'https://chefsarah.test/feed')).toBe(true);
  });

  it('refuses a shared parent domain, which is not the same site', () => {
    // No public suffix list here, so the parent-domain direction is limited to
    // `www.`. Without that limit a feed on the hosting platform's own root —
    // every other tenant's posts — reads as the creator's own.
    expect(isOnSameSite('https://sarah.wordpress.com/', 'https://wordpress.com/feed')).toBe(false);
    expect(isOnSameSite('https://sarah.github.io/', 'https://github.io/feed')).toBe(false);
    expect(isOnSameSite('https://chefsarah.test/', 'https://evil.test/feed')).toBe(false);
    // A suffix match that is not a label boundary is not a subdomain either.
    expect(isOnSameSite('https://sarah.test/', 'https://notsarah.test/feed')).toBe(false);
  });

  it('reads through a trailing dot in either position', () => {
    expect(isOnSameSite('https://chefsarah.test./', 'https://chefsarah.test/feed')).toBe(true);
    expect(isOnSameSite('https://chefsarah.test/', 'https://chefsarah.test./feed')).toBe(true);
  });

  it('refuses anything it cannot parse', () => {
    expect(isOnSameSite('not a url', 'https://chefsarah.test/feed')).toBe(false);
    expect(isOnSameSite('https://chefsarah.test/', 'not a url')).toBe(false);
  });

  it('refuses another creator’s handle on a platform where the path is the publisher', () => {
    // Host equality is the wrong question on these: `medium.com/@sarah` and
    // `medium.com/@bob` are two people behind one hostname, so a host-only
    // check publishes another creator's recipe under this creator's name —
    // the exact outcome the check exists to prevent.
    expect(isOnSameSite('https://medium.com/@sarah', 'https://medium.com/@sarah/best-guacamole')).toBe(true);
    expect(isOnSameSite('https://medium.com/@sarah', 'https://medium.com/@bob/best-guacamole')).toBe(false);
    expect(isOnSameSite('https://substack.com/@sarah', 'https://substack.com/@bob/p/x')).toBe(false);
    // A bare platform host names nobody, so nothing is on "their" site.
    expect(isOnSameSite('https://medium.com', 'https://medium.com/@sarah/x')).toBe(false);
  });

  it('leaves a creator on their own subdomain of one alone', () => {
    // `sarah.medium.com` is already told apart by the host rule, and the path
    // on it is just a path.
    expect(isOnSameSite('https://sarah.medium.com/', 'https://sarah.medium.com/best-guacamole')).toBe(true);
    expect(isOnSameSite('https://sarah.medium.com/', 'https://bob.medium.com/x')).toBe(false);
  });

  it('does not let a creator on a subdomain claim the parent’s whole site', () => {
    // `blog.example.com` accepting everything on `example.com` was the other
    // direction of the same mistake: a shared parent is not the same site.
    expect(isOnSameSite('https://blog.example.com/', 'https://example.com/anyones-post')).toBe(false);
    expect(isOnSameSite('https://blog.example.com/', 'https://shop.example.com/x')).toBe(false);
  });
});

/**
 * The polling invariants, now shared between the admin source picker and the
 * creator's own link editor (MEAL-94).
 *
 * They exist because every one of them is about a *combination* of columns, so
 * they can only be judged on the row a write would leave behind. Tested here,
 * once, rather than twice through two routes.
 */
describe('creator-sources — checkPollingInvariants', () => {
  const READY = {
    website_url: 'https://chefsarah.test/',
    youtube_url: null,
    instagram_url: null,
    tiktok_url: null,
    primary_source: 'website',
    import_opt_in: true,
    feed_url: 'https://chefsarah.test/feed',
  };

  it('passes a creator with a source, a link and a confirmed feed', () => {
    expect(checkPollingInvariants(READY)).toEqual({ ok: true, importOptIn: true });
  });

  it('refuses opt-in for a source the creator has no link for', () => {
    const verdict = checkPollingInvariants({ ...READY, primary_source: 'youtube' });
    expect(verdict).toMatchObject({ ok: false });
    expect((verdict as { error: string }).error).toMatch(/no YouTube link/i);
  });

  it('refuses opt-in for a website whose feed was never confirmed', () => {
    expect(checkPollingInvariants({ ...READY, feed_url: null })).toMatchObject({ ok: false });
  });

  it('refuses opt-in for a feed that is not on the creator’s own site', () => {
    // The pairing the admin route checks when a feed is submitted, carried here
    // so it also holds when the *website* is what moved. Otherwise the rule is
    // enforceable from one side only, and the other side — a creator editing
    // their own links — is the side that is not an operator.
    const verdict = checkPollingInvariants({ ...READY, website_url: 'https://sarahcooks.test/' });
    expect(verdict).toMatchObject({ ok: false });
    expect((verdict as { error: string }).error).toMatch(/not on the creator's own site/i);
  });

  it('turns the switch off with the source rather than leaving it dangling', () => {
    // An opt-in against `none` is a switch that means nothing today and the
    // wrong thing the day somebody picks a source.
    expect(checkPollingInvariants({ ...READY, primary_source: 'none' })).toEqual({ ok: true, importOptIn: false });
  });

  it('refuses a request that explicitly asks to poll nothing', () => {
    // Asking for opt-in with no source is a contradiction, not an off switch.
    expect(checkPollingInvariants({ ...READY, primary_source: 'none' }, true)).toMatchObject({ ok: false });
  });

  it('says nothing about a creator who is not opted in', () => {
    // Every rule here is about what gets polled. A creator nothing is polled
    // for can have any combination of links and sources there is.
    expect(checkPollingInvariants({ ...READY, import_opt_in: false, website_url: null, feed_url: null }))
      .toEqual({ ok: true, importOptIn: false });
  });
});

/**
 * What the Sources tab has to say without an operator digging for it.
 *
 * Both notices answer a question asked long after the event, and both are
 * currently answerable only by accident: a pause lived in an email, and a broken
 * feed/website pairing surfaced only as a 400 at the moment somebody tried to
 * turn import back on.
 */
describe('creator-sources — what an operator sees on the Sources tab', () => {
  const PAUSED = {
    website_url: 'https://sarahcooks.test/',
    feed_url: null,
    primary_source: 'website',
    import_opt_in: false,
    import_paused_reason: 'The creator changed the Website link we poll, from https://chefsarah.test/ to https://sarahcooks.test/.',
    import_paused_at: '2026-07-01T00:00:00.000Z',
  };

  it('reports why a creator is not being polled, and since when', () => {
    expect(describeSourceHealth(PAUSED)).toEqual([
      {
        kind: 'paused',
        label: 'Import paused',
        detail: PAUSED.import_paused_reason,
        at: '2026-07-01T00:00:00.000Z',
      },
    ]);
  });

  it('stops reporting a pause once the operator has lifted it', () => {
    // A stale reason beside a creator that is being polled says the opposite of
    // what the row does, which is worse than saying nothing.
    expect(describeSourceHealth({ ...PAUSED, import_opt_in: true })).toEqual([]);
  });

  it('says nothing about a creator nobody paused', () => {
    expect(describeSourceHealth({ ...PAUSED, import_paused_reason: null, import_paused_at: null })).toEqual([]);
  });

  it('flags a feed left behind on a host the website has moved off', () => {
    // The pairing an operator confirmed once and nothing re-checks. Since a
    // creator can move `website_url` themselves, the poller can end up reading a
    // feed on a host that is no longer theirs — every entry then fails the
    // item-level host check and the sync returns nothing, with no message
    // anywhere saying why.
    const [notice] = describeSourceHealth({
      website_url: 'https://sarahcooks.test/',
      feed_url: 'https://chefsarah.test/feed',
      primary_source: 'website',
      import_opt_in: false,
    });

    expect(notice).toMatchObject({ kind: 'feed-host', label: 'Feed off-site' });
    expect(notice.detail).toMatch(/not on the creator's own site/i);
    // And what it costs, said here rather than discovered as a 400 on the
    // switch: this is the thing that will refuse to turn import back on.
    expect(notice.detail).toMatch(/before turning import back on/i);
  });

  it('flags a feed stored against no website at all', () => {
    const [notice] = describeSourceHealth({ website_url: null, feed_url: 'https://chefsarah.test/feed' });
    expect(notice).toMatchObject({ kind: 'feed-host' });
  });

  it('says nothing about a pairing that still holds', () => {
    expect(describeSourceHealth({
      website_url: 'https://chefsarah.test/',
      feed_url: 'https://chefsarah.test/feed',
      import_opt_in: true,
    })).toEqual([]);
  });

  it('reports both when both are true', () => {
    // They are independent: one is why polling stopped, the other is what would
    // stop it starting again. An operator needs both to know what to do next.
    expect(describeSourceHealth({ ...PAUSED, feed_url: 'https://chefsarah.test/feed' }).map(n => n.kind))
      .toEqual(['paused', 'feed-host']);
  });
});
