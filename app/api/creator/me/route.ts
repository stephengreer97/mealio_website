import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';
import { getCachedTrendingMeals } from '@/lib/trending-cache';
import { log } from '@/lib/logger';
import { adminNotifyEmails, sendCreatorSourceMovedEmail } from '@/lib/email';
import { HANDLE_RE, RESERVED_HANDLES, normalizeHandle } from '@/lib/handles';
import {
  checkPollingInvariants,
  isConnectedPlatform,
  isPlatformSource,
  isPrimarySource,
  normalizePlatformUrl,
  SOURCE_COLUMNS,
  SOURCE_LABELS,
  type PlatformSource,
} from '@/lib/creator-sources';

/**
 * The columns a link edit has to see to judge the row it would leave behind.
 *
 * `display_name` and `handle` are not judged by anything — they name the creator
 * in the operator alert a moved polled link raises, and re-reading the row for
 * two strings after the write would be a second query for the same row.
 */
const LINK_FIELDS =
  'id, display_name, handle, website_url, youtube_url, instagram_url, tiktok_url, primary_source, import_opt_in, feed_url';

/**
 * The polled link a creator has just moved: which source, and where from and to.
 *
 * Carried out of `applyLinkEdits` because two things downstream need it — the
 * `import_opt_in` clear, and the operator alert that keeps that clear from being
 * silent. At most one can be set: `primary_source` names exactly one source.
 */
interface RepointedSource {
  source: PlatformSource;
  from: string;
  to: string;
}

/**
 * Applies a creator's edit to their four platform links (MEAL-94).
 *
 * Collected on the application form and copied onto the row at approval, and
 * until now unchangeable afterwards — so a creator who started a YouTube channel
 * six months later could not tell us, which silently blocked connecting it, the
 * append setting (MEAL-78), a `primary_source` switch and back-catalog import.
 *
 * Validated with `normalizePlatformUrl`, the application form's own function, so
 * the two cannot drift into accepting different things. Per-key rather than all
 * four at once: a request that mentions one link must not clear the other three.
 */
