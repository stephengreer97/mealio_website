import { vi } from 'vitest';

export type QueryResult = { data?: any; error?: any; count?: number | null };

/**
 * PostgREST's URI ceiling, in bytes, as the fake enforces it.
 *
 * Filters go in the QUERY STRING, not the body, so `.in('id', ids)` grows the
 * URL linearly with the id count. Supabase fronts PostgREST with Cloudflare and
 * Kong/nginx, which reject long URIs in the 8-16 KB range. Measured against
 * supabase-js: 2000 uuids in one `.in()` is a 78 KB DELETE URL and 2000 Expo
 * tokens is a 96 KB PATCH URL - both far past any proxy's limit.
 *
 * 8 KB is the conservative end of that range, so code that stays under it here
 * stays under it everywhere. This is the constraint that makes "chunk your
 * filters" testable instead of a thing you find out in production.
 */
export const URL_LIMIT_BYTES = 8 * 1024;

/**
 * Rows a select returns when nothing asked for more, as Supabase configures
 * PostgREST.
 *
 * It is a CEILING, not an error: the response is truncated and says nothing
 * about it, so code that reads a whole table in one call gets a partial answer
 * that looks complete. A mock without this cannot tell a paged read from an
 * unpaged one, which is how a partial `creator_source_items` map — where a
 * missing record reads as "this post is new" — survives a green suite.
 */
export const MAX_ROWS = 1000;

type Filter = { op: string; column: string; value: any };

function compare(a: any, b: any): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Orders two cells the way Postgres does, NULLs included.
 *
 * Postgres treats NULL as LARGER than every value, so a bare `ORDER BY col ASC`
 * is `NULLS LAST` and `DESC` is `NULLS FIRST`, and `.order(col, { nullsFirst })`
 * is how supabase-js overrides that. Sorting NULL as `''` instead - which this
 * fake used to do - puts it first on ASC, the exact opposite of the default, and
 * that disagreement hid a real defect: the null-`expires_at` rows the refresh
 * sweep was widened to include sort to the TAIL in Postgres and are the first
 * ones `.limit()` drops. A mock that disagrees with the database is worse than
 * no mock, because it launders the bug into a green test.
 */
function compareOrdered(a: any, b: any, ascending: boolean, nullsFirst: boolean): number {
  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;
  if (aNull && bNull) return 0;
  // NULLs are placed outright rather than compared: their position is set by
  // `nullsFirst` and is not flipped again by the direction.
  if (aNull) return nullsFirst ? -1 : 1;
  if (bNull) return nullsFirst ? 1 : -1;
  return (ascending ? 1 : -1) * compare(a, b);
}

/** Postgres three-valued logic: a comparison against NULL never matches. */
function matchesFilter(row: any, f: Filter): boolean {
  const cell = row[f.column];
  switch (f.op) {
    case 'eq': return cell === f.value;
    case 'neq': return cell !== f.value;
    case 'in': return Array.isArray(f.value) && f.value.includes(cell);
    case 'is': return f.value === null ? cell === null || cell === undefined : cell === f.value;
    case 'not': return !matchesFilter(row, { op: f.value[0], column: f.column, value: f.value[1] });
    case 'lt': return cell !== null && cell !== undefined && compare(cell, f.value) < 0;
    case 'lte': return cell !== null && cell !== undefined && compare(cell, f.value) <= 0;
    case 'gt': return cell !== null && cell !== undefined && compare(cell, f.value) > 0;
    case 'gte': return cell !== null && cell !== undefined && compare(cell, f.value) >= 0;
    case 'or':
      // `col.op.value,col.op.value` - an OR of the same simple terms. Values
      // containing commas are not supported and nothing here has any.
      return String(f.value)
        .split(',')
        .some((term) => {
          const [column, op, ...rest] = term.split('.');
          const raw = rest.join('.');
          return matchesFilter(row, { op, column, value: op === 'is' && raw === 'null' ? null : raw });
        });
    default: return true;
  }
}

/** What supabase-js would put after the `?`, near enough to measure. */
function queryStringBytes(filters: Filter[]): number {
  const parts = filters.map((f) => {
    const value = f.op === 'in' && Array.isArray(f.value)
      ? `in.(${f.value.map((v) => encodeURIComponent(String(v))).join(',')})`
      : `${f.op}.${encodeURIComponent(String(f.value))}`;
    return `${encodeURIComponent(f.column)}=${value}`;
  });
  return Buffer.byteLength(parts.join('&'));
}

function project(row: any, columns?: string): any {
  if (!columns || columns.trim() === '*') return { ...row };
  const wanted = columns.split(',').map((c) => c.trim()).filter(Boolean);
  const out: any = {};
  for (const c of wanted) out[c] = row[c] ?? null;
  return out;
}

