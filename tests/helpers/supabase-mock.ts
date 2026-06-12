import { vi } from 'vitest';

export type QueryResult = { data?: any; error?: any; count?: number | null };

/**
 * Chainable fake for the supabase-js query builder.
 *
 * Every builder method (.select, .eq, .order, …) returns the builder; the
 * query resolves when awaited directly or via .single()/.maybeSingle().
 * Resolution pops the next queued result for that table (FIFO), so a test
 * queues results in the order the route under test issues queries:
 *
 *   db.queue('user_profiles', { data: { subscription_tier: 'free' } });
 *   db.queue('meals', { count: 3 });
 *
 * Unqueued queries resolve to { data: null, error: null, count: null },
 * which matches "row not found" semantics for most routes. Every method
 * call is recorded in `calls` for assertions on query shape.
 */
export class FakeSupabase {
  private queues = new Map<string, QueryResult[]>();
  calls: Array<{ table: string; method: string; args: any[] }> = [];

  queue(table: string, result: QueryResult): this {
    if (!this.queues.has(table)) this.queues.set(table, []);
    this.queues.get(table)!.push(result);
    return this;
  }

  reset(): void {
    this.queues.clear();
    this.calls = [];
  }

  from(table: string) {
    const next = (): QueryResult => {
      const q = this.queues.get(table);
      return q && q.length > 0 ? q.shift()! : { data: null, error: null, count: null };
    };

    const builder: any = {};
    const chainable = [
      'select', 'insert', 'update', 'delete', 'upsert',
      'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is', 'not',
      'contains', 'filter', 'or', 'order', 'limit', 'range',
    ];
    for (const method of chainable) {
      builder[method] = (...args: any[]) => {
        this.calls.push({ table, method, args });
        return builder;
      };
    }
    builder.single = () => Promise.resolve(next());
    builder.maybeSingle = () => Promise.resolve(next());
    // Thenable: `await supabase.from(t).select().eq(...)` resolves here.
    builder.then = (resolve: any, reject: any) => Promise.resolve(next()).then(resolve, reject);
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
