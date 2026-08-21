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
import type {
  DoctorReport,
  RunOutcome,
  SessionInputResult,
  SessionScreenshotResult,
  SessionSetupResult,
  SessionShareResult,
  SessionStatus,
} from './api.js';
import type { SessionApp } from '../session/index.js';

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
    // Counted, not spelled out: this sentence said "All three lanes" for one
    // lane longer than it was true, and a report that miscounts itself is the
    // last thing that should be reassuring the reader.
    lines.push(`All ${report.lanes.length} lanes are usable on this machine.`);
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
  if (decision.refuse !== undefined) {
    lines.push('');
    lines.push(
      ...wrap('offstage will refuse to run this automatically, on any lane. See reason above.'),
    );
  } else if (decision.confidence === 'low') {
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

/* -------------------------------------------------------------------------- */
/* session                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * `offstage session status`, for a human.
 *
 * The order is the order of the availability ladder in `docs/session-lane.md`,
 * so the first ✗ from the top is the thing to fix — and everything below it is
 * shown anyway, because "the socket is absent" reads very differently when the
 * line above it says the account has never been logged in.
 */
export function renderSessionStatus(status: SessionStatus): string[] {
  /* One column width for every label, so the ✓/✗ column and the value column
     both line up no matter which rows this particular machine produces. */
  const row = (ok: boolean, label: string, text: string): string =>
    `  ${ok ? CHECK : CROSS} ${label.padEnd(17)}${text}`;
  const gui = status.guiSession;
  const lines: string[] = [
    `${status.available ? CHECK : CROSS} session lane ${status.available ? 'available' : 'unavailable'} — account "${status.user}"${
      status.uid === null ? '' : ` (uid ${status.uid})`
    }`,
    '',
    row(
      status.accountExists,
      'account',
      status.accountExists ? `${status.fullName}, home ${status.home ?? 'unknown'}` : 'not on this Mac',
    ),
    row(
      gui.exists && gui.loginDone,
      'gui session',
      !gui.exists
        ? 'none — nothing is logged in under that account'
        : !gui.loginDone
          ? 'at the login window, which is not a session'
          : `logged in${gui.sessionId === null ? '' : ` (session ${gui.sessionId})`}`,
    ),
    row(
      gui.loginDone && !gui.onConsole,
      'off your screen',
      gui.onConsole
        ? 'no — that session is the one on your display right now'
        : gui.loginDone
          ? 'yes — it is running in the background'
          : 'unknown until it is logged in',
    ),
    row(
      status.socketPresent,
      'socket',
      `${status.socketPath}${status.socketPresent ? '' : ' (absent)'}`,
    ),
    row(
      status.daemon !== null,
      'daemon',
      status.daemon === null
        ? 'not answering'
        : `offstage-sessiond ${status.daemon.version}, pid ${status.daemon.pid}, protocol ${status.daemon.protocol}`,
    ),
  ];

  if (status.display !== null) {
    lines.push(
      `    ${'display'.padEnd(17)}${status.display.width}×${status.display.height} points @${status.display.scale}x (input coordinates are points)`,
    );
  }
  if (status.permissions !== null) {
    lines.push(
      row(
        status.permissions.screenCapture,
        'Screen Recording',
        status.permissions.screenCapture ? 'granted' : 'not granted — screenshots will fail',
      ),
    );
    lines.push(
      row(
        status.permissions.accessibility,
        'Accessibility',
        status.permissions.accessibility ? 'granted' : 'not granted — input injection will fail',
      ),
    );
  }

  if (status.reason !== null) {
    lines.push('');
    lines.push(...block(status.reason, '  ', '  '));
  }
  if (status.fix !== null) {
    lines.push(...block(status.fix, '  fix: ', '       '));
  }
  for (const note of status.notes) {
    lines.push('');
    lines.push(...block(note, '  note: ', '        '));
  }
  return lines;
}

/** `offstage session setup` — what it did, and what the human still has to do. */
export function renderSessionSetup(result: SessionSetupResult): string[] {
  const lines: string[] = ['', `${result.ok ? CHECK : CROSS} session setup for "${result.user}"${
    result.uid === null ? '' : ` (uid ${result.uid})`
  }`];
  for (const step of result.steps) {
    lines.push(`  ${step.ok ? CHECK : CROSS} ${step.step.padEnd(12)}${step.detail}`);
  }
  if (result.nextSteps.length > 0) {
    lines.push('');
    lines.push(result.ok ? 'Next:' : 'What to do:');
    let index = 1;
    for (const step of result.nextSteps) {
      lines.push(...block(step, `  ${index}. `, '     '));
      index += 1;
    }
  }
  return lines;
}

/** `offstage session share` — the ACLs that were applied, verbatim. */
export function renderSessionShare(result: SessionShareResult): string[] {
  const lines: string[] = [
    `${result.ok ? CHECK : CROSS} ${result.ok ? 'shared' : 'could not share'} ${result.target} with "${result.user}" (read-only)`,
  ];
  for (const command of result.commands) lines.push(`  ${command}`);
  for (const failure of result.failures) {
    lines.push(...block(`failed: ${failure.command} — ${failure.stderr}`, '  ', '    '));
  }
  if (result.ok) {
    lines.push('');
    lines.push(
      ...wrap(
        'Read only, and only this tree: a run writes to its own .offstage/runs/<id> directory, ' +
          'which the lane opens to the helper account per run.',
      ),
    );
  }
  return lines;
}

/** `offstage session screenshot` — where it landed and what it is a picture of. */
export function renderSessionScreenshot(result: SessionScreenshotResult): string[] {
  const lines = [
    `${CHECK} captured the helper session's display: ${result.width}×${result.height} px @${result.scale}x`,
  ];
  if (result.path !== null) lines.push(`  ${result.path}`);
  lines.push(
    `  ${Math.round(result.width / result.scale)}×${Math.round(result.height / result.scale)} points — divide pixel coordinates by ${result.scale} before passing them to \`offstage session click\`.`,
  );
  return lines;
}

/** `offstage session input` / `click` / `type` / `key`. */
export function renderSessionInput(result: SessionInputResult): string[] {
  return [
    `${CHECK} performed ${result.performed} action${result.performed === 1 ? '' : 's'} in the helper session`,
    ...result.actions.map((action) => `  - ${JSON.stringify(action)}`),
    '',
    ...wrap(
      'Take a screenshot now: input is fire-and-forget, and the only way to know what it did is to look.',
    ),
  ];
}

/** `offstage session apps`. */
export function renderSessionApps(apps: SessionApp[]): string[] {
  if (apps.length === 0) {
    return ['No regular apps are running in the helper session.'];
  }
  const lines = [`${apps.length} app${apps.length === 1 ? '' : 's'} running in the helper session:`];
  for (const app of apps) {
    const flags = [app.active ? 'active' : '', app.hidden ? 'hidden' : ''].filter(Boolean).join(', ');
    lines.push(
      `  - ${String(app.pid).padEnd(7)}${app.name ?? '(unnamed)'}${
        app.bundleId ? ` [${app.bundleId}]` : ''
      }${flags ? ` (${flags})` : ''}`,
    );
  }
  return lines;
}
