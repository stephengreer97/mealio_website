import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    // Mirror tsconfig's "@/*" path alias.
    alias: { '@': path.resolve(__dirname) },
  },
  test: {
    environment: 'node',
    include: ['tests/api/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
  },
});
