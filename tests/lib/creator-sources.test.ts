import { describe, it, expect } from 'vitest';
import {
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
});
