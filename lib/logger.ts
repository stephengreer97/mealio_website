import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const LOG_DIR  = join(process.cwd(), 'logs');
const LOG_FILE = join(LOG_DIR, 'mealio.log');

// Ensure logs/ directory exists at startup
mkdirSync(LOG_DIR, { recursive: true });

type EventType =
  | 'AUTH:LOGIN'
  | 'AUTH:REGISTER'
  | 'AUTH:POLL'
  | 'AUTH:REFRESH'
  | 'AUTH:VERIFY'
  | 'AUTH:VERIFY_EMAIL'
  | 'AUTH:RESEND'
  | 'AUTH:FORGOT_PASSWORD'
  | 'AUTH:RESET_PASSWORD';

type Status = 'success' | 'failed' | 'pending' | 'error';

interface LogData {
  event: EventType;
  status: Status;
  email?: string;
  userId?: string;
  ip?: string;
  reason?: string;
}

const ICONS: Record<Status, string> = {
  success: '✓',
  failed:  '✗',
  pending: '→',
  error:   '!',
};

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return email;
  return `${local[0]}***@${domain}`;
}

export function log(data: LogData): void {
  const now     = new Date();
  const icon    = ICONS[data.status];
  const event   = data.event.padEnd(14);
  const status  = data.status.padEnd(7);
  const email   = data.email  ? `  ${maskEmail(data.email)}` : '';
  const userId  = data.userId && !data.email ? `  uid:${data.userId.slice(0, 8)}…` : '';
  const ip      = data.ip     ? `  ${data.ip}` : '';
  const reason  = data.reason ? `  (${data.reason})` : '';

  // Console uses short HH:MM:SS; file uses full ISO timestamp
  const shortTs = now.toTimeString().slice(0, 8);
  const isoTs   = now.toISOString();
  const body    = `${event} ${icon} ${status}${email}${userId}${ip}${reason}`;

  const consoleLine = `[${shortTs}] ${body}`;
  const fileLine    = `[${isoTs}] ${body}\n`;

  if (data.status === 'error') {
    console.error(consoleLine);
  } else if (data.status === 'failed') {
    console.warn(consoleLine);
  } else {
    console.log(consoleLine);
  }

  appendFileSync(LOG_FILE, fileLine);
}
