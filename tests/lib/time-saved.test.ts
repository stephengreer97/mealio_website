/**
 * MEAL-214 part 2. The ticket says the assumption behind this number decides
 * whether it ships at all, so these tests are about the ways it could flatter.
 */
import { describe, it, expect } from 'vitest';
import {
  timeSaved, formatTimeSaved, MINUTES_PER_ITEM_BY_HAND, TIME_SAVED_BASIS,
} from '../../lib/time-saved';

const run = (o: Partial<Parameters<typeof timeSaved>[0][number]> = {}) => ({
  items_added: 10,
  started_at: '2026-09-08T00:00:00Z',
  completed_at: '2026-09-08T00:00:03Z',
  ...o,
});

describe('the assumption is conservative and named', () => {
  it('uses the LOW end, not a flattering number', () => {
    // Every objection to this figure is that it is too high, so it sits at the
    // bottom of the published range rather than the middle.
    expect(MINUTES_PER_ITEM_BY_HAND).toBeLessThanOrEqual(1.5);
  });

  it('ships the basis sentence with the number', () => {
    expect(TIME_SAVED_BASIS).toMatch(/1\.2 minutes per item/);
    expect(timeSaved([run()]).basis).toBe(TIME_SAVED_BASIS);
  });
});

describe('counting', () => {
  it('counts what Mealio ADDED, not what was requested', () => {
    const r = timeSaved([run({ items_added: 6 })]);
    expect(r.itemsAdded).toBe(6);
    expect(r.byHandMinutes).toBeCloseTo(6 * 1.2);
  });

  it('SKIPS runs that reported nothing rather than counting them as zero', () => {
    // Folding unknowns in as zeroes drags the number down while looking like
    // data. A run that never reported is unknown, not empty.
    const r = timeSaved([run({ items_added: 10 }), run({ items_added: null })]);
    expect(r.runs).toBe(1);
    expect(r.itemsAdded).toBe(10);
  });

  it('subtracts the time Mealio actually spent', () => {
    const r = timeSaved([run({ items_added: 10 })]); // 3 seconds
    expect(r.byHandMinutes).toBeCloseTo(12);
    expect(r.mealioMinutes).toBeCloseTo(0.05);
    expect(r.savedMinutes).toBeCloseTo(11.95);
  });

  it('ignores an impossible duration rather than trusting the clock', () => {
    const r = timeSaved([run({ items_added: 10, completed_at: '2020-01-01T00:00:00Z' })]);
    expect(r.mealioMinutes).toBe(0);
  });

  it('never reports a negative saving', () => {
    // If Mealio somehow took longer, the honest display is "none", not a
    // negative dressed up as a saving.
    const r = timeSaved([run({ items_added: 1, started_at: '2026-09-08T00:00:00Z', completed_at: '2026-09-08T00:30:00Z' })]);
    expect(r.savedMinutes).toBe(0);
  });
});

describe('formatTimeSaved', () => {
  it('says nothing until there is enough to say', () => {
    // Claiming "you saved 4 minutes" cheapens every other number on the screen.
    expect(formatTimeSaved(timeSaved([run({ items_added: 2 })]))).toBeNull();
  });

  it('reads as hours and minutes once it is real', () => {
    const many = Array.from({ length: 20 }, () => run({ items_added: 10 }));
    const out = formatTimeSaved(timeSaved(many));
    expect(out).toMatch(/hours/);
  });
});
