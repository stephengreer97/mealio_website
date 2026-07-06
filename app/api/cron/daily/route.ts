import { NextRequest, NextResponse } from 'next/server';
import { log } from '@/lib/logger';

export const dynamic = 'force-dynamic';

// Single daily cron for all lifecycle email passes — kept to one job so we stay
// within Vercel Hobby's cron limits (see vercel.json). Vercel injects
// `Authorization: Bearer <CRON_SECRET>` on scheduled invocations.
//
// M0: scaffold only. M2 fills in the two passes:
//   - creator publish-reminders (idle creators)
//   - user upsell drip (free users, N days after signup)
// Both go through sendMarketingEmail() (suppression + dedup handled there).
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get('authorization') ?? '';
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  const results = {
    creatorReminders: 0, // M2: await runCreatorReminders()
    userUpsell: 0,       // M2: await runUserUpsellDrip()
  };

  log({ event: 'CRON:DAILY', status: 'success', detail: JSON.stringify(results) });
  return NextResponse.json({ ok: true, ...results });
}
