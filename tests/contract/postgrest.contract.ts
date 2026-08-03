import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { contractEnv, skipReason } from './helpers/contract-env';
import { CREATORS, DRAFTS } from './helpers/contract-schema';
import {
  DifferentialHarness,
  describeDivergence,
  type ContractClient,
  type Normalized,
  type Row,
  type Runner,
  type SeedSpec,
} from './helpers/differential';

/**
 * PostgREST contract suite — does the fake Supabase client behave like the real one?
 *
 * ## Not part of `npm test`
 *
 *     npm run test:contract
 *
 * It talks to the live Supabase project, so it is opt-in the same way the
 * extraction eval is: its own vitest config, its own script, and a clean skip
 * with a printed reason when `.env.contract` is not there. `npm test` stays
 * offline and fast.
 *
 * ## Why this exists
 *
 * `tests/helpers/supabase-mock.ts` is a hand-written stand-in for
 * Supabase/PostgREST, and roughly 1500 tests run against it. It has now hidden
 * four production bugs, every one the same shape: the code was wrong, the test
 * passed, and nothing could tell — because the test and the code shared the same
 * wrong assumption about what the database does.
 *
 *   1. NULL ordering. Postgres puts NULLs LAST on ASC. The fake put them first,
 *      so a query that needed `nullsFirst` looked fine, and the longest-waiting
 *      creator was never polled.
 *   2. `{ count: 'exact' }` with `.limit()`. PostgREST counts what the FILTERS
 *      matched. The fake returned the page length, so a 4,000-row queue reported
 *      as exactly 100 — the one number a caller asks for BECAUSE it wants to
 *      know the queue exceeds a page.
 *   3. Embedded selects. `creators!creator_id ( display_name )` is a LEFT JOIN,
 *      not three columns. The fake split select lists on every comma and
 *      silently dropped the embed.
 *   4. Unique constraints. The fake could not express one, so "one publish
 *      attempt creates one meal" passed against code that did nothing.
 *
 * Patching each as it was found did not stop the next one. This suite closes the
 * category, and it is DIFFERENTIAL by design: no test here asserts what Postgres
 * does. Each runs the identical operation against both backends and asserts the
 * results match. The real client is the oracle; the fake is on trial. A test
 * that only exercised the real database would prove nothing about the fake,
 * which is the thing the rest of the suite actually runs against.
 *
 * ## When to run it
 *
 * - Before merging any change to `tests/helpers/supabase-mock.ts`.
 * - When a bug reaches production that a unit test "covered" — check whether the
 *   fake and the database agree about the semantics involved.
 * - When adopting a PostgREST feature the fake has not modelled before (a new
 *   filter, an embed shape, a `Prefer` header).
 *
 * ## Safety
 *
 * It creates its own `contract_`-prefixed tables in `public`, is their only
 * writer, and drops them at the end. It never reads or writes a production
 * table. If setup fails it throws rather than falling back to anything else.
 *
 * ## Known differences
 *
 * Where the fake and the database genuinely disagree and the fake was left
 * alone, the scenario carries a `knownDifference` with the reason. Those tests
 * assert that the divergence is STILL THERE, so closing the gap in the fake
 * turns this suite red and tells you to delete the entry. There is no way for a
 * known difference to rot quietly.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Four creators and three drafts.
 *
 * Every sort column holds distinct non-NULL values plus AT MOST ONE NULL, so the
 * ordering scenarios have a total order and the comparison is not at the mercy
 * of Postgres' freedom to return tied rows in any order.
 */
const STANDARD: SeedSpec = {
  key: 'standard',
  creators: [
    { id: 'c1', display_name: 'Ada', handle: 'ada', score: 30, active: true, last_polled_at: '2026-01-01T00:00:00Z' },
    { id: 'c2', display_name: 'Bea', handle: 'bea', score: 10, active: false, last_polled_at: null },
    { id: 'c3', display_name: null, handle: 'cyd', score: 20, active: null, last_polled_at: '2026-03-01T00:00:00Z' },
    { id: 'c4', display_name: 'Dee', handle: 'dee', score: 40, active: true, last_polled_at: '2026-02-01T00:00:00Z' },
  ],
  drafts: [
    { id: 'd1', creator_id: 'c1', title: 'first', publish_token: 'tok-1', slug: 's1', kind: 'video', bucket: null, state: 'draft' },
    { id: 'd2', creator_id: null, title: 'orphan', publish_token: null, slug: null, kind: 'video', bucket: null, state: 'draft' },
    { id: 'd3', creator_id: 'c1', title: 'third', publish_token: 'tok-3', slug: null, kind: 'post', bucket: 'cold', state: 'live' },
  ],
};

