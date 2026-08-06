// @vitest-environment jsdom
import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

afterEach(cleanup);

import { TrendSparkline, CodeChips, DayPoint } from '@/components/AdminFunnelChart';

/**
 * The funnel's chart, tested for the two things a styling pass could quietly
 * undo: a day with no runs must be a GAP rather than a zero, and `uncoded` must
 * be a visible bucket rather than an absence.
 *
 * Both are the same mistake in different clothes — drawing "we don't know" as
 * "we know it's nothing". On this page that mistake costs someone a day chasing
 * an outage that never happened, or ignoring forty failures nobody can explain.
 */

const day = (over: Partial<DayPoint> & { day: string }): DayPoint => ({
  runs: 4,
  runsSucceeded: 4,
  terminalSuccessRate: 1,
  blocked: 0,
  failures: 0,
  ...over,
});

function polylinePoints(): string[] {
  return [...document.querySelectorAll('polyline')].map((p) => p.getAttribute('points') ?? '');
}

describe('TrendSparkline', () => {
  it('breaks the line across a day with no runs instead of drawing it at zero', () => {
    const daily = [
      day({ day: '2026-08-01' }),
      day({ day: '2026-08-02' }),
      day({ day: '2026-08-03', runs: 0, runsSucceeded: 0, terminalSuccessRate: null }),
      day({ day: '2026-08-04' }),
      day({ day: '2026-08-05' }),
    ];
    render(<TrendSparkline daily={daily} />);
    // Two segments, not one line dipping to the floor and back.
    expect(polylinePoints()).toHaveLength(2);
    expect(polylinePoints().every((p) => p.split(' ').length === 2)).toBe(true);
  });

  it('draws an isolated day as a dot rather than dropping it', () => {
    const daily = [
      day({ day: '2026-08-01', runs: 0, runsSucceeded: 0, terminalSuccessRate: null }),
      day({ day: '2026-08-02', terminalSuccessRate: 0.5 }),
      day({ day: '2026-08-03', runs: 0, runsSucceeded: 0, terminalSuccessRate: null }),
    ];
    const { container } = render(<TrendSparkline daily={daily} />);
    expect(polylinePoints()).toHaveLength(0);
    expect(container.querySelectorAll('circle')).toHaveLength(1);
  });

  it('says so plainly when the whole window is empty', () => {
    const daily = [
      day({ day: '2026-08-01', runs: 0, runsSucceeded: 0, terminalSuccessRate: null }),
      day({ day: '2026-08-02', runs: 0, runsSucceeded: 0, terminalSuccessRate: null }),
    ];
    render(<TrendSparkline daily={daily} />);
    expect(screen.getByText(/No daily history/i)).toBeTruthy();
  });

  it('keeps every plotted point inside the viewport at both extremes', () => {
    // A 0% day and a 100% day are the values most likely to be clipped, and a
    // clipped point reads as a missing one.
    const daily = [
      day({ day: '2026-08-01', terminalSuccessRate: 0 }),
      day({ day: '2026-08-02', terminalSuccessRate: 1 }),
      day({ day: '2026-08-03', terminalSuccessRate: 0.5 }),
    ];
    const { container } = render(<TrendSparkline daily={daily} width={300} height={56} />);
    const svg = container.querySelector('svg')!;
    const coords = polylinePoints()[0].split(' ').map((p) => p.split(',').map(Number));
    for (const [x, y] of coords) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(300);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(56);
    }
    expect(svg.getAttribute('height')).toBe('70'); // room for the date axis labels
  });

  it('labels the last plotted value and both ends of the window', () => {
    const daily = [
      day({ day: '2026-07-07', terminalSuccessRate: 1 }),
      day({ day: '2026-08-05', terminalSuccessRate: 0.75 }),
    ];
    const { container } = render(<TrendSparkline daily={daily} />);
    const text = container.textContent ?? '';
    expect(text).toContain('07-07');
    expect(text).toContain('08-05');
    expect(text).toContain('last 75%');
  });

  it('gives every day a hover label, including the empty ones', () => {
    const daily = [
      day({ day: '2026-08-01', runs: 3, runsSucceeded: 3 }),
      day({ day: '2026-08-02', runs: 0, runsSucceeded: 0, terminalSuccessRate: null }),
      day({ day: '2026-08-03', terminalSuccessRate: 0.5, runs: 2, runsSucceeded: 1, blocked: 2 }),
    ];
    const { container } = render(<TrendSparkline daily={daily} />);
    const titles = [...container.querySelectorAll('title')].map((t) => t.textContent);
    expect(titles).toHaveLength(3);
    expect(titles[1]).toContain('no runs');
    expect(titles[2]).toContain('2 blocked');
  });
});

describe('CodeChips', () => {
  it('orders codes by count, biggest first', () => {
    const { container } = render(<CodeChips codes={{ selector_miss: 2, timeout: 9, nav_failed: 5 }} />);
    const text = container.textContent ?? '';
    expect(text.indexOf('timeout')).toBeLessThan(text.indexOf('nav_failed'));
    expect(text.indexOf('nav_failed')).toBeLessThan(text.indexOf('selector_miss'));
  });

  it('shows uncoded failures as their own labelled bucket', () => {
    // Not an absence. These rows predate MEAL-4's taxonomy and no backfill can
    // attribute them, so the page has to say "we don't know" out loud.
    render(<CodeChips codes={{ uncoded: 12 }} />);
    const chip = screen.getByText(/uncoded 12/);
    expect(chip.getAttribute('title')).toMatch(/no code/i);
  });

  it('renders the caller\'s empty message rather than a bare dash by default', () => {
    render(<CodeChips codes={{}} empty="none in this window" />);
    expect(screen.getByText('none in this window')).toBeTruthy();
  });
});
