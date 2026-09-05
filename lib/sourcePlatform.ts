// Where a creator's meal came from, so the "add your link" prompt can say the one
// thing that matters for that platform. TikTok is the only one with a deadline:
// a description is editable for 7 days after posting, once per day, then locked
// for good — after that the link can only go in by deleting and reposting.
//
// Kept in sync with src/lib/sourcePlatform.ts in mealio_app.

export type SourcePlatform = 'tiktok' | 'instagram' | null;

export function detectSourcePlatform(source?: string | null): SourcePlatform {
  if (!source) return null;
  let host: string;
  try {
    host = new URL(source.trim()).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) return 'tiktok';
  if (host === 'instagram.com' || host.endsWith('.instagram.com')) return 'instagram';
  return null;
}

export interface CaptionGuidance {
  title: string;
  body: string;
  /** Platform quirk worth calling out — only TikTok has a hard deadline. */
  note: string | null;
}

export function captionGuidance(platform: SourcePlatform): CaptionGuidance {
  switch (platform) {
    case 'tiktok':
      return {
        title: 'Add this link to your TikTok caption',
        body: 'Anyone who taps it can save the meal and send every ingredient straight to their grocery cart.',
        note: 'TikTok only lets you edit a description for 7 days after posting, once per day, then it locks permanently. If the video is already up, add the link now.',
      };
    case 'instagram':
      return {
        title: 'Add this link to your Instagram caption',
        body: 'Anyone who taps it can save the meal and send every ingredient straight to their grocery cart.',
        note: 'Instagram captions stay editable, so you can add it to the post whenever you like.',
      };
    default:
      return {
        title: 'Add this link to your video caption',
        body: 'Paste it into the caption, description, or your bio. Anyone who taps it can save the meal and send every ingredient straight to their grocery cart.',
        note: null,
      };
  }
}

/** A uuid at the very end of a path segment. The id is always the last 36. */
const TRAILING_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The meal's public link, with the name in front of the id.
 *
 * The id has to be in the URL — meals have no unique slug and inventing one
 * needs a column, a uniqueness rule and a backfill. But a bare uuid is a bad
 * link in the one place this URL matters most: YouTube truncates a description
 * link at roughly forty characters, so `mealio.co/meal/p/9ca4eee0-d12b-404…`
 * showed a viewer nothing at all about where it went.
 *
 * Putting the name first means the part that survives truncation is the part
 * worth reading — `mealio.co/meal/p/weeknight-garlic-butter-shrimp-…`. The slug
 * is decorative: nothing resolves by it, so it can change with the meal's name
 * without breaking a link already sitting in somebody's description.
 *
 * Without a name it stays exactly as it was, so every link already published
 * keeps working and old callers need no change.
 */
export function mealShareUrl(mealId: string, name?: string | null): string {
  const slug = mealSlug(name);
  return `https://mealio.co/meal/p/${slug ? `${slug}-${mealId}` : mealId}`;
}

/** The readable half. Empty when there is nothing usable to say. */
export function mealSlug(name: string | null | undefined): string {
  return (name ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    // A trailing hyphen after the cut would double up against the id's own.
    .replace(/-+$/, '');
}

/**
 * The id inside a `/meal/p/…` segment, whether or not it carries a slug.
 *
 * Reads the trailing uuid rather than splitting on hyphens, because the slug
 * has hyphens too and a meal called "Chicken 65" would otherwise be indexed
 * from the wrong place. Returns the input untouched when there is no uuid in
 * it, so a caller that already had a bare id is unaffected and a malformed
 * param still reaches the lookup that will honestly fail to find it.
 */
export function mealIdFromParam(param: string): string {
  return TRAILING_UUID.exec(param)?.[0] ?? param;
}
