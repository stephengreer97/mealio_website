import { describe, it, expect } from 'vitest';
import {
  MAX_MEAL_TAGS,
  SERVES_ERROR,
  sameTags,
  servesChangeError,
  servesTextOf,
  tagCapError,
  tagChangeError,
  toggleTag,
} from '@/lib/import/vocab';

/**
 * The tag and serves rules, where they are written down once.
 *
 * Two of these functions exist because the rule was previously copied instead:
 *
 *   - `toggleTag` is the click every tag picker performs. Three hand-written
 *     copies existed — the creator portal, `my-meals`, the admin draft editor —
 *     and one counted to a literal `3`. It is the *client* half of a rule the
 *     server refuses on, and it was the only guard in the tag-cap change with no
 *     test behind it: gutting the creator portal's copy left the whole suite
 *     green, because the chip it would have let through is `disabled`, and no
 *     click reaches a disabled button. A cap that is only reachable through a
 *     `disabled` attribute is one attribute away from not existing.
 *   - `tagChangeError` and `servesChangeError` are the grandfathering rule: a
 *     field is checked when a save *changes* it, not when a save *mentions* it.
 */

describe('toggleTag — the click every picker performs', () => {
  it('adds a tag there is room for', () => {
    expect(toggleTag(['Mexican'], 'Vegan')).toEqual(['Mexican', 'Vegan']);
  });

  it('removes one that is already chosen', () => {
    expect(toggleTag(['Mexican', 'Vegan'], 'Mexican')).toEqual(['Vegan']);
  });

  it('refuses the one past the cap, and hands back the same selection', () => {
    const selected = ['Mexican', 'No Cook', 'Vegan'];
    expect(toggleTag(selected, 'Healthy')).toEqual(selected);
  });

  it('takes the tag at the cap — three passes, four is the one that fails', () => {
    expect(toggleTag(['Mexican', 'No Cook'], 'Vegan')).toHaveLength(MAX_MEAL_TAGS);
  });

  it('deselecting makes room again — a cap, not a freeze', () => {
    let selected = ['Mexican', 'No Cook', 'Vegan'];
    selected = toggleTag(selected, 'No Cook');
    selected = toggleTag(selected, 'Healthy');
    expect(selected).toEqual(['Mexican', 'Vegan', 'Healthy']);
  });

  it('lets an over-cap selection be reduced, which is the only way back', () => {
    // What an edit modal opens on when the meal was published before the cap.
    const legacy = ['Mexican', 'No Cook', 'Vegan', 'Healthy', 'Snack'];
    expect(toggleTag(legacy, 'Snack')).toEqual(['Mexican', 'No Cook', 'Vegan', 'Healthy']);
  });

  it('never mutates the selection it was handed', () => {
    const selected = ['Mexican'];
    toggleTag(selected, 'Vegan');
    expect(selected).toEqual(['Mexican']);
  });
});

describe('sameTags — what counts as a change', () => {
  it('is the same list when the tags and their order match', () => {
    expect(sameTags(['Mexican', 'Vegan'], ['Mexican', 'Vegan'])).toBe(true);
  });

  it('treats a null column as the empty list', () => {
    expect(sameTags([], null)).toBe(true);
    expect(sameTags([], undefined)).toBe(true);
  });

  it('counts a reorder as a change, because the card renders the first three', () => {
    expect(sameTags(['Vegan', 'Mexican'], ['Mexican', 'Vegan'])).toBe(false);
  });

  it('counts an added or removed tag as a change', () => {
    expect(sameTags(['Mexican'], ['Mexican', 'Vegan'])).toBe(false);
  });
});

describe('tagChangeError — grandfathering', () => {
  const legacy = ['Mexican', 'No Cook', 'Vegan', 'Healthy', 'Snack'];

  it('lets an untouched over-cap list through, so the meal stays editable', () => {
    // The creator opened this meal to fix a typo in the name. The editor posts
    // `tags` regardless; refusing here loses the edit and blames a field they
    // never opened.
    expect(tagChangeError(legacy, legacy)).toBeNull();
  });

  it('refuses a change that is still over the cap', () => {
    expect(tagChangeError(['Mexican', 'No Cook', 'Vegan', 'Healthy'], legacy))
      .toBe('That is 4 tags. A meal takes at most 3.');
  });

  it('refuses a reorder of an over-cap list — it changes which three show', () => {
    const reordered = ['Snack', 'Mexican', 'No Cook', 'Vegan', 'Healthy'];
    expect(tagChangeError(reordered, legacy)).toMatch(/That is 5 tags/);
  });

  it('accepts a change that comes back to the cap', () => {
    expect(tagChangeError(['Mexican', 'No Cook', 'Vegan'], legacy)).toBeNull();
  });

  it('checks a list arriving where there was none — a create has nothing to grandfather', () => {
    expect(tagChangeError(['a', 'b', 'c', 'd'], null)).toBe(tagCapError(['a', 'b', 'c', 'd']));
  });
});

describe('servesChangeError — the same grandfathering, on the other field', () => {
  it('lets an untouched legacy value through', () => {
    expect(servesChangeError('2 1/2 cups', '2 1/2 cups')).toBeNull();
  });

  it('refuses a yield the save is actually setting', () => {
    expect(servesChangeError('2 1/2 cups', '4')).toBe(SERVES_ERROR);
  });

  it('takes a count and a range', () => {
    expect(servesChangeError('4', null)).toBeNull();
    expect(servesChangeError('2-4', null)).toBeNull();
  });

  it('takes clearing a legacy value — emptying it is always allowed', () => {
    expect(servesChangeError('', '2 1/2 cups')).toBeNull();
  });
});

describe('servesTextOf — the column is text', () => {
  it('trims, and reads absent as empty', () => {
    expect(servesTextOf('  4 ')).toBe('4');
    expect(servesTextOf(null)).toBe('');
    expect(servesTextOf(undefined)).toBe('');
  });

  it('renders a number as the text the column holds', () => {
    // An older client posting `serves: 4` stores "4". `0` stores "0", which
    // `SERVES_PATTERN` accepts here exactly as it does on POST — noted rather
    // than special-cased, so the two routes cannot disagree about it.
    expect(servesTextOf(4)).toBe('4');
    expect(servesTextOf(0)).toBe('0');
  });
});