function applyLinkEdits(
  creator: Record<string, any>,
  links: Record<string, unknown>,
):
  | { ok: true; update: Record<string, string | null>; cleared: PlatformSource[]; repointed: RepointedSource | null }
  | { ok: false; error: string } {
  const update: Record<string, string | null> = {};
  const cleared: PlatformSource[] = [];
  const touched: PlatformSource[] = [];

  for (const [key, raw] of Object.entries(links)) {
    if (!isPlatformSource(key)) {
      return { ok: false, error: `"${key}" is not one of website, youtube, instagram or tiktok.` };
    }
    const result = normalizePlatformUrl(key, raw);
    if (!result.ok) {
      return { ok: false, error: `${SOURCE_LABELS[key]}: ${result.error}` };
    }
    const column = SOURCE_COLUMNS[key];
    if ((creator[column] ?? null) === result.url) continue;
    update[column] = result.url;
    if (!result.url) cleared.push(key);
    // What the link *means*, against the stored value read the same way. A row
    // written before this validator existed can hold `chefsarah.com` where the
    // card now sends `https://chefsarah.com/`: the same place, and rewriting it
    // is a tidy-up rather than a repointing. Refusing that as a repointing would
    // lock such a creator out of editing any of their links.
    const stored = normalizePlatformUrl(key, creator[column] ?? undefined);
    if ((stored.ok ? stored.url : (creator[column] ?? null)) !== result.url) touched.push(key);
  }

  // Adding a link tells us a place exists. It does not opt the creator into
  // anything: which source is polled, and whether it is polled at all, stay an
  // operator decision (MEAL-81), so nothing here writes `primary_source` or
  // `import_opt_in`. The one edit that touches polling reports it back for the
  // caller to act on — and only ever to turn it off.
  const primarySource = isPrimarySource(creator.primary_source) ? creator.primary_source : 'none';
  let repointed: RepointedSource | null = null;
  for (const source of touched) {
    if (creator.import_opt_in !== true || primarySource !== source) continue;

    // Moving the polled link is allowed, and clears the opt-in with it.
    //
    // The risk is real and unchanged: for a source read straight off the link
    // (`primary_source` of 'youtube' with no OAuth grant, where
    // `channelIdForCreator` resolves the channel from `youtube_url`) a
    // replacement *is* a change of what gets read, so this edit can point an
    // actively-polled source at a stranger's channel and have their uploads
    // published under this creator's name. Operator review of the drafts is
    // mediation, not prevention: the videos really are from the channel the row
    // now names.
    //
    // Refusing it was the first answer and it cost more than it bought. A
    // creator who moves their blog or renames their channel — not a rare event,
    // and an entirely legitimate one — could not tell us at all without a human
    // editing the row by hand, which is the manual step MEAL-81 argued against.
    // Clearing `import_opt_in` stops the substitution just as completely, since
    // nothing is polled until an operator turns it back on, and leaves the
    // creator unblocked. The objection to it was that a creator's edit reverses
    // an operator's decision with nobody told; that is answered by the alert the
    // route raises, not by this line, so the two belong together.
    if (update[SOURCE_COLUMNS[source]]) {
      repointed = {
        source,
        from: String(creator[SOURCE_COLUMNS[source]] ?? ''),
        to: update[SOURCE_COLUMNS[source]] as string,
      };
      continue;
    }

    // Removing it is still refused. A creator who has moved sends the new link;
    // one who wants to stop being imported is asking for the operator's switch,
    // which they have to ask for anyway. Neither is served by letting the row
    // arrive at "polling a source with no link" — the state every rule here
    // exists to keep out — and unlike a move there is no legitimate case behind
    // it that has no other route.
    return {
      ok: false,
      error:
        `Mealio is currently importing your recipes from your ${SOURCE_LABELS[source]}, so that link can't be ` +
        `removed here — it is the one we read your recipes from. Change it to your new ${SOURCE_LABELS[source]} ` +
        "link if you have moved, or ask us to stop importing first.",
    };
  }

  return { ok: true, update, cleared, repointed };
}

/**
 * What a creator has to be told about a link they just cleared.
 *
 * Removing an Instagram URL does not revoke the Instagram grant — the grant is a
 * separate record, made on a separate screen, and the sync reads a connected
 * channel whether or not a link sits on the row. Saying nothing would leave a
 * creator believing they had disconnected something they had not, which is the
 * kind of thing nobody goes back to check.
 */
async function grantNotices(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  creatorId: string,
  cleared: PlatformSource[],
): Promise<string[]> {
  const connectable = cleared.filter(isConnectedPlatform);
  if (connectable.length === 0) return [];

  const { data } = await supabase
    .from('creator_platform_accounts')
    .select('platform')
    .eq('creator_id', creatorId);

  const connected = new Set(((data ?? []) as Array<{ platform: string }>).map((row) => row.platform));
  return connectable
    .filter((platform) => connected.has(platform))
    .map(
      (platform) =>
        `Your connected ${SOURCE_LABELS[platform]} account is still connected — removing the link here does not ` +
        `disconnect it, and Mealio can still read what you allowed it to. Disconnect it from the ` +
        `${SOURCE_LABELS[platform]} card if that is what you meant.`,
    );
}

