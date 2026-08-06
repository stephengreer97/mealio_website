import { describe, it, expect } from 'vitest';
import { analyseFile, analyseRepo, formatFindings } from '@/tests/helpers/select-bounds';

/**
 * The gate for MEAL-130, plus the evidence that the gate is worth having.
 *
 * `tests/helpers/select-bounds.ts` explains why this is a static check rather
 * than another fixture. This file is in three parts:
 *
 *  1. THE NINE. Every instance of the row-ceiling bug found in this repository,
 *     as the source that actually shipped, asserted to be caught. Recovered from
 *     the pre-fix commits and pasted here rather than read out of git, because CI
 *     checks out at depth 1 and a proof that evaporates in CI proves nothing.
 *     Alongside each, the reads in the SAME file that were already correct,
 *     asserted NOT to be flagged — a checker that fires on everything would also
 *     "catch" all nine and be useless.
 *
 *  2. THE SHAPES. The syntax that made a regex hopeless here, each pinned
 *     directly.
 *
 *  3. THE GATE. No unannotated unbounded select anywhere in app/, lib/ or
 *     components/.
 *
 * HOW IT RUNS
 *
 *   npm test                                  # with everything else, and in CI
 *   npx vitest run tests/lib/select-bounds.test.ts    # just this, ~1s
 *
 * No extra tooling and no new CI step: `.github/workflows/test.yml` runs `npm
 * test` on every pull request, so this gates every change from the day it lands.
 * The failure message names the file, the line and the fix.
 *
 * TO ALLOW A GENUINELY BOUNDED READ
 *
 *   // unbounded-select-ok: one creator's grants — at most one row per platform
 *
 * on or inside the statement. The reason is required, and every opt-out in the
 * tree is listed by:
 *
 *   grep -rn 'unbounded-select-ok' app lib components
 */

/**
 * Parses a fixture the way the real file would be parsed.
 *
 * The wrapper is load-bearing. At the top level of a snippet TypeScript parses
 * `await (x).y()` as a CALL to a function named `await` — `await(x).y()` — so the
 * chain hangs off the wrong node and a fixture written without a function around
 * it tests a shape that does not exist in the codebase. Every real select here
 * lives in an async function, so every fixture does too.
 */
const one = (src: string) => analyseFile('probe.ts', `async function probe() {${src}}`);
const findings = (src: string) => one(src).findings;
const caught = (src: string) => findings(src).length;

// ── 1. The nine ──────────────────────────────────────────────────────────────

