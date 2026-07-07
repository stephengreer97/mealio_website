import { Resend } from 'resend';
import { createServerSupabaseClient } from '@/lib/supabase';
import { log } from '@/lib/logger';
import { marketingEmailLayout } from '@/lib/email';

// Central sender for marketing / lifecycle email (creator publish-reminders,
// user upsell). Gives the compliance + reliability guarantees the raw Resend
// client doesn't: physical-address gate, suppression (opt-out / bounce /
// complaint), idempotency (dedup_key), an unsubscribe footer + List-Unsubscribe
// headers, and a logged row in email_sends for the admin dashboard.
//
// Transactional email (OTP, creator status, bug report) stays in lib/email.ts
// and must NOT route through here.

const resend = new Resend(process.env.RESEND_API_KEY);
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://mealio.co';

export interface MarketingEmailInput {
  /** Mealio user_profiles.id — used for suppression + unsubscribe token. */
  userId: string;
  to: string;
  /** Campaign id, stored on email_sends.type (e.g. 'user_upsell_1'). */
  type: string;
  subject: string;
  /** Inner HTML — wrapped in the shared layout + unsubscribe footer. */
  bodyHtml: string;
  /**
   * Idempotency key. If a row with this key already exists, the send is
   * skipped. e.g. `user_upsell_1:${userId}` or
   * `creator_reminder:${userId}:${period}`.
   */
  dedupKey?: string;
}

export type MarketingSendResult =
  | { status: 'sent'; messageId: string | null }
  | { status: 'skipped'; reason: 'opted_out' | 'duplicate' | 'no_address' | 'no_profile' }
  | { status: 'error'; error: string };

export async function sendMarketingEmail(input: MarketingEmailInput): Promise<MarketingSendResult> {
  const { userId, to, type, subject, bodyHtml, dedupKey } = input;
  const supabase = createServerSupabaseClient();

  // Compliance gate: never send marketing without a physical address (CAN-SPAM).
  if (!process.env.MEALIO_MAILING_ADDRESS) {
    log({ event: 'EMAIL:SUPPRESSED', status: 'failed', userId, detail: type, reason: 'no MEALIO_MAILING_ADDRESS configured' });
    return { status: 'skipped', reason: 'no_address' };
  }

  // Idempotency: bail if this dedup_key was already logged.
  if (dedupKey) {
    const { data: existing } = await supabase
      .from('email_sends')
      .select('id')
      .eq('dedup_key', dedupKey)
      .maybeSingle();
    if (existing) return { status: 'skipped', reason: 'duplicate' };
  }

  // Suppression + fetch the unsubscribe token.
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('marketing_opt_out, unsubscribe_token')
    .eq('id', userId)
    .maybeSingle();

  if (!profile) return { status: 'skipped', reason: 'no_profile' };

  if (profile.marketing_opt_out) {
    // Log the suppression so the dashboard shows why nothing sent. Do NOT write
    // dedup_key here — a suppressed row must not permanently block a future send
    // if the user later opts back in.
    await supabase.from('email_sends').insert({
      user_id: userId, email: to, type, dedup_key: null, status: 'suppressed',
    });
    log({ event: 'EMAIL:SUPPRESSED', status: 'pending', userId, detail: type, reason: 'opted out' });
    return { status: 'skipped', reason: 'opted_out' };
  }

  const unsubscribeUrl = `${APP_URL}/api/email/unsubscribe?token=${profile.unsubscribe_token}`;
  const html = marketingEmailLayout(bodyHtml, unsubscribeUrl);

  try {
    const { data, error } = await resend.emails.send({
      from: 'Mealio <noreply@mealio.co>',
      to,
      subject,
      html,
      headers: {
        // RFC 8058 one-click unsubscribe.
        'List-Unsubscribe': `<${unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });
    if (error) throw new Error(error.message);

    await supabase.from('email_sends').insert({
      user_id: userId, email: to, type, dedup_key: dedupKey ?? null,
      resend_message_id: data?.id ?? null, status: 'sent',
    });
    log({ event: 'EMAIL:MARKETING_SENT', status: 'success', userId, detail: type });
    return { status: 'sent', messageId: data?.id ?? null };
  } catch (err: any) {
    // No dedup_key on error rows — the send never went out, so a retry must not
    // be permanently blocked.
    await supabase.from('email_sends').insert({
      user_id: userId, email: to, type, dedup_key: null,
      status: 'error', error: err.message,
    });
    log({ event: 'EMAIL:MARKETING_SENT', status: 'error', userId, detail: type, reason: err.message });
    return { status: 'error', error: err.message };
  }
}
