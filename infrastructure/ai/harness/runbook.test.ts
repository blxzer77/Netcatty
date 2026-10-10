import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isRunbook,
  parseRunbook,
  renderRunbookSteps,
  runbookGoal,
  runbookStepsToPlanSteps,
  validateRunbook,
} from './runbook';

const runbookText = [
  '# Runbook: rotate the proxy certificate',
  '> Renew the certificate on the proxy hosts without dropping the tunnel.',
  'targets: proxy hosts',
  '',
  '## Steps',
  '1. Back up the current certificate',
  '   - command: certbot certificates --dry-run',
  '   - verify: the dry run reports success',
  '2. Renew',
  '   - command: certbot renew',
  '   - verify: systemctl reload exits 0',
].join('\n');

describe('runbook parsing', () => {
  it('parses the heading, description, targets and steps', () => {
    assert.equal(isRunbook(runbookText), true);
    const runbook = parseRunbook(runbookText);
    assert.ok(runbook);
    assert.equal(runbook.name, 'rotate the proxy certificate');
    assert.equal(runbook.description, 'Renew the certificate on the proxy hosts without dropping the tunnel.');
    assert.equal(runbook.targets, 'proxy hosts');
    assert.deepEqual(runbook.steps, [
      { id: 'step-1', title: 'Back up the current certificate', command: 'certbot certificates --dry-run', verify: 'the dry run reports success' },
      { id: 'step-2', title: 'Renew', command: 'certbot renew', verify: 'systemctl reload exits 0' },
    ]);
  });

  it('returns null for free-form skill guidance', () => {
    assert.equal(isRunbook('Diagnose first, then change.'), false);
    assert.equal(parseRunbook('Diagnose first, then change.'), null);
  });

  it('parses a runbook with no steps section instead of throwing', () => {
    const runbook = parseRunbook('# Runbook: empty\n> nothing yet');
    assert.ok(runbook);
    assert.deepEqual(runbook.steps, []);
  });

  it('keeps a step title that has no fields', () => {
    const runbook = parseRunbook('# Runbook: t\n\n## Steps\n1. Just do the thing');
    assert.deepEqual(runbook.steps, [{ id: 'step-1', title: 'Just do the thing' }]);
  });
});

describe('runbook validation', () => {
  it('reports a runbook with no steps', () => {
    const issues = validateRunbook(parseRunbook('# Runbook: empty')!);
    assert.equal(issues.length, 1);
    assert.match(issues[0].message, /no steps/);
  });

  it('reports a step without a command and one without verification', () => {
    const runbook = parseRunbook([
      '# Runbook: partial',
      '## Steps',
      '1. No command here',
      '   - verify: something',
      '2. No verification',
      '   - command: ls',
    ].join('\n'))!;
    const issues = validateRunbook(runbook);

    assert.equal(issues.length, 2);
    assert.match(issues[0].message, /has no command/);
    assert.equal(issues[0].stepId, 'step-1');
    assert.match(issues[1].message, /has no verification/);
    assert.equal(issues[1].stepId, 'step-2');
  });

  it('passes a complete runbook', () => {
    assert.deepEqual(validateRunbook(parseRunbook(runbookText)!), []);
  });
});

describe('runbook to plan', () => {
  it('converts steps mechanically, keeping commands and verification', () => {
    const steps = runbookStepsToPlanSteps(parseRunbook(runbookText)!);
    assert.deepEqual(steps, [
      { id: 'step-1', title: 'Back up the current certificate', command: 'certbot certificates --dry-run', verification: 'the dry run reports success' },
      { id: 'step-2', title: 'Renew', command: 'certbot renew', verification: 'systemctl reload exits 0' },
    ]);
    // Targets are resolved by the agent, never invented here.
    for (const step of steps) {
      assert.equal('sessionId' in step, false);
    }
  });

  it('renders a compact step list for the prompt', () => {
    const rendered = renderRunbookSteps(parseRunbook(runbookText)!);
    assert.match(rendered ?? '', /1\. Back up the current certificate — command: certbot certificates --dry-run/);
    assert.match(rendered ?? '', /verify: systemctl reload exits 0/);
  });

  it('names the goal after the runbook', () => {
    assert.equal(runbookGoal(parseRunbook(runbookText)!), 'Run the runbook "rotate the proxy certificate"');
  });

  it('renders nothing for a runbook without steps', () => {
    assert.equal(renderRunbookSteps(parseRunbook('# Runbook: empty')!), null);
  });
});
