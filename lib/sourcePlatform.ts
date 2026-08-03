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
        note: 'TikTok only lets you edit a description for 7 days after posting, once per day — then it locks permanently. If the video is already up, add the link now.',
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

export function mealShareUrl(mealId: string): string {
  return `https://mealio.co/meal/p/${mealId}`;
}
