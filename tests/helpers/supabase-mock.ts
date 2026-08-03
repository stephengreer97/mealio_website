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
 * PostgREST's default page size, as the fake enforces it.
 *
 * A select with no `.limit()` does not return every row: it returns the first
 * `db-max-rows` of them — 1000 on Supabase — with no error, no exception and
 * nothing in the response saying the answer was cut short. Code that folds the
 * result in memory therefore keeps working perfectly on every test-sized table
 * and quietly stops being correct for exactly the rows that grew, which is the
 * kind of bug that only ever shows up on the biggest account.
 *
 * Concretely, the case that motivated this: a partial `creator_source_items`
 * map, where a record missing because it was past the page boundary reads as
 * "this post is new" and the post is imported a second time.
 */
export const DEFAULT_PAGE_ROWS = 1000;

type Filter = { op: string; column: string; value: any };

/** A partial unique index, as `FakeSupabase.unique()` records one. */
type UniqueIndex = { columns: string[]; name: string };

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

const isNull = (cell: any) => cell === null || cell === undefined;

/** Postgres three-valued logic: a comparison against NULL never matches. */
function matchesFilter(row: any, f: Filter): boolean {
  const cell = row[f.column];
  switch (f.op) {
    case 'eq': return cell === f.value;
    // `col <> 'x'` is NULL — not TRUE — when col is NULL, so Postgres drops the
    // row. Plain `!==` keeps it, and the difference is invisible until a
    // nullable column shows up: `.neq('primary_source', 'none')` is meant to
    // exclude one value and would silently start including every unset row.
    case 'neq': return !isNull(cell) && cell !== f.value;
    case 'in': return Array.isArray(f.value) && f.value.includes(cell);
    case 'is': return f.value === null ? isNull(cell) : cell === f.value;
    case 'not': {
      const inner: Filter = { op: f.value[0], column: f.column, value: f.value[1] };
      // `IS NULL` is the one predicate that is never itself NULL, so negating it
      // is ordinary boolean logic. Every other `NOT (…)` over a NULL cell is
      // NULL, and the row is dropped rather than kept.
      if (inner.op === 'is') return !matchesFilter(row, inner);
      return !isNull(cell) && !matchesFilter(row, inner);
    }
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

/**
 * Splits a select list on commas that are not inside an embed's parentheses.
 *
 * PostgREST embeds a related table as `creators!creator_id ( id, display_name )`,
 * and those inner commas are not column separators. Splitting on every comma
 * turned one embed into several nonsense keys and silently dropped the nested
 * object - which reads exactly like a row whose relation is missing, so the code
 * under test defaulted its fields and the failure surfaced somewhere else.
 */
function splitColumns(columns: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of columns) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map((c) => c.trim()).filter(Boolean);
}

/**
 * Matches one embed in a select list: `table ( … )`, `table!fk ( … )`,
 * `table!inner ( … )` and `table!fk!inner ( … )`.
 *
 * The hint is repeated, not optional-once. PostgREST stacks hints, and the app
 * writes `preset_meals!preset_meal_id!inner ( … )` in two places - a pattern
 * allowing a single `!hint` does not recognise that as an embed at all, so it
 * became a column key named after the whole expression and the relation went
 * missing. That is the original embed bug wearing a different hat.
 */
const EMBED_RE = /^([A-Za-z_][\w]*)((?:!\w+)*)\s*\(/;

/** Relation names the select list joins with `!inner`. */
function innerEmbeds(columns?: string): string[] {
  if (!columns || columns.trim() === '*') return [];
  const names: string[] = [];
  for (const column of splitColumns(columns)) {
    const embed = EMBED_RE.exec(column);
    if (embed && embed[2].split('!').includes('inner')) names.push(embed[1]);
  }
  return names;
}

function project(row: any, columns?: string): any {
  if (!columns || columns.trim() === '*') return { ...row };
  const out: any = {};
  for (const column of splitColumns(columns)) {
    // Take the whole nested value under the relation's name. The embed's own
    // column list is not enforced here; a test seeds the shape it wants and the
    // point is that the relation survives.
    const embed = EMBED_RE.exec(column);
    if (embed) {
      out[embed[1]] = row[embed[1]] ?? null;
      continue;
    }
    out[column] = row[column] ?? null;
  }
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
  private uniques = new Map<string, UniqueIndex[]>();
  calls: Array<{ table: string; method: string; args: any[] }> = [];

  queue(table: string, result: QueryResult): this {
    if (!this.queues.has(table)) this.queues.set(table, []);
    this.queues.get(table)!.push(result);
    return this;
  }

  /**
   * Declare a unique index on a seeded table, so an insert that collides fails
   * the way Postgres fails it.
   *
   * Opt-in, because a fake that enforced every real constraint would need to
   * know the schema, and every existing test seeds only the columns it cares
   * about. But a test for idempotency written against a fake that cannot express
   * a unique violation is vacuous: the second insert simply succeeds, two rows
   * appear, and the assertion that "one publish means one meal" passes against
   * code that does nothing. Declaring the index is how a test says which
   * constraint it is relying on.
   *
   * Partial, matching how this repository writes them
   * (`… WHERE publish_token IS NOT NULL`): a row with a null in any of the key
   * columns is outside the index and never conflicts, which is what lets a
   * column stay null for every row written before the index existed.
   */
  unique(table: string, columns: string[], name?: string): this {
    const list = this.uniques.get(table) ?? [];
    list.push({ columns, name: name ?? `${table}_${columns.join('_')}_key` });
    this.uniques.set(table, list);
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

  /**
   * The first declared index `candidate` would collide with, or null.
   *
   * A null (or absent) value in any key column puts the row outside a partial
   * index, so it never collides — the same reason two meals published before
   * `publish_token` existed do not conflict with each other.
   */
  private violatedUnique(table: string, rows: any[], candidate: any): UniqueIndex | null {
    for (const index of this.uniques.get(table) ?? []) {
      if (index.columns.some((c) => candidate[c] === null || candidate[c] === undefined)) continue;
      if (rows.some((row) => index.columns.every((c) => row[c] === candidate[c]))) return index;
    }
    return null;
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
    let counting = false;
    let headOnly = false;
    // Separate from `counting`, because PostgREST asks for the two in different
    // places: `{ count }` on a WRITE is an option of `insert`/`update`/`delete`
    // itself. The same option on the `.select()` that FOLLOWS a write is not a
    // count request at all - the real client answers `count: null` there - so
    // the two must not be confused.
    let writeCounting = false;

    const builder: any = {};
    const record = (method: string, args: any[]) => { this.calls.push({ table, method, args }); };

    builder.select = (...args: any[]) => {
      record('select', args);
      // `.select()` after a write is PostgREST's "return the rows you changed";
      // before one it IS the query.
      if (op === null) { op = 'select'; columns = args[0]; } else { returning = true; columns = args[0]; }
      if (args[1]?.count) counting = true;
      if (args[1]?.head) headOnly = true;
      return builder;
    };
    builder.insert = (...args: any[]) => {
      record('insert', args); op = 'insert'; payload = args[0];
      if (args[1]?.count) writeCounting = true;
      return builder;
    };
    builder.update = (...args: any[]) => {
      record('update', args); op = 'update'; payload = args[0];
      if (args[1]?.count) writeCounting = true;
      return builder;
    };
    builder.delete = (...args: any[]) => {
      record('delete', args); op = 'delete';
      if (args[0]?.count) writeCounting = true;
      return builder;
    };
    builder.upsert = (...args: any[]) => {
      record('upsert', args);
      op = 'upsert';
      payload = args[0];
      if (args[1]?.count) writeCounting = true;
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
          // Which of the incoming values land on a row that is already there,
          // decided before anything is written: a declared unique index has to
          // be judged against the rows an insert would *add*, and Postgres
          // aborts the whole statement on a violation rather than keeping the
          // rows ahead of it.
          const plan = incoming.map((value) => ({
            value,
            existing: op === 'upsert' && conflict.length > 0
              ? rows.find((row) => conflict.every((c) => row[c] === value[c]))
              : undefined,
          }));
          const pending: any[] = [];
          for (const { value, existing } of plan) {
            if (existing) continue;
            const violated = this.violatedUnique(table, [...rows, ...pending], value);
            if (violated) {
              return {
                data: null,
                count: null,
                error: {
                  code: '23505',
                  message: `duplicate key value violates unique constraint "${violated.name}"`,
                },
              };
            }
            pending.push(value);
          }

          const written: any[] = [];
          for (const { value, existing } of plan) {
            if (existing) { Object.assign(existing, value); written.push(existing); }
            else { const row = { ...value }; rows.push(row); written.push(row); }
          }
          return {
            data: returning ? written.map((r) => project(r, columns)) : null,
            error: null,
            count: writeCounting ? written.length : null,
          };
        }
        case 'update': {
          for (const row of matched) Object.assign(row, payload);
          return {
            data: returning ? matched.map((r) => project(r, columns)) : null,
            error: null,
            count: writeCounting ? matched.length : null,
          };
        }
        case 'delete': {
          for (const row of matched) rows.splice(rows.indexOf(row), 1);
          return {
            data: returning ? matched.map((r) => project(r, columns)) : null,
            error: null,
            count: writeCounting ? matched.length : null,
          };
        }
        default: {
          // `!inner` is an INNER JOIN: a row with no related row is not in the
          // result at all, and is not in the count either, because the count is
          // an aggregate over the same FROM and WHERE as the rows.
          const inner = innerEmbeds(columns);
          const visible = inner.length === 0
            ? matched
            : matched.filter((row) => inner.every((name) => row[name] !== null && row[name] !== undefined));
          let out = [...visible];
          if (orderBy) {
            const { column, ascending, nullsFirst } = orderBy;
            out.sort((a, b) => compareOrdered(a[column], b[column], ascending, nullsFirst));
          }
          if (rowRange) out = out.slice(rowRange.from, rowRange.to + 1);
          else if (rowLimit !== null) out = out.slice(0, rowLimit);
          // Whatever the caller asked for, the server never returns more than
          // this and never says it truncated. See DEFAULT_PAGE_ROWS.
          out = out.slice(0, DEFAULT_PAGE_ROWS);
          return {
            // `{ head: true }` asks for the count and no rows at all.
            data: headOnly ? null : out.map((r) => project(r, columns)),
            error: null,
            // PostgREST counts the rows the FILTERS matched and reports it in
            // `Content-Range`, so `{ count: 'exact' }` alongside a `.limit()`
            // returns "0-99/4213" — the limit does not narrow it. Returning
            // `out.length` here instead would make a query that reads the front
            // of a long queue report the queue as exactly one page long, which
            // is the number a caller reaches for precisely BECAUSE it wants to
            // know the queue is longer than a page.
            count: counting ? visible.length : null,
          };
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
