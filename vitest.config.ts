import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  // Needed only by tests/ui/**, which render real client components. The lib
  // and api suites are unaffected and still run in the node environment.
  plugins: [react()],
  resolve: {
    // Mirror tsconfig's "@/*" path alias.
    alias: { '@': path.resolve(__dirname) },
  },
  test: {
    environment: 'node',
    include: ['tests/api/**/*.test.ts', 'tests/lib/**/*.test.ts', 'tests/ui/**/*.test.tsx'],
    // UI files opt into jsdom with a `@vitest-environment jsdom` docblock.
    setupFiles: ['tests/setup.ts'],
  },
});
