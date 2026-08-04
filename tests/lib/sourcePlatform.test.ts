import { describe, it, expect } from 'vitest';
import { detectSourcePlatform, captionGuidance, mealIdFromParam, mealShareUrl, mealSlug } from '@/lib/sourcePlatform';

// The platform decides which caption guidance a creator sees after publishing,
// and only TikTok's copy carries the 7-day edit deadline. A false positive on a
// look-alike host would tell a creator a deadline that does not apply to them;
// a false negative would hide a real one.
//
// Mirrors tests/unit/sourcePlatform.test.ts in mealio_app — the two copies of
// this module must stay in agreement.

describe('detectSourcePlatform', () => {
  it('returns null for missing or empty sources', () => {
    expect(detectSourcePlatform(null)).toBeNull();
    expect(detectSourcePlatform(undefined)).toBeNull();
    expect(detectSourcePlatform('')).toBeNull();
  });

  it('returns null for a value that is not a URL', () => {
    expect(detectSourcePlatform('my tiktok video')).toBeNull();
  });

  it('detects TikTok, including subdomains and short links', () => {
    expect(detectSourcePlatform('https://www.tiktok.com/@chef/video/123')).toBe('tiktok');
    expect(detectSourcePlatform('https://tiktok.com/@chef/video/123')).toBe('tiktok');
    expect(detectSourcePlatform('https://vm.tiktok.com/ZMabc123/')).toBe('tiktok');
  });

  it('detects Instagram, including reels and subdomains', () => {
    expect(detectSourcePlatform('https://www.instagram.com/reel/Cabc123/')).toBe('instagram');
    expect(detectSourcePlatform('https://instagram.com/p/Cabc123/')).toBe('instagram');
  });

  it('does not match look-alike hosts', () => {
    expect(detectSourcePlatform('https://nottiktok.com/video/1')).toBeNull();
    expect(detectSourcePlatform('https://tiktok.com.evil.example/video/1')).toBeNull();
    expect(detectSourcePlatform('https://instagram.co/p/1')).toBeNull();
  });

  it('returns null for an ordinary recipe blog', () => {
    expect(detectSourcePlatform('https://myfoodblog.com/lemon-chicken')).toBeNull();
  });
});

describe('captionGuidance', () => {
  it('states the TikTok deadline', () => {
    const g = captionGuidance('tiktok');
    expect(g.note).toContain('7 days');
    expect(g.note).toContain('once per day');
  });

  it('tells Instagram creators there is no deadline', () => {
    expect(captionGuidance('instagram').note).toContain('stay editable');
  });

  it('gives generic guidance with no deadline when the platform is unknown', () => {
    expect(captionGuidance(null).note).toBeNull();
  });
});

describe('mealShareUrl', () => {
  it('points at the public preset-meal page', () => {
    // No name given: exactly as before, so every link already sitting in a
    // description keeps resolving and old callers need no change.
    expect(mealShareUrl('abc-123')).toBe('https://mealio.co/meal/p/abc-123');
  });

  it('puts the name in front of the id, because truncation eats the end', () => {
    // YouTube cuts a description link at roughly forty characters. A bare uuid
    // therefore showed a viewer `mealio.co/meal/p/9ca4eee0-d12b-404…` — nothing
    // about where it goes. The readable half has to come first to survive.
    const id = '9ca4eee0-d12b-4041-9c4e-4a1f2b3c4d5e';
    expect(mealShareUrl(id, 'Weeknight Garlic Butter Shrimp'))
      .toBe(`https://mealio.co/meal/p/weeknight-garlic-butter-shrimp-${id}`);
  });

  it('reads the id back out, slug or no slug', () => {
    const id = '9ca4eee0-d12b-4041-9c4e-4a1f2b3c4d5e';
    expect(mealIdFromParam(`weeknight-garlic-butter-shrimp-${id}`)).toBe(id);
    expect(mealIdFromParam(id)).toBe(id);
    // A name that is all hyphens once slugged must not eat into the id, and a
    // name full of digits must not be mistaken for part of it.
    expect(mealIdFromParam(`chicken-65-${id}`)).toBe(id);
    // Nothing resolvable: handed on untouched, so the lookup fails honestly
    // rather than this inventing an id.
    expect(mealIdFromParam('not-a-meal')).toBe('not-a-meal');
  });

  it('makes a slug that is safe in a URL, or none at all', () => {
    expect(mealSlug('Grandma’s "Best" Chicken & Rice!')).toBe('grandma-s-best-chicken-rice');
    expect(mealSlug('')).toBe('');
    expect(mealSlug(null)).toBe('');
    // Long names are cut, and never leave a trailing hyphen to double up
    // against the one that joins the id.
    const long = mealSlug('a'.repeat(80));
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long.endsWith('-')).toBe(false);
  });
});
