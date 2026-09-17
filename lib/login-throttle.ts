import type { SupabaseClient } from '@supabase/supabase-js';
import { log } from '@/lib/logger';

/**
 * How many attempts one key gets, and over how long.
 *
 * TWO KEYS, because the two attacks are different shapes. Many passwords
 * against ONE account is credential stuffing, and the email key stops it. One
 * password against MANY accounts is spraying, and only the IP key sees that at
 * all -- each account looks untouched.
 *
 * Generous on purpose. A person who has forgotten which password they used gets
 * several goes, a shared office NAT gets thirty, and neither number is where an
 * attack lives: the runs this exists to stop are thousands long.
 */
export const LOGIN_WINDOW_SECONDS = 15 * 60;
export const MAX_PER_EMAIL = 10;
export const MAX_PER_IP = 30;

/**
 * Count this attempt. Returns true when the caller should refuse it.
 *
 * FAILS OPEN, and that is the important decision here. If the table has not
 * been created yet, or the RPC errors, or Supabase is briefly unreachable, this
 * returns false and the login proceeds. A throttle that cannot read its own
 * state must not become an outage: the failure it is guarding against is an
 * attacker guessing passwords, and the failure it would otherwise cause is
 * every real customer locked out of the product at once. The first is survivable
 * for the minutes it takes to notice; the second is not.
 *
 * Counted BEFORE the password is checked, so a wrong password costs an attacker
 * exactly as much as a right one and the count cannot be avoided by guessing
 * badly.
 */
export async function loginThrottled(
  supabase: SupabaseClient,
  email: string,
  ip: string,
): Promise<boolean> {
  const keys: Array<{ key: string; max: number }> = [
    { key: `email:${email.trim().toLowerCase()}`, max: MAX_PER_EMAIL },
    { key: `ip:${ip}`, max: MAX_PER_IP },
  ];

  for (const { key, max } of keys) {
    const { data, error } = await supabase.rpc('record_login_attempt', {
      p_key: key,
      p_window_seconds: LOGIN_WINDOW_SECONDS,
    });
    if (error || typeof data !== 'number') {
      // Recorded rather than silent: "the throttle is not running" is the one
      // thing nobody would otherwise find out.
      log({ event: 'AUTH:LOGIN_THROTTLE', status: 'error', ip, reason: error?.message ?? 'no count returned' });
      return false;
    }
    if (data > max) {
      log({ event: 'AUTH:LOGIN_THROTTLE', status: 'failed', ip, reason: `over ${max} for ${key.split(':')[0]}` });
      return true;
    }
  }
  return false;
}
