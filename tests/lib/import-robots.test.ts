import { describe, it, expect } from 'vitest';
import { checkRobots, isAllowed, parseRobots } from '@/lib/import/robots';
import { publicLookup, stubFetch } from '../helpers/import-stubs';

describe('import/robots — parsing', () => {
  it('applies the wildcard group when we are not named', () => {
    const rules = parseRobots(['User-agent: *', 'Disallow: /private/', 'Allow: /private/public/'].join('\n'));
    expect(isAllowed(rules, '/recipes/pasta')).toBe(true);
    expect(isAllowed(rules, '/private/notes')).toBe(false);
    expect(isAllowed(rules, '/private/public/thing')).toBe(true);
  });

  it('prefers a group that names us over the wildcard group', () => {
    const rules = parseRobots(
      ['User-agent: *', 'Disallow: /', '', 'User-agent: MealioBot', 'Disallow: /admin/'].join('\n'),
    );
    expect(isAllowed(rules, '/recipes/pasta')).toBe(true);
    expect(isAllowed(rules, '/admin/x')).toBe(false);
  });

  it('treats consecutive User-agent lines as one group', () => {
    const rules = parseRobots(['User-agent: Googlebot', 'User-agent: *', 'Disallow: /drafts/'].join('\n'));
    expect(isAllowed(rules, '/drafts/x')).toBe(false);
  });

  it('reads an empty Disallow as allow-everything', () => {
    const rules = parseRobots(['User-agent: *', 'Disallow:'].join('\n'));
    expect(isAllowed(rules, '/anything')).toBe(true);
  });

  it('honours * and $ wildcards, longest match wins', () => {
    const rules = parseRobots(
      ['User-agent: *', 'Disallow: /*.pdf$', 'Disallow: /wp-admin/', 'Allow: /wp-admin/admin-ajax.php'].join('\n'),
    );
    expect(isAllowed(rules, '/files/menu.pdf')).toBe(false);
    expect(isAllowed(rules, '/files/menu.pdf.html')).toBe(true);
    expect(isAllowed(rules, '/wp-admin/options.php')).toBe(false);
    expect(isAllowed(rules, '/wp-admin/admin-ajax.php')).toBe(true);
  });

  it('ignores comments and unknown directives', () => {
    const rules = parseRobots(
      ['# a comment', 'Sitemap: https://x/sitemap.xml', 'User-agent: *  # inline', 'Crawl-delay: 10', 'Disallow: /x'].join('\n'),
    );
    expect(isAllowed(rules, '/x')).toBe(false);
    expect(isAllowed(rules, '/y')).toBe(true);
  });
});

describe('import/robots — checkRobots', () => {
  it('blocks a disallowed path and says which file said so', async () => {
    const { impl } = stubFetch({
      'https://blog.example.com/robots.txt': { body: 'User-agent: *\nDisallow: /recipes/' },
    });
    const result = await checkRobots('https://blog.example.com/recipes/pasta', {
      fetchImpl: impl,
      lookup: publicLookup,
    });
    expect(result.allowed).toBe(false);
    expect(result.detail).toContain('robots.txt');
    expect(result.detail).toContain('MealioBot');
  });

  it('allows a path outside the disallowed prefix', async () => {
    const { impl } = stubFetch({
      'https://blog.example.com/robots.txt': { body: 'User-agent: *\nDisallow: /admin/' },
    });
    const result = await checkRobots('https://blog.example.com/recipes/pasta', {
      fetchImpl: impl,
      lookup: publicLookup,
    });
    expect(result.allowed).toBe(true);
  });

  it('fails open when robots.txt is missing or unreachable', async () => {
    // A site that cannot serve robots.txt has not disallowed anything, and
    // failing closed would make every import depend on a second request.
    const { impl } = stubFetch({});
    const result = await checkRobots('https://blog.example.com/recipes/pasta', {
      fetchImpl: impl,
      lookup: publicLookup,
    });
    expect(result.allowed).toBe(true);
    expect(result.detail).toMatch(/no usable robots\.txt/i);
  });
});
