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
  | 'AUTH:LOGOUT_ALL'
  | 'AUTH:REGISTER'
  | 'AUTH:REFRESH'          // refresh token rotation
  | 'AUTH:RENEW'            // access token renewal (mobile keep-alive)
  | 'AUTH:VERIFY'           // verify endpoint (token validation)
  | 'AUTH:VERIFY_EMAIL'     // email verification link click
  | 'AUTH:RESEND'           // resend verification email
  | 'AUTH:FORGOT_PASSWORD'
  | 'AUTH:RESET_PASSWORD'
  | 'AUTH:SESSION_STATUS'   // lightweight token health check
  | 'AUTH:2FA_SENT'
  | 'AUTH:2FA_VERIFY'
  | 'AUTH:2FA_RESEND'
  | 'AUTH:2FA_EXEMPT'       // MFA_EXEMPT_EMAILS allowlist skipped the 2FA gate
  | 'AUTH:OAUTH_GOOGLE'
  | 'AUTH:OAUTH_APPLE'
  // ── Meals ─────────────────────────────────────────────────────────────────
  | 'MEAL:GET'
  | 'MEAL:GET_DELETED'
  | 'MEAL:CREATE'
  | 'MEAL:UPDATE'
  | 'MEAL:DELETE'
  | 'MEAL:DELETE_PERMANENT'
  | 'MEAL:RESTORE'
  | 'MEAL:SAVE_PRESET'
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
  | 'CREATOR:MEAL_IMPORT'    // paste-a-link import pipeline (MEAL-67)
  | 'CREATOR:PROFILE_UPDATE'
  | 'CREATOR:FOLLOW'
  // Connecting a publishing account by OAuth (MEAL-74, and MEAL-82/83 after it).
  | 'CREATOR:SOURCE_CONNECT'
  | 'CREATOR:SOURCE_DISCONNECT'
  | 'CREATOR:SOURCE_WITHDRAW'
  // A declined draft's post moved off `imported`, so the catalogue offers it
  // back instead of showing a meal that does not exist (MEAL-99). The pair of
  // this and `ADMIN:SOURCE_REJECT` is the same event with different actors —
  // who changed their mind about a post is the whole reason it is recorded.
  | 'CREATOR:SOURCE_REJECT'
  // A creator moved the link we were polling, so `import_opt_in` was cleared and
  // an operator was emailed about it (MEAL-94). Logged only when that email
  // fails — the email is the signal, this is the record that it did not arrive.
  | 'CREATOR:SOURCE_MOVED_ALERT'
  // A creator saved a website and we ran the full viability check on it
  // (MEAL-101). Logged either way: a refusal is the interesting one, because the
  // creator is told a sentence and this is the only record of what produced it.
  | 'CREATOR:SOURCE_CHECK'
  // A creator importing their own back catalogue off the checklist (MEAL-101).
  // The admin equivalent is `ADMIN:SYNC_RUN`; kept apart so "who started this"
  // is answerable from the log line rather than from the run row.
  | 'CREATOR:SYNC_RUN'
  // Consent to let Mealio edit the creator's own YouTube descriptions. Separate
  // from `import_opt_in` on purpose: reading and writing are different
  // permissions over different property (MEAL-77).
  | 'CREATOR:APPEND_OPT_IN'
  // A creator approving, editing or declining a draft in their own review queue
  // (MEAL-89). Distinct from the ADMIN:DRAFT_* events even though both reach the
  // same functions in `lib/import-drafts.ts`: MEAL-77's consent story turns on
  // who decided, and an operator publishing under a creator's name and that
  // creator publishing their own recipe must not read identically in the log.
  | 'CREATOR:DRAFT_DECIDE'
  | 'CREATOR:DRAFT_EDIT'
  // ── Payments ──────────────────────────────────────────────────────────────
  | 'PAYMENT:CHECKOUT'
  | 'PAYMENT:WEBHOOK'
  | 'PAYMENT:PORTAL'
  | 'PAYMENT:RC_WEBHOOK'
  // ── Kroger ────────────────────────────────────────────────────────────────
  | 'KROGER:CALLBACK'
  | 'KROGER:DISCONNECT'
  | 'KROGER:SEARCH_PRODUCTS'
  | 'KROGER:ADD_TO_CART'
  | 'KROGER:SET_LOCATION'
  // ── Admin ─────────────────────────────────────────────────────────────────
  | 'ADMIN:APPLICATION_REVIEW'
  | 'ADMIN:APPLICATION_EMAIL'   // telling the applicant; the decision is already written
  | 'ADMIN:MEAL_DELETE'
  | 'ADMIN:BROADCAST'
  | 'ADMIN:CREATOR_SOURCE'      // which of a creator's links we poll (MEAL-81)
  | 'ADMIN:CREATOR_VIABILITY'   // the onboarding importability measurement (MEAL-81)
  | 'ADMIN:AUTOMATION_CONFIG'   // publish / roll back the remote store config
  | 'ADMIN:AUTOMATION_FUNNEL'   // per-store add-to-cart reliability dashboard
  // The per-run drilldown behind that dashboard (MEAL-143). Two events, because
  // they fail for different reasons and only one of them means a lost trace:
  // listing recent failing runs is a picker that can be retried, while a trace
  // read that could not be completed is the case where someone is looking at a
  // prefix of a run.
  | 'ADMIN:AUTOMATION_RUNS'
  | 'ADMIN:AUTOMATION_RUN_TRACE'
  | 'ADMIN:STATS'               // logged only when an aggregate read came back short (MEAL-127)
  | 'ADMIN:EMAIL_STATS'         // only ever logged when the funnel read came back short
  // Listing creators for the Sources tab. Kept apart from ADMIN:CREATOR_SOURCE so
  // that event stays a record of what an operator CHANGED — this one is only ever
  // written when a read came back short (MEAL-112), and mixing the two would put
  // read failures in the middle of the audit trail for source decisions.
  | 'ADMIN:CREATOR_LIST'
  // Same idea as ADMIN:CREATOR_LIST and separate from ADMIN:APPLICATION_REVIEW
  // for the same reason: this is only ever written when the application list came
  // back short (MEAL-135), and a read failure is not a review decision.
  | 'ADMIN:APPLICATION_LIST'
  | 'ADMIN:SYNC_RUN'            // an operator-triggered sync run (MEAL-90)
  | 'ADMIN:SYNC_ITEM'           // one item inside a run: recorded, or retried
  // The four decisions in the admin review queue (MEAL-91). Every publish under
  // a creator's name now has one of these lines behind it, with the actor on it.
  | 'ADMIN:DRAFT_APPROVE'
  | 'ADMIN:DRAFT_HANDOFF'       // handed to the creator to decide instead
  | 'ADMIN:DRAFT_RECLAIM'       // and taken back, so a handoff is never one-way
  | 'ADMIN:DRAFT_EDIT'
  | 'ADMIN:DRAFT_CANCEL'        // declined; the row is marked, never removed
  | 'ADMIN:SOURCE_REJECT'       // and its post is offerable again (MEAL-99)
  | 'ADMIN:DRAFT_NOTIFY'        // the "these are live now" email to the creator
  // Writing the Mealio link into a creator's own video description (MEAL-79).
  // The only event in this file that records us editing somebody else's
  // property, so it carries the actor, the creator, the video and whether
  // anything was actually written.
  | 'ADMIN:YOUTUBE_APPEND'
  // The same edit, made because a CREATOR approved their own recipe rather than
  // because an operator pressed a button. Separate name for the reason the
  // decide events are separate: MEAL-77's consent story turns on who acted, and
  // this is the one event in the file that records editing somebody's property.
  | 'CREATOR:YOUTUBE_APPEND'
  // ── Account ───────────────────────────────────────────────────────────────
  | 'ACCOUNT:CHANGE_PASSWORD'
  | 'ACCOUNT:DELETE'
  // ── Client ────────────────────────────────────────────────────────────────
  | 'CLIENT:ERROR'
  | 'BUG_REPORT'
  // ── Email (marketing / lifecycle) ──────────────────────────────────────────
  | 'EMAIL:MARKETING_SENT'
  | 'EMAIL:SUPPRESSED'
  | 'EMAIL:UNSUBSCRIBE'
  | 'EMAIL:WEBHOOK'
  // ── Push (MEAL-88) ────────────────────────────────────────────────────────
  | 'PUSH:REGISTER'
  | 'PUSH:UNREGISTER'
  | 'PUSH:SEND'
  | 'PUSH:RECEIPTS'         // deferred delivery-receipt sweep
  | 'PUSH:REVOKE'           // token pruned (DeviceNotRegistered)
  // ── Cron ──────────────────────────────────────────────────────────────────
  | 'CRON:DAILY'
  | 'CRON:TOKEN_REFRESH'      // the shared platform-grant refresh sweep (MEAL-74)
  | 'CRON:PUSH_RECEIPTS'      // second, offset receipt sweep
  | 'CRON:POLL'               // one pass of the creator feed poller (MEAL-75)
  // One creator's source, per pass. At `error` for the two things that are
  // signals rather than failures: a source that used to work and has started
  // refusing us, and more new items in one poll than a creator could publish.
  | 'POLL:SOURCE'
  | 'POLL:NOTIFY'             // the "these drafts are waiting" email (MEAL-76)
  // The operator digest about sources that have gone unhealthy (MEAL-109).
  // Logged only when it does not happen — a send that failed, an alert with
  // nobody to address it, or a mark that did not stick. The email is the signal;
  // the counts a successful sweep produces ride out on CRON:DAILY.
  | 'POLL:HEALTH_ALERT'
  // The operator digest about stores whose cart automation has regressed
  // (MEAL-6). Same discipline as POLL:HEALTH_ALERT: logged only when the alert
  // does NOT happen — a refused send, nobody to address it, a mark that did not
  // stick, or a window too large to read in full. The counts a successful sweep
  // produces ride out on CRON:DAILY.
  | 'CRON:FUNNEL_ALERT'
  // ── Storage ───────────────────────────────────────────────────────────────
  | 'STORAGE:CLEANUP'
  | 'STORAGE:BACKFILL'
  | 'USAGE:OPEN'
  | 'USAGE:AUTOMATION'
  | 'USAGE:AUTOMATION_STEPS'    // per-step funnel telemetry ingest
  | 'AUTOMATION:CONFIG'         // client fetching the remote store config
  // ── Stores ────────────────────────────────────────────────────────────────
  | 'STORES:CATALOG';           // client fetching the store catalog (MEAL-23)

export type Status = 'success' | 'failed' | 'pending' | 'error';

export interface LogData {
  event:    EventType;
  status:   Status;
  email?:   string;
  userId?:  string;
  ip?:      string;
  /** Abbreviated user-agent string, e.g. "Chrome/122" or "Mealio-App/1.0" */
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
  // Mealio app or other custom client
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
