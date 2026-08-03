import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { NextRequest } from 'next/server';

vi.mock('@/lib/logger', () => ({ log: vi.fn() }));

const checkPushReceipts = vi.fn(async () => ({ checked: 0, revoked: 0 }));
vi.mock('@/lib/push', () => ({ checkPushReceipts: () => checkPushReceipts() }));

import { GET } from '@/app/api/cron/push-receipts/route';

function cronRequest(secret?: string) {
  return new NextRequest('https://mealio.co/api/cron/push-receipts', {
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  });
}

describe('GET /api/cron/push-receipts', () => {
  const original = process.env.CRON_SECRET;
  beforeEach(() => { checkPushReceipts.mockClear(); process.env.CRON_SECRET = 'sekrit'; });
  afterEach(() => { process.env.CRON_SECRET = original; });

  it('fails closed when no cron secret is configured, rather than running unauthenticated', async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(cronRequest('sekrit'));
    expect(res.status).toBe(500);
    expect(checkPushReceipts).not.toHaveBeenCalled();
  });

  it('401s without the cron secret', async () => {
    const res = await GET(cronRequest('wrong'));
    expect(res.status).toBe(401);
    expect(checkPushReceipts).not.toHaveBeenCalled();
  });

  it('sweeps receipts and reports what it pruned', async () => {
    checkPushReceipts.mockResolvedValueOnce({ checked: 12, revoked: 3 });
    const res = await GET(cronRequest('sekrit'));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, pushTokensPruned: 3 });
  });

  it('still returns 200 when the sweep throws — a cron that 500s tells us nothing new', async () => {
    checkPushReceipts.mockRejectedValueOnce(new Error('supabase down'));
    const res = await GET(cronRequest('sekrit'));
    expect(res.status).toBe(200);
  });

  it('is scheduled apart from the daily job, so a receipt is read twice inside its ~24 h life', () => {
    // Expo expires a receipt after about a day. One sweep a day leaves a send
    // made just after it with minutes of margin, and overflows past
    // RECEIPT_SWEEP_LIMIT with none at all.
    //
    // This used to also assert `crons` had exactly two entries, on the grounds
    // that two was "the Vercel Hobby ceiling". That was wrong: Hobby allows 100
    // cron jobs per project and caps the *frequency* at once per day. The job
    // count was never the limit, so adding the poller (MEAL-75) is free and this
    // assertion only ever guarded a misunderstanding.
    const crons = JSON.parse(readFileSync('vercel.json', 'utf8')).crons as Array<{ path: string; schedule: string }>;
    const hours = crons
      .filter((c) => c.path === '/api/cron/daily' || c.path === '/api/cron/push-receipts')
      .map((c) => Number(c.schedule.split(' ')[1]));

    expect(hours).toHaveLength(2);
    expect(Math.abs(hours[0] - hours[1])).toBeGreaterThanOrEqual(8);
  });
});
