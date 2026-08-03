import type { ContractEnv } from './contract-env';

/**
 * The tables this suite owns.
 *
 * Everything is prefixed `contract_` and lives in `public` (PostgREST cannot see
 * any other schema). NOTHING here touches a production table: the suite creates
 * these at start, is the only writer, and drops them at the end. If creation
 * fails the suite throws — it must never quietly fall back to a real table.
 *
 * The unique indexes are declared once here and are the SAME declaration the
 * fake is given via `FakeSupabase.unique()`, so the two backends are set up from
 * one source of truth rather than two hand-copied lists that can drift.
 */
export const CREATORS = 'contract_creators';
export const DRAFTS = 'contract_drafts';

/** A unique index, in the subset of index shapes the fake can express. */
export interface UniqueSpec {
  table: string;
  name: string;
  columns: string[];
  /**
   * The index predicate, or null for a full index.
   *
   * `FakeSupabase.unique()` only models "a NULL in any key column is outside the
   * index" — which is what Postgres does for a full index on nullable columns
   * AND for `where <col> is not null`. Any other predicate is beyond it; those
   * are marked here and covered as declared known differences.
   */
  predicate: string | null;
  /** True when `FakeSupabase.unique()` can represent this index faithfully. */
  fakeCanExpress: boolean;
}

export const UNIQUES: UniqueSpec[] = [
  {
    // The production shape: `preset_meals.publish_token` is exactly this.
    table: DRAFTS,
    name: 'contract_drafts_publish_token_key',
    columns: ['publish_token'],
    predicate: 'publish_token is not null',
    fakeCanExpress: true,
  },
  {
    // A full index on a nullable column. Postgres defaults to NULLS DISTINCT, so
    // any number of rows may hold NULL here — the same rule as the partial one.
    table: DRAFTS,
    name: 'contract_drafts_slug_key',
    columns: ['slug'],
    predicate: null,
    fakeCanExpress: true,
  },
  {
    // Composite. A NULL in EITHER column puts the row outside the index.
    table: DRAFTS,
    name: 'contract_drafts_creator_kind_key',
    columns: ['creator_id', 'kind'],
    predicate: null,
    fakeCanExpress: true,
  },
  {
    // A predicate that is not "is not null". The fake has no way to say this;
    // the closest it can do is a full index, which over-rejects.
    table: DRAFTS,
    name: 'contract_drafts_hot_bucket_key',
    columns: ['bucket'],
    predicate: "bucket = 'hot'",
    fakeCanExpress: false,
  },
];

/** DDL for the whole suite, idempotent. */
export function createSql(): string {
  const indexes = UNIQUES.map(
    (u) =>
      `create unique index ${u.name} on public.${u.table} (${u.columns.join(', ')})` +
      (u.predicate ? ` where ${u.predicate}` : '') +
      ';'
  ).join('\n');
  return `
drop table if exists public.${DRAFTS} cascade;
drop table if exists public.${CREATORS} cascade;

create table public.${CREATORS} (
  id            text primary key,
  display_name  text,
  handle        text,
  score         int,
  active        boolean,
  last_polled_at timestamptz
);

create table public.${DRAFTS} (
  id            text primary key,
  creator_id    text references public.${CREATORS}(id),
  title         text,
  publish_token text,
  slug          text,
  kind          text,
  bucket        text,
  state         text
);

${indexes}

-- Service-role reads bypass RLS, but leaving it off on a public-schema table is
-- the kind of thing a security scan flags. On, with no policies: only the
-- service role this suite uses can see it.
alter table public.${CREATORS} enable row level security;
alter table public.${DRAFTS} enable row level security;

notify pgrst, 'reload schema';
`;
}

export function dropSql(): string {
  return `
drop table if exists public.${DRAFTS} cascade;
drop table if exists public.${CREATORS} cascade;
notify pgrst, 'reload schema';
`;
}

/** Runs SQL through the Supabase management API. Throws loudly on failure. */
export async function runDdl(env: ContractEnv, sql: string): Promise<void> {
  const response = await fetch(
    `https://api.supabase.com/v1/projects/${env.projectRef}/database/query`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.managementToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query: sql }),
    }
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Contract suite DDL failed (${response.status}). The suite refuses to run ` +
        `against anything it did not create, so this is fatal.\n${body}`
    );
  }
}
