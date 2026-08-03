import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { FakeSupabase } from '@/tests/helpers/supabase-mock';
import type { ContractEnv } from './contract-env';
import { CREATORS, DRAFTS, UNIQUES, createSql, dropSql, runDdl } from './contract-schema';

/**
 * The two backends under comparison.
 *
 * `real` is the oracle. `fake` is what is on trial. Every scenario runs the
 * IDENTICAL builder chain against both — the callback takes the client, so
 * there is no way to accidentally send a different query to each.
 */
export interface ContractClient {
  from(table: string): any;
}

export type Runner = (client: ContractClient) => PromiseLike<any>;

/** A query result reduced to the three things a caller actually branches on. */
export interface Normalized {
  data: unknown;
  count: number | null;
  errorCode: string | null;
}

export type Row = Record<string, any>;

export interface SeedSpec {
  /** Re-seeding is skipped while this is unchanged, which keeps the suite fast. */
  key: string;
  creators?: Row[];
  drafts?: Row[];
  /**
   * Builds the rows the FAKE is seeded with, given what the real database
   * actually stored. The fake cannot join, so an embed scenario uses this to
   * hand it the nested object PostgREST would have computed — which is exactly
   * how the rest of the suite uses the fake, and therefore what is worth
   * testing about it.
   */
  fakeRows?: (stored: { creators: Row[]; drafts: Row[] }) => { creators: Row[]; drafts: Row[] };
}

function normalize(result: any): Normalized {
  return {
    data: result?.data ?? null,
    count: result?.count ?? null,
    errorCode: result?.error?.code ?? null,
  };
}

const show = (value: unknown): string =>
  value === undefined ? 'undefined' : JSON.stringify(value);

/**
 * Says which backend disagreed and how.
 *
 * This is the whole value of the suite on the day it goes red: a bare
 * `toEqual` diff of two 40-row arrays tells you nothing about which side is the
 * database and which side is the thing that is wrong.
 */
