import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { log } from '@/lib/logger';

export const dynamic = 'force-dynamic';

async function optOut(token: string | null): Promise<boolean> {
  if (!token) return false;
  const supabase = createServerSupabaseClient();
  const { data, error } = await supabase
    .from('user_profiles')
    .update({ marketing_opt_out: true })
    .eq('unsubscribe_token', token)
    .select('id')
    .maybeSingle();

  if (error || !data) {
    log({ event: 'EMAIL:UNSUBSCRIBE', status: error ? 'error' : 'failed', reason: error?.message ?? 'token not found' });
    return false;
  }
  log({ event: 'EMAIL:UNSUBSCRIBE', status: 'success', userId: data.id });
  return true;
}

// RFC 8058 one-click unsubscribe — mail clients POST here directly.
export async function POST(request: NextRequest) {
  const token = new URL(request.url).searchParams.get('token');
  await optOut(token);
  return NextResponse.json({ ok: true });
}

// Link click — returns a simple branded confirmation page.
export async function GET(request: NextRequest) {
  const token = new URL(request.url).searchParams.get('token');
  const ok = await optOut(token);
  const message = ok
    ? "You've been unsubscribed from Mealio marketing emails. You'll still get important account emails (login codes, receipts, security)."
    : "We couldn't process that unsubscribe link. Please email contact@mealio.co and we'll take care of it.";

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Mealio — Unsubscribe</title></head>
    <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#faf7f5;margin:0;padding:48px 16px;">
      <div style="max-width:440px;margin:0 auto;background:#fff;border-radius:16px;padding:32px 24px;text-align:center;box-shadow:0 2px 16px rgba(0,0,0,0.05);">
        <img src="https://mealio.co/email-logo.png" alt="Mealio" width="130" height="45" style="display:block;margin:0 auto 16px;border:0;" />
        <p style="color:#444;font-size:15px;line-height:1.6;margin:0;">${message}</p>
      </div>
    </body></html>`;

  return new NextResponse(html, {
    status: ok ? 200 : 400,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
