import { NextResponse } from 'next/server';
import { readBroadcasts } from '@/lib/broadcasts';

// GET /api/broadcast — public. Returns all active broadcasts. Each carries a
// store list (empty = everyone), a forceShow flag, and an id the client keys
// dismissal off of. Targeting is enforced client-side in the mobile app.
export async function GET() {
  const broadcasts = (await readBroadcasts()).filter((b) => b.message.trim());
  return NextResponse.json({ broadcasts });
}