/**
 * Chainable fake for the supabase-js query builder, in two modes.
 *
 * QUEUE MODE (the original, and still the default) records every builder call
 * and replays results queued per table, FIFO:
 *
 *   db.queue('user_profiles', { data: { subscription_tier: 'free' } });
 *   db.queue('meals', { count: 3 });
 *
 * That is enough to assert the SHAPE of a query, and nothing more. Four push
 * bugs (a 78 KB DELETE URL, a revoke count that counted its own input, an
 * upsert that reassigned another user's device, a revoke that raced a
 * re-register) all survived a green suite because shape was all anyone could
 * assert.
 *
 * TABLE MODE closes that. `db.seed(table, rows)` gives a table real rows, and
 * from then on queries against it are EVALUATED: filters select, updates mutate
 * and report how many rows they actually touched, deletes remove, and `upsert`
 * resolves `onConflict` against the rows already there. `db.rows(table)` is the
 * resulting state, so a test can assert an effect rather than a call. That last
 * part is the point - a canned `{ data: [] }` proves a BRANCH was taken; it
 * cannot tell a correct conditional write from one whose predicate is
 * misspelled, dropped, or missing its `.select()`.
 *
 *   db.seed('push_tokens', [{ token: 'a', user_id: 'u1', revoked_at: null }]);
 *   await POST(...);
 *   expect(db.rows('push_tokens')[0].revoked_at).not.toBeNull();
 *
 * Both modes enforce URL_LIMIT_BYTES, because an over-long filter list is a
 * transport failure that happens before the database sees anything.
 *
 * A queued result still wins over a seeded table, so a test can inject an error
 * on one specific query of an otherwise live table.
 */
export class FakeSupabase {
  private queues = new Map<string, QueryResult[]>();
  private tables = new Map<string, any[]>();
  private uniques = new Map<string, string[]>();
  calls: Array<{ table: string; method: string; args: any[] }> = [];

  queue(table: string, result: QueryResult): this {
    if (!this.queues.has(table)) this.queues.set(table, []);
    this.queues.get(table)!.push(result);
    return this;
  }

  /**
   * Declare a UNIQUE constraint, so `insert` can lose a race the way it does in
   * Postgres — a 23505 rather than a second row.
   *
   * Opt-in per table because it is the constraint that makes a claim-first write
   * meaningful: without it two overlapping passes both insert, both proceed, and
   * the duplicate work is invisible.
   */
  unique(table: string, columns: string[]): this {
    this.uniques.set(table, columns);
    return this;
  }

  /** Give `table` real rows, switching it to table mode. Rows are copied. */
  seed(table: string, rows: any[]): this {
    this.tables.set(table, rows.map((r) => ({ ...r })));
    return this;
  }

  /** Current contents of a seeded table - the state a test asserts on. */
  rows(table: string): any[] {
    return this.tables.get(table) ?? [];
  }

  /** One stored row by primary key, as it is now. */
  row(table: string, id: string): any | null {
    return this.rows(table).find((r) => r.id === id) ?? null;
  }

  /**
   * Writes to a stored row behind the code's back - a second worker, another
   * tab, the cron. How an interleaving is staged in a test.
   */
  patch(table: string, id: string, values: Record<string, any>): this {
    const target = this.rows(table).find((r) => r.id === id);
    if (!target) throw new Error(`FakeSupabase: no ${table} row with id ${id}`);
    Object.assign(target, values);
    return this;
  }

  reset(): void {
    this.queues.clear();
    this.tables.clear();
    this.uniques.clear();
    this.calls = [];
  }

