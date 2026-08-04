// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { render, screen } from '@testing-library/react';

afterEach(cleanup);
import AboutPage from '@/app/about/page';

vi.mock('@/components/AppHeader', () => ({ default: () => null }));
vi.mock('@/components/AppFooter', () => ({ default: () => null }));

/**
 * Google's OAuth verification refused with "your home page does not explain the
 * purpose of your app", and it was right: `/` redirected to `/discover`, which
 * renders client-side, so a reviewer loaded the site and saw no text at all.
 * `/about` was in the sitemap and returned 404.
 *
 * These assert the things a reviewer is actually looking for, so the page can
 * be reworded freely but cannot quietly stop doing its job.
 */
describe('/about — what Mealio is, for someone who has never seen it', () => {
  it('says what the app does without needing JavaScript to say it', () => {
    render(<AboutPage />);
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/recipe/i);
    expect(text).toMatch(/grocery cart/i);
    // The specific claim, not just the words: saving a meal leads to shopping.
    expect(text).toMatch(/adds every ingredient to your online cart/i);
  });

  it('explains the YouTube connection the OAuth scopes are for', () => {
    render(<AboutPage />);
    const text = document.body.textContent ?? '';
    // A reviewer assessing youtube.readonly / force-ssl is asking whether the
    // stated purpose justifies them. Reading a channel and the opt-in write are
    // both the reason those scopes exist, so both belong here.
    expect(text).toMatch(/YouTube channel/i);
    expect(text).toMatch(/approve, edit or decline/i);
    expect(text).toMatch(/off unless the creator turns it on/i);
  });

  it('says what user data it asks for and why, requirement by requirement', () => {
    render(<AboutPage />);
    const text = document.body.textContent ?? '';
    // Google's homepage rules require explaining "the purpose for which your app
    // requests user data". Describing the feature is not the same as naming the
    // permission and the reason, so each one is stated as request + purpose.
    expect(text).toMatch(/what we ask for, and why/i);
    expect(text).toMatch(/read access to a creator[’']s own YouTube channel/i);
    expect(text).toMatch(/permission to edit that channel[’']s video descriptions/i);
    // The Limited Use promises, in the same words as the privacy policy.
    expect(text).toMatch(/does not use information obtained from Google APIs for advertising/i);
    expect(text).toMatch(/train machine-learning models/i);
  });

  it('identifies who operates it', () => {
    render(<AboutPage />);
    expect(document.body.textContent ?? '').toMatch(/Mealio LLC/);
  });

  it('points at the privacy policy by the same absolute URL the consent screen carries', () => {
    render(<AboutPage />);
    const hrefs = Array.from(document.querySelectorAll('a')).map(a => a.getAttribute('href'));
    // Google asks that this link match the consent screen entry. A relative
    // href resolves to the same place but is not the same string, and the check
    // is not worth failing twice over.
    expect(hrefs).toContain('https://mealio.co/privacy');
  });

  it('links the privacy policy and terms, which verification also checks', () => {
    render(<AboutPage />);
    const hrefs = Array.from(document.querySelectorAll('a')).map(a => a.getAttribute('href'));
    expect(hrefs.some(h => h?.endsWith('/privacy'))).toBe(true);
    expect(hrefs.some(h => h?.endsWith('/terms'))).toBe(true);
  });

  it('gives a first-time visitor somewhere to go', () => {
    render(<AboutPage />);
    const discover = Array.from(document.querySelectorAll('a')).filter(a => a.getAttribute('href') === '/discover');
    expect(discover.length).toBeGreaterThan(0);
    expect(discover.some(a => /browse meals/i.test(a.textContent ?? ''))).toBe(true);
  });
});
