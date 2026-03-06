/**
 * fix-pixabay-urls.mjs
 *
 * Finds all preset_meals rows with expiring pixabay.com/get/ photo URLs,
 * re-fetches a stable cdn.pixabay.com previewURL for each meal name,
 * and updates the database row.
 *
 * Usage:
 *   node scripts/fix-pixabay-urls.mjs
 *
 * Requires in .env.local:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   PIXABAY_API_KEY
 */

import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';

// ── Load .env.local ──────────────────────────────────────────────────────────
function loadEnv() {
  const env = {};
  try {
    const raw = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
      env[key] = val;
    }
  } catch {
    console.error('Could not read .env.local — make sure you run this from mealio_central/');
    process.exit(1);
  }
  return env;
}

const env = loadEnv();

const SUPABASE_URL      = 'https://etaracmlewdvzpcjrgru.supabase.co';
const SERVICE_ROLE_KEY  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV0YXJhY21sZXdkdnpwY2pyZ3J1Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MTQ0MDQ1NCwiZXhwIjoyMDg3MDE2NDU0fQ.1-wsmxUCUFO6R-4KeU7Ajy7CgYR0JUfOYKBEAbIK91Y';
const PIXABAY_API_KEY   = '54864097-5301b0b3b13f2283ad533bc40';

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !PIXABAY_API_KEY) {
  console.error('Missing required env vars: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PIXABAY_API_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// ── Pixabay lookup ───────────────────────────────────────────────────────────
async function fetchPreviewUrl(mealName) {
  const query = encodeURIComponent(mealName);
  const url = `https://pixabay.com/api/?key=${PIXABAY_API_KEY}&q=${query}&image_type=photo&safesearch=true&per_page=3`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pixabay HTTP ${res.status}`);
  const data = await res.json();
  const hit = data.hits?.[0];
  return hit?.previewURL ?? null;   // cdn.pixabay.com — stable, no expiry
}

// ── Main ─────────────────────────────────────────────────────────────────────
const DELAY_MS = 600; // Pixabay free tier: ~100 req/min

const { data: meals, error } = await supabase
  .from('preset_meals')
  .select('id, name, photo_url')
  .like('photo_url', 'https://pixabay.com/get/%');

if (error) {
  console.error('Failed to fetch meals:', error.message);
  process.exit(1);
}

if (!meals.length) {
  console.log('No rows with expiring Pixabay URLs found — nothing to do.');
  process.exit(0);
}

console.log(`Found ${meals.length} meals to fix.\n`);

let updated = 0;
let failed  = 0;

for (const meal of meals) {
  try {
    const previewUrl = await fetchPreviewUrl(meal.name);

    if (!previewUrl) {
      console.warn(`  [SKIP] "${meal.name}" — no Pixabay results`);
      // Set to null so broken URL is removed; can add photo manually later
      await supabase.from('preset_meals').update({ photo_url: null }).eq('id', meal.id);
      failed++;
    } else {
      await supabase.from('preset_meals').update({ photo_url: previewUrl }).eq('id', meal.id);
      console.log(`  [OK]   "${meal.name}"`);
      console.log(`         ${previewUrl}`);
      updated++;
    }
  } catch (err) {
    console.error(`  [ERR]  "${meal.name}": ${err.message}`);
    failed++;
  }

  // Respect Pixabay rate limit
  await new Promise(r => setTimeout(r, DELAY_MS));
}

console.log(`\nDone. Updated: ${updated}  Skipped/null'd: ${failed}`);