export function describeDivergence(fake: Normalized, real: Normalized, operation: string): string {
  const lines: string[] = [
    '',
    'PostgREST contract mismatch — the fake Supabase client does not behave like the real one.',
    `  operation:  ${operation}`,
    '  (real = the live database, the oracle;  fake = tests/helpers/supabase-mock.ts, on trial)',
  ];

  if (fake.errorCode !== real.errorCode) {
    lines.push(
      `  error code: real ${show(real.errorCode)}  vs  fake ${show(fake.errorCode)}` +
        (real.errorCode && !fake.errorCode
          ? '   <- the database rejects this; the fake accepts it'
          : !real.errorCode && fake.errorCode
            ? '   <- the fake rejects this; the database accepts it'
            : '')
    );
  }
  if (fake.count !== real.count) {
    lines.push(`  count:      real ${show(real.count)}  vs  fake ${show(fake.count)}`);
  }

  const realData = real.data;
  const fakeData = fake.data;
  if (Array.isArray(realData) && Array.isArray(fakeData)) {
    if (realData.length !== fakeData.length) {
      lines.push(`  row count:  real ${realData.length}  vs  fake ${fakeData.length}`);
    }
    const limit = Math.max(realData.length, fakeData.length);
    for (let i = 0; i < limit; i++) {
      const a = JSON.stringify(realData[i]);
      const b = JSON.stringify(fakeData[i]);
      if (a !== b) {
        lines.push(`  first differing row, index ${i}:`);
        lines.push(`      real: ${a ?? '(no such row)'}`);
        lines.push(`      fake: ${b ?? '(no such row)'}`);
        break;
      }
    }
  } else if (JSON.stringify(realData) !== JSON.stringify(fakeData)) {
    lines.push(`  data:       real ${show(realData)}`);
    lines.push(`              fake ${show(fakeData)}`);
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Owns both backends and the seeding that keeps them identical.
 */
export class DifferentialHarness {
  readonly real: SupabaseClient;
  readonly fake = new FakeSupabase();
  private seededKey: string | null = null;

  constructor(private env: ContractEnv) {
    this.real = createClient(env.url, env.serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  /** Creates the `contract_` tables and waits for PostgREST to see them. */
  async setup(): Promise<void> {
    await runDdl(this.env, createSql());
    // The schema cache reload is asynchronous; queries 404 until it lands.
    for (let attempt = 0; attempt < 30; attempt++) {
      const [a, b] = await Promise.all([
        this.real.from(CREATORS).select('id').limit(1),
        this.real.from(DRAFTS).select('id').limit(1),
      ]);
      if (!a.error && !b.error) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(
      `PostgREST never picked up ${CREATORS}/${DRAFTS} from its schema cache. ` +
        'Refusing to continue rather than run against anything else.'
    );
  }

  /** Drops everything this suite created. Nothing is left behind. */
  async teardown(): Promise<void> {
    await runDdl(this.env, dropSql());
  }

  /** Reads a whole table back, paging past the 1000-row server ceiling. */
  private async readBack(table: string): Promise<Row[]> {
    const out: Row[] = [];
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await this.real
        .from(table)
        .select('*')
        .order('id', { ascending: true })
        .range(offset, offset + 999);
      if (error) throw new Error(`contract read-back of ${table} failed: ${error.message}`);
      out.push(...(data ?? []));
      if (!data || data.length < 1000) return out;
    }
  }

  private async insertAll(table: string, rows: Row[]): Promise<void> {
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await this.real.from(table).insert(rows.slice(i, i + 500));
      if (error) throw new Error(`contract seed of ${table} failed: ${error.message}`);
    }
  }

  /**
   * Puts the same rows in both backends.
   *
   * The fake is seeded from what the REAL database stored, not from the literal
   * input — so column defaults, type coercions and timestamp formatting are the
   * database's, and a later mismatch is a behaviour difference rather than a
   * formatting one.
   */
  async seed(spec: SeedSpec, force = false): Promise<void> {
    if (!force && this.seededKey === spec.key) return;

    // Children first: `contract_drafts` has an FK to `contract_creators`.
    await this.real.from(DRAFTS).delete().neq('id', '__no_row_has_this_id__');
    await this.real.from(CREATORS).delete().neq('id', '__no_row_has_this_id__');
    await this.insertAll(CREATORS, spec.creators ?? []);
    await this.insertAll(DRAFTS, spec.drafts ?? []);

    const stored = { creators: await this.readBack(CREATORS), drafts: await this.readBack(DRAFTS) };
    const forFake = spec.fakeRows ? spec.fakeRows(stored) : stored;

    this.fake.reset();
    this.fake.seed(CREATORS, forFake.creators);
    this.fake.seed(DRAFTS, forFake.drafts);
    // The same index declarations the real tables were built with — one source
    // of truth, so the two backends cannot drift apart through a typo. The one
    // index the fake cannot express faithfully is still declared, because the
    // closest available declaration is what a test author would reach for, and
    // the consequence of that gap is covered as a declared known difference.
    for (const unique of UNIQUES) {
      this.fake.unique(unique.table, unique.columns, unique.name);
    }

    // A forced (post-write) seed does not memoise: the scenario about to run is
    // going to dirty these tables, and recording the key here would let the NEXT
    // scenario skip re-seeding if this one threw before it could say so.
    this.seededKey = force ? null : spec.key;
  }

  /** Runs one operation against both backends and returns both results. */
  async both(run: Runner): Promise<{ fake: Normalized; real: Normalized }> {
    // The fake is in-memory and the real is over the wire; running the fake
    // first means a fake that throws does not leave a half-mutated table.
    const fake = normalize(await run(this.fake as unknown as ContractClient));
    const real = normalize(await run(this.real as unknown as ContractClient));
    return { fake, real };
  }

  /** Both backends' final view of a table, for asserting the effect of a write. */
  async finalState(table: string): Promise<{ fake: Row[]; real: Row[] }> {
    const real = await this.readBack(table);
    const fake = [...this.fake.rows(table)].sort((a, b) => String(a.id).localeCompare(String(b.id)));
    return { fake, real };
  }
}
