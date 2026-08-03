import { vi } from 'vitest';

export type QueryResult = { data?: any; error?: any; count?: number | null };

type Row = Record<string, any>;

/** One `.eq('status', 'x')`-style predicate, kept until the query is evaluated. */
interface Filter {
  method: string;
  args: any[];
}

const clone = <T>(value: T): T => (value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T));

/**
 * Evaluates one PostgREST filter against a stored row.
 *
 * Only the operators this codebase actually issues. An unknown one throws
 * rather than passing, because a filter the stub silently ignores is exactly
 * the hole that lets a mis-written predicate go on passing its test.
 */
function matches(row: Row, filter: Filter): boolean {
  const [column, value] = filter.args as [string, any];
  const cell = column === undefined ? undefined : row[column];
  switch (filter.method) {
    case 'eq': return cell === value;
    case 'neq': return cell !== value;
    case 'is': return value === null ? cell === null || cell === undefined : cell === value;
    case 'in': return Array.isArray(value) && value.includes(cell);
    case 'gt': return cell != null && cell > value;
    case 'gte': return cell != null && cell >= value;
    case 'lt': return cell != null && cell < value;
    case 'lte': return cell != null && cell <= value;
    case 'not':
      // `.not('col', 'is', null)` — the only spelling in use.
      return !matches(row, { method: String(filter.args[1]), args: [column, filter.args[2]] });
    case 'or':
      // `col.op.value,col.op.value` — OR of the same simple terms. Values with
      // commas in them are not supported and nothing here has any.
      return String(filter.args[0])
        .split(',')
        .some((term) => {
          const [col, op, ...rest] = term.split('.');
          const raw = rest.join('.');
          const parsed = op === 'is' && raw === 'null' ? null : raw;
          return matches(row, { method: op, args: [col, parsed] });
        });
    default:
      throw new Error(`FakeSupabase: unsupported filter .${filter.method}(${JSON.stringify(filter.args)})`);
  }
}

/**
 * Chainable fake for the supabase-js query builder, in two flavours.
 *
 * **Queued (FIFO).** `db.queue('meals', { count: 3 })` hands the next query on
 * that table a canned result, in the order the route issues them. Enough for a
 * route that reads one row and writes one row, and how most of these tests are
 * written:
 *
 *   db.queue('user_profiles', { data: { subscription_tier: 'free' } });
 *   db.queue('meals', { count: 3 });
 *
 * **Stored rows.** `db.seed('creator_sync_runs', [row])` puts a real row in the
 * stub and every subsequent query on that table runs against it: filters decide
 * which rows match, an update mutates them and `.select()` returns the ones it
 * actually changed. That last part is the point. A canned `{ data: [] }` proves
 * a *branch* was taken; it cannot tell a correct conditional write from one
 * whose predicate is misspelled, dropped, or missing its `.select()` — and
 * three of the concurrency defects on this branch (double publish, the
 * whole-array blind write, and a lease released by whoever finished last) were
 * invisible to the FIFO stub for exactly that reason.
 *
 * Queued results win where both exist, so seeding a table changes nothing for
 * tests that were written against the FIFO behaviour.
 *
 * Every method call is still recorded in `calls` for assertions on query shape.
 */
export class FakeSupabase {
  private queues = new Map<string, QueryResult[]>();
  private tables = new Map<string, Row[]>();
  calls: Array<{ table: string; method: string; args: any[] }> = [];

  queue(table: string, result: QueryResult): this {
    if (!this.queues.has(table)) this.queues.set(table, []);
    this.queues.get(table)!.push(result);
    return this;
  }

  /** Stores rows so queries on this table run against real state. */
  seed(table: string, rows: Row[]): this {
    this.tables.set(table, rows.map(clone));
    return this;
  }

  /** The stored rows, as they are now. A copy — mutate via `patch`. */
  rows(table: string): Row[] {
    return (this.tables.get(table) ?? []).map(clone);
  }

  /** One stored row by primary key, as it is now. */
  row(table: string, id: string): Row | null {
    return this.rows(table).find((row) => row.id === id) ?? null;
  }

  /**
   * Writes to a stored row behind the code's back — a second worker, another
   * tab, the cron. How an interleaving is staged in a test.
   */
  patch(table: string, id: string, values: Row): this {
    const target = (this.tables.get(table) ?? []).find((row) => row.id === id);
    if (!target) throw new Error(`FakeSupabase: no ${table} row with id ${id}`);
    Object.assign(target, clone(values));
    return this;
  }

  reset(): void {
    this.queues.clear();
    this.tables.clear();
    this.calls = [];
  }

