import { describe, it, expect } from 'vitest';
import { detectSourcePlatform, captionGuidance, mealShareUrl } from '@/lib/sourcePlatform';

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
    expect(mealShareUrl('abc-123')).toBe('https://mealio.co/meal/p/abc-123');
  });
});
