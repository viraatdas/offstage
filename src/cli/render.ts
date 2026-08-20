/**
 * offstage — human rendering.
 *
 * Every function here is pure: it takes a value from `./api.js` and returns
 * lines. Nothing writes, nothing exits, nothing reads the clock. That is what
 * makes the CLI's output testable without spawning a process, and it is why
 * `index.ts` stays a thin wiring layer.
 *
 * Rendering deliberately surfaces the *qualifiers*, not just the verdicts: a
 * decision's `confidence`, a probe trigger's `certainty`, and every `note` the
 * probe recorded. A tool that prints "adhoc-ok" without saying it found no
 * evidence either way is lying by omission.
 */

import path from 'node:path';

import type { LaneResult, RouteDecision } from '../contract/index.js';
import type { EntitlementsProbeReport } from '../probe/index.js';
import type { DoctorReport, RunOutcome } from './api.js';

const CHECK = '✓';
const CROSS = '✗';

/** Wrap `text` so no line exceeds `width` columns. Long single words are not split. */
export function wrap(text: string, width = 78): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let current = words[0] as string;
  for (const word of words.slice(1)) {
    if (current.length + 1 + word.length <= width) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  lines.push(current);
  return lines;
}

/**
 * Wrap and indent a block: `first` in front of the first line, `rest` in front
 * of every continuation, so wrapped text stays visually attached to its label.
 */
export function block(text: string, first: string, rest: string, width = 78): string[] {
  return wrap(text, Math.max(20, width - rest.length)).map((line, index) =>
    index === 0 ? first + line : rest + line,
  );
}

/** `<label>: <text>`, wrapped so continuation lines align under the text. */
function field(label: string, text: string, labelWidth = 12): string[] {
  const head = `${label}:`.padEnd(labelWidth);
  if (text.trim() === '') return [`${head}(none)`];
  return block(text, head, ' '.repeat(labelWidth));
}

/** A path shown relative to `cwd` when it is inside it, absolute otherwise. */
export function displayPath(cwd: string, target: string): string {
  const rel = path.relative(path.resolve(cwd), path.resolve(target));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return target;
  return rel.split(path.sep).join('/');
}

/** `4.2s`, `860ms`, `1m 04s` — durations a human reads at a glance. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/* -------------------------------------------------------------------------- */
/* doctor                                                                     */
/* -------------------------------------------------------------------------- */

export function renderDoctor(report: DoctorReport): string[] {
  // Name the directory, not just the version: two installs both claiming the
  // same version are only the same code if they came from the same place.
  const where = report.install.root ? ` (${report.install.root})` : '';
  const lines: string[] = [
    `offstage ${report.offstageVersion}${where} — node ${report.node}, ${report.platform}/${report.arch}`,
    '',
  ];

  // An install that is lying about itself outranks any lane report, so it goes
  // first — a stale build makes everything below it untrustworthy.
  for (const warning of report.warnings) {
    lines.push(`  ${CROSS} stale build`);
    lines.push(...block(warning, '      ', '      '));
    lines.push('');
  }

  for (const health of report.lanes) {
    const mark = health.availability.available ? CHECK : CROSS;
    const status = health.availability.available ? 'available' : 'unavailable';
    lines.push(`  ${mark} ${health.lane.padEnd(10)}${status}`);
    if (health.availability.reason) {
      lines.push(...block(health.availability.reason, '      ', '      '));
    }
    if (health.availability.fix) {
      // A fix may be several commands on several lines; keep them aligned
      // under `fix:` so each one is still copy-pasteable on its own.
      const [head, ...rest] = health.availability.fix.split('\n');
      lines.push(`      fix: ${head}`);
      for (const line of rest) lines.push(`           ${line}`);
    }
    // The lane's own probe often re-states what `reason` and `fix` already
    // said. Print only what they did not cover, so doctor stays readable.
    const covered = `${health.availability.reason ?? ''}\n${health.availability.fix ?? ''}`;
    const details = health.detail.filter((detail) => {
      const trimmed = detail.trim();
      if (trimmed.startsWith('- ')) return !covered.includes(trimmed.slice(2));
      if (trimmed.startsWith('fix: ')) return !covered.includes(trimmed.slice(5));
      return true;
    });
    // A heading whose every item was already covered says nothing on its own.
    if (details.some((detail) => detail.startsWith(' '))) {
      for (const detail of details) lines.push(`      ${detail}`);
    }
    lines.push('');
  }

  const missing = report.lanes.filter((health) => !health.availability.available);
  if (missing.length === 0) {
    lines.push('All three lanes are usable on this machine.');
  } else {
    lines.push(
      ...wrap(
        `${missing.length} of ${report.lanes.length} lanes cannot run right now (${missing
          .map((health) => health.lane)
          .join(', ')}). offstage will refuse work that needs them rather than run it on your screen.`,
      ),
    );
  }
  return lines;
}

/* -------------------------------------------------------------------------- */
/* route                                                                      */
/* -------------------------------------------------------------------------- */