  from(table: string) {
    const queued = (): QueryResult | null => {
      const q = this.queues.get(table);
      return q && q.length > 0 ? q.shift()! : null;
    };

    // Accumulated across the chain; read once the builder is awaited.
    let op: 'select' | 'insert' | 'update' | 'delete' | 'upsert' | null = null;
    let payload: any = null;
    let columns: string | undefined;
    let conflict: string[] = [];
    let returning = false;
    const filters: Filter[] = [];
    let orderBy: { column: string; ascending: boolean; nullsFirst: boolean } | null = null;
    let rowLimit: number | null = null;
    let rowRange: { from: number; to: number } | null = null;

    const builder: any = {};
    const record = (method: string, args: any[]) => { this.calls.push({ table, method, args }); };

    builder.select = (...args: any[]) => {
      record('select', args);
      // `.select()` after a write is PostgREST's "return the rows you changed";
      // before one it IS the query.
      if (op === null) { op = 'select'; columns = args[0]; } else { returning = true; columns = args[0]; }
      return builder;
    };
    builder.insert = (...args: any[]) => { record('insert', args); op = 'insert'; payload = args[0]; return builder; };
    builder.update = (...args: any[]) => { record('update', args); op = 'update'; payload = args[0]; return builder; };
    builder.delete = (...args: any[]) => { record('delete', args); op = 'delete'; return builder; };
    builder.upsert = (...args: any[]) => {
      record('upsert', args);
      op = 'upsert';
      payload = args[0];
      conflict = String(args[1]?.onConflict ?? '').split(',').map((c) => c.trim()).filter(Boolean);
      return builder;
    };

    for (const method of ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is', 'not']) {
      builder[method] = (...args: any[]) => {
        record(method, args);
        filters.push({ op: method, column: args[0], value: method === 'not' ? args.slice(1) : args[1] });
        return builder;
      };
    }
    // `.or()` takes the whole predicate as its first argument, so it has no
    // column of its own; matchesFilter parses the string.
    builder.or = (...args: any[]) => {
      record('or', args);
      filters.push({ op: 'or', column: '', value: args[0] });
      return builder;
    };
    for (const method of ['contains', 'filter']) {
      builder[method] = (...args: any[]) => { record(method, args); return builder; };
    }
    // Inclusive at both ends, like PostgREST's `Range` header.
    builder.range = (...args: any[]) => {
      record('range', args);
      rowRange = { from: args[0], to: args[1] };
      return builder;
    };
    builder.order = (...args: any[]) => {
      record('order', args);
      const ascending = args[1]?.ascending !== false;
      // Postgres' default when the caller does not say: NULLS LAST ascending,
      // NULLS FIRST descending.
      orderBy = { column: args[0], ascending, nullsFirst: args[1]?.nullsFirst ?? !ascending };
      return builder;
    };
    builder.limit = (...args: any[]) => { record('limit', args); rowLimit = args[0]; return builder; };

    const evaluate = (): QueryResult => {
      const fromQueue = queued();
      if (fromQueue) return fromQueue;

      const bytes = queryStringBytes(filters);
      if (bytes > URL_LIMIT_BYTES) {
        // What a proxy in front of PostgREST does with an over-long URI. The
        // request never reaches the database, so nothing is written.
        return {
          data: null,
          count: null,
          error: { code: '414', message: `Request-URI Too Long (${bytes} bytes of filters)` },
        };
      }

      const rows = this.tables.get(table);
      if (!rows) return { data: null, error: null, count: null };

      const matched = rows.filter((row) => filters.every((f) => matchesFilter(row, f)));

      switch (op) {
        case 'insert':
        case 'upsert': {
          const incoming = Array.isArray(payload) ? payload : [payload];
          const key = this.uniques.get(table);
          if (op === 'insert' && key) {
            const clash = incoming.find((value) => rows.some((row) => key.every((c) => row[c] === value[c])));
            if (clash) {
              // Postgres fails the whole statement, so nothing is written.
              return {
                data: null,
                count: null,
                error: {
                  code: '23505',
                  message: `duplicate key value violates unique constraint on ${table} (${key.join(', ')})`,
                },
              };
            }
          }
          const written: any[] = [];
          for (const value of incoming) {
            const existing = op === 'upsert' && conflict.length > 0
              ? rows.find((row) => conflict.every((c) => row[c] === value[c]))
              : undefined;
            if (existing) { Object.assign(existing, value); written.push(existing); }
            else { const row = { ...value }; rows.push(row); written.push(row); }
          }
          return { data: returning ? written.map((r) => project(r, columns)) : null, error: null, count: written.length };
        }
        case 'update': {
          for (const row of matched) Object.assign(row, payload);
          return { data: returning ? matched.map((r) => project(r, columns)) : null, error: null, count: matched.length };
        }
        case 'delete': {
          for (const row of matched) rows.splice(rows.indexOf(row), 1);
          return { data: returning ? matched.map((r) => project(r, columns)) : null, error: null, count: matched.length };
        }
        default: {
          let out = [...matched];
          if (orderBy) {
            const { column, ascending, nullsFirst } = orderBy;
            out.sort((a, b) => compareOrdered(a[column], b[column], ascending, nullsFirst));
          }
          if (rowRange) out = out.slice(rowRange.from, rowRange.to + 1);
          else if (rowLimit !== null) out = out.slice(0, rowLimit);
          // Whatever the caller asked for, the server never returns more than
          // this and never says it truncated. See MAX_ROWS.
          out = out.slice(0, MAX_ROWS);
          return { data: out.map((r) => project(r, columns)), error: null, count: out.length };
        }
      }
    };

    const single = () => {
      const result = evaluate();
      if (Array.isArray(result.data)) return { ...result, data: result.data[0] ?? null };
      return result;
    };
    builder.single = () => Promise.resolve(single());
    builder.maybeSingle = () => Promise.resolve(single());
    // Thenable: `await supabase.from(t).select().eq(...)` resolves here.
    builder.then = (resolve: any, reject: any) => Promise.resolve(evaluate()).then(resolve, reject);
    return builder;
  }
}

// Shared singletons so test files and the vi.mock('@/lib/supabase') factory
// (which imports this module) see the same instances. Reset in beforeEach.
export const fakeDb = new FakeSupabase();
export const signInWithPassword = vi.fn();

/** Module shape for vi.mock('@/lib/supabase', mockSupabaseModule). */
export async function mockSupabaseModule() {
  return {
    createServerSupabaseClient: () => fakeDb,
    createAnonSupabaseClient: () => ({ auth: { signInWithPassword } }),
  };
}
