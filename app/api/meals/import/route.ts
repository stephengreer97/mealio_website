import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';
import { log } from '@/lib/logger';
import { PASTED_TEXT_MAX, PASTED_TEXT_MIN, pastedDocument, runImport } from '@/lib/import/pipeline';
import { importLogSink } from '@/lib/import/import-log';
import { formatTelemetry } from '@/lib/import/telemetry';
import { createPhotoResolver } from '@/lib/import/photo';
import { urlSpellings } from '@/lib/import/ssrf';
import { checkUserImportAllowance } from '@/lib/import/user-budget';

/**
 * POST /api/meals/import — a user fills their Create Meal form from a recipe
 * link or from pasted recipe text.
 *
 * Request: `{ url }` or `{ text }`, plus `ignoreCreatorMatch` / `ignoreDuplicate`
 * once the user has seen and dismissed those prompts.
 *
 * Responses, by `status`:
 *   200 `ok`               the pipeline's ImportSuccess, plus `freeImportsLeft`
 *   422 `rejected`         the pipeline's ImportRejection, plus `suggestPaste`
 *   409 `creator-match`    the link is a recipe a Mealio creator published
 *   409 `duplicate`        the user already has a meal from this link
 *   402 `upgrade-required` a free user who has used their one import
 *   429 `limit`            Full Access over the monthly or daily cap
 *
 * Nothing is saved. The draft fills the form, and the user saves it through
 * `POST /api/meals` like any other meal, after picking a store.
 */

// Fetch, gate and extraction run in series; the default 10s is not enough.
export const maxDuration = 60;

/** Rejections where pasting the recipe text would get round what stopped us. */
const PASTE_HELPS = new Set(['fetch', 'robots']);

export async function POST(request: NextRequest) {
  const token = extractTokenFromHeader(request.headers.get('authorization'));
  const decoded = token ? await verifyAccessToken(token) : null;
  if (!decoded) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = decoded.userId;

  let body: { url?: unknown; text?: unknown; ignoreCreatorMatch?: unknown; ignoreDuplicate?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const url = typeof body.url === 'string' ? body.url.trim() : '';
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (Boolean(url) === Boolean(text)) {
    return NextResponse.json({ error: 'Send either a link or the recipe text.' }, { status: 400 });
  }
  if (text && text.length > PASTED_TEXT_MAX) {
    return NextResponse.json(
      { error: `That is ${text.length.toLocaleString('en-US')} characters. Paste at most ${PASTED_TEXT_MAX.toLocaleString('en-US')}.` },
      { status: 400 },
    );
  }
  if (text && text.length < PASTED_TEXT_MIN) {
    return NextResponse.json({ error: 'That is too short to be a recipe. Paste the ingredients and the method.' }, { status: 400 });
  }

  const supabase = createServerSupabaseClient();

  // Before any check that costs money, and before the prompts below: a free
  // user who has used their import should see the upgrade, not a duplicate
  // warning for a link they cannot import anyway.
  const allowance = await checkUserImportAllowance(supabase, userId);
  if (!allowance.ok) {
    return NextResponse.json(
      { status: allowance.reason, error: allowance.error },
      { status: allowance.reason === 'upgrade-required' ? 402 : 429 },
    );
  }

  if (url) {
    const spellings = urlSpellings(url);

    // A creator's own recipe. Saving their version is what counts toward their
    // profit share; a private copy of their blog post counts for nothing.
    if (spellings.length > 0 && body.ignoreCreatorMatch !== true) {
      const { data: preset } = await supabase
        .from('preset_meals')
        .select('id, name, creators!creator_id ( display_name )')
        .in('source', spellings)
        .not('creator_id', 'is', null)
        .limit(1)
        .maybeSingle();
      if (preset) {
        const row = preset as { id: string; name: string; creators?: { display_name?: string } | null };
        return NextResponse.json(
          {
            status: 'creator-match',
            meal: { id: row.id, name: row.name, creatorName: row.creators?.display_name ?? null },
          },
          { status: 409 },
        );
      }
    }

    if (spellings.length > 0 && body.ignoreDuplicate !== true) {
      const { data: existing } = await supabase
        .from('meals')
        .select('id, name')
        .eq('user_id', userId)
        .eq('is_active', true)
        .in('website', spellings)
        .limit(1)
        .maybeSingle();
      if (existing) {
        return NextResponse.json({ status: 'duplicate', meal: existing }, { status: 409 });
      }
    }
  }

  const result = await runImport(url, {
    mode: 'manual',
    ...(text ? { document: pastedDocument(text), pasted: true } : {}),
    // Someone else's recipe going into a private meal: keep the link, use a
    // stock photo, never copy the blogger's image into our storage.
    resolvePhoto: createPhotoResolver(userId, {}, { copySource: false }),
    // The cache is keyed on the URL and shared with creator imports, whose
    // cached draft carries the page's copied image. A user re-importing the same
    // link is rare enough to pay for twice.
    skipCache: true,
    telemetry: importLogSink({ actor: 'user', userId }, (event) =>
      log({
        event: 'MEAL:IMPORT',
        status: event.outcome === 'ok' ? 'success' : 'error',
        userId,
        detail: `${text ? 'pasted ' : ''}${formatTelemetry(event)}`,
      }),
    ),
  });

  if (result.status === 'ok') {
    // A rejection does not spend the free import, so the count only moves here.
    const freeImportsLeft = allowance.freeImportsLeft == null ? null : Math.max(0, allowance.freeImportsLeft - 1);
    return NextResponse.json({ ...result, freeImportsLeft });
  }
  return NextResponse.json({ ...result, suggestPaste: Boolean(url) && PASTE_HELPS.has(result.stage) }, { status: 422 });
}
