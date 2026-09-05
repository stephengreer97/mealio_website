import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { requireAdmin } from '@/lib/requireAdmin';
import { log } from '@/lib/logger';

// Admin CRUD for the remote automation config the mobile cart engine consumes.
//
//   GET  /api/admin/automation-config          → { active, versions: [...] }
//   POST /api/admin/automation-config
//        { config: {...}, notes? }             → publish a NEW version (activated)
//        { activateVersion: n }                → roll back to an existing version
//
// Rows are immutable: publishing always inserts a new version rather than editing
// one in place, so telemetry that recorded config_version = 7 always refers to
// the same bytes, and a rollback is one activateVersion call away.

export const dynamic = 'force-dynamic';

// Guard against a fat-fingered paste blowing up every client's config parse.
// The client validates per-field too, but rejecting nonsense at the write side
// means a bad push never reaches a device in the first place.
const MAX_CONFIG_BYTES = 128 * 1024;

export async function GET(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const supabase = createServerSupabaseClient();
  const { data, error } = await supabase
    .from('automation_config')
    .select('id, version, config, is_active, notes, created_at')
    .order('version', { ascending: false })
    .limit(50);

  if (error) {
    log({ event: 'ADMIN:AUTOMATION_CONFIG', status: 'error', userId: admin.userId, error, detail: 'list' });
    return NextResponse.json({ error: 'Failed to load' }, { status: 500 });
  }

  const versions = data ?? [];
  return NextResponse.json({
    active: versions.find((v) => v.is_active) ?? null,
    versions,
  });
}

export async function POST(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const body = await request.json().catch(() => ({}));
  const supabase = createServerSupabaseClient();

  // ── Rollback: activate an already-published version ───────────────────────
  if (body?.activateVersion != null) {
    const target = Number(body.activateVersion);
    if (!Number.isInteger(target) || target <= 0) {
      return NextResponse.json({ error: 'activateVersion must be a positive integer' }, { status: 400 });
    }

    const { data: exists } = await supabase
      .from('automation_config')
      .select('id')
      .eq('version', target)
      .maybeSingle();
    if (!exists) return NextResponse.json({ error: `Version ${target} not found` }, { status: 404 });

    // Deactivate-then-activate: the single-active partial unique index rejects a
    // second active row, so the clear must land first. The brief no-active-row
    // window is safe — the client treats an empty/absent config as "keep the
    // cached overrides", never as "revert to bundled".
    await supabase.from('automation_config').update({ is_active: false }).eq('is_active', true);
    const { error: actErr } = await supabase
      .from('automation_config')
      .update({ is_active: true })
      .eq('version', target);

    if (actErr) {
      log({ event: 'ADMIN:AUTOMATION_CONFIG', status: 'error', userId: admin.userId, error: actErr, detail: 'activate' });
      return NextResponse.json({ error: 'Failed to activate' }, { status: 500 });
    }
    log({ event: 'ADMIN:AUTOMATION_CONFIG', status: 'success', userId: admin.userId, detail: `activated v${target}` });
    return NextResponse.json({ ok: true, version: target });
  }

  // ── Publish a new version ─────────────────────────────────────────────────
  const config = body?.config;
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return NextResponse.json({ error: 'config must be an object' }, { status: 400 });
  }

  const serialized = JSON.stringify(config);
  if (serialized.length > MAX_CONFIG_BYTES) {
    return NextResponse.json({ error: `config exceeds ${MAX_CONFIG_BYTES} bytes` }, { status: 400 });
  }

  const { data: latest } = await supabase
    .from('automation_config')
    .select('version')
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();

  const nextVersion = (latest?.version ?? 0) + 1;

  await supabase.from('automation_config').update({ is_active: false }).eq('is_active', true);

  const { data: inserted, error: insErr } = await supabase
    .from('automation_config')
    .insert({
      version: nextVersion,
      config,
      is_active: true,
      notes: typeof body?.notes === 'string' ? body.notes.slice(0, 500) : null,
      created_by: admin.userId,
    })
    .select('id, version, created_at')
    .single();

  if (insErr || !inserted) {
    // A concurrent publish took nextVersion (unique index on version). The admin
    // retries; nothing is half-written because the insert is a single statement.
    log({ event: 'ADMIN:AUTOMATION_CONFIG', status: 'error', userId: admin.userId, error: insErr, detail: 'publish' });
    return NextResponse.json({ error: 'Failed to publish. Retry.' }, { status: 409 });
  }

  log({ event: 'ADMIN:AUTOMATION_CONFIG', status: 'success', userId: admin.userId, detail: `published v${nextVersion}` });
  return NextResponse.json({ ok: true, ...inserted });
}