describe('the nine known instances, as they shipped', () => {
  it('MEAL-126: orphan cleanup read four photo tables unbounded, then deleted the difference', () => {
    // The worst of them. 500 live user photos, unrecoverable: a truncated
    // keep-set meant every photo past the ceiling looked like an orphan.
    const src = `
      const [meals, presets, creators, apps] = await Promise.all([
        supabase.from('meals').select('photo_url'),
        supabase.from('preset_meals').select('photo_url'),
        supabase.from('creators').select('photo_url'),
        supabase.from('creator_applications').select('photo_url'),
      ]);
      const { error: deleteError } = await supabase.storage.from('meal-photos').remove(batch);
    `;
    const f = findings(src);
    expect(f).toHaveLength(4);
    expect(f.map((x) => x.table)).toEqual(['meals', 'preset_meals', 'creators', 'creator_applications']);
    // The storage call is not a table read and must not be counted as one.
    expect(f.some((x) => x.table === 'meal-photos')).toBe(false);
  });

  it('MEAL-127: the payout leaderboard folded an arbitrary unordered 1000 saves', () => {
    const src = `
      const { data: saves } = await supabase
        .from('preset_meal_saves')
        .select('saved_at, preset_meals!preset_meal_id!inner ( creator_id, creators!creator_id ( id, display_name ) )');
      const { data: events } = await supabase
        .from('subscription_events')
        .select('event, created_at');
    `;
    expect(findings(src).map((f) => f.table)).toEqual(['preset_meal_saves', 'subscription_events']);
  });

  it('MEAL-127: the head+count reads in the same route were already right', () => {
    // Nine of these sit beside the two broken reads. Flagging them would have
    // buried the real finding in noise.
    const src = `
      const [a, b] = await Promise.all([
        supabase.from('meals').select('id', { count: 'exact', head: true }).gte('created_at', thirtyDaysAgo),
        supabase.from('user_profiles').select('id', { count: 'exact', head: true })
          .gte('created_at', qtrStart).lt('created_at', qtrEnd),
      ]);
    `;
    expect(caught(src)).toBe(0);
  });

  it('MEAL-112: the creator list and its platform grants', () => {
    // Rendered `unconfigured` for every creator past 222 once the related `.in()`
    // URI ceiling was hit downstream.
    const src = `
      const { data, error } = await supabase
        .from('creators')
        .select(CREATOR_FIELDS)
        .order('created_at', { ascending: false });
      const [{ data: accounts }, health] = await Promise.all([
        supabase
          .from('creator_platform_accounts')
          .select('creator_id, platform, external_id, external_name, broken_reason, broken_at'),
        pollHealthByCreator(supabase, creatorIds, primarySource),
      ]);
    `;
    expect(findings(src).map((f) => f.table)).toEqual(['creators', 'creator_platform_accounts']);
  });

  it('MEAL-112: an `.order()` is not a bound, which is the trap in that one', () => {
    // `.order()` makes the truncated answer *stable*, so it looks more correct
    // than it is. It does not reduce the row count by one row.
    const src = `
      const { data } = await supabase.from('creators').select('id').order('created_at', { ascending: false });
    `;
    expect(caught(src)).toBe(1);
  });

  it('MEAL-112: poll health read every creator id in one shot', () => {
    const src = `
      const [stateRes] = await Promise.all([
        supabase
          .from('creator_source_state')
          .select('creator_id, source, last_polled_at, poll_after')
          .in('creator_id', ids)
          .order('source', { ascending: true }),
      ]);
    `;
    expect(caught(src)).toBe(1);
  });

  it('MEAL-112: the paged reads in that same file were already right', () => {
    const src = `
      const a = await supabase
        .from('creator_source_items')
        .select('creator_id, source, created_at')
        .in('creator_id', pending)
        .order('created_at', { ascending: false })
        .limit(PAGE_ROWS);
      const b = await supabase
        .from('creator_import_drafts')
        .select('creator_id, published_meal_id')
        .in('creator_id', ids)
        .order('id', { ascending: true })
        .range(from, from + PAGE_ROWS - 1);
    `;
    expect(caught(src)).toBe(0);
  });

  it('MEAL-128: the email funnel aggregated over a truncated read', () => {
    const src = `
      const { data: all } = await supabase
        .from('email_sends')
        .select('type, status, opened_at, clicked_at');
    `;
    expect(caught(src)).toBe(1);
  });

  it('MEAL-128: the `.limit(50)` recent-sends read beside it was already right', () => {
    const src = `
      const { data: recent } = await supabase
        .from('email_sends')
        .select('email, type, status, sent_at, opened_at, clicked_at')
        .order('sent_at', { ascending: false })
        .limit(50);
      const { data: optOuts } = await supabase
        .from('user_profiles')
        .select('*', { count: 'exact', head: true })
        .eq('marketing_opt_out', true);
    `;
    expect(caught(src)).toBe(0);
  });

  it('MEAL-129: the hash backfill read every known url to diff against', () => {
    const src = `
      const { data: existing } = await supabase.from('photo_hashes').select('url');
      await supabase.from('photo_hashes').upsert({ hash, url }, { onConflict: 'hash', ignoreDuplicates: true });
    `;
    const f = findings(src);
    expect(f).toHaveLength(1);
    expect(f[0].table).toBe('photo_hashes');
    // The read is flagged and the upsert beside it is not: `db-max-rows` does not
    // cap what a write touches.
    expect(f[0].snippet).toContain('existing');
  });

  it('MEAL-134: the photo backfill read both photo tables unbounded', () => {
    const src = `
      const [mealsRes, presetsRes] = await Promise.all([
        supabase.from('meals').select('id, user_id, photo_url').not('photo_url', 'is', null),
        supabase.from('preset_meals').select('id, creator_id, photo_url').not('photo_url', 'is', null),
      ]);
      const { error } = await supabase.from('meals').update({ photo_url: resolved }).eq('id', row.id);
    `;
    expect(findings(src).map((f) => f.table)).toEqual(['meals', 'preset_meals']);
  });

  it('MEAL-135: the application list, ordered newest-first so truncation drops the oldest', () => {
    const src = `
      const { data, error } = await supabase
        .from('creator_applications')
        .select(\`
          id,
          display_name,
          status,
          created_at,
          user_profiles!user_id ( email )
        \`)
        .order('created_at', { ascending: false });
    `;
    expect(caught(src)).toBe(1);
  });

  it('the funnel runs query, unbounded in a `let` — and the paged one beside it', () => {
    // The pair that makes the variable-flow handling worth its complexity. Both
    // are builders in a `let`, both are narrowed by a conditional `.eq()` further
    // down, and exactly one of them is the bug.
    const src = `
      let runsQuery = supabase
        .from('automation_runs')
        .select('store_id, outcome, status, items_requested, items_added')
        .gte('started_at', since);
      if (storeId) runsQuery = runsQuery.eq('store_id', storeId);
      const { data: runs } = await runsQuery;

      for (let page = 0; page < MAX_PAGES; page++) {
        let q = supabase
          .from('automation_steps')
          .select('store_id, step, outcome, duration_ms, detail')
          .gte('occurred_at', since)
          .order('id', { ascending: true })
          .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
        if (storeId) q = q.eq('store_id', storeId);
        const { data } = await q;
      }
    `;
    const f = findings(src);
    expect(f).toHaveLength(1);
    expect(f[0].table).toBe('automation_runs');
  });
});

