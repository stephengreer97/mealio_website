// @vitest-environment jsdom
import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import ConfidenceMarker from '@/components/ConfidenceMarker';
import { MARKER_COLORS } from '@/lib/import/draft-form';
import type { FieldConfidence } from '@/lib/import/types';

afterEach(cleanup);

function field(overrides: Partial<FieldConfidence> = {}): FieldConfidence {
  return {
    level: 'amber',
    derivation: 'normalized',
    match: 'exact',
    score: 1,
    evidence: '3 tablespoons lime juice (from about 1 ½ limes), or more if needed',
    reason: 'Restated from the source — check the amount and unit.',
    ...overrides,
  };
}

describe('ConfidenceMarker', () => {
  it('shows the evidence span when tapped — the thing that makes a colour actionable', () => {
    render(<ConfidenceMarker field={field()} fieldLabel="Lime juice" />);

    expect(screen.queryByRole('note')).toBeNull();
    fireEvent.click(screen.getByRole('button'));

    const panel = screen.getByRole('note');
    expect(panel.textContent).toContain('We got this from:');
    expect(panel.textContent).toContain('3 tablespoons lime juice');
    expect(panel.textContent).toContain('Restated from the source');
  });

  it('shows it on hover too, for a creator at a desk', () => {
    render(<ConfidenceMarker field={field()} fieldLabel="Lime juice" />);
    fireEvent.mouseEnter(screen.getByRole('button'));
    expect(screen.getByRole('note').textContent).toContain('3 tablespoons lime juice');
    fireEvent.mouseLeave(screen.getByRole('button'));
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('closes a pinned panel on Escape', () => {
    render(<ConfidenceMarker field={field()} fieldLabel="Lime juice" />);
    fireEvent.click(screen.getByRole('button'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('explains a red field that has no span to quote', () => {
    render(
      <ConfidenceMarker
        field={field({ level: 'red', derivation: 'absent', evidence: null, match: 'none', score: 0, reason: 'No evidence span — the value is not traceable to the source.' })}
        fieldLabel="Story"
      />,
    );
    fireEvent.click(screen.getByRole('button'));
    const panel = screen.getByRole('note');
    expect(panel.textContent).toContain('Nothing on the page backed this up');
    expect(panel.textContent).not.toContain('We got this from:');
  });

  it('is readable without colour — the level is named in the label and the accessible name', () => {
    render(<ConfidenceMarker field={field({ level: 'red', derivation: 'page-text' })} fieldLabel="Serves" />);
    const button = screen.getByRole('button');
    expect(button.getAttribute('aria-label')).toContain('Serves');
    expect(button.getAttribute('aria-label')).toContain('Unverified');
    expect(button.textContent).toContain('Unverified');
  });

  it('uses the error red, never the brand red', () => {
    render(<ConfidenceMarker field={field({ level: 'red' })} fieldLabel="Serves" />);
    const dot = screen.getByRole('button').querySelector('span[aria-hidden="true"]') as HTMLElement;
    expect(dot.style.background).toBe('rgb(220, 38, 38)'); // #DC2626
    expect(MARKER_COLORS.red.dot).not.toBe('#DD0031');
  });

  it('drops the word on a dense ingredient row but keeps it in the accessible name', () => {
    render(<ConfidenceMarker field={field()} fieldLabel="Ingredient 2, lime juice" variant="dot" />);
    const button = screen.getByRole('button');
    expect(button.textContent).toBe('');
    expect(button.getAttribute('aria-label')).toContain('Ingredient 2, lime juice: Adjusted');
  });

  it('carries a form-supplied note, e.g. that Serves was shortened', () => {
    render(<ConfidenceMarker field={field()} fieldLabel="Serves" note="Shortened to fit the Serves box." />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('note').textContent).toContain('Shortened to fit the Serves box.');
  });
});
