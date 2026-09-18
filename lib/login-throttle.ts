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

/**
 * Wrong 2FA codes one account may enter, across every code it is sent, before
 * verification and resend stop for the rest of the window.
 *
 * Each code allows five tries (MAX_ATTEMPTS in the verify route), but a resend
 * every sixty seconds, or a fresh login, issues a new code with five more. On
 * their own that is roughly three hundred guesses an hour against a six-digit
 * code. Ten failures an hour is still generous to a person mistyping; it is not
 * a rate at which anyone guesses a million-way code.
 *
 * Stored in `login_attempts` under `otp:<userId>`, the same table and RPC as
 * the password throttle, so no migration.
 */
export const OTP_WINDOW_SECONDS = 60 * 60;
export const MAX_OTP_FAILURES = 10;
export const OTP_LOCKED_MESSAGE =
  'Too many incorrect codes. For your security, please wait an hour and try again.';

const otpKey = (userId: string) => `otp:${userId}`;

/**
 * True when this account has used up its wrong-code allowance. Reads without
 * counting, so looking does not spend an attempt. Fails open, as loginThrottled
 * does: a throttle that cannot read its own state must not lock anyone out.
 */
export async function otpLocked(supabase: SupabaseClient, userId: string): Promise<boolean> {
  const since = new Date(Date.now() - OTP_WINDOW_SECONDS * 1000).toISOString();
  const { count, error } = await supabase
    .from('login_attempts')
    .select('id', { count: 'exact', head: true })
    .eq('key', otpKey(userId))
    .gt('created_at', since);
  if (error || typeof count !== 'number') {
    log({ event: 'AUTH:OTP_THROTTLE', status: 'error', userId, reason: error?.message ?? 'no count returned' });
    return false;
  }
  return count >= MAX_OTP_FAILURES;
}

/**
 * Count one wrong code. Returns true when that failure used up the allowance,
 * so the caller can say "locked" rather than "N attempts remaining".
 */
export async function recordOtpFailure(supabase: SupabaseClient, userId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('record_login_attempt', {
    p_key: otpKey(userId),
    p_window_seconds: OTP_WINDOW_SECONDS,
  });
  if (error || typeof data !== 'number') {
    log({ event: 'AUTH:OTP_THROTTLE', status: 'error', userId, reason: error?.message ?? 'no count returned' });
    return false;
  }
  if (data >= MAX_OTP_FAILURES) {
    log({ event: 'AUTH:OTP_THROTTLE', status: 'failed', userId, reason: `${data} wrong codes in window` });
    return true;
  }
  return false;
}

/**
 * Bug reports one IP may send per window. The route needs no sign-in (the
 * app's crash screen posts to it before anyone may be signed in) and every
 * report is an email, sent on the same Resend quota as login codes, so an
 * unlimited endpoint was a way to spend that quota and bury the inbox.
 */
export const BUG_REPORT_WINDOW_SECONDS = 15 * 60;
export const MAX_BUG_REPORTS_PER_IP = 5;

/** Count one bug report from `ip`; true when it should be refused. Fails open. */
export async function bugReportThrottled(supabase: SupabaseClient, ip: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('record_login_attempt', {
    p_key: `bug:${ip}`,
    p_window_seconds: BUG_REPORT_WINDOW_SECONDS,
  });
  if (error || typeof data !== 'number') {
    log({ event: 'BUG_REPORT', status: 'error', ip, reason: `throttle: ${error?.message ?? 'no count returned'}` });
    return false;
  }
  return data > MAX_BUG_REPORTS_PER_IP;
}
