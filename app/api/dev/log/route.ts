import { NextRequest, NextResponse } from 'next/server';
import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';

// Dev-only endpoint — the extension posts console output here so it can be
// read from the WSL filesystem without opening DevTools.
// Automatically disabled in production.

const LOG_FILE = join(process.cwd(), 'logs', 'browser.log');

export async function POST(request: NextRequest) {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'Not available' }, { status: 404 });
  }

  try {
    const { source, level, args } = await request.json();
    const ts = new Date().toISOString();
    const message = args
      .map((a: unknown) => {
        try {
          return typeof a === 'object' ? JSON.stringify(a) : String(a);
        } catch {
          return '[unserializable]';
        }
      })
      .join(' ');

    mkdirSync(join(process.cwd(), 'logs'), { recursive: true });
    appendFileSync(LOG_FILE, `[${ts}] [${source}] [${level.toUpperCase()}] ${message}\n`);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  }
}