export function renderRoute(decision: RouteDecision, command: string[]): string[] {
  const lines = [
    ...field('command', command.join(' ')),
    ...field('lane', decision.lane),
    ...field('confidence', decision.confidence),
    ...field('reason', decision.reason),
  ];
  if (decision.signals.length > 0) {
    lines.push('signals:');
    for (const signal of decision.signals) {
      lines.push(...block(signal, '  - ', '    '));
    }
  }
  if (decision.confidence === 'low') {
    lines.push('');
    lines.push(
      ...wrap(
        'Low confidence means offstage could not settle this by reading. Pass --headed or ' +
          '--headless on the command itself and the decision becomes certain.',
      ),
    );
  }
  return lines;
}

/** The one line printed before a run starts, so a long run is not silent. */
export function renderRunHeader(event: {
  decision: RouteDecision;
  lane: string;
  laneSource: 'router' | 'explicit';
}): string[] {
  const suffix =
    event.laneSource === 'explicit' && event.lane !== event.decision.lane
      ? ` (forced; the router chose ${event.decision.lane})`
      : '';
  return [
    `→ ${event.lane} lane${suffix} — ${event.decision.reason}`,
  ];
}

/* -------------------------------------------------------------------------- */
/* run                                                                        */
/* -------------------------------------------------------------------------- */

const STATUS_MEANING: Record<LaneResult['status'], string> = {
  passed: 'the command ran and reported success',
  failed: 'the command ran and something was red',
  errored: 'the run could not be trusted — nothing can be concluded about your code',
  skipped: 'the substrate was unavailable, so nothing ran anywhere',
};

export function renderRun(outcome: RunOutcome, cwd: string): string[] {
  const { result } = outcome;
  const lines: string[] = [
    '',
    `${result.status.toUpperCase()}  ${result.lane} lane  ${formatDuration(result.durationMs)}  ` +
      `exit ${result.exitCode ?? 'none'}`,
    `  ${STATUS_MEANING[result.status]}`,
    '',
    ...field('run', displayPath(cwd, outcome.artifactsDir)),
  ];
  if (result.logPath) lines.push(...field('log', displayPath(cwd, result.logPath)));
  if (outcome.resultPath) lines.push(...field('result', displayPath(cwd, outcome.resultPath)));

  const extras = result.artifacts.filter((artifact) => artifact.kind !== 'log');
  if (extras.length > 0) {
    lines.push('artifacts:');
    for (const artifact of extras) {
      lines.push(`  - ${artifact.kind}: ${displayPath(cwd, artifact.path)}`);
    }
  }

  if (result.failures.length > 0) {
    lines.push('');
    lines.push(`failures (${result.failures.length}):`);
    for (const failure of result.failures) {
      const where = failure.file
        ? `${failure.file}${failure.line === undefined ? '' : `:${failure.line}`}`
        : '';
      const head = [where, failure.test].filter(Boolean).join(' — ');
      lines.push(`  - ${head || 'failure'}`);
      lines.push(...block(failure.message, '      ', '      '));
    }
  }

  if (result.diagnostics.length > 0) {
    lines.push('');
    lines.push('diagnostics:');
    for (const diagnostic of result.diagnostics) {
      lines.push(...block(diagnostic, '  - ', '    '));
    }
  }
  return lines;
}

/* -------------------------------------------------------------------------- */
/* probe                                                                      */
/* -------------------------------------------------------------------------- */

export function renderProbe(report: EntitlementsProbeReport): string[] {
  const lines: string[] = [
    `${report.verdict}  (${report.confidence} confidence)`,
    '',
    ...field('target', report.target),
    ...field('kind', report.targetKind),
    ...field('summary', report.summary),
  ];

  if (report.confidence === 'low' && report.verdict === 'adhoc-ok') {
    lines.push('');
    lines.push(
      ...wrap(
        'Low confidence on an adhoc-ok verdict means offstage found no blocker — not that it ' +
          'proved there is none. Read the notes below before budgeting on it.',
      ),
    );
  }

  if (report.triggers.length > 0) {
    lines.push('');
    lines.push('triggers (these force a signing lane):');
    for (const trigger of report.triggers) {
      lines.push(`  - ${trigger.key} — ${trigger.capability} [${trigger.certainty}]`);
      lines.push(...block(trigger.explanation, '      ', '      '));
    }
    if (report.triggers.some((trigger) => trigger.certainty === 'namespace-heuristic')) {
      lines.push('');
      lines.push(
        ...wrap(
          'A namespace-heuristic trigger is a guess: the key is unrecognized but sits in the ' +
            'com.apple.developer.* namespace Apple allowlists per App ID. Verify it before ' +
            'planning work around it.',
        ),
      );
    }
  }

  const bucket = (label: string, keys: string[]): void => {
    if (keys.length === 0) return;
    lines.push(...field(label, keys.join(', ')));
  };
  lines.push('');
  bucket('adhoc-ok', report.adhocSatisfied);
  bucket('team-scoped', report.teamScoped);
  bucket('inert', report.inert);
  bucket('unclassified', report.unclassified);

  if (report.sources.length > 0) {
    lines.push('sources:');
    for (const source of report.sources) {
      lines.push(`  - ${source.origin}: ${source.path}`);
    }
  }

  if (report.notes.length > 0) {
    lines.push('');
    lines.push('notes:');
    for (const note of report.notes) {
      lines.push(...block(note, '  - ', '    '));
    }
  }
  return lines;
}
