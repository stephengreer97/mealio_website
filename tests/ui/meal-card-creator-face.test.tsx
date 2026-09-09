// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import MealCard, { type PresetMeal } from '@/components/MealCard';

/**
 * Whose meal is this, answered by a face.
 *
 * The card is a wide photo and a narrow text column, and the text column already
 * carries name, byline, source host, difficulty and tags. So the avatar sits on
 * the photo instead: the assertion that matters below is not that it renders but
 * that it renders OUTSIDE the text column, because the moment it moves inside it
 * takes its width out of the byline and the byline is what wraps.
 */

afterEach(cleanup);

const base: PresetMeal = {
  id: 'm1',
  name: 'Garlic butter shrimp',
  ingredients: [],
  photo_url: 'https://img/meal.jpg',
};

const draw = (meal: Partial<PresetMeal>, onCreatorClick?: (id: string) => void) =>
  render(<MealCard meal={{ ...base, ...meal }} onAdd={vi.fn()} onCreatorClick={onCreatorClick} />);

describe('the creator face on a meal card', () => {
  it('shows the creator photo when there is one', () => {
    draw({ creator_id: 'c1', creator_name: 'Sarah Lane', creator_photo: 'https://img/sarah.jpg' });
    const avatar = screen.getByTestId('creator-avatar');
    expect(avatar.querySelector('img')?.getAttribute('src')).toBe('https://img/sarah.jpg');
  });

  it('falls back to the creator initial rather than an empty circle', () => {
    draw({ creator_id: 'c1', creator_name: 'Priya', creator_photo: null });
    const avatar = screen.getByTestId('creator-avatar');
    expect(avatar.querySelector('img')).toBeNull();
    expect(avatar.textContent).toBe('P');
  });

  it('takes the initial from the name, not the @ in front of a handle', () => {
    draw({ creator_id: 'c1', creator_name: '@sarahcooks' });
    expect(screen.getByTestId('creator-avatar').textContent).toBe('S');
  });

  it('shows no face for an author-only meal, which has no creator behind it', () => {
    draw({ author: 'An old cookbook' });
    expect(screen.queryByTestId('creator-avatar')).toBeNull();
  });

  it('sits on the photo, not in the text column beside the byline', () => {
    draw({ creator_id: 'c1', creator_name: 'Sarah Lane', creator_photo: 'https://img/sarah.jpg' });
    const avatar = screen.getByTestId('creator-avatar');
    const mealPhoto = document.querySelector('img[alt="Garlic butter shrimp"]')!;
    // Same parent as the meal photo is the photo column; the byline lives in the
    // sibling column, and this test fails if the avatar is moved into it.
    expect(avatar.parentElement).toBe(mealPhoto.parentElement);
    expect(avatar.parentElement?.textContent).not.toContain('Sarah Lane');
  });

  it('opens the creator, the same as clicking their name', () => {
    const onCreatorClick = vi.fn();
    const onAdd = vi.fn();
    render(
      <MealCard
        meal={{ ...base, creator_id: 'c1', creator_name: 'Sarah Lane', creator_photo: 'https://img/sarah.jpg' }}
        onAdd={onAdd}
        onCreatorClick={onCreatorClick}
      />,
    );
    fireEvent.click(screen.getByTestId('creator-avatar'));
    expect(onCreatorClick).toHaveBeenCalledWith('c1');
  });

  it('does not open the meal underneath it on the way', () => {
    // The card opens the detail modal on click. Without stopPropagation the
    // avatar would open the creator AND the meal, one on top of the other.
    const onCreatorClick = vi.fn();
    render(
      <MealCard
        meal={{ ...base, creator_id: 'c1', creator_name: 'Sarah Lane' }}
        onAdd={vi.fn()}
        onCreatorClick={onCreatorClick}
      />,
    );
    fireEvent.click(screen.getByTestId('creator-avatar'));
    // The modal is the only thing on this card that renders the meal name as a
    // heading; the card itself uses a <p>.
    expect(screen.queryByRole('heading', { name: base.name })).toBeNull();
  });

  it('is not a button when there is no profile to open', () => {
    draw({ creator_id: 'c1', creator_name: 'Sarah Lane' });
    expect(screen.getByTestId('creator-avatar').tagName).toBe('SPAN');
  });
});
