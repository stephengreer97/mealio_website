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
  /**
   * When the object was created, as `storage.objects.created_at` renders through
   * PostgREST: an ISO 8601 string with an offset, or null (the column is
   * nullable). Left off, it defaults to `DEFAULT_CREATED_AT` — long ago, so a test
   * that says nothing about age is testing an object old enough to sweep.
   *
   * `null` and absent are NOT the same thing here, and the difference is the one
   * MEAL-133's fix turns on: null is an object of unknown age in a listing that
   * HAS the column, which the route keeps; the column being absent from the
   * listing altogether is the pre-migration function, under which no age is
   * knowable at all. `rpcHasCreatedAt` is what models the second case.
   */
  createdAt?: string | null;
}

/**
 * The age an object has unless a test says otherwise: 2020, i.e. far outside any
 * grace window. Chosen so `bucket.objects = [{ name, size }]` keeps meaning
 * "an object a sweep may delete", which is what every test written before
 * MEAL-133 assumed.
 */
export const DEFAULT_CREATED_AT = '2020-01-01T00:00:00+00:00';

export class FakeStorage {
  /** The bucket's contents. Uploads add to it; a confirmed remove takes away. */
  objects: FakeObject[] = [];

  /**
   * Whether `list_storage_objects` returns a `created_at` column — i.e. whether
   * `supabase/migrations/20260807000002_list_storage_objects_created_at.sql` has
   * been applied.
   *
   * Defaults to true, the post-migration shape. Set it to false to run a test
   * against the function as production has it until Stephen applies the migration:
   * every row then arrives with the KEY ABSENT, exactly as `select=*` renders a
   * function that does not declare the column, and no object's age is knowable.
   *
   * Modelled as a shape switch rather than as "created_at is null everywhere"
   * because the route must tell those two apart — the first has to keep behaving
   * as it did before MEAL-133, the second protects every object — and a double
   * that could not express the difference would let either behaviour pass for the
   * other.
   */
  rpcHasCreatedAt = true;

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
    this.rpcHasCreatedAt = true;
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

      // Stamped with the current time, because storage stamps `created_at` with
      // `now()` and a double that back-dated a fresh upload would make MEAL-133's
      // whole window untestable: the object this route must NOT delete is
      // precisely the one that has just been uploaded. `Date.now()` is honoured
      // (rather than read once) so a test holding the clock can move an object
      // through the window.
      upload: async (path: string, buffer: Buffer) => {
        this.uploaded.push(path);
        if (this.uploadError) return { data: null, error: this.uploadError };
        this.objects.push({
          name: path,
          size: buffer.length,
          createdAt: new Date(Date.now()).toISOString(),
        });
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
 * returns for the cleanup route — and it answers THROUGH `FakeSupabase`, as a real
 * query builder over the pseudo-table `rpc:list_storage_objects`, not as a resolved
 * array.
 *
 * That mattered. This double used to be `async () => ({ data: objects })`, which
 * silently disagreed with PostgREST about two things at once. It served every
 * object however many there were — so it could not have failed a route that read
 * the bucket in one unbounded call, which is MEAL-134 — and it accepted no
 * `.select()`, `.order()` or `.range()`, so a route that paged the RPC could not
 * be driven through it at all. `FakeSupabase.rpc()` already models a set-returning
 * function as a table subject to `DEFAULT_PAGE_ROWS` (see its comment), and this is
 * the same model rather than a second one; the seed happens per call because tests
 * assign `bucket.objects` after `beforeEach` and uploads mutate it mid-request.
 *
 * `fakeDb.queue('rpc:list_storage_objects', …)` still overrides one page, which is
 * how a failed page read is staged.
 */
export async function mockSupabaseWithStorage() {
  const { fakeDb } = await import('./supabase-mock');
  return {
    createServerSupabaseClient: () => ({
      from: (table: string) => fakeDb.from(table),
      rpc: (fn: string, args?: Record<string, unknown>) => {
        // The rows the function would return, in the shape the migration decides:
        // `created_at` present (post-migration, value defaulted when the test does
        // not care) or the key absent altogether (pre-migration).
        fakeDb.seed(`rpc:${fn}`, fakeStorage.objects.map((o) => ({
          name: o.name,
          size: o.size,
          ...(fakeStorage.rpcHasCreatedAt
            ? { created_at: o.createdAt === undefined ? DEFAULT_CREATED_AT : o.createdAt }
            : {}),
        })));
        return fakeDb.rpc(fn, args);
      },
      storage: { from: () => fakeStorage.bucket() },
    }),
    createAnonSupabaseClient: () => ({ auth: { signInWithPassword: vi.fn() } }),
  };
}
