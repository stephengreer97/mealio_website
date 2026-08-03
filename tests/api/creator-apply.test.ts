import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeDb } from '../helpers/supabase-mock';
import { jsonRequest } from '../helpers/request';

// vi.mock is hoisted above imports, so the factory must import the helper
// dynamically rather than close over the static import.
vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));
vi.mock('@/lib/email', () => ({
  sendCreatorApplicationEmail: vi.fn(async () => {}),
  sendCreatorAppliedEmail: vi.fn(async () => {}),
}));

import { POST } from '@/app/api/creator/apply/route';
import { createAccessToken } from '@/lib/tokens';

const BASE = {
  displayName: 'Chef Sarah',
  handle: 'chefsarah',
  photoUrl: 'https://cdn.test/photo.jpg',
  findUs: 'instagram.com/chefsarah',
};

function insertedRow() {
  return fakeDb.calls.find((c) => c.table === 'creator_applications' && c.method === 'insert')?.args[0];
}

describe('/api/creator/apply — platform links', () => {
  let token: string;

  beforeEach(async () => {
    fakeDb.reset();
    token = await createAccessToken('user-1', 'a@b.test');
  });

  it('stores all four links, normalised', async () => {
    // All four are stored even though only one will ever be polled: the
    // *decision* is manual, the *data* should not be, and switching a creator
    // later should be a field edit rather than re-onboarding them.
    const res = await POST(jsonRequest('/api/creator/apply', {
      token,
      body: {
        ...BASE,
        websiteUrl: 'chefsarah.com',
        youtubeUrl: 'https://www.youtube.com/@chefsarah',
        instagramUrl: '',
        tiktokUrl: 'tiktok.com/@chefsarah',
      },
    }));

    expect(res.status).toBe(201);
    expect(insertedRow()).toMatchObject({
      website_url: 'https://chefsarah.com/',
      youtube_url: 'https://www.youtube.com/@chefsarah',
      instagram_url: null,
      tiktok_url: 'https://tiktok.com/@chefsarah',
    });
  });

  it('accepts an application with no links at all — all four are optional', async () => {
    const res = await POST(jsonRequest('/api/creator/apply', { token, body: BASE }));
    expect(res.status).toBe(201);
    expect(insertedRow()).toMatchObject({
      website_url: null, youtube_url: null, instagram_url: null, tiktok_url: null,
    });
  });

  it('400s on a link in the wrong box, without inserting anything', async () => {
    const res = await POST(jsonRequest('/api/creator/apply', {
      token,
      body: { ...BASE, instagramUrl: 'https://tiktok.com/@chefsarah' },
    }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not on Instagram/i);
    expect(insertedRow()).toBeUndefined();
  });

  it('400s on a link that is not a public website', async () => {
    const res = await POST(jsonRequest('/api/creator/apply', {
      token,
      body: { ...BASE, websiteUrl: 'http://169.254.169.254/' },
    }));
    expect(res.status).toBe(400);
    expect(insertedRow()).toBeUndefined();
  });
});
