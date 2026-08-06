/**
 * A double for `supabase.storage.from('meal-photos')`.
 *
 * The bucket lives outside the query builder, so `FakeSupabase` says nothing
 * about it: objects are not rows, and every fact about them — whether one is
 * there, whether a delete took, what URL an upload hands back — comes from this
 * side of the client. Extracted from `tests/api/admin-storage-cleanup-orphans.test.ts`
 * so the cleanup route and the two upload paths share ONE model of the bucket.
 * They have to agree: MEAL-132 is a bug whose write half is in the cleanup route
 * and whose read half is in the uploaders, and a test that saw the object side
 * differently in each place could show either half working alone.
 *
 * Every method here models what the real endpoint DOES, not what would make the
 * code under test look right — see the note on `exists`, which is the one whose
 * exact failure shape decides a branch.
 */
import { vi } from 'vitest';

/** The public prefix of the `meal-photos` bucket, as `getPublicUrl` builds it. */
export const STORAGE_BASE_URL =
  'https://etaracmlewdvzpcjrgru.supabase.co/storage/v1/object/public/meal-photos/';

/** One object in the bucket. */
export interface FakeObject {
  name: string;
  size: number;
}

export class FakeStorage {
  /** The bucket's contents. Uploads add to it; a confirmed remove takes away. */
  objects: FakeObject[] = [];

  /** Every path handed to `remove()`, whether or not it went away. */
  removed: string[] = [];
  /** Paths `remove()` silently declines to delete — a batch that half-succeeds. */
  undeletable = new Set<string>();
  /** When set, `remove()` fails outright, the way a storage outage does. */
  removeError: { message: string } | null = null;

  /** Every path handed to `upload()`, in order. */
  uploaded: string[] = [];
  /** When set, `upload()` fails. */
  uploadError: { message: string } | null = null;

  /**
   * Every path `exists()` was asked about, in order.
   *
   * Asserted as EMPTY by the cost-promise test: verifying a dedupe hit must not
   * put a round trip in front of a fresh upload.
   */
  existsCalls: string[] = [];
  /**
   * When set, `exists()` throws it — a 5xx, a DNS failure, a dropped socket.
   * See the note on `exists()` for why this throws rather than resolving.
   */
  existsError: Error | null = null;
  /** When true, `exists()` never settles, so only a deadline can end the wait. */
  existsHangs = false;

  reset(): void {
    this.objects = [];
    this.removed = [];
    this.undeletable = new Set();
    this.removeError = null;
    this.uploaded = [];
    this.uploadError = null;
    this.existsCalls = [];
    this.existsError = null;
    this.existsHangs = false;
  }

  /** Names currently in the bucket. */
  names(): string[] {
    return this.objects.map((o) => o.name);
  }

  has(path: string): boolean {
    return this.objects.some((o) => o.name === path);
  }

  /** The object side of the client: what `supabase.storage.from(bucket)` returns. */
  bucket() {
    return {
      // Models the real endpoint rather than a stub that always says "fine":
      // `remove()` answers 200 with the rows it DID delete, and a path it could
      // not delete is simply absent from that list instead of raising an error.
      // MEAL-132's write-side fix reads that list to decide which dedupe rows may
      // be dropped, so a fake returning `data: null` would have made the safe
      // branch — invalidate nothing — look correct.
      remove: async (paths: string[]) => {
        this.removed.push(...paths);
        if (this.removeError) return { data: null, error: this.removeError };
        const gone = paths.filter((p) => !this.undeletable.has(p) && this.has(p));
        this.objects = this.objects.filter((o) => !gone.includes(o.name));
        return { data: gone.map((name) => ({ name })), error: null };
      },

      upload: async (path: string, buffer: Buffer) => {
        this.uploaded.push(path);
        if (this.uploadError) return { data: null, error: this.uploadError };
        this.objects.push({ name: path, size: buffer.length });
        return { data: { path }, error: null };
      },

      getPublicUrl: (path: string) => ({ data: { publicUrl: `${STORAGE_BASE_URL}${path}` } }),

      /**
       * `exists()`, in all three of its shapes — and the third one is the reason
       * this is modelled instead of stubbed.
       *
       * storage-js issues a HEAD on the object endpoint and then:
       *
       *  - present            → resolves `{ data: true,  error: null }`
       *  - a 404 or a 400     → resolves `{ data: false, error: StorageApiError }`
       *  - ANYTHING else      → THROWS (a 5xx, DNS, a socket that died)
       *
       * A double that resolved `{ data: false }` for the third case would be
       * actively misleading here, in the same way the old `data: null` stub was
       * for `remove()`: `data: false` means "storage says it is gone", and the
       * code answers that by DELETING the dedupe row and re-uploading. Folding a
       * transient 5xx into that answer would make a row get dropped on a network
       * blip, and would leave the deliberate fall-back-to-upload branch — the
       * one that exists precisely because a failed probe proves nothing — with no
       * test at all.
       */
      exists: async (path: string) => {
        this.existsCalls.push(path);
        if (this.existsHangs) return new Promise<never>(() => {});
        if (this.existsError) throw this.existsError;
        if (this.has(path)) return { data: true, error: null };
        return {
          data: false,
          error: { name: 'StorageApiError', message: 'Object not found', status: 404 },
        };
      },
    };
  }
}

/**
 * Shared singleton, so a `vi.mock('@/lib/supabase')` factory (which is hoisted
 * above a test file's own declarations) and the test body see the same bucket.
 * Reset in beforeEach.
 */
export const fakeStorage = new FakeStorage();

/**
 * The whole `@/lib/supabase` module shape for a test that needs both halves: the
 * query builder from `supabase-mock`, and this bucket.
 *
 * `rpc` answers with the bucket listing, which is what `list_storage_objects`
 * returns for the cleanup route.
 */
export async function mockSupabaseWithStorage() {
  const { fakeDb } = await import('./supabase-mock');
  return {
    createServerSupabaseClient: () => ({
      from: (table: string) => fakeDb.from(table),
      rpc: async () => ({ data: fakeStorage.objects, error: null }),
      storage: { from: () => fakeStorage.bucket() },
    }),
    createAnonSupabaseClient: () => ({ auth: { signInWithPassword: vi.fn() } }),
  };
}
