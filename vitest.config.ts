import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only files we author as tests run. `tests/fixtures/**` is deliberately
    // excluded: lane fixtures contain Playwright/Jest spec files that are meant
    // to be executed *by the lane under test*, never by this vitest run.
    //
    // The `.test.ts` in this glob is also what lets a shared helper sit beside
    // the suites without being run as one: `tests/*.fixtures.ts` and
    // `tests/*.helpers.ts` are imported by the suites, never collected. Widen
    // this to `tests/**/*.ts` and each of them fails with "No test suite found".
    // tests/test-helpers.test.ts locks both halves of that.
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
