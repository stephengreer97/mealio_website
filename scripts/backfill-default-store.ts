/**
 * One-time backfill: give every account with meals a default store, and move
 * its meals there (see lib/default-store.ts). Safe to run again: an account
 * that already has a default is skipped, and a moved meal does not move twice.
 *
 * Needs the migration supabase/migrations/20261024000001_default_store.sql.
 *
 *   set -a; . ./.env.local; set +a
 *   npx tsx scripts/backfill-default-store.ts                 # dry run, all accounts
 *   npx tsx scripts/backfill-default-store.ts --user <id>     # dry run, one account
 *   npx tsx scripts/backfill-default-store.ts --apply [--user <id>]
 *
 * Every run writes a backup of each account's meals, as they were, to
 * `backups/default-store-<timestamp>.json` before anything is written.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createClient } from '@supabase/supabase-js';
import { mealsForUser, moveAccountToStore, startingStore, type MealStoreRow } from '@/lib/default-store';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const onlyUser = args.includes('--user') ? args[args.indexOf('--user') + 1] : null;

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('Load .env.local first: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
const supabase = createClient(url, key, { auth: { persistSession: false } });

async function main() {
  // unbounded-select-ok: an operator's one-off pass over every account
  const { data: profiles, error } = await supabase.from('user_profiles').select('id, default_store_id');
  if (error) throw new Error(`user_profiles: ${error.message} (has the migration been run?)`);

  const targets = (profiles ?? []).filter(
    (p: { id: string; default_store_id: string | null }) => (onlyUser ? p.id === onlyUser : !p.default_store_id),
  );

  const backup: Record<string, MealStoreRow[]> = {};
  const report: Array<Record<string, unknown>> = [];

  for (const profile of targets) {
    const meals = await mealsForUser(supabase, profile.id);
    if (meals.length === 0) continue;
    const start = startingStore(meals);
    if (!start) {
      report.push({ user: profile.id, meals: meals.length, skipped: 'no meals at a supported store' });
      continue;
    }
    backup[profile.id] = meals;
    const stores = [...new Set(meals.map((m) => m.store_id))];
    const result = await moveAccountToStore(supabase, profile.id, start, { meals, dryRun: !apply });
    report.push({ user: profile.id, meals: meals.length, stores, to: start, changed: result.changed, errors: result.errors });
  }

  const dir = join(process.cwd(), 'backups');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `default-store-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify({ apply, onlyUser, backup }, null, 2));

  console.log(JSON.stringify(report, null, 2));
  console.log(`\n${apply ? 'APPLIED' : 'DRY RUN, nothing written'}. ${report.length} accounts. Backup: ${file}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
