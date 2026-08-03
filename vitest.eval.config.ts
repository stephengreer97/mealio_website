import { defineConfig } from 'vitest/config';
import path from 'path';

/**
 * The extraction eval set (MEAL-71). Separate from `vitest.config.ts` because it
 * makes real, billed Anthropic API calls — `npm test` must never pick it up.
 *
 *   npm run test:eval
 *   EVAL_MODEL=claude-sonnet-5 npm run test:eval
 */
export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname) },
  },
  test: {
    environment: 'node',
    include: ['tests/eval/**/*.eval.ts'],
    setupFiles: ['tests/setup.ts'],
    // One item at a time, so a rate limit doesn't look like an accuracy problem.
    fileParallelism: false,
    testTimeout: 180_000,
  },
});
