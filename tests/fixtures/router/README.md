# router fixtures

Sample projects that exist to **falsify a routing rule** rather than to be
classified. Like the rest of `tests/fixtures/**` they are excluded from this
repository's vitest run and from its TypeScript program, so they may import
packages this repo does not install.

| Fixture  | What it is                                             | Used to prove                                            |
| -------- | ------------------------------------------------------ | -------------------------------------------------------- |
| `video/` | one Playwright spec, `headless: true` + `video: 'on'`   | recording video needs no display, so `--video=on` is headless work |

## Why `video/` exists

The router's whole thesis is that isolation is a cost you pay only when a
command genuinely cannot run without a head. `--video=on` reads like it needs
one and does not: Playwright asks the browser for its own frames over CDP
(`Page.startScreencast`) and encodes them with the ffmpeg it ships, so the
renderer produces the video whether or not anything is presenting it.

`tests/router.video.test.ts` runs this project with `DISPLAY` and
`WAYLAND_DISPLAY` stripped from the environment and asserts a real WebM comes
out — EBML magic bytes, more than 2 KB of encoded frames. If that ever stops
being true, the rule that keeps `--video=on` in the headless lane is wrong and
this fixture is how you find out.

## It is gated

The block is skipped unless **both** hold, matching the headless lane's gate:

1. `@playwright/test` resolves from `video/` — the spec imports it; and
2. a Chromium build is already in the Playwright browser cache
   (`PLAYWRIGHT_BROWSERS_PATH`, or the per-platform default), marked complete by
   an `INSTALLATION_COMPLETE` file.

Nothing here ever downloads a browser. To run it locally:

```bash
npm install --no-save @playwright/test   # add `npx playwright install chromium` if you have no browser yet
npm test
```

Playwright's `outputDir` is pinned under `.offstage/` (gitignored at any depth)
for hand-runs; the test overrides it with `--output` into a temp directory, so a
run never leaves artifacts in the repository.
