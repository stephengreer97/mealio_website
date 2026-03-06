import { randomInt, createHash } from 'crypto';

export function generateOtp(): string {
  return String(randomInt(100000, 999999));
}

export function hashOtp(code: string): string {
  return createHash('sha256').update(code.trim()).digest('hex');
}
