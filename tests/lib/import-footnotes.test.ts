import { describe, it, expect } from 'vitest';
import { stripFootnoteMarkers } from '@/lib/import/extract';

/**
 * Footnote markers left on a step by the recipe card it came from.
 *
 * Budget Bytes' cottage cheese eggs ends a step "…remove them from the heat and
 * enjoy!**" in their own JSON-LD — the asterisks point at a note printed under
 * their recipe card. Ours was a faithful copy, which is the problem: lifted out
 * of that page the marker refers to nothing, and the creator deletes it by hand.
 */
describe('import/extract — stripFootnoteMarkers', () => {
  it('drops a trailing marker from the line it is stuck to', () => {
    expect(stripFootnoteMarkers('…remove them from the heat and enjoy!**'))
      .toBe('…remove them from the heat and enjoy!');
    expect(stripFootnoteMarkers('Rest for ten minutes.*')).toBe('Rest for ten minutes.');
  });

  it('leaves an asterisk that is doing real work alone', () => {
    // Emphasis mid-sentence is a choice the writer made about their own recipe,
    // and a rule that ate it would be trading one wrong character for another.
    expect(stripFootnoteMarkers('1 tbsp butter *or* oil')).toBe('1 tbsp butter *or* oil');
  });

  it('cleans every line, not just the last one', () => {
    // Steps arrive as one field with newlines between them, so a marker on step
    // three is in the middle of the string rather than at its end.
    expect(stripFootnoteMarkers('Whisk the eggs.\nFold in the cheese.**\nServe.'))
      .toBe('Whisk the eggs.\nFold in the cheese.\nServe.');
  });
});
