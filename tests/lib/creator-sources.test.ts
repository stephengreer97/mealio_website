import { describe, it, expect } from 'vitest';
import {
  checkPollingInvariants,
  describeSourceHealth,
  isOnSameSite,
  knownUnsupportedSource,
  normalizePlatformUrl,
  normalizePlatformUrls,
  summariseCreatorViability,
  chooseCreatorSource,
  creatorSourceBlockedReason,
  CREATOR_SOURCE_OPTIONS,
  describeWebsiteImportFailure,
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
    expect((verdict as { error: string }).error).toMatch(/neither a YouTube link nor a connected YouTube account/i);
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

// ── The creator's own source choice (MEAL-101) ───────────────────────────────

describe('creator-sources — chooseCreatorSource', () => {
  const CHECKED_SITE = {
    website_url: 'https://chefsarah.test/',
    feed_url: 'https://chefsarah.test/feed',
    primary_source: 'none',
    import_opt_in: false,
  };

  it('turns both switches on together', () => {
    const choice = chooseCreatorSource(CHECKED_SITE, 'website');

    // The poller's query requires `import_opt_in = true AND primary_source <>
    // 'none'`, so writing one without the other is a creator who chose a source
    // and is never read. They are one decision and they are written as one.
    expect(choice).toMatchObject({
      ok: true,
      update: { primary_source: 'website', import_opt_in: true },
    });
  });

  it('accepts YouTube on the grant alone, with no link on the row', () => {
    // The channel id comes off the grant and `channelIdForCreator` refuses to
    // derive one from a link. Insisting on a link would refuse exactly the
    // creator who connected properly.
    expect(chooseCreatorSource({ primary_source: 'none' }, 'youtube', ['youtube'])).toMatchObject({ ok: true });
  });

  it('refuses YouTube with a link but no grant', () => {
    const choice = chooseCreatorSource({ youtube_url: 'https://youtube.com/@chefsarah' }, 'youtube', []);
    expect(choice).toMatchObject({ ok: false });
    expect((choice as { error: string }).error).toMatch(/connect your youtube account first/i);
  });

  it('refuses Instagram, with the reason on it', () => {
    // Disabled in the dropdown, and disabled here: a request is not a dropdown,
    // and a grant does not help while Meta has not approved the app.
    const choice = chooseCreatorSource({}, 'instagram', ['instagram']);
    expect(choice).toMatchObject({ ok: false });
    expect((choice as { error: string }).error).toBe(creatorSourceBlockedReason('instagram'));
  });

  it('accepts TikTok on its grant, now that the app has credentials', () => {
    // TikTok sat beside Instagram until `TIKTOK_CLIENT_KEY` was set. Nothing
    // about the code path changed; the block was about the app's status, so it
    // is expressed as data (`blockedReason`) rather than as a branch.
    expect(creatorSourceBlockedReason('tiktok')).toBeNull();
    expect(chooseCreatorSource({}, 'tiktok', ['tiktok'])).toMatchObject({ ok: true });
    expect(chooseCreatorSource({}, 'tiktok', [])).toMatchObject({ ok: false });
  });

  it('offers TikTok plainly, with nothing hedged in front of it', () => {
    const tiktok = CREATOR_SOURCE_OPTIONS.find(option => option.source === 'tiktok');
    // Neither blocked nor caveated. A refusal is rare, and since approval
    // (2026-08-06) there is no allow-list to warn about at all — and it
    // is the callback's to explain — to the creator it happened to, at the
    // moment it happened, rather than to everyone in advance.
    expect(tiktok?.blockedReason).toBeNull();
    expect(tiktok?.label).toBe('TikTok');
    expect(tiktok?.note).toBeNull();
  });

  it('refuses a value the CHECK constraint would refuse too', () => {
    expect(chooseCreatorSource(CHECKED_SITE, 'facebook')).toMatchObject({ ok: false });
    expect(chooseCreatorSource(CHECKED_SITE, undefined)).toMatchObject({ ok: false });
  });

  it('always allows off, whatever state the row is in', () => {
    // Consent that can only be given is not consent. Nothing about a row may
    // make a creator unable to withdraw.
    expect(chooseCreatorSource({ primary_source: 'instagram', import_opt_in: true }, 'none')).toMatchObject({
      ok: true,
      update: { primary_source: 'none', import_opt_in: false },
    });
  });

  it('refuses a website whose feed sits on a host they have left', () => {
    // Both columns populated, so "both present" would call this ready and poll a
    // feed that is no longer theirs.
    expect(chooseCreatorSource(
      { website_url: 'https://sarahcooks.test/', feed_url: 'https://chefsarah.test/feed' },
      'website',
    )).toMatchObject({ ok: false });
  });

  it('clears the pause the choice has just answered', () => {
    const choice = chooseCreatorSource(CHECKED_SITE, 'website');
    expect((choice as { update: Record<string, unknown> }).update).toMatchObject({
      import_paused_reason: null,
      import_paused_at: null,
    });
  });
});

describe('creator-sources — describeWebsiteImportFailure', () => {
  const site = 'https://chefsarah.test/';

  it('says nothing at all about a site that works', () => {
    expect(describeWebsiteImportFailure(site, { outcome: 'viable', reason: null, checked: 10, passed: 8 })).toBeNull();
    // `partial` works too. A blog where three in ten are recipes syncs less
    // often; refusing it would be Mealio deciding a creator publishes the wrong
    // things.
    expect(describeWebsiteImportFailure(site, { outcome: 'partial', reason: null, checked: 10, passed: 3 })).toBeNull();
  });

  it.each([
    ['no-feed', /could not find a feed/i],
    ['blocked-by-robots', /robots\.txt/i],
    ['blocked-by-site', /refused to let Mealio read it/i],
    ['unreachable', /could not reach/i],
    ['no-entries', /could not read any posts out of it/i],
    ['feed-off-site', /not on/i],
    ['classifier-unavailable', /try again in a few minutes/i],
    ['empty', /found nothing posted yet/i],
  ])('turns %s into something a creator can act on', (reason, expected) => {
    const sentence = describeWebsiteImportFailure(site, { outcome: 'unavailable', reason, checked: 0, passed: 0 });
    expect(sentence).toMatch(expected);
    // The rule this function exists for: no status codes, ever. A creator handed
    // "403 on /feed" has been told nothing they can do anything about.
    expect(sentence).not.toMatch(/\b[45]\d\d\b/);
  });

  it('never leaves a creator with no sentence at all', () => {
    // A reason nobody has seen yet — a new probe, a renamed constant — must not
    // produce an empty error box.
    const sentence = describeWebsiteImportFailure(site, { outcome: 'unavailable', reason: 'something-new', checked: 0, passed: 0 });
    expect(sentence).toMatch(/could not read/i);
  });

  it('counts what it read when the posts simply are not recipes', () => {
    expect(describeWebsiteImportFailure(site, { outcome: 'not-viable', reason: null, checked: 10, passed: 0 }))
      .toMatch(/read the 10 most recent posts/i);
    // One post is one post.
    expect(describeWebsiteImportFailure(site, { outcome: 'not-viable', reason: null, checked: 1, passed: 0 }))
      .toMatch(/the 1 most recent post\b/i);
  });
});