/** 1100 rows — past the server's 1000-row default page ceiling. */
const BIG: SeedSpec = {
  key: 'big-1100',
  creators: Array.from({ length: 1100 }, (_, i) => ({
    id: `b${String(i).padStart(5, '0')}`,
    display_name: `creator ${i}`,
    handle: `h${i}`,
    score: i,
    active: i % 2 === 0,
    last_polled_at: null,
  })),
  drafts: [],
};

const pick = (row: Row, columns: string[]): Row =>
  Object.fromEntries(columns.map((c) => [c, row[c] ?? null]));

/**
 * Hands the fake the LEFT JOIN result PostgREST computes.
 *
 * The fake cannot join — a test seeds the nested shape it expects. That IS what
 * is under test here: given the row PostgREST would have produced, does the
 * fake's column projection carry the embed through, and does a missing relation
 * come back as `null` rather than a dropped key?
 */
const withEmbed = (columns: string[] | null): SeedSpec['fakeRows'] =>
  ({ creators, drafts }) => ({
    creators,
    drafts: drafts.map((draft) => {
      const parent = creators.find((c) => c.id === draft.creator_id);
      return {
        ...draft,
        [CREATORS]: parent ? (columns ? pick(parent, columns) : { ...parent }) : null,
      };
    }),
  });

const EMBEDDED: SeedSpec = { ...STANDARD, key: 'standard+embed', fakeRows: withEmbed(['display_name']) };

// ---------------------------------------------------------------------------
// Scenario shape
// ---------------------------------------------------------------------------

interface KnownDifference {
  /** Why the fake was left as it is. */
  why: string;
  /** Pins today's fake behaviour, so fixing the fake turns this test red. */
  fakeShows: (fake: Normalized, real: Normalized) => void;
}

interface Scenario {
  name: string;
  /** The chain, spelled out for the failure message. */
  operation: string;
  seed?: SeedSpec;
  run: Runner;
  /** The query has no ORDER BY, so Postgres may return any order: compare as a set. */
  unordered?: boolean;
  /** Writes to the tables; both backends get a fresh seed and the next scenario re-seeds. */
  mutates?: boolean;
  /** Also compare both backends' resulting view of this table. */
  finalState?: string;
  knownDifference?: KnownDifference;
}

