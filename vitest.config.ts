import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: [
      'packages/**/*.test.ts',
      'apps/server/**/*.test.ts',
      'apps/web/**/*.test.{ts,tsx}',
    ],
    setupFiles: ['apps/server/test-support/vitest-setup.ts'],
  },
});
