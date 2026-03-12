import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';

// Vercel serverless is read-only except /tmp; local dev uses process.cwd()/logs
const LOG_DIR  = process.env.VERCEL ? '/tmp/logs' : join(process.cwd(), 'logs');
const LOG_FILE = join(LOG_DIR, 'mealio.log');

try {
  mkdirSync(LOG_DIR, { recursive: true });
} catch {
  // ignore — console logging still works
}

export type EventType =
  // ── Auth ──────────────────────────────────────────────────────────────────
  | 'AUTH:LOGIN'
  | 'AUTH:LOGOUT'
  | 'AUTH:REGISTER'
  | 'AUTH:POLL'             // extension polling check-extension-session
  | 'AUTH:REFRESH'          // refresh token rotation
  | 'AUTH:RENEW'            // access token renewal (extension keep-alive)
  | 'AUTH:VERIFY'           // verify endpoint (token validation)
  | 'AUTH:VERIFY_EMAIL'     // email verification link click
  | 'AUTH:RESEND'           // resend verification email
  | 'AUTH:FORGOT_PASSWORD'
  | 'AUTH:RESET_PASSWORD'
  | 'AUTH:SESSION_STATUS'   // lightweight token health check
  | 'AUTH:2FA_SENT'
  | 'AUTH:2FA_VERIFY'
  | 'AUTH:2FA_RESEND'
  // ── Meals ─────────────────────────────────────────────────────────────────
  | 'MEAL:GET'
  | 'MEAL:GET_DELETED'
  | 'MEAL:CREATE'
  | 'MEAL:UPDATE'
  | 'MEAL:DELETE'
  | 'MEAL:DELETE_PERMANENT'
  | 'MEAL:RESTORE'
  // ── Images ────────────────────────────────────────────────────────────────
  | 'IMAGE:UPLOAD'
  | 'PHOTO:GENERATE'
  | 'PHOTO:UPLOAD'
  // ── Creator ───────────────────────────────────────────────────────────────
  | 'CREATOR:APPLY'
  | 'CREATOR:EMAIL_ADMIN'
  | 'CREATOR:EMAIL_APPLICANT'
  | 'CREATOR:MEAL_CREATE'
  | 'CREATOR:MEAL_UPDATE'
  | 'CREATOR:MEAL_DELETE'
  // ── Payments ──────────────────────────────────────────────────────────────
  | 'PAYMENT:CHECKOUT'
  | 'PAYMENT:WEBHOOK'
  | 'PAYMENT:PORTAL'
  // ── Kroger ────────────────────────────────────────────────────────────────
  | 'KROGER:CALLBACK'
  | 'KROGER:DISCONNECT'
  | 'KROGER:ADD_TO_CART';

export type Status = 'success' | 'failed' | 'pending' | 'error';

export interface LogData {
  event:    EventType;
  status:   Status;
  email?:   string;
  userId?:  string;
  ip?:      string;
  /** Abbreviated user-agent string, e.g. "Chrome/122" or "Mealio-Extension/1.0" */
  ua?:      string;
  /** Short human-readable reason for a failure or contextual label for an event */
  reason?:  string;
  /** Actual Error / unknown thrown — message + first stack frame are extracted */
  error?:   unknown;
  /** Free-form extra context: webhook event name, resource id, HTTP status, etc. */
  detail?:  string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return email;
  return `${local[0]}***@${domain}`;
}

/** Shorten a raw User-Agent string to the most useful identifier. */
export function abbreviateUa(ua: string | null | undefined): string | undefined {
  if (!ua) return undefined;
  // Extension or custom client
  const ext = ua.match(/Mealio[^\s]*/i);
  if (ext) return ext[0];
  const edg = ua.match(/Edg\/([\d]+)/);
  if (edg) return `Edge/${edg[1]}`;
  const chrome = ua.match(/Chrome\/([\d]+)/);
  if (chrome) return `Chrome/${chrome[1]}`;
  const firefox = ua.match(/Firefox\/([\d]+)/);
  if (firefox) return `Firefox/${firefox[1]}`;
  if (ua.includes('Safari') && !ua.includes('Chrome')) {
    const safari = ua.match(/Version\/([\d]+)/);
    return safari ? `Safari/${safari[1]}` : 'Safari';
  }
  return ua.slice(0, 32);
}

/** Extract a concise error description from any thrown value. */
export function formatError(err: unknown): string {
  if (err instanceof Error) {
    const msg = err.message || err.name;
    const frame = err.stack?.split('\n').find(l => l.trim().startsWith('at '));
    return frame ? `${msg} · ${frame.trim()}` : msg;
  }
  // Supabase PostgrestError — plain object with message/code/details
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof e.message === 'string') parts.push(e.message);
    if (typeof e.code    === 'string') parts.push(`code=${e.code}`);
    if (typeof e.details === 'string') parts.push(e.details);
    if (typeof e.hint    === 'string') parts.push(`hint=${e.hint}`);
    if (parts.length) return parts.join(' | ');
  }
  return String(err);
}

// ── Core log function ───────────────────────────────────────────────────────

const ICONS: Record<Status, string> = {
  success: '✓',
  failed:  '✗',
  pending: '→',
  error:   '!',
};

export function log(data: LogData): void {
  const now    = new Date();
  const icon   = ICONS[data.status];
  const event  = data.event.padEnd(22);
  const status = data.status.padEnd(7);

  const email  = data.email  ? `  ${maskEmail(data.email)}` : '';
  const userId = data.userId && !data.email ? `  uid:${data.userId.slice(0, 8)}…` : '';
  const ip     = data.ip     ? `  ${data.ip}` : '';
  const ua     = data.ua     ? `  [${data.ua}]` : '';
  const reason = data.reason ? `  (${data.reason})` : '';
  const detail = data.detail ? `  {${data.detail}}` : '';
  const errStr = data.error  ? `  ERR: ${formatError(data.error)}` : '';

  const shortTs = now.toTimeString().slice(0, 8);
  const isoTs   = now.toISOString();
  const body    = `${event} ${icon} ${status}${email}${userId}${ip}${ua}${reason}${detail}${errStr}`;

  const consoleLine = `[${shortTs}] ${body}`;
  const fileLine    = `[${isoTs}] ${body}\n`;

  if (data.status === 'error') {
    console.error(consoleLine);
  } else if (data.status === 'failed') {
    console.warn(consoleLine);
  } else {
    console.log(consoleLine);
  }

  try {
    appendFileSync(LOG_FILE, fileLine);
  } catch {
    // ignore — read-only filesystem (e.g. Vercel), console output is sufficient
  }
}
