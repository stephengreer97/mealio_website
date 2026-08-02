import { vi } from 'vitest';

export type QueryResult = { data?: any; error?: any; count?: number | null };

/**
 * PostgREST's URI ceiling, in bytes, as the fake enforces it.
 *
 * Filters go in the QUERY STRING, not the body, so `.in('id', ids)` grows the
 * URL linearly with the id count. Supabase fronts PostgREST with Cloudflare and
 * Kong/nginx, which reject long URIs in the 8–16 KB range. Measured against
 * supabase-js: 2000 uuids in one `.in()` is a 78 KB DELETE URL and 2000 Expo
 * tokens is a 96 KB PATCH URL — both far past any proxy's limit.
 *
 * 8 KB is the conservative end of that range, so code that stays under it here
 * stays under it everywhere. This is the constraint that makes "chunk your
 * filters" testable instead of a thing you find out in production.
 */
export const URL_LIMIT_BYTES = 8 * 1024;

type Filter = { op: string; column: string; value: any };

function compare(a: any, b: any): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
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
 * resulting state, so a test can assert an effect rather than a call.
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
  calls: Array<{ table: string; method: string; args: any[] }> = [];

  queue(table: string, result: QueryResult): this {
    if (!this.queues.has(table)) this.queues.set(table, []);
    this.queues.get(table)!.push(result);
    return this;
  }

  /** Give `table` real rows, switching it to table mode. Rows are copied. */
  seed(table: string, rows: any[]): this {
    this.tables.set(table, rows.map((r) => ({ ...r })));
    return this;
  }

  /** Current contents of a seeded table — the state a test asserts on. */
  rows(table: string): any[] {
    return this.tables.get(table) ?? [];
  }

  reset(): void {
    this.queues.clear();
    this.tables.clear();
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
    let orderBy: { column: string; ascending: boolean } | null = null;
    let rowLimit: number | null = null;

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
    for (const method of ['contains', 'filter', 'or', 'range']) {
      builder[method] = (...args: any[]) => { record(method, args); return builder; };
    }
    builder.order = (...args: any[]) => {
      record('order', args);
      orderBy = { column: args[0], ascending: args[1]?.ascending !== false };
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
            const { column, ascending } = orderBy;
            out.sort((a, b) => (ascending ? 1 : -1) * compare(a[column], b[column]));
          }
          if (rowLimit !== null) out = out.slice(0, rowLimit);
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
