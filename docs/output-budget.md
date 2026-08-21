# The output budget

Every lane has to answer the same question about a command's output: how much of
it do we keep, and where? offstage's answer has two halves that pull against
each other, and both are promises, not defaults.

> **4 MB is retained in memory for parsing. `command.log` on disk is complete.**

The in-memory half exists because a runaway command can print gigabytes and
offstage must survive it. The on-disk half exists because the log is what a
human opens when the parsed summary is not enough — a log that quietly loses its
middle is worse than no log, because nothing says it happened.

The headless lane (`src/lanes/headless/runner.ts`) implements this. The
container and session lanes capture output too, so the reasoning is written
down here rather than left in one lane's comments.

## What holds it up

Three things, and dropping any one of them collapses a promise:

1. **The in-memory bound is exact, whatever the chunk sizes are.**
   `CappedText` keeps `MAX_CAPTURED_CHARS` characters, evicting the *oldest*
   because reporters print their failure summary last. Eviction trims inside the
   oldest chunk rather than only at chunk boundaries, and a single chunk larger
   than the whole budget is trimmed as it arrives — so the retained size is the
   cap, not "the cap rounded up to whatever the pipe handed us".

2. **Eviction is O(1) amortized.** Output arrives in pieces as small as one
   line, so a gigabyte is millions of writes. A buffer that `shift()`s a large
   array on each one is quadratic: measured on 64 MB of 31-character writes,
   that is ~33 s of pure buffer overhead versus ~30 ms for an index-and-compact
   buffer. The cap exists to survive runaway output; it must not itself be what
   hangs on it.

3. **The disk log cannot become the buffer instead.** `Writable.write()`
   returning `false` means the bytes are now in the stream's *unbounded* queue.
   Writing on regardless converts a slow sink into heap growth proportional to
   the entire output — the same blow-up the cap forbids, arriving through the
   file. Measured while writing a 262 MB log to a local SSD: 52.8 MB queued in
   memory at peak. `appendWithBackpressure()` waits for `drain`, which stops the
   lane reading the child, fills the pipe and throttles the *command*. Nothing
   is dropped and memory stays bounded — a slow disk slows the run, which is the
   honest trade.

## What the result says

When output is dropped, the lane says so in `diagnostics`: how many characters
went, that `failures[]` therefore reflects only the end of the run, and that
`command.log` on disk is still complete. A partial parse that does not announce
itself reads exactly like a whole one, which is the kind of quiet lie the
`LaneResult` contract exists to prevent.

## For the container and session lanes

Same budget, same disclosure. Whatever ferries output out of a guest or a
helper session, the two promises are unchanged: bound what you hold in memory,
and hand back a complete log on disk. `CappedText` and
`appendWithBackpressure` are exported from `src/lanes/headless/runner.ts` and
are substrate-agnostic — reuse them rather than re-deriving the trade-off, and
if a lane genuinely cannot keep the log whole (a guest that dies mid-copy,
say), say so in `diagnostics` instead of returning a truncated log that looks
complete.

Locked by `tests/lanes.headless.capture.test.ts`.
