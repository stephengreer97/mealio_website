import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { requireAuth } from '@/lib/requireAuth';
import { log } from '@/lib/logger';
import { deleteConnection, describeConnection, loadConnection } from '@/lib/platform-tokens';
import { grantCanReadCaptions, YOUTUBE_FORCE_SSL_SCOPE } from '@/lib/youtube';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The creator's own view of their YouTube connection (MEAL-74).
 *
 * GET    — is a channel connected, which one, and is the append consent on.
 * PATCH  — turn the append consent on or off. One click, either direction.
 * DELETE — disconnect the channel.
 *
 * `youtube_append_opt_in` is exposed and edited here, but it is not *enforced*
 * here: `assertAppendAllowed` in `lib/youtube.ts` is the single gate every
 * append endpoint must go through (MEAL-78 / MEAL-79). A flag whose enforcement
 * lives in the screen that sets it is a flag a different client can ignore.
 *
 * Nothing on any of these paths returns a token. `describeConnection` is the
 * only projection allowed out of this module's data.
 */

const CREATOR_FIELDS = 'id, youtube_url, youtube_append_opt_in';

async function loadCreator(supabase: SupabaseClient, userId: string) {
  const { data } = await supabase.from('creators').select(CREATOR_FIELDS).eq('user_id', userId).maybeSingle();
  return (data as Record<string, any> | null) ?? null;
}

export async function GET(request: NextRequest) {
  const user = await requireAuth(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createServerSupabaseClient();
  const creator = await loadCreator(supabase, user.userId);
  if (!creator) return NextResponse.json({ error: 'Not a creator' }, { status: 403 });

  const connection = await loadConnection(supabase, creator.id, 'youtube');
  const summary = connection ? describeConnection(connection) : null;

  return NextResponse.json({
    /**
     * Does this creator have a YouTube channel at all? (MEAL-78)
     *
     * A grant, or a link they gave us saying one exists. False means the whole
     * card — the connect button and the append consent with it — is hidden
     * rather than disabled: offering to add a link to the description of a
     * channel that does not exist is noise at best, and at worst it teaches
     * people to click through a permission prompt, which is the one thing a
     * permission prompt cannot afford.
     *
     * Not the enforcement, and never was. `assertAppendAllowed` is the single
     * server-side gate every append goes through; this only decides what a
     * creator is shown. A creator who starts a channel later adds the link in
     * the editor above (MEAL-94) and the card appears.
     */
    hasChannel: Boolean(connection) || Boolean(creator.youtube_url),
    connected: Boolean(connection),
    channel: summary ? { id: summary.externalId, title: summary.externalName } : null,
    /** Non-null means the creator has to reconnect before anything reads or writes. */
    brokenReason: summary?.brokenReason ?? null,
    /** False on a grant made without `force-ssl` — the append offer must not appear. */
    canWriteDescriptions: grantCanReadCaptions(summary?.scopes),
    /**
     * Whether captions on this channel are readable at all (MEAL-138).
     *
     * The **same** scope as `canWriteDescriptions`, and reported separately
     * because it is a different question with a different consequence. Google
     * sells both through `youtube.force-ssl`; what differs is which Mealio-side
     * consent authorises using it — `youtube_append_opt_in` for a write, and for
     * a caption read, the fact that the creator connected the channel to have its
     * videos read in the first place.
     *
     * False means every video whose description runs under 250 characters is
     * unimportable for this creator, silently until this ticket. The card shows
     * it and offers the consent trip that fixes it.
     */
    canReadCaptions: grantCanReadCaptions(summary?.scopes),
    appendOptIn: creator.youtube_append_opt_in === true,
  });
}

export async function PATCH(request: NextRequest) {
  const user = await requireAuth(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { appendOptIn?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (typeof body.appendOptIn !== 'boolean') {
    return NextResponse.json({ error: 'appendOptIn must be a boolean' }, { status: 400 });
  }
  const appendOptIn = body.appendOptIn;

  const supabase = createServerSupabaseClient();
  const creator = await loadCreator(supabase, user.userId);
  if (!creator) return NextResponse.json({ error: 'Not a creator' }, { status: 403 });

  // Turning it *on* needs a channel to write to; turning it off never does.
  // Revocation must work from any state, including one where the connection has
  // already broken — a switch that can only be flipped one way is not revocable.
  if (appendOptIn) {
    const connection = await loadConnection(supabase, creator.id, 'youtube');
    if (!connection) {
      return NextResponse.json({ error: 'Connect your YouTube channel before turning this on.' }, { status: 400 });
    }
    if (!connection.scopes.includes(YOUTUBE_FORCE_SSL_SCOPE)) {
      // Flagged rather than only described, so the card can act on it instead
      // of matching the sentence. The write scope is asked for at this moment
      // by design — it is the only moment it means anything to the creator.
      return NextResponse.json(
        {
          error: 'This connection has not been given permission to edit descriptions yet.',
          needsConsent: true,
        },
        { status: 409 },
      );
    }
  }

  const { error } = await supabase
    .from('creators')
    .update({ youtube_append_opt_in: appendOptIn })
    .eq('id', creator.id);

  if (error) {
    log({ event: 'CREATOR:APPEND_OPT_IN', status: 'error', userId: user.userId, email: user.email, error });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  log({
    event: 'CREATOR:APPEND_OPT_IN',
    status: 'success',
    userId: user.userId,
    email: user.email,
    detail: `creator=${creator.id} youtube_append_opt_in=${appendOptIn}`,
  });

  return NextResponse.json({ ok: true, appendOptIn });
}

export async function DELETE(request: NextRequest) {
  const user = await requireAuth(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createServerSupabaseClient();
  const creator = await loadCreator(supabase, user.userId);
  if (!creator) return NextResponse.json({ error: 'Not a creator' }, { status: 403 });

  // Consent to edit descriptions cannot outlive the connection it was given for.
  // Leaving it set would mean a creator who reconnected months later found us
  // already permitted to write, on the strength of a decision they made about a
  // channel they had since disconnected.
  //
  // Withdrawn before the grant is deleted, so the order of the two failure
  // modes is the safe one: consent off with a token still stored blocks every
  // append, where a deleted token with consent still standing would not.
  const { error: consentError } = await supabase
    .from('creators')
    .update({ youtube_append_opt_in: false })
    .eq('id', creator.id);

  if (consentError) {
    log({ event: 'CREATOR:SOURCE_DISCONNECT', status: 'error', userId: user.userId, email: user.email, error: consentError });
    return NextResponse.json(
      { error: 'We could not disconnect that channel. Nothing was changed — please try again.' },
      { status: 500 },
    );
  }

  // A revocation is the one action that must not report success optimistically.
  // Telling a creator their channel is disconnected while the refresh token is
  // still in the table — and the grant still live at Google — is the failure
  // they are least likely to check up on.
  try {
    await deleteConnection(supabase, creator.id, 'youtube');
  } catch (err) {
    log({ event: 'CREATOR:SOURCE_DISCONNECT', status: 'error', userId: user.userId, email: user.email, error: err });
    return NextResponse.json(
      { error: 'We could not disconnect that channel. Mealio can no longer edit your descriptions, but the connection is still stored — please try again.' },
      { status: 500 },
    );
  }

  log({
    event: 'CREATOR:SOURCE_DISCONNECT',
    status: 'success',
    userId: user.userId,
    email: user.email,
    detail: `platform=youtube creator=${creator.id}`,
  });

  return NextResponse.json({ ok: true });
}
