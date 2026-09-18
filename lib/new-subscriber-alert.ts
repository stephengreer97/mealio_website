import { adminNotifyEmails, sendNewSubscriberEmail } from '@/lib/email';
import { log } from '@/lib/logger';
import type { SubscriptionSource } from '@/lib/subscription-source';

/** `app_settings` key for the admin toggle. Anything but 'off' — including no row at all — is on. */
const SETTING_KEY = 'notify_new_subscribers';

type Db = { from: (table: string) => any };

export async function isNewSubscriberAlertOn(supabase: Db): Promise<boolean> {
  const { data, error } = await supabase.from('app_settings').select('value').eq('key', SETTING_KEY).maybeSingle();
  if (error) throw error;
  return (data as { value?: string | null } | null)?.value !== 'off';
}

export async function setNewSubscriberAlert(supabase: Db, on: boolean): Promise<{ error: { message: string } | null }> {
  const { error } = await supabase.from('app_settings').upsert({ key: SETTING_KEY, value: on ? 'on' : 'off' }, { onConflict: 'key' });
  return { error };
}

const CHANNEL_LABEL: Record<SubscriptionSource, string> = {
  stripe: 'Web (Stripe)',
  app_store: 'App Store',
  play_store: 'Google Play',
  store: 'App store (other)',
  comp: 'Comp',
  unknown: 'Unknown',
};

/**
 * Tell every admin that `userId` just subscribed to Full Access.
 *
 * Never throws: it runs inside the payment webhooks after access has already
 * been granted, and a failed notification must not turn into a non-2xx that
 * makes Stripe or RevenueCat redeliver the purchase. A failure is logged.
 *
 * Switched off from the admin dashboard (Marketing → Emails). If the setting
 * cannot be read the email is sent: a stray notification is cheaper than a
 * subscriber nobody heard about.
 */
export async function notifyAdminsOfNewSubscriber(
  supabase: Db,
  userId: string,
  source: SubscriptionSource,
): Promise<void> {
  try {
    const on = await isNewSubscriberAlertOn(supabase).catch(() => true);
    if (!on) return;
    const [adminEmails, { data: profile }] = await Promise.all([
      adminNotifyEmails(supabase),
      supabase.from('user_profiles').select('email').eq('id', userId).maybeSingle(),
    ]);
    await sendNewSubscriberEmail({
      adminEmails,
      userEmail: (profile as { email?: string | null } | null)?.email ?? null,
      channel: CHANNEL_LABEL[source],
    });
    log({ event: 'PAYMENT:ADMIN_NOTIFY', status: 'success', userId, detail: source });
  } catch (err) {
    log({ event: 'PAYMENT:ADMIN_NOTIFY', status: 'error', userId, reason: String(err), detail: source });
  }
}
