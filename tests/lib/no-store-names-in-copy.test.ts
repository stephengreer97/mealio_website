// No retailer is named in help, legal or marketing copy.
//
// Stephen, 2026-09-09: "I don't want specific stores named anywhere. Keep it
// generic." Two reasons it stays true rather than being a one-off sweep:
//
//   1. The roster is data. A store is added or pulled with one row in `stores`,
//      and every enumeration in shipped copy is wrong from that moment until
//      someone remembers it exists. The help page carried 33 brand names in two
//      grids, and the app's FAQ was still offering Amazon Fresh five days after
//      the product dropped it.
//   2. The picker is generated from that same catalog, so it is right on the
//      day. Copy points at the picker instead of reciting it.
//
// SCOPE. This checks copy, not the product. The store pickers, the catalog, the
// automation code and the admin dashboard all name stores and must: you cannot
// pick a store you cannot see. Only the files listed here are read, and only
// what they SAY -- comments are stripped first, because the engineering reason a
// rail exists is a different thing from a promise made to a user.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');

/** Copy a user reads. Not pickers, not the catalog, not admin. */
const COPY_FILES = [
  'app/help/page.tsx',
  'app/terms/page.tsx',
  'app/privacy/page.tsx',
  'app/about/page.tsx',
  'app/pricing/page.tsx',
  'components/GuestPitch.tsx',
  'lib/pitch.ts',
  'lib/email.ts',
  'emails/confirm-signup.html',
  'emails/reset-password.html',
];

/**
 * Brand names, unambiguous ones only.
 *
 * Deliberately omits `Acme`, `Kings`, `United`, `Star Market` and `Carrs`:
 * they are ordinary words or fragments of them, and a check that fires on
 * "United States" in the Terms would be turned off rather than obeyed. The
 * banners left out are all family members of a chain that IS on this list, so
 * a reintroduced list cannot slip past whole.
 */
const BRANDS = [
  'Kroger', 'Ralphs', 'Fred Meyer', 'King Soopers', "Smith's Food",
  "Fry's Food", 'QFC', 'City Market', 'Dillons', "Mariano's", "Pick 'n Save",
  'Metro Market', 'Harris Teeter',
  'H-E-B', 'HEB', 'Walmart', 'ALDI', 'Wegmans', 'Publix', 'Sprouts',
  'Albertsons', 'Safeway', 'Vons', 'Jewel-Osco', "Shaw's", 'Tom Thumb',
  'Randalls', 'Pavilions', 'Haggen', "Balducci's",
  'Instacart', 'Amazon Fresh', 'Price Chopper', 'Fresh Market',
];

/** The file with `//` and block comments removed, so only copy is read. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ');
}

describe('help, legal and marketing copy', () => {
  for (const file of COPY_FILES) {
    it(`names no retailer: ${file}`, () => {
      const path = join(ROOT, file);
      if (!existsSync(path)) return; // a page can be deleted; that is not a failure here
      const copy = withoutComments(readFileSync(path, 'utf8'));
      const found = BRANDS.filter((b) => new RegExp(b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(copy));
      expect(found, `${file} names ${found.join(', ')}. Point at the store picker instead.`).toEqual([]);
    });
  }
});
