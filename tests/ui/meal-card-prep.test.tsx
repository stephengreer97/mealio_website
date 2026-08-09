// @vitest-environment jsdom
import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { fmtMeasurement, MealDetailBody, type PresetMeal } from '@/components/MealCard';

/**
 * MEAL-102 — how a preparation reads, and what a hostile one cannot do.
 *
 * `fmtMeasurement` is the one line format on this side: Discover, My Meals, the
 * creator portal, the admin review card, `/meal/[token]` and `/meal/p/[id]` all
 * render through it. So prep is appended here, once, and every surface gets it
 * — which is also why a mistake here would appear on all of them at once,
 * including the two public pages that render to people who are not logged in.
 *
 * The rule the ticket sets is that this is *additive*: a row with no prep must
 * render the string it rendered before the field existed, character for
 * character.
 */

const ing = (over: Record<string, unknown>) =>
  ({ ingredientName: 'Onion', qty: 1, unit: 'qty', measure: null, searchTerm: null, productQty: 1, ...over }) as any;

afterEach(cleanup);

describe('fmtMeasurement — preparation', () => {
  it('trails the preparation after the name, the way a recipe writes it', () => {
    expect(fmtMeasurement(ing({ measure: '1', prep: 'finely diced' }))).toBe('1 Onion, finely diced');
  });

  it('trails it on a measured row too', () => {
    expect(fmtMeasurement(ing({ ingredientName: 'Unsalted Butter', unit: 'tbsp', measure: '2', prep: 'melted' })))
      .toBe('2 tbsp Unsalted Butter, melted');
  });

  it('trails it on a row the source never quantified', () => {
    // "Salt" prints no invented "1", and the preparation still lands.
    expect(fmtMeasurement(ing({ ingredientName: 'Salt', measure: null, prep: 'to taste' })))
      .toBe('Salt, to taste');
  });

  it.each([
    ['absent', {}],
    ['null', { prep: null }],
    ['undefined', { prep: undefined }],
    ['empty', { prep: '' }],
    ['whitespace only', { prep: '   ' }],
  ])('renders exactly as it did before the field existed when prep is %s', (_label, over) => {
    // The additive guarantee, stated as the identity it actually is.
    expect(fmtMeasurement(ing({ measure: '1', ...over }))).toBe('1 Onion');
  });

  it('keeps a comma inside the preparation without breaking the line', () => {
    expect(fmtMeasurement(ing({ ingredientName: 'Black Beans', unit: 'cans', measure: '1', prep: 'drained, rinsed' })))
      .toBe('1 can Black Beans, drained, rinsed');
  });

  it('does not disturb the singular unit spelling beside it', () => {
    // `unitLabel` reads the amount, not the line. Appending prep must not
    // change what it decided.
    expect(fmtMeasurement(ing({ ingredientName: 'Flour', unit: 'cups', measure: '1', prep: 'sifted' })))
      .toBe('1 cup Flour, sifted');
  });
});

describe('MEAL-102 — a hostile preparation on a public meal page', () => {
  const meal = (prep: string): PresetMeal => ({
    id: 'preset-1',
    name: 'Guacamole',
    ingredients: [{ ingredientName: 'Onion', qty: 1, unit: 'qty', measure: '1', searchTerm: null, prep } as any],
  } as PresetMeal);

  it('renders markup as text rather than as HTML', () => {
    // `/meal/[token]` and `/meal/p/[id]` render this body to logged-out
    // readers, which makes prep the widest-reach string in the product. It is
    // a JSX child, so React escapes it — this pins that nobody "improves" the
    // line into a `dangerouslySetInnerHTML` later.
    const { container } = render(<MealDetailBody meal={meal('<script>alert(1)</script>')} />);

    expect(container.querySelector('script')).toBeNull();
    expect(container.innerHTML).not.toContain('<script>');
    // Present, and present as visible text.
    expect(screen.getByText(/1 Onion, <script>alert\(1\)<\/script>/)).toBeTruthy();
  });

  it('renders quotes and ampersands as the characters a cook typed', () => {
    // A real preparation contains both: 1" cubes, "drained & rinsed". They must
    // survive as themselves rather than arriving as &quot; and &amp;.
    render(<MealDetailBody meal={meal('cut into 1" cubes & patted dry')} />);

    expect(screen.getByText('1 Onion, cut into 1" cubes & patted dry')).toBeTruthy();
  });

  it('renders an image tag in prep as text, not as an element', () => {
    const { container } = render(<MealDetailBody meal={meal('<img src=x onerror=alert(1)>')} />);

    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText(/1 Onion, <img src=x onerror=alert\(1\)>/)).toBeTruthy();
  });
});