/** Key-order-independent string form, used only as a sort key. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Row).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${k}:${canonical(v)}`).join(',')}}`;
}

function sortForSetCompare(result: Normalized): Normalized {
  if (!Array.isArray(result.data)) return result;
  return { ...result, data: [...result.data].sort((a, b) => canonical(a).localeCompare(canonical(b))) };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const ORDERING: Scenario[] = [
  {
    // HISTORICAL BUG 1. This is the production query shape: the poller takes the
    // creator that has waited longest, and a never-polled creator has waited
    // forever. In Postgres those NULL rows sort to the TAIL on ASC and are the
    // first thing `.limit()` drops, which is why the caller must say nullsFirst.
    name: 'longest-waiting first: order(asc, nullsFirst) + limit(1)',
    operation: `.select('id').order('last_polled_at', { ascending: true, nullsFirst: true }).limit(1)`,
    run: (c: ContractClient) =>
      c.from(CREATORS).select('id, last_polled_at').order('last_polled_at', { ascending: true, nullsFirst: true }).limit(1),
  },
  {
    name: 'ASC with no nullsFirst puts NULLs LAST',
    operation: `.select('id, last_polled_at').order('last_polled_at')`,
    run: (c: ContractClient) => c.from(CREATORS).select('id, last_polled_at').order('last_polled_at'),
  },
  {
    name: 'DESC with no nullsFirst puts NULLs FIRST',
    operation: `.order('last_polled_at', { ascending: false })`,
    run: (c: ContractClient) =>
      c.from(CREATORS).select('id, last_polled_at').order('last_polled_at', { ascending: false }),
  },
  {
    name: 'ASC + nullsFirst: true',
    operation: `.order('last_polled_at', { ascending: true, nullsFirst: true })`,
    run: (c: ContractClient) =>
      c.from(CREATORS).select('id, last_polled_at').order('last_polled_at', { ascending: true, nullsFirst: true }),
  },
  {
    name: 'ASC + nullsFirst: false',
    operation: `.order('last_polled_at', { ascending: true, nullsFirst: false })`,
    run: (c: ContractClient) =>
      c.from(CREATORS).select('id, last_polled_at').order('last_polled_at', { ascending: true, nullsFirst: false }),
  },
  {
    name: 'DESC + nullsFirst: true',
    operation: `.order('last_polled_at', { ascending: false, nullsFirst: true })`,
    run: (c: ContractClient) =>
      c.from(CREATORS).select('id, last_polled_at').order('last_polled_at', { ascending: false, nullsFirst: true }),
  },
  {
    name: 'DESC + nullsFirst: false',
    operation: `.order('last_polled_at', { ascending: false, nullsFirst: false })`,
    run: (c: ContractClient) =>
      c.from(CREATORS).select('id, last_polled_at').order('last_polled_at', { ascending: false, nullsFirst: false }),
  },
  {
    name: 'ordering a text column with a NULL, ASC and DESC',
    operation: `.order('display_name')`,
    run: (c: ContractClient) => c.from(CREATORS).select('id, display_name').order('display_name'),
  },
  {
    name: 'no .order() at all — same set of rows, order unspecified',
    operation: `.select('id')`,
    unordered: true,
    run: (c: ContractClient) => c.from(CREATORS).select('id'),
  },
];

const PAGING: Scenario[] = [
  {
    name: '.limit(2) after an order',
    operation: `.order('score').limit(2)`,
    run: (c: ContractClient) => c.from(CREATORS).select('id, score').order('score').limit(2),
  },
  {
    name: '.range(1, 3) is inclusive at BOTH ends — three rows, not two',
    operation: `.order('score').range(1, 3)`,
    run: (c: ContractClient) => c.from(CREATORS).select('id, score').order('score').range(1, 3),
  },
  {
    name: '.range(0, 0) is one row',
    operation: `.order('score').range(0, 0)`,
    run: (c: ContractClient) => c.from(CREATORS).select('id').order('score').range(0, 0),
  },
  {
    name: '.range() past the end of the table',
    operation: `.order('score').range(10, 20)`,
    run: (c: ContractClient) => c.from(CREATORS).select('id').order('score').range(10, 20),
  },
];

const BIG_PAGING: Scenario[] = [
  {
    // The silent one: no error, no exception, nothing saying the answer was cut
    // short. Code that folds the result in memory keeps working on every
    // test-sized table and quietly stops being correct for the account that grew.
    name: 'no .limit() stops at the 1000-row page ceiling, silently',
    operation: `.select('id').order('id')  // 1100 rows in the table`,
    seed: BIG,
    run: (c: ContractClient) => c.from(CREATORS).select('id').order('id'),
  },
  {
    name: '.limit(1100) is still capped at 1000',
    operation: `.select('id').order('id').limit(1100)`,
    seed: BIG,
    run: (c: ContractClient) => c.from(CREATORS).select('id').order('id').limit(1100),
  },
  {
    name: '.range(0, 1099) is still capped at 1000',
    operation: `.select('id').order('id').range(0, 1099)`,
    seed: BIG,
    run: (c: ContractClient) => c.from(CREATORS).select('id').order('id').range(0, 1099),
  },
  {
    // HISTORICAL BUG 2, at the size that made it matter.
    name: 'count exact over 1100 rows with limit(10) reports 1100, not 10',
    operation: `.select('id', { count: 'exact' }).order('id').limit(10)`,
    seed: BIG,
    run: (c: ContractClient) => c.from(CREATORS).select('id', { count: 'exact' }).order('id').limit(10),
  },
  {
    name: 'count exact with no rows requested still sees past the page ceiling',
    operation: `.select('id', { count: 'exact', head: true })  // 1100 rows`,
    seed: BIG,
    run: (c: ContractClient) => c.from(CREATORS).select('id', { count: 'exact', head: true }),
  },
];

const COUNTING: Scenario[] = [
  {
    // HISTORICAL BUG 2. The limit does not narrow the count: PostgREST answers
    // `Content-Range: 0-1/4` — what the FILTERS matched, over the page returned.
    name: 'count exact + limit counts the filter matches, not the page',
    operation: `.select('id', { count: 'exact' }).order('id').limit(2)`,
    run: (c: ContractClient) => c.from(CREATORS).select('id', { count: 'exact' }).order('id').limit(2),
  },
  {
    name: 'count exact + range counts the filter matches, not the window',
    operation: `.select('id', { count: 'exact' }).order('id').range(1, 2)`,
    run: (c: ContractClient) => c.from(CREATORS).select('id', { count: 'exact' }).order('id').range(1, 2),
  },
  {
    name: 'count exact + a filter counts what the filter matched',
    operation: `.select('id', { count: 'exact' }).eq('active', true).order('id')`,
    run: (c: ContractClient) => c.from(CREATORS).select('id', { count: 'exact' }).eq('active', true).order('id'),
  },
  {
    name: 'count exact + a filter matching nothing',
    operation: `.select('id', { count: 'exact' }).eq('handle', 'nobody')`,
    run: (c: ContractClient) => c.from(CREATORS).select('id', { count: 'exact' }).eq('handle', 'nobody'),
  },
  {
    name: '{ head: true } returns the count and no rows at all',
    operation: `.select('id', { count: 'exact', head: true })`,
    run: (c: ContractClient) => c.from(CREATORS).select('id', { count: 'exact', head: true }),
  },
  {
    name: '{ head: true } alongside a filter',
    operation: `.select('id', { count: 'exact', head: true }).eq('active', true)`,
    run: (c: ContractClient) => c.from(CREATORS).select('id', { count: 'exact', head: true }).eq('active', true),
  },
  {
    name: 'no count option means count is null, not a number',
    operation: `.select('id').order('id')`,
    run: (c: ContractClient) => c.from(CREATORS).select('id').order('id'),
  },
];

const FILTERS: Scenario[] = [
  {
    name: 'eq',
    operation: `.eq('handle', 'ada')`,
    run: (c: ContractClient) => c.from(CREATORS).select('id, handle').eq('handle', 'ada'),
  },
  {
    name: 'eq against a column whose value is NULL in one row',
    operation: `.eq('display_name', 'Ada')`,
    run: (c: ContractClient) => c.from(CREATORS).select('id').eq('display_name', 'Ada'),
  },
  {
    // Three-valued logic: `display_name <> 'zzz'` is NULL for the NULL row, and
    // NULL is not TRUE, so Postgres drops it. A fake using `!==` keeps it.
    name: 'neq excludes rows whose cell is NULL (three-valued logic)',
    operation: `.neq('display_name', 'zzz').order('id')`,
    run: (c: ContractClient) => c.from(CREATORS).select('id, display_name').neq('display_name', 'zzz').order('id'),
  },
  {
    name: 'neq that excludes a real value',
    operation: `.neq('handle', 'ada').order('id')`,
    run: (c: ContractClient) => c.from(CREATORS).select('id').neq('handle', 'ada').order('id'),
  },
  {
    name: 'in with a value that is not there',
    operation: `.in('id', ['c1', 'c3', 'nope']).order('id')`,
    run: (c: ContractClient) => c.from(CREATORS).select('id').in('id', ['c1', 'c3', 'nope']).order('id'),
  },
  {
    name: 'in with an empty list',
    operation: `.in('id', [])`,
    run: (c: ContractClient) => c.from(CREATORS).select('id').in('id', []),
  },
  {
    name: 'is null',
    operation: `.is('active', null).order('id')`,
    run: (c: ContractClient) => c.from(CREATORS).select('id, active').is('active', null).order('id'),
  },
  {
    name: 'is false — NOT the same rows as is null',
    operation: `.is('active', false).order('id')`,
    run: (c: ContractClient) => c.from(CREATORS).select('id, active').is('active', false).order('id'),
  },
  {
    name: 'is true',
    operation: `.is('active', true).order('id')`,
    run: (c: ContractClient) => c.from(CREATORS).select('id, active').is('active', true).order('id'),
  },
  {
    name: 'gte',
    operation: `.gte('score', 20).order('score')`,
    run: (c: ContractClient) => c.from(CREATORS).select('id, score').gte('score', 20).order('score'),
  },
  {
    name: 'lte',
    operation: `.lte('score', 20).order('score')`,
    run: (c: ContractClient) => c.from(CREATORS).select('id, score').lte('score', 20).order('score'),
  },
  {
    name: 'gte and lte together',
    operation: `.gte('score', 20).lte('score', 30).order('score')`,
    run: (c: ContractClient) => c.from(CREATORS).select('id, score').gte('score', 20).lte('score', 30).order('score'),
  },
  {
    name: 'not(col, is, null) — the production "has been set" filter',
    operation: `.not('last_polled_at', 'is', null).order('id')`,
    run: (c: ContractClient) => c.from(CREATORS).select('id').not('last_polled_at', 'is', null).order('id'),
  },
  {
    name: 'not(col, eq, value) also excludes NULL cells',
    operation: `.not('display_name', 'eq', 'zzz').order('id')`,
    run: (c: ContractClient) => c.from(CREATORS).select('id, display_name').not('display_name', 'eq', 'zzz').order('id'),
  },
  {
    name: 'two filters compose as AND',
    operation: `.eq('active', true).gte('score', 35)`,
    run: (c: ContractClient) => c.from(CREATORS).select('id').eq('active', true).gte('score', 35),
  },
];

const EMBEDS: Scenario[] = [
  {
    // HISTORICAL BUG 3. `contract_creators!creator_id ( display_name )` is one
    // resource embed and a LEFT JOIN, not two columns named by splitting on the
    // comma. Splitting turned it into nonsense keys and dropped the nested
    // object — which reads exactly like a row whose relation is missing.
    name: 'embed survives column projection, and an absent relation is null (LEFT JOIN)',
    operation: `.select('id, title, contract_creators!creator_id ( display_name )').order('id')`,
    seed: EMBEDDED,
    run: (c: ContractClient) =>
      c.from(DRAFTS).select(`id, title, ${CREATORS}!creator_id ( display_name )`).order('id'),
  },
  {
    name: 'embed alongside several plain columns',
    operation: `.select('id, title, state, contract_creators!creator_id ( display_name )').order('id')`,
    seed: EMBEDDED,
    run: (c: ContractClient) =>
      c.from(DRAFTS).select(`id, title, state, ${CREATORS}!creator_id ( display_name )`).order('id'),
  },
  {
    name: '!inner drops rows that have no related row',
    operation: `.select('id, contract_creators!inner ( display_name )').order('id')`,
    seed: EMBEDDED,
    run: (c: ContractClient) => c.from(DRAFTS).select(`id, ${CREATORS}!inner ( display_name )`).order('id'),
  },
  {
    // The two-hint form production uses: `preset_meals!preset_meal_id!inner(...)`.
    // A regex that allows only ONE `!hint` does not recognise this as an embed
    // at all, which is bug 3 wearing a different hat.
    name: 'fk hint AND !inner together — the two-hint form the app actually writes',
    operation: `.select('id, contract_creators!creator_id!inner ( display_name )').order('id')`,
    seed: EMBEDDED,
    run: (c: ContractClient) =>
      c.from(DRAFTS).select(`id, ${CREATORS}!creator_id!inner ( display_name )`).order('id'),
  },
  {
    name: 'count exact with !inner counts the JOINED rows, not the base table',
    operation: `.select('id, contract_creators!inner ( display_name )', { count: 'exact' }).order('id')`,
    seed: EMBEDDED,
    run: (c: ContractClient) =>
      c.from(DRAFTS).select(`id, ${CREATORS}!inner ( display_name )`, { count: 'exact' }).order('id'),
  },
  {
    name: 'embed with two columns inside it',
    operation: `.select('id, contract_creators!creator_id ( display_name, handle )').order('id')`,
    seed: { ...STANDARD, key: 'standard+embed2', fakeRows: withEmbed(['display_name', 'handle']) },
    run: (c: ContractClient) =>
      c.from(DRAFTS).select(`id, ${CREATORS}!creator_id ( display_name, handle )`).order('id'),
  },
  {
    name: 'the fake does not enforce an embed\'s own column list',
    operation: `.select('id, contract_creators!creator_id ( display_name )')  // fake seeded with the whole parent row`,
    seed: { ...STANDARD, key: 'standard+embed-all', fakeRows: withEmbed(null) },
    run: (c: ContractClient) =>
      c.from(DRAFTS).select(`id, ${CREATORS}!creator_id ( display_name )`).order('id'),
    knownDifference: {
      why:
        'The fake takes whatever nested object the test seeded under the relation name and does not ' +
        'trim it to the embed\'s column list — its own documented design ("a test seeds the shape it ' +
        'wants and the point is that the relation survives"). Harmless in practice: a test that seeds ' +
        'extra fields is asserting on the ones it seeded. Trimming would mean parsing the embed body, ' +
        'which is a parser this fake deliberately does not have.',
      fakeShows: (fake) => {
        const rows = fake.data as Row[];
        // The whole parent row came through, not just display_name.
        expect(Object.keys(rows[0][CREATORS] as Row).sort()).toContain('handle');
      },
    },
  },
];

const WRITES: Scenario[] = [
  {
    name: 'update().eq().select() returns the rows it actually changed',
    operation: `.update({ state: 'live' }).eq('state', 'draft').select('id, state')`,
    mutates: true,
    unordered: true,
    finalState: DRAFTS,
    run: (c: ContractClient) => c.from(DRAFTS).update({ state: 'live' }).eq('state', 'draft').select('id, state'),
  },
  {
    name: 'update() whose predicate matches nothing returns an empty array, not null',
    operation: `.update({ state: 'x' }).eq('state', 'nothing').select('id')`,
    mutates: true,
    finalState: DRAFTS,
    run: (c: ContractClient) => c.from(DRAFTS).update({ state: 'x' }).eq('state', 'nothing').select('id'),
  },
  {
    name: 'update() with no .select() returns no rows',
    operation: `.update({ state: 'live' }).eq('id', 'd1')`,
    mutates: true,
    finalState: DRAFTS,
    run: (c: ContractClient) => c.from(DRAFTS).update({ state: 'live' }).eq('id', 'd1'),
  },
  {
    // `{ count }` on the select that FOLLOWS a write is not a count request:
    // supabase-js takes the option on `update()` itself, so this form silently
    // returns no count at all. Easy to write and easy to misread.
    name: 'update().select(_, { count }) does NOT produce a count — the option is on the wrong call',
    operation: `.update({ state: 'live' }).eq('id', 'd1').select('id', { count: 'exact' })`,
    mutates: true,
    run: (c: ContractClient) => c.from(DRAFTS).update({ state: 'live' }).eq('id', 'd1').select('id', { count: 'exact' }),
  },
  {
    // …whereas here it is on the write, which is the form that works.
    name: 'update(values, { count: exact }) DOES produce a count',
    operation: `.update({ state: 'live' }, { count: 'exact' }).eq('state', 'draft').select('id')`,
    mutates: true,
    unordered: true,
    finalState: DRAFTS,
    run: (c: ContractClient) =>
      c.from(DRAFTS).update({ state: 'live' }, { count: 'exact' }).eq('state', 'draft').select('id'),
  },
  {
    name: 'delete({ count: exact }) produces a count',
    operation: `.delete({ count: 'exact' }).eq('state', 'draft').select('id')`,
    mutates: true,
    unordered: true,
    finalState: DRAFTS,
    run: (c: ContractClient) => c.from(DRAFTS).delete({ count: 'exact' }).eq('state', 'draft').select('id'),
  },
  {
    name: 'delete().eq().select() returns the rows it removed',
    operation: `.delete().eq('id', 'd3').select('id, title')`,
    mutates: true,
    finalState: DRAFTS,
    run: (c: ContractClient) => c.from(DRAFTS).delete().eq('id', 'd3').select('id, title'),
  },
  {
    name: 'insert().select() returns the inserted row',
    operation: `.insert({ id: 'd9', ... }).select('id, title')`,
    mutates: true,
    finalState: DRAFTS,
    run: (c: ContractClient) =>
      c
        .from(DRAFTS)
        .insert({ id: 'd9', creator_id: 'c4', title: 'ninth', publish_token: 'tok-9', slug: 's9', kind: 'video', bucket: null, state: 'draft' })
        .select('id, title'),
  },
  {
    name: 'insert() with no .select() returns no rows',
    operation: `.insert({ id: 'd8', ... })`,
    mutates: true,
    finalState: DRAFTS,
    run: (c: ContractClient) =>
      c.from(DRAFTS).insert({ id: 'd8', creator_id: null, title: 'eighth', publish_token: null, slug: null, kind: null, bucket: null, state: 'draft' }),
  },
];

const UNIQUES: Scenario[] = [
  {
    // HISTORICAL BUG 4. A fake that cannot express a unique index makes any
    // idempotency test vacuous: the second insert simply succeeds.
    name: 'partial unique index: a duplicate publish_token is 23505',
    operation: `.insert({ id: 'dup', publish_token: 'tok-1' }).select('id')`,
    mutates: true,
    finalState: DRAFTS,
    run: (c: ContractClient) =>
      c
        .from(DRAFTS)
        .insert({ id: 'dup', creator_id: null, title: 'dup', publish_token: 'tok-1', slug: null, kind: null, bucket: null, state: 'draft' })
        .select('id'),
  },
  {
    // `where publish_token is not null`: a row with a NULL key is outside the
    // index, which is what lets every meal written before the column existed
    // keep its NULL without conflicting.
    name: 'partial unique index: a second NULL publish_token does NOT conflict',
    operation: `.insert({ id: 'nul', publish_token: null }).select('id')`,
    mutates: true,
    finalState: DRAFTS,
    run: (c: ContractClient) =>
      c
        .from(DRAFTS)
        .insert({ id: 'nul', creator_id: null, title: 'nul', publish_token: null, slug: null, kind: null, bucket: null, state: 'draft' })
        .select('id'),
  },
  {
    name: 'full unique index on a nullable column: a duplicate slug is 23505',
    operation: `.insert({ id: 'dup2', slug: 's1' }).select('id')`,
    mutates: true,
    finalState: DRAFTS,
    run: (c: ContractClient) =>
      c
        .from(DRAFTS)
        .insert({ id: 'dup2', creator_id: null, title: 'dup2', publish_token: null, slug: 's1', kind: null, bucket: null, state: 'draft' })
        .select('id'),
  },
  {
    // Postgres indexes are NULLS DISTINCT by default, so this is the same rule
    // as the partial index above — it is not the `where` clause doing it.
    name: 'full unique index: NULLs are distinct, so a third NULL slug is fine',
    operation: `.insert({ id: 'nul2', slug: null }).select('id')`,
    mutates: true,
    finalState: DRAFTS,
    run: (c: ContractClient) =>
      c
        .from(DRAFTS)
        .insert({ id: 'nul2', creator_id: null, title: 'nul2', publish_token: null, slug: null, kind: null, bucket: null, state: 'draft' })
        .select('id'),
  },
  {
    name: 'composite unique index: a duplicate (creator_id, kind) pair is 23505',
    operation: `.insert({ id: 'dup3', creator_id: 'c1', kind: 'video' }).select('id')`,
    mutates: true,
    finalState: DRAFTS,
    run: (c: ContractClient) =>
      c
        .from(DRAFTS)
        .insert({ id: 'dup3', creator_id: 'c1', title: 'dup3', publish_token: null, slug: null, kind: 'video', bucket: null, state: 'draft' })
        .select('id'),
  },
  {
    name: 'composite unique index: a NULL in EITHER column is outside the index',
    operation: `.insert({ id: 'dup4', creator_id: null, kind: 'video' }).select('id')`,
    mutates: true,
    finalState: DRAFTS,
    run: (c: ContractClient) =>
      c
        .from(DRAFTS)
        .insert({ id: 'dup4', creator_id: null, title: 'dup4', publish_token: null, slug: null, kind: 'video', bucket: null, state: 'draft' })
        .select('id'),
  },
  {
    name: 'primary key collision is 23505 too',
    operation: `.insert({ id: 'd1' }).select('id')`,
    mutates: true,
    run: (c: ContractClient) =>
      c
        .from(DRAFTS)
        .insert({ id: 'd1', creator_id: null, title: 'clash', publish_token: null, slug: null, kind: null, bucket: null, state: 'draft' })
        .select('id'),
    knownDifference: {
      why:
        'The fake has no notion of a primary key — `unique()` is the only constraint it models, and ' +
        'the `contract_drafts_pkey` index is not one a test would think to declare. It therefore ' +
        'appends a SECOND row with the same id instead of raising 23505. Declaring `unique(table, ' +
        "['id'])" +
        ' in a test that cares is the workaround; teaching the fake that `id` is special ' +
        'would break every test that seeds partial rows without one.',
      fakeShows: (fake, real) => {
        expect(real.errorCode).toBe('23505');
        expect(fake.errorCode).toBeNull();
      },
    },
  },
  {
    name: 'a batch insert where one row collides writes NOTHING',
    operation: `.insert([{ id: 'ok' }, { id: 'bad', publish_token: 'tok-1' }]).select('id')`,
    mutates: true,
    finalState: DRAFTS,
    run: (c: ContractClient) =>
      c
        .from(DRAFTS)
        .insert([
          { id: 'okrow', creator_id: null, title: 'ok', publish_token: 'tok-ok', slug: null, kind: null, bucket: null, state: 'draft' },
          { id: 'badrow', creator_id: null, title: 'bad', publish_token: 'tok-1', slug: null, kind: null, bucket: null, state: 'draft' },
        ])
        .select('id'),
  },
  {
    name: 'an index predicate that is not "is not null" — beyond what the fake can say',
    operation: `.insert({ id: 'b2', bucket: 'cold' }).select('id')  // index is: where bucket = 'hot'`,
    mutates: true,
    run: (c: ContractClient) =>
      c
        .from(DRAFTS)
        .insert({ id: 'b2', creator_id: null, title: 'b2', publish_token: null, slug: null, kind: null, bucket: 'cold', state: 'draft' })
        .select('id'),
    knownDifference: {
      why:
        "The real index is `unique (bucket) where bucket = 'hot'`, so two 'cold' rows are outside it " +
        'and both insert. `FakeSupabase.unique()` can only express "NULL in a key column is outside ' +
        'the index", so the closest declaration is a full index — which over-rejects and returns ' +
        '23505. Nothing in this repository writes a partial index with a value predicate; ' +
        '`publish_token is not null` is the shape we use. If one is ever added, this fake needs a ' +
        'predicate argument before any test about it means anything.',
      fakeShows: (fake, real) => {
        expect(real.errorCode).toBeNull();
        expect(fake.errorCode).toBe('23505');
      },
    },
  },
  {
    name: 'an UPDATE that collides with a unique index',
    operation: `.update({ publish_token: 'tok-1' }).eq('id', 'd3').select('id')`,
    mutates: true,
    run: (c: ContractClient) => c.from(DRAFTS).update({ publish_token: 'tok-1' }).eq('id', 'd3').select('id'),
    knownDifference: {
      why:
        'The fake checks declared unique indexes on insert/upsert only, so an update that moves a row ' +
        'onto an existing key silently succeeds where Postgres raises 23505. Worth knowing before ' +
        'writing a test about a token being REASSIGNED; the publish path only ever inserts, which is ' +
        'the case that was covered.',
      fakeShows: (fake, real) => {
        expect(real.errorCode).toBe('23505');
        expect(fake.errorCode).toBeNull();
      },
    },
  },
];

const SINGLE_ROW: Scenario[] = [
  {
    name: '.single() on one row',
    operation: `.eq('id', 'c1').single()`,
    run: (c: ContractClient) => c.from(CREATORS).select('id, handle').eq('id', 'c1').single(),
  },
  {
    name: '.maybeSingle() on one row',
    operation: `.eq('id', 'c1').maybeSingle()`,
    run: (c: ContractClient) => c.from(CREATORS).select('id, handle').eq('id', 'c1').maybeSingle(),
  },
  {
    name: '.maybeSingle() on zero rows is null and NO error',
    operation: `.eq('id', 'nope').maybeSingle()`,
    run: (c: ContractClient) => c.from(CREATORS).select('id').eq('id', 'nope').maybeSingle(),
  },
  {
    name: '.single() on zero rows is an ERROR (PGRST116), not a null',
    operation: `.eq('id', 'nope').single()`,
    run: (c: ContractClient) => c.from(CREATORS).select('id').eq('id', 'nope').single(),
    knownDifference: {
      why:
        'PostgREST cannot coerce zero rows to one object and returns PGRST116; the fake returns ' +
        '`{ data: null, error: null }`. Both make `if (!data)` true, which is how every call site in ' +
        'app/ and lib/ is written, so the branch taken is the same. It is `if (error)` that differs — ' +
        'a code path that treats a missing row as an infrastructure failure would be tested wrongly ' +
        'here. Left alone because ~50 call sites and their tests are built on the current behaviour; ' +
        'a test that needs the error can queue it: `db.queue(table, { error: { code: "PGRST116" } })`.',
      fakeShows: (fake, real) => {
        expect(real.errorCode).toBe('PGRST116');
        expect(real.data).toBeNull();
        expect(fake.errorCode).toBeNull();
        expect(fake.data).toBeNull();
      },
    },
  },
  {
    name: '.single() on many rows is an ERROR (PGRST116), not the first row',
    operation: `.select('id').single()  // 4 rows match`,
    run: (c: ContractClient) => c.from(CREATORS).select('id').single(),
    knownDifference: {
      why:
        'Same root cause. The fake hands back the FIRST row, which is the dangerous direction: a query ' +
        'the author believed was unique but is not looks correct in tests and picks an arbitrary row ' +
        'in production. Not fixed here for the same blast-radius reason as zero rows, but this is the ' +
        'entry to close first if the fake ever gets a second pass.',
      fakeShows: (fake, real) => {
        expect(real.errorCode).toBe('PGRST116');
        expect(real.data).toBeNull();
        expect(fake.errorCode).toBeNull();
        expect(fake.data).not.toBeNull();
      },
    },
  },
  {
    name: '.maybeSingle() on many rows is ALSO an error',
    operation: `.select('id').maybeSingle()  // 4 rows match`,
    run: (c: ContractClient) => c.from(CREATORS).select('id').maybeSingle(),
    knownDifference: {
      why:
        '"maybe" is about zero-or-one, not about many: supabase-js still errors on more than one row. ' +
        'The fake returns the first. Same reasoning as `.single()` on many rows.',
      fakeShows: (fake, real) => {
        expect(real.errorCode).toBe('PGRST116');
        expect(fake.errorCode).toBeNull();
        expect(fake.data).not.toBeNull();
      },
    },
  },
];

const GROUPS: Array<[string, Scenario[]]> = [
  ['ordering and NULL placement', ORDERING],
  ['limit and range', PAGING],
  ['the 1000-row default page ceiling', BIG_PAGING],
  ['count: exact', COUNTING],
  ['filters', FILTERS],
  ['resource embeds', EMBEDS],
  ['conditional writes', WRITES],
  ['unique violations and SQLSTATE 23505', UNIQUES],
  ['single() and maybeSingle()', SINGLE_ROW],
];

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

const title = contractEnv
  ? 'PostgREST contract — fake supabase-mock vs the real client'
  : `PostgREST contract — SKIPPED: ${skipReason}. Run \`npm run test:contract\` with .env.contract present.`;

describe.skipIf(!contractEnv)(title, () => {
  let harness: DifferentialHarness;

  beforeAll(async () => {
    harness = new DifferentialHarness(contractEnv!);
    await harness.setup();
  }, 120_000);

  afterAll(async () => {
    if (harness) await harness.teardown();
  }, 120_000);

  for (const [group, scenarios] of GROUPS) {
    describe(group, () => {
      for (const scenario of scenarios) {
        it(scenario.name, async () => {
          await harness.seed(scenario.seed ?? STANDARD, scenario.mutates === true);

          const raw = await harness.both(scenario.run);
          const fake = scenario.unordered ? sortForSetCompare(raw.fake) : raw.fake;
          const real = scenario.unordered ? sortForSetCompare(raw.real) : raw.real;

          if (scenario.knownDifference) {
            // A declared difference has to STILL BE THERE. Fixing the fake turns
            // this red, which is the prompt to delete the entry.
            scenario.knownDifference.fakeShows(fake, real);
            expect(
              canonical(fake),
              `\nDECLARED KNOWN DIFFERENCE NO LONGER EXISTS — the fake now matches the real client for:\n` +
                `  ${scenario.name}\n  ${scenario.operation}\n` +
                `Delete the knownDifference entry from tests/contract/postgrest.contract.ts.\n` +
                `Reason it was recorded:\n  ${scenario.knownDifference.why}\n`
            ).not.toEqual(canonical(real));
          } else {
            expect(fake, describeDivergence(fake, real, scenario.operation)).toEqual(real);
          }

          if (scenario.finalState) {
            const state = await harness.finalState(scenario.finalState);
            expect(
              state.fake,
              `\nPostgREST contract mismatch — the two backends' ${scenario.finalState} ` +
                `differ AFTER the write.\n  operation:  ${scenario.operation}\n` +
                `  real has ${state.real.length} rows, fake has ${state.fake.length}\n`
            ).toEqual(state.real);
          }
        }, 60_000);
      }
    });
  }
});
