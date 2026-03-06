/**
 * seed-preset-photos.mjs
 *
 * For every preset_meal that doesn't yet have a Supabase Storage photo URL:
 *   1. Searches Pixabay for the meal name
 *   2. Downloads the full-size webformatURL (640px) with the required Referer header
 *   3. Uploads to the meal-photos Supabase Storage bucket (preset/{id}.jpg)
 *   4. Updates preset_meals.photo_url with the permanent public URL
 *
 * Safe to re-run — skips rows that already have a Supabase Storage URL.
 *
 * Usage:
 *   node scripts/seed-preset-photos.mjs
 *   node scripts/seed-preset-photos.mjs --all    # re-process every row (overwrite)
 *
 * Requires in .env.local:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   PIXABAY_API_KEY
 */

import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';

// ── Load .env.local ───────────────────────────────────────────────────────────
function loadEnv() {
  const env = {};
  try {
    const raw = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key   = trimmed.slice(0, eq).trim();
      const val   = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
      env[key] = val;
    }
  } catch {
    console.error('Could not read .env.local — run this from mealio_central/');
    process.exit(1);
  }
  return env;
}

const env = loadEnv();

const SUPABASE_URL      = 'https://etaracmlewdvzpcjrgru.supabase.co';
const SERVICE_ROLE_KEY  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV0YXJhY21sZXdkdnpwY2pyZ3J1Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MTQ0MDQ1NCwiZXhwIjoyMDg3MDE2NDU0fQ.1-wsmxUCUFO6R-4KeU7Ajy7CgYR0JUfOYKBEAbIK91Y';
const PIXABAY_API_KEY   = '54864097-5301b0b3b13f2283ad533bc40';

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !PIXABAY_API_KEY) {
  console.error('Missing env vars: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PIXABAY_API_KEY');
  process.exit(1);
}

const supabase   = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
const BUCKET     = 'meal-photos';
const DELAY_MS   = 700; // Pixabay free tier: ~100 req/min → 700ms is safe
const RERUN_ALL  = process.argv.includes('--all');

// ── Pixabay search ────────────────────────────────────────────────────────────
async function searchPixabay(mealName) {
  const q   = encodeURIComponent(mealName);
  const url = `https://pixabay.com/api/?key=${PIXABAY_API_KEY}&q=${q}&image_type=photo&safesearch=true&per_page=3`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pixabay HTTP ${res.status}`);
  const data = await res.json();
  return data.hits?.[0] ?? null; // { previewURL, webformatURL, ... }
}

// ── Download image with Pixabay's required Referer header ─────────────────────
async function downloadImage(webformatURL) {
  const res = await fetch(webformatURL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; Mealio/1.0; +https://mealio.co)',
      'Referer':    'https://pixabay.com/',
      'Accept':     'image/webp,image/png,image/*,*/*',
    },
  });
  if (!res.ok) throw new Error(`Image download HTTP ${res.status}`);
  const contentType = res.headers.get('content-type') ?? 'image/jpeg';
  const buffer      = await res.arrayBuffer();
  return { buffer, contentType };
}

// ── Upload to Supabase Storage ────────────────────────────────────────────────
async function uploadToStorage(mealId, buffer, contentType) {
  const ext  = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
  const path = `preset/${mealId}.${ext}`;

  // Remove any existing file at this path so upsert works cleanly
  await supabase.storage.from(BUCKET).remove([path]);

  const { data, error } = await supabase.storage
    .from(BUCKET)
    .upload(path, buffer, { contentType, upsert: true });

  if (error) throw new Error(`Storage upload failed: ${error.message}`);

  const { data: { publicUrl } } = supabase.storage.from(BUCKET).getPublicUrl(data.path);
  return publicUrl;
}

// ── Main ──────────────────────────────────────────────────────────────────────
let query = supabase.from('preset_meals').select('id, name, photo_url');

if (!RERUN_ALL) {
  // Skip rows that already point at Supabase Storage
  query = query.not('photo_url', 'like', `${SUPABASE_URL}/storage/%`);
}

const { data: meals, error: fetchErr } = await query.order('name');

if (fetchErr) {
  console.error('Failed to fetch preset meals:', fetchErr.message);
  process.exit(1);
}

if (!meals.length) {
  console.log('All preset meals already have Supabase Storage photos. Nothing to do.');
  console.log('Run with --all to re-process every row.');
  process.exit(0);
}

console.log(`Processing ${meals.length} preset meal(s)...\n`);

let updated = 0;
let skipped = 0;
let failed  = 0;

for (const meal of meals) {
  try {
    // 1. Search Pixabay
    const hit = await searchPixabay(meal.name);
    if (!hit?.webformatURL) {
      console.warn(`  [SKIP] "${meal.name}" — no Pixabay results`);
      skipped++;
      await new Promise(r => setTimeout(r, DELAY_MS));
      continue;
    }

    // 2. Download full-size image
    const { buffer, contentType } = await downloadImage(hit.webformatURL);

    // 3. Upload to Supabase Storage
    const publicUrl = await uploadToStorage(meal.id, buffer, contentType);

    // 4. Update the database row
    const { error: updateErr } = await supabase
      .from('preset_meals')
      .update({ photo_url: publicUrl })
      .eq('id', meal.id);

    if (updateErr) throw new Error(`DB update failed: ${updateErr.message}`);

    console.log(`  [OK]   "${meal.name}"`);
    console.log(`         ${publicUrl}`);
    updated++;
  } catch (err) {
    console.error(`  [ERR]  "${meal.name}": ${err.message}`);
    failed++;
  }

  await new Promise(r => setTimeout(r, DELAY_MS));
}

console.log(`\nDone.  Updated: ${updated}  Skipped: ${skipped}  Errors: ${failed}`);
