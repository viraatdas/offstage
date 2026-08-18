import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only files we author as tests run. `tests/fixtures/**` is deliberately
    // excluded: lane fixtures contain Playwright/Jest spec files that are meant
    // to be executed *by the lane under test*, never by this vitest run.
    include: ['tests/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.offstage/**',
      'tests/fixtures/**',
    ],
    // Lanes shell out to docker/tart/xcodebuild, which are slow even when they
    // only get as far as reporting "substrate unavailable".
    testTimeout: 60_000,
    hookTimeout: 60_000,
    reporters: ['default'],
  },
});
