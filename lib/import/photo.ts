/**
 * Photo resolution for an imported draft.
 *
 * **We never hotlink.** A bare third-party URL on a published meal makes the
 * creator's server carry our traffic, and the meal breaks silently the day they
 * move the file or their CDN starts refusing us. So a source image is copied
 * into our own bucket or it is not used at all.
 *
 * Resolution order:
 *
 *   1. **Copy the page's own image.** The best outcome: it is the photo the
 *      creator chose, and after this it lives on our storage.
 *   2. **Fall back to Pixabay**, which the product already uses for meals with
 *      no photo, and store that in the same bucket.
 *   3. **Nothing.** The field reads red and the creator adds their own.
 *
 * Step 1 fails more often than it succeeds — hotlink protection, Cloudflare,
 * and referer checks all reject a server-side read of an image that loads fine
 * in a browser. That is expected, and it is exactly why step 2 exists.
 *
 * The two outcomes are **not** equally trustworthy, and the pipeline reports
 * them differently: a copied image came from the page, a Pixabay image is a
 * stand-in *we* picked. Presenting the second as though we found it on the
 * creator's page would be the same dishonesty MEAL-72 exists to prevent.
 */

import { pixabayPhotoFor, storeImageBuffer } from '@/lib/photos';
import { log } from '@/lib/logger';
import { safeFetchImage, type SafeFetchOptions } from './ssrf';

export type PhotoOrigin =
  /** Copied from the image the page publishes, now on our storage. */
  | 'copied'
  /** A Pixabay stand-in we chose, on our storage. */
  | 'pixabay'
  /** No usable photo. */
  | 'none';

export interface PhotoResolution {
  /** Always our own URL, or null. Never a third-party URL. */
  url: string | null;
  origin: PhotoOrigin;
  /**
   * The source image URL we copied, when `origin` is `copied`. This is the
   * provenance claim the confidence model verifies against the page — the
   * storage URL it was rewritten to is our own bookkeeping, not a claim about
   * the source.
   */
  sourceUrl: string | null;
  /** Why we ended up here, for the field's confidence reason and for logs. */
  detail: string;
}

export interface PhotoResolverInput {
  /** The image the page advertises (JSON-LD `image` or `og:image`), if any. */
  sourceImageUrl: string | null;
  /** Used as the Pixabay query when there is no usable source image. */
  mealName: string;
}

export type PhotoResolver = (input: PhotoResolverInput) => Promise<PhotoResolution>;

/** The resolver used when no user context is available — produces no photo. */
export const nullPhotoResolver: PhotoResolver = async () => ({
  url: null,
  origin: 'none',
  sourceUrl: null,
  detail: 'No photo was resolved for this import.',
});

/**
 * Builds the production resolver. `userId` scopes the storage path, matching
 * every other upload in the product.
 */
export function createPhotoResolver(
  userId: string,
  fetchOptions: SafeFetchOptions = {},
): PhotoResolver {
  return async ({ sourceImageUrl, mealName }) => {
    if (sourceImageUrl) {
      const copied = await copySourceImage(sourceImageUrl, userId, fetchOptions);
      if (copied) {
        return {
          url: copied,
          origin: 'copied',
          sourceUrl: sourceImageUrl,
          detail: 'Copied from the image the page publishes.',
        };
      }
    }

    // Either there was no image, or the site would not let us read it.
    const generated = await pixabayPhotoFor(mealName, userId);
    if (generated) {
      return {
        url: generated,
        origin: 'pixabay',
        sourceUrl: null,
        detail: sourceImageUrl
          ? 'We could not copy the page’s image, so this is a stock photo we picked.'
          : 'The page has no photo, so this is a stock photo we picked.',
      };
    }

    return {
      url: null,
      origin: 'none',
      sourceUrl: null,
      detail: sourceImageUrl
        ? 'We could not copy the page’s image and found no stock photo to stand in.'
        : 'The page has no photo and we found no stock photo to stand in.',
    };
  };
}

/** Downloads a page's image through the SSRF guards and stores it. */
async function copySourceImage(
  sourceImageUrl: string,
  userId: string,
  fetchOptions: SafeFetchOptions,
): Promise<string | null> {
  const fetched = await safeFetchImage(sourceImageUrl, fetchOptions);
  if (!fetched.ok) {
    // Routine, not exceptional: most sites refuse a server-side image read.
    log({
      event: 'PHOTO:UPLOAD',
      status: 'error',
      userId,
      detail: `Could not copy source image (${fetched.reason}): ${sourceImageUrl}`,
    });
    return null;
  }

  try {
    return await storeImageBuffer(fetched.bytes, fetched.contentType || 'image/jpeg', userId);
  } catch (err) {
    log({ event: 'PHOTO:UPLOAD', status: 'error', userId, detail: 'Storing source image threw', error: err });
    return null;
  }
}