  from(table: string) {
    const nextQueued = (): QueryResult | null => {
      const q = this.queues.get(table);
      return q && q.length > 0 ? q.shift()! : null;
    };

    const filters: Filter[] = [];
    let operation: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select';
    let payload: any = null;
    let onConflict: string[] = [];
    let returning = false;
    let limit: number | null = null;
    let order: { column: string; ascending: boolean } | null = null;

    const stored = (): Row[] | null => this.tables.get(table) ?? null;

    /** Runs the collected query against stored rows. */
    const evaluate = (single: boolean): QueryResult => {
      const rows = stored()!;
      const hit = (row: Row) => filters.every((filter) => matches(row, filter));

      if (operation === 'insert' || operation === 'upsert') {
        const incoming = (Array.isArray(payload) ? payload : [payload]).map(clone);
        const written: Row[] = [];
        for (const record of incoming) {
          const conflict = onConflict.length > 0
            ? rows.find((row) => onConflict.every((column) => row[column] === record[column]))
            : undefined;
          if (conflict && operation === 'upsert') {
            Object.assign(conflict, record);
            written.push(conflict);
          } else {
            const inserted = { id: record.id ?? `${table}-${rows.length + 1}`, ...record };
            rows.push(inserted);
            written.push(inserted);
          }
        }
        const data = single ? written[0] ?? null : written;
        return { data: clone(data), error: null, count: written.length };
      }

      if (operation === 'update') {
        // The affected count is the whole reason this stub exists: a
        // conditional write that matched nothing must come back empty, not
        // succeed silently.
        const affected = rows.filter(hit);
        for (const row of affected) Object.assign(row, clone(payload));
        // PostgREST returns rows only when the caller asked with `.select()`.
        const data = returning ? (single ? affected[0] ?? null : affected) : null;
        return { data: clone(data), error: null, count: affected.length };
      }

      if (operation === 'delete') {
        const affected = rows.filter(hit);
        this.tables.set(table, rows.filter((row) => !hit(row)));
        return { data: returning ? clone(affected) : null, error: null, count: affected.length };
      }

      let found = rows.filter(hit);
      if (order) {
        const { column, ascending } = order;
        found = [...found].sort((a, b) => {
          const left = a[column] ?? '';
          const right = b[column] ?? '';
          if (left === right) return 0;
          return (left < right ? -1 : 1) * (ascending ? 1 : -1);
        });
      }
      if (limit !== null) found = found.slice(0, limit);
      const data = single ? found[0] ?? null : found;
      return { data: clone(data), error: null, count: found.length };
    };

    const resolve = (single: boolean): QueryResult => {
      const queued = nextQueued();
      if (queued) return queued;
      if (stored()) return evaluate(single);
      return { data: null, error: null, count: null };
    };

    const builder: any = {};
    const filterMethods = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is', 'not', 'contains', 'filter', 'or'];
    for (const method of filterMethods) {
      builder[method] = (...args: any[]) => {
        this.calls.push({ table, method, args });
        filters.push({ method, args });
        return builder;
      };
    }

    builder.select = (...args: any[]) => {
      this.calls.push({ table, method: 'select', args });
      // After a write, `.select()` is the "return me the rows you touched" flag.
      if (operation === 'select') operation = 'select';
      returning = true;
      return builder;
    };
    for (const method of ['insert', 'update', 'upsert', 'delete'] as const) {
      builder[method] = (...args: any[]) => {
        this.calls.push({ table, method, args });
        operation = method;
        payload = args[0];
        const conflict = args[1]?.onConflict;
        if (typeof conflict === 'string') onConflict = conflict.split(',').map((column: string) => column.trim());
        return builder;
      };
    }
    builder.order = (column: string, options: { ascending?: boolean } = {}) => {
      this.calls.push({ table, method: 'order', args: [column, options] });
      order = { column, ascending: options.ascending !== false };
      return builder;
    };
    builder.limit = (count: number) => {
      this.calls.push({ table, method: 'limit', args: [count] });
      limit = count;
      return builder;
    };
    builder.range = (...args: any[]) => {
      this.calls.push({ table, method: 'range', args });
      return builder;
    };

    builder.single = () => Promise.resolve(resolve(true));
    builder.maybeSingle = () => Promise.resolve(resolve(true));
    // Thenable: `await supabase.from(t).select().eq(...)` resolves here.
    builder.then = (onFulfilled: any, onRejected: any) =>
      Promise.resolve(resolve(false)).then(onFulfilled, onRejected);
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
