# headless lane fixtures

Sample projects the **headless lane executes**. They are not collected by this
repository's own vitest run (`vitest.config.ts` excludes `tests/fixtures/**`)
and they are outside the TypeScript program (`tsconfig.json` excludes them), so
they may import packages this repo does not install.

| Fixture        | What it is                                   | Used to prove                                  |
| -------------- | -------------------------------------------- | ---------------------------------------------- |
| `vitest-pass/` | one-assertion vitest project that passes     | `status: 'passed'`, `exitCode: 0`, log capture |
| `vitest-fail/` | same, with one red assertion                 | `status: 'failed'` + parsed `failures[]`       |
| `playwright/`  | `@playwright/test` specs, `headless: true`   | a real browser run in place, one green one red |
| `slow.mjs`     | prints one line, then hangs                  | `timeoutMs` -> `status: 'errored'`             |
| `noisy.mjs`    | prints ~1MB and exits 0                      | a log sink that cannot keep up never changes the verdict |

## The Playwright block is gated

`tests/lanes.headless.test.ts` skips the Playwright tests unless **both** are
true:

1. `@playwright/test` resolves from `playwright/`: the specs import it, so the
   lane cannot run them otherwise; and
2. a Chromium build is already present in the Playwright browser cache
   (`PLAYWRIGHT_BROWSERS_PATH`, or the per-platform default), marked complete by
   an `INSTALLATION_COMPLETE` file.

Nothing here ever downloads a browser. A suite that pulls 150MB onto a cold CI
runner is a worse outcome than a skipped test, so the gate fails closed.

Neither `@playwright/test` nor a browser is a dependency of this repository, so
in a bare checkout the block skips. To run it locally:

```bash
cd tests/fixtures/headless/playwright
npm install --no-save @playwright/test   # add `npx playwright install chromium` if you have no browser yet
cd -
npm test
```

`playwright/node_modules/` is covered by the repository's `node_modules/`
ignore rule, so a local install here never shows up in the diff. Playwright's
own `outputDir` is pinned under `.offstage/` (also ignored) for hand-runs, and
the lane test overrides it with `--output` into that run's artifacts directory.