// ── 2. The shapes ────────────────────────────────────────────────────────────

describe('shapes a line-oriented check would miss', () => {
  it('follows a bound applied to a variable many lines later', () => {
    const src = `
      let query = supabase.from('preset_meals').select(FIELDS);
      if (tag) query = query.contains('tags', [tag]);
      if (creator) query = query.eq('creator_id', creator);
      query = query.order('created_at', { ascending: false }).limit(pageSize);
      const { data } = await query;
    `;
    expect(caught(src)).toBe(0);
  });

  it('still reports that variable when nobody ever bounds it', () => {
    const src = `
      let query = supabase.from('preset_meals').select(FIELDS);
      if (tag) query = query.contains('tags', [tag]);
      const { data } = await query;
    `;
    expect(caught(src)).toBe(1);
  });

  it('steps through an `await` in the middle of a chain', () => {
    const src = `
      const rows = (await supabase.from('meals').select('id').limit(10)).data;
    `;
    expect(caught(src)).toBe(0);
  });

  it('steps through `as` casts and non-null assertions mid-chain', () => {
    const src = `
      const { data } = await (supabase.from('meals').select('id') as any).limit(5);
    `;
    expect(caught(src)).toBe(0);
  });

  it('sees a builder factory bounded at its call sites', () => {
    // The real shape from the orphan sweep: one filter, defined once, paged by
    // each caller.
    const src = `
      const rowsWithPhotos = () =>
        supabase.from(table).select('photo_url').not('photo_url', 'is', null);
      for (let page = 0; page < MAX_PAGES; page++) {
        const { data } = await rowsWithPhotos()
          .order('id', { ascending: true })
          .range(from, from + PAGE_ROWS - 1);
      }
    `;
    expect(caught(src)).toBe(0);
  });

  it('reports a builder factory when a call site forgets the bound', () => {
    const src = `
      const rowsWithPhotos = () =>
        supabase.from(table).select('photo_url').not('photo_url', 'is', null);
      const paged = await rowsWithPhotos().order('id').range(from, from + 999);
      const all = await rowsWithPhotos();
    `;
    expect(caught(src)).toBe(1);
  });

  it('does not mistake Buffer.from, Array.from or supabase.storage.from for a table', () => {
    const src = `
      const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
      const list = Array.from(new Set(ids)).map(String);
      const { data } = await supabase.storage.from('meal-photos').list('', { limit: 100 });
      const { data: up } = await supabase.storage.from('meal-photos').upload(path, buffer);
    `;
    expect(caught(src)).toBe(0);
  });

  it('treats a `.select()` after a write as bounded by the payload, not the table', () => {
    const src = `
      const { data } = await supabase.from('meals').insert(rows).select('id');
      const { data: u } = await supabase.from('meals').update(values).eq('id', id).select();
      const { data: d } = await supabase.from('meals').delete().eq('id', id).select('id');
    `;
    expect(caught(src)).toBe(0);
  });
});

