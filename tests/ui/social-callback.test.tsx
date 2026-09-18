// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';

/**
 * /auth/social-callback moves the OAuth handoff into localStorage.
 *
 * It used to fall back to a `?token=` in the URL when the handoff cookie was
 * missing, so a link carrying the ATTACKER's token signed the victim into the
 * attacker's account without a word. Only the cookie, which only our own OAuth
 * callback can set on this origin, may sign anyone in.
 */

const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));

const SocialCallback = (await import('@/app/auth/social-callback/page')).default;

const USER = Buffer.from(JSON.stringify({ id: 'u1', email: 'a@b.test' })).toString('base64url');

function visit(search: string) {
  window.history.replaceState(null, '', `/auth/social-callback${search}`);
  render(<SocialCallback />);
}

beforeEach(() => {
  replace.mockReset();
  localStorage.clear();
  document.cookie = 'mealio_oauth_token=; Max-Age=0; path=/';
});
afterEach(cleanup);

describe('social-callback', () => {
  it('signs in from the handoff cookie', async () => {
    document.cookie = 'mealio_oauth_token=cookie-token; path=/';
    visit(`?user=${USER}&redirect=/my-meals`);

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/my-meals'));
    expect(localStorage.getItem('accessToken')).toBe('cookie-token');
  });

  it('ignores a token planted in the URL', async () => {
    visit(`?token=attacker-token&user=${USER}`);

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/signin'));
    expect(localStorage.getItem('accessToken')).toBeNull();
    expect(localStorage.getItem('user')).toBeNull();
  });
});
