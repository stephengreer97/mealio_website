import { defineConfig } from 'vitest/config';
import path from 'path';

/**
 * The PostgREST differential contract suite.
 *
 * Separate from `vitest.config.ts` because it talks to the live Supabase
 * project and creates real (throwaway, `contract_`-prefixed) tables — `npm test`
 * must never pick it up and must stay offline.
 *
 *   npm run test:contract
 *
 * Skips cleanly with a printed reason when `.env.contract` is absent. See the
 * header of tests/contract/postgrest.contract.ts for what it covers and why.
 */
export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname) },
  },
  test: {
    environment: 'node',
    include: ['tests/contract/**/*.contract.ts'],
    // No `tests/setup.ts`: it points the Supabase env vars at an invalid host on
    // purpose, and a contract suite that quietly ran against `supabase.invalid`
    // would pass while proving nothing. Credentials come from `.env.contract`.
    setupFiles: [],
    // Scenarios share one set of tables and re-seed between writes, so they must
    // not interleave.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
