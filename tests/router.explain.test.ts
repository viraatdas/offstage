/**
 * `explain()` is what a human or an agent actually sees. Its one hard promise
 * is that it fits on a line: no newline, no tab, never longer than the cap.
 */

import { describe, expect, it } from 'vitest';

import type { RouteDecision } from '../src/contract/index.js';
import { classify, explain } from '../src/router/index.js';

const decision = (overrides: Partial<RouteDecision> = {}): RouteDecision => ({
  lane: 'container',
  reason: 'The command asks for a headed browser, so it runs against an Xvfb display.',
  confidence: 'high',
  signals: ['argv: --headed'],
  ...overrides,
});

describe('explain', () => {
  it('renders lane, confidence, reason and signals on one line', () => {
    expect(explain(decision(), { maxLength: 500 })).toBe(
      'container (high) | The command asks for a headed browser, so it runs against an Xvfb display. | signals: argv: --headed',
    );
  });

  it('echoes the command when it is given', () => {
    const line = explain(decision(), { command: ['npx', 'playwright', 'test', '--headed'], maxLength: 500 });
    expect(line).toContain('npx playwright test --headed');
    expect(line.indexOf('npx')).toBeLessThan(line.indexOf('The command asks'));
  });

  it('omits the signals section on request', () => {
    expect(explain(decision(), { includeSignals: false, maxLength: 500 })).not.toContain('signals:');
  });

  it('omits the signals section when there are none', () => {
    expect(explain(decision({ signals: [] }), { maxLength: 500 })).not.toContain('signals:');
  });

  it('collapses newlines and tabs out of the reason and the signals', () => {
    const line = explain(
      decision({ reason: 'line one\nline two\t\tstill going', signals: ['argv:\n--headed'] }),
      { maxLength: 500 },
    );
    expect(line).not.toMatch(/[\n\t]/);
    expect(line).toContain('line one line two still going');
  });

  it('drops the signals before it cuts into the reason', () => {
    const line = explain(decision(), { maxLength: 100 });
    expect(line.length).toBeLessThanOrEqual(100);
    expect(line).not.toContain('signals:');
    expect(line).toContain('Xvfb display.');
  });

  it('truncates to the requested length, with an ellipsis', () => {
    const line = explain(decision(), { maxLength: 40 });
    expect(line.length).toBeLessThanOrEqual(40);
    expect(line.endsWith('…')).toBe(true);
    expect(line.startsWith('container (high)')).toBe(true);
  });

  it('defaults to a length that fits a terminal', () => {
    const long = decision({
      reason: 'x'.repeat(400),
      signals: ['y'.repeat(400)],
    });
    expect(explain(long).length).toBeLessThanOrEqual(160);
  });

  it('never truncates below a usable minimum', () => {
    expect(explain(decision(), { maxLength: 1 }).length).toBe(8);
  });

  it('renders every lane', () => {
    expect(explain(decision({ lane: 'headless' }), { maxLength: 500 })).toMatch(/^headless \(high\)/);
    expect(explain(decision({ lane: 'session' }), { maxLength: 500 })).toMatch(/^session \(high\)/);
    expect(explain(decision({ lane: 'container', confidence: 'low' }), { maxLength: 500 })).toMatch(
      /^container \(low\)/,
    );
  });

  it('renders REFUSED instead of a lane when the decision refuses', () => {
    const line = explain(decision({ refuse: 'A .dmg could change the machine.' }), { maxLength: 500 });
    expect(line.startsWith('REFUSED')).toBe(true);
    expect(line).not.toContain('container (high)');
  });

  it('renders a real decision end to end', async () => {
    const command = ['xcrun', 'simctl', 'boot', 'iPhone 15'];
    const line = explain(await classify({ cwd: process.cwd(), command }), { command });
    expect(line.startsWith('session (high)')).toBe(true);
    expect(line).not.toContain('\n');
    expect(line.length).toBeLessThanOrEqual(160);
  });

  it('renders the full session reason, as `offstage route` prints it, with no vm escape hatch', async () => {
    const command = ['open', '-a', 'Safari'];
    const decided = await classify({ cwd: process.cwd(), command });
    expect(decided.lane).toBe('session');
    expect(explain(decided, { command, maxLength: 4000 })).toContain('second, logged-in macOS account');
    expect(explain(decided, { command, maxLength: 4000 })).not.toContain('--lane vm');
  });

  it('renders a real refused decision end to end', async () => {
    const command = ['installer', '-pkg', 'MyApp.pkg', '-target', '/'];
    const line = explain(await classify({ cwd: process.cwd(), command }), { command });
    expect(line.startsWith('REFUSED')).toBe(true);
    expect(line).toContain('installer package to a target volume');
    expect(line.length).toBeLessThanOrEqual(160);
  });
});