describe('bounds that do not bound', () => {
  it('rejects .limit(1000) — exactly db-max-rows, so it changes nothing', () => {
    // The easy escape this check must not leave open. If `.limit(1000)` silenced
    // it, every one of the nine could have been "fixed" without being fixed.
    const f = findings(`const { data } = await supabase.from('meals').select('id').limit(1000);`);
    expect(f).toHaveLength(1);
    expect(f[0].kind).toBe('ceiling-limit');
  });

  it('rejects a .range() window wider than the ceiling', () => {
    const f = findings(`const { data } = await supabase.from('meals').select('id').range(0, 4999);`);
    expect(f).toHaveLength(1);
    expect(f[0].kind).toBe('ceiling-range');
  });

  it('accepts .limit(999) and a full-page .range(0, 999)', () => {
    // A page of exactly the ceiling is a real page — it is the first page of this
    // repository's paging idiom.
    expect(caught(`const a = await supabase.from('meals').select('id').limit(999);`)).toBe(0);
    expect(caught(`const b = await supabase.from('meals').select('id').range(0, 999);`)).toBe(0);
  });

  it('accepts a computed bound rather than guessing at it', () => {
    // `.limit(pageSize)` cannot be judged here, and guessing is how a checker
    // earns the false positive that gets it switched off.
    expect(caught(`const a = await supabase.from('meals').select('id').limit(pageSize);`)).toBe(0);
    expect(caught(`const b = await supabase.from('meals').select('id').range(from, to);`)).toBe(0);
  });

  it('accepts .single() and .maybeSingle()', () => {
    expect(caught(`const a = await supabase.from('meals').select('*').eq('id', id).single();`)).toBe(0);
    expect(caught(`const b = await supabase.from('meals').select('*').eq('id', id).maybeSingle();`)).toBe(0);
  });
});

describe('the opt-out', () => {
  it('accepts a marker with a reason, on the line above', () => {
    const src = `
      // unbounded-select-ok: at most four grant rows exist per creator (one per platform)
      const { data } = await supabase.from('creator_platform_accounts').select('platform').eq('creator_id', id);
    `;
    const r = one(src);
    expect(r.findings).toHaveLength(0);
    expect(r.exemptions).toHaveLength(1);
    expect(r.exemptions[0].reason).toMatch(/four grant rows/);
  });

  it('accepts a marker inside the statement', () => {
    const src = `
      const { data } = await supabase
        .from('creator_platform_accounts') // unbounded-select-ok: four rows per creator, one per platform
        .select('platform')
        .eq('creator_id', id);
    `;
    expect(caught(src)).toBe(0);
  });

  it('rejects a bare marker with no reason', () => {
    // Otherwise the token becomes a mute button.
    const src = `
      // unbounded-select-ok:
      const { data } = await supabase.from('meals').select('id');
    `;
    const f = findings(src);
    expect(f).toHaveLength(1);
    expect(f[0].kind).toBe('reason-missing');
  });

  it('rejects a marker whose reason is a shrug', () => {
    const src = `
      // unbounded-select-ok: fine
      const { data } = await supabase.from('meals').select('id');
    `;
    expect(findings(src)[0].kind).toBe('reason-missing');
  });

  it('does not let one marker cover the next select as well', () => {
    const src = `
      // unbounded-select-ok: the store list is a fixed nine rows and cannot grow
      const { data: a } = await supabase.from('stores').select('id');
      const { data: b } = await supabase.from('meals').select('id');
    `;
    const r = one(src);
    expect(r.exemptions).toHaveLength(1);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].table).toBe('meals');
  });
});

// ── 3. The gate ──────────────────────────────────────────────────────────────

describe('the repository', () => {
  const report = analyseRepo(process.cwd());

  it('has no unbounded select that is not annotated with a reason', () => {
    expect(
      report.findings,
      `\n\nUnbounded PostgREST reads. Each will return at most 1000 rows and will NOT\n` +
      `say that it truncated. Page it (see fetchAllCreators in\n` +
      `app/api/admin/creators/route.ts), bound it, or annotate it:\n\n` +
      `    // unbounded-select-ok: <why this cannot exceed a page>\n\n` +
      formatFindings(report.findings) + '\n',
    ).toEqual([]);
  });

  it('checks a plausible number of selects, so a broken walker cannot pass vacuously', () => {
    // If a refactor stops the walker finding chains, the gate above goes green by
    // finding nothing at all. This is the tripwire for that.
    expect(report.selectsChecked).toBeGreaterThan(120);
  });

  it('keeps every opt-out visible and justified', () => {
    for (const e of report.exemptions) {
      expect(e.reason.length, `${e.file}:${e.line}`).toBeGreaterThan(11);
    }
    // Deliberately loose. It is a budget, not a target: if this number climbs
    // toward the select count, the opt-out has become the default and the gate is
    // no longer buying anything.
    expect(report.exemptions.length).toBeLessThan(45);
  });
});