// PATCH /api/creator/me — update creator profile fields
export async function PATCH(request: NextRequest) {
  const token = extractTokenFromHeader(request.headers.get('authorization'));
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const decoded = await verifyAccessToken(token);
  if (!decoded) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createServerSupabaseClient();
  const body = await request.json();
  const { photoUrl, handle, bio, socialHandle, links } = body;

  const updates: Record<string, unknown> = {};
  const notices: string[] = [];
  /** Set when a moved polled link paused the import — the operator alert's input. */
  let repointed: RepointedSource | null = null;
  /** Creator identity for that alert, read with the link columns. */
  let creatorIdentity: { display_name?: unknown; handle?: unknown } = {};

  if (links !== undefined) {
    if (typeof links !== 'object' || links === null || Array.isArray(links)) {
      return NextResponse.json({ error: 'links must be an object keyed by platform.' }, { status: 400 });
    }
    const { data: creator } = await supabase
      .from('creators')
      .select(LINK_FIELDS)
      .eq('user_id', decoded.userId)
      .maybeSingle();
    if (!creator) {
      return NextResponse.json({ error: 'Only approved creators have links to edit.' }, { status: 403 });
    }

    const edit = applyLinkEdits(creator as Record<string, any>, links as Record<string, unknown>);
    if (!edit.ok) {
      return NextResponse.json({ error: edit.error }, { status: 400 });
    }

    repointed = edit.repointed;
    creatorIdentity = creator as { display_name?: unknown; handle?: unknown };

    // The backstop, on the row this write would leave behind and through the
    // same function the admin source picker uses. `applyLinkEdits` already
    // handles the two cases a creator can actually reach — a moved polled link
    // and a removed one — each with a sentence written for them; this catches
    // every combination neither of us thought of, including rows an operator
    // left in a state no UI can produce.
    //
    // Its verdict stops the polling rather than the edit. The wording is the
    // operator's — "confirm the discovered feed URL" names a screen the creator
    // cannot open — and a 400 would hard-block them from touching *any* of their
    // links until somebody repaired a row they did not break. A row that cannot
    // be polled coherently should not be polled, so the switch goes off and the
    // creator is told plainly; the operator's own route still refuses to turn it
    // back on until the row makes sense.
    //
    // Two reasons now write this switch and both write it the same way. A moved
    // polled link is the second: the row it leaves behind can be perfectly
    // coherent — the same source, a link that is present and on the right host —
    // so no invariant catches it, and pausing is a decision about *who* changed
    // it rather than about the row. It still may only ever write `false`:
    // nothing a creator sends can start polling.
    const resulting = { ...(creator as Record<string, unknown>), ...edit.update };
    const verdict = checkPollingInvariants(resulting);
    const importOptIn = verdict.ok && !edit.repointed ? verdict.importOptIn : false;
    if (importOptIn !== (resulting.import_opt_in === true)) {
      updates.import_opt_in = importOptIn;
      if (edit.repointed) {
        // Said in the same response as the save, because the alternative is a
        // creator discovering it by noticing nothing arrives. It also says what
        // they do not have to do: the pause is ours to lift, not theirs.
        notices.push(
          `Your ${SOURCE_LABELS[edit.repointed.source]} link is saved. Mealio was importing your recipes from it, ` +
            'so we have paused that import until someone here has checked the new link — nothing is read from it ' +
            'in the meantime. Somebody has been told; there is nothing else for you to do.',
        );
      } else if (!verdict.ok) {
        notices.push(
          "We've paused importing your recipes automatically. The import settings on your account no longer add " +
            "up, and we'd rather stop than publish the wrong thing under your name — get in touch and we'll sort " +
            'it out.',
        );
      }
    }

    Object.assign(updates, edit.update);
    notices.push(...(await grantNotices(supabase, (creator as { id: string }).id, edit.cleared)));
  }

  if (photoUrl !== undefined) updates.photo_url = photoUrl ?? null;
  if (bio !== undefined) updates.bio = typeof bio === 'string' ? (bio.trim() || null) : null;
  if (socialHandle !== undefined) updates.social_handle = typeof socialHandle === 'string' ? (socialHandle.trim() || null) : null;

  if (handle !== undefined) {
    const h = normalizeHandle(handle);
    // Handles are permanent once set. Blank input is ignored (a handle can't be cleared).
    if (h !== '') {
      if (!HANDLE_RE.test(h)) {
        return NextResponse.json(
          { error: 'Handle must be 3–30 characters and contain only letters, numbers, hyphens, or underscores.' },
          { status: 400 }
        );
      }
      if (RESERVED_HANDLES.has(h)) {
        return NextResponse.json({ error: 'That handle is not available.' }, { status: 400 });
      }
      // Immutable: only settable when the creator has no handle yet (covers legacy
      // creators from before handles were chosen at application time).
      const { data: self } = await supabase
        .from('creators')
        .select('handle')
        .eq('user_id', decoded.userId)
        .maybeSingle();
      if (self?.handle && self.handle !== h) {
        return NextResponse.json({ error: "Your handle is permanent and can't be changed." }, { status: 400 });
      }
      if (!self?.handle) {
        // Uniqueness check before the one-time set (exclude self).
        const { data: existing } = await supabase
          .from('creators')
          .select('id')
          .eq('handle', h)
          .neq('user_id', decoded.userId)
          .maybeSingle();
        if (existing) {
          return NextResponse.json({ error: 'That handle is already taken.' }, { status: 409 });
        }
        updates.handle = h;
      }
    }
  }

  // Whether this request turned polling off, as a fact rather than as prose the
  // client would have to match a string against. The card shows "Mealio is
  // importing your recipes from your X" off its own copy of the row, which this
  // write has just invalidated — without this it would keep saying so beside a
  // notice saying the opposite.
  const importPaused = updates.import_opt_in === false;

  if (Object.keys(updates).length === 0) return NextResponse.json({ ok: true, notices, importPaused: false });

  const { error } = await supabase
    .from('creators')
    .update(updates)
    .eq('user_id', decoded.userId);

  if (error) {
    log({ event: 'CREATOR:PROFILE_UPDATE', status: 'error', userId: decoded.userId, email: decoded.email, error });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  log({ event: 'CREATOR:PROFILE_UPDATE', status: 'success', userId: decoded.userId, email: decoded.email, detail: Object.keys(updates).join(',') });

  // The operator half of a moved polled link, raised only once the write it
  // describes has actually landed. An operator's decision has just been reversed
  // by somebody else's request, and this is what keeps that from being something
  // they find out weeks later because a creator's imports stopped. Same reason
  // the token sweep writes `broken_reason` rather than logging a refresh
  // failure: a poller that finds nothing must never be the first sign.
  //
  // After the response has been decided, and swallowed like the application
  // alert: a creator's save must not fail because Resend is down. The log line
  // is the fallback, not the signal.
  if (repointed) {
    await sendCreatorSourceMovedEmail({
      adminEmails: await adminNotifyEmails(supabase),
      creatorName: typeof creatorIdentity.display_name === 'string' ? creatorIdentity.display_name : 'A creator',
      handle: typeof creatorIdentity.handle === 'string' ? creatorIdentity.handle : null,
      sourceLabel: SOURCE_LABELS[repointed.source],
      previousUrl: repointed.from,
      newUrl: repointed.to,
    }).catch((err) =>
      log({ event: 'CREATOR:SOURCE_MOVED_ALERT', status: 'error', userId: decoded.userId, error: err?.message }),
    );
  }

  return NextResponse.json({ ok: true, notices, importPaused });
}

// GET /api/creator/me — creator profile + their meals with save stats
export async function GET(request: NextRequest) {
  const token = extractTokenFromHeader(request.headers.get('authorization'));
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const decoded = await verifyAccessToken(token);
  if (!decoded) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createServerSupabaseClient();

  // Get creator profile
  const { data: creator, error: creatorError } = await supabase
    .from('creators')
    // The four links, and the polling settings that decide what the link editor
    // is allowed to say about them: a creator whose website is being polled has
    // to be told so *before* they try to clear it, not only when it is refused.
    .select('id, display_name, bio, social_handle, photo_url, approved_at, handle, website_url, youtube_url, instagram_url, tiktok_url, primary_source, import_opt_in')
    .eq('user_id', decoded.userId)
    .maybeSingle();

  if (creatorError) {
    return NextResponse.json({ error: creatorError.message }, { status: 500 });
  }

  if (!creator) {
    // Check for pending application
    const { data: application } = await supabase
      .from('creator_applications')
      .select('status, created_at')
      .eq('user_id', decoded.userId)
      .maybeSingle();

    return NextResponse.json({ creator: null, application: application ?? null });
  }

  // Get their meals — direct query for full editable fields + cached RPC for trending score
  const [{ data: myMealsRaw }, allMealsRpc] = await Promise.all([
    supabase
      .from('preset_meals')
      .select('id, name, photo_url, difficulty, ingredients, recipe, source, story, tags')
      .eq('creator_id', creator.id)
      .order('created_at', { ascending: false }),
    getCachedTrendingMeals().catch(() => []),
  ]);

  const allScores = allMealsRpc;
  const rawScores = allScores.map(m => Number(m.trending_score));
  const minScore = rawScores.length > 0 ? Math.min(...rawScores) : 0;
  const maxScore = rawScores.length > 0 ? Math.max(...rawScores) : 1;
  const scoreRange = maxScore - minScore || 1;
  const normalize = (raw: number) => Math.round(1 + ((raw - minScore) / scoreRange) * 99);

  const trendingMap = new Map(allScores.map(m => [m.id, m.trending_score]));

  const mealIds = (myMealsRaw ?? []).map((m: { id: string }) => m.id);

  // Rolling 12-month (annual) window — profit share is based entirely on saves in the last 365 days.
  const annualStart = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const safeMealIds = mealIds.length > 0 ? mealIds : ['00000000-0000-0000-0000-000000000000'];

  // Creator's own saves (aggregate + per-meal)
  const [
    { count: saves30d },
    { count: savesAnnual },
    { count: savesAll },
    { data: perMealSavesRaw },
  ] = await Promise.all([
    supabase.from('preset_meal_saves').select('id', { count: 'exact', head: true })
      .in('preset_meal_id', safeMealIds).gte('saved_at', thirtyDaysAgo),
    supabase.from('preset_meal_saves').select('id', { count: 'exact', head: true })
      .in('preset_meal_id', safeMealIds).gte('saved_at', annualStart),
    supabase.from('preset_meal_saves').select('id', { count: 'exact', head: true })
      .in('preset_meal_id', safeMealIds),
    supabase.from('preset_meal_saves').select('preset_meal_id')
      .in('preset_meal_id', safeMealIds),
  ]);

  // Count saves per meal
  const perMealSavesMap = new Map<string, number>();
  for (const row of (perMealSavesRaw ?? [])) {
    const id = (row as { preset_meal_id: string }).preset_meal_id;
    perMealSavesMap.set(id, (perMealSavesMap.get(id) ?? 0) + 1);
  }

  const myMeals = (myMealsRaw ?? []).map(m => ({
    ...m,
    trending_score: normalize(trendingMap.get(m.id) ?? minScore),
    saves_all: perMealSavesMap.get(m.id) ?? 0,
  })).sort((a, b) => b.trending_score - a.trending_score);

  // Platform total for creator meals in the rolling 12-month window (denominator for revenue share) + follower count
  const [
    { count: totalCreatorAnnualSaves },
    { count: followerCount },
  ] = await Promise.all([
    supabase.from('preset_meal_saves')
      .select('id, preset_meals!preset_meal_id!inner(creator_id)', { count: 'exact', head: true })
      .gte('saved_at', annualStart)
      .not('preset_meals.creator_id', 'is', null),
    supabase.from('creator_follows')
      .select('id', { count: 'exact', head: true })
      .eq('creator_id', creator.id),
  ]);

  const creatorAnnualSaves = savesAnnual ?? 0;
  const creatorAlltimeSaves = savesAll ?? 0;
  const totalAnnual = totalCreatorAnnualSaves ?? 0;

  // Profit share = creator's saves in the last 365 days ÷ all creators' saves in the last 365 days.
  const annualPct = totalAnnual > 0 ? (creatorAnnualSaves / totalAnnual * 100) : 0;
  const sharePercent = annualPct;

  return NextResponse.json({
    creator,
    meals: myMeals,
    stats: {
      followers:                followerCount ?? 0,
      savesAnnual:              creatorAnnualSaves,
      savesAll:                 creatorAlltimeSaves,
      totalCreatorAnnualSaves:  totalAnnual,
      annualPct,
      sharePercent,
    },
  });
}
