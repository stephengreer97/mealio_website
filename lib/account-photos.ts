import type { SupabaseClient } from '@supabase/supabase-js';
import { MEAL_PHOTOS_BUCKET } from '@/lib/photos';
import { chunkIds } from '@/lib/paged-select';

/** Objects per `list()` page. Storage's own ceiling for one call is 1000. */
const LIST_PAGE = 1000;
/** Pages before giving up. 50,000 photos is far past any one account. */
const MAX_LIST_PAGES = 50;
/**
 * URLs per reference lookup. Public URLs are ~130 bytes and travel in the query
 * string, so 30 of them stays well under the proxy's URI ceiling.
 */
const URL_CHUNK = 30;

/** Every column a stored photo URL can live in, outside the deleted account's own rows. */
const REFERENCE_COLUMNS: Array<{ table: string; column: string }> = [
  { table: 'meals', column: 'photo_url' },
  { table: 'preset_meals', column: 'photo_url' },
  { table: 'creators', column: 'photo_url' },
  { table: 'creator_applications', column: 'photo_url' },
  { table: 'creator_import_drafts', column: 'draft->>photoUrl' },
];

export type PhotoPurge =
  | { ok: true; removed: number; kept: number }
  | { ok: false; reason: string };

/**
 * Deletes the photos a user uploaded, i.e. every object under `<userId>/` in the
 * public `meal-photos` bucket, except those somebody else still shows.
 *
 * WHY SOME ARE KEPT. Uploads are deduplicated by content hash (`photo_hashes`,
 * see lib/photos.ts): a second person uploading the same bytes is handed the
 * FIRST uploader's URL, which lives in the first uploader's folder. Copying a
 * creator's meal copies its `photo_url` too. So an object in this folder can be
 * the picture on someone else's meal, and deleting it would break their meal.
 *
 * So this runs AFTER the account's own rows are gone, and an object is removed
 * only when no remaining row in any photo column points at it. `photo_hashes` is
 * left alone on purpose: a row pointing at a removed object is exactly the case
 * `verifiedDedupeUrl` already detects and repairs on the next matching upload.
 *
 * Fails closed: any read that cannot be completed removes nothing and reports
 * why, so the caller can stop and the user can retry. Safe to run again: a
 * second run lists only what is left.
 */
export async function purgeUserPhotos(supabase: SupabaseClient, userId: string): Promise<PhotoPurge> {
  const bucket = supabase.storage.from(MEAL_PHOTOS_BUCKET);

  // 1) Everything in the folder. Listed in full before anything is removed, so
  //    the offset walk is not shifted by its own deletes.
  const paths: string[] = [];
  let complete = false;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const { data, error } = await bucket.list(userId, {
      limit: LIST_PAGE,
      offset: page * LIST_PAGE,
      sortBy: { column: 'name', order: 'asc' },
    });
    if (error) return { ok: false, reason: `list failed: ${error.message}` };
    const entries = data ?? [];
    for (const e of entries) {
      // A null id is a folder, not an object. Uploads are flat (`<userId>/<ts>.<ext>`).
      if (e.id === null || !e.name) continue;
      paths.push(`${userId}/${e.name}`);
    }
    if (entries.length < LIST_PAGE) { complete = true; break; }
  }
  if (!complete) return { ok: false, reason: 'list did not finish' };
  if (paths.length === 0) return { ok: true, removed: 0, kept: 0 };

  // 2) Which of them someone else still uses.
  const urlOf = new Map(paths.map((p) => [bucket.getPublicUrl(p).data.publicUrl, p]));
  const urls = [...urlOf.keys()];
  const referenced = new Set<string>();
  for (const { table, column } of REFERENCE_COLUMNS) {
    for (const chunk of chunkIds(urls, URL_CHUNK)) {
      const { data, error } = await supabase
        .from(table)
        .select('id')
        .in(column, chunk)
        .limit(1);
      if (error) return { ok: false, reason: `reference check on ${table} failed: ${error.message}` };
      if (!data || data.length === 0) continue;
      // Something in this chunk is referenced. Resolve which, one URL at a time;
      // this is the rare path, so the extra reads are cheap.
      for (const url of chunk) {
        const { data: hit, error: oneErr } = await supabase
          .from(table)
          .select('id')
          .eq(column, url)
          .limit(1);
        if (oneErr) return { ok: false, reason: `reference check on ${table} failed: ${oneErr.message}` };
        if (hit && hit.length > 0) referenced.add(url);
      }
    }
  }

  const doomed = urls.filter((u) => !referenced.has(u)).map((u) => urlOf.get(u)!);

  // 3) Remove, in chunks.
  let removed = 0;
  for (const chunk of chunkIds(doomed, 100)) {
    const { data, error } = await bucket.remove(chunk);
    if (error) return { ok: false, reason: `remove failed: ${error.message}` };
    removed += data?.length ?? 0;
  }
  return { ok: true, removed, kept: referenced.size };
}
