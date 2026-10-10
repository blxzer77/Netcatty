/**
 * Runbooks: the structured half of the skill layer.
 *
 * A skill is guidance the agent reads. A runbook is a procedure the agent
 * executes: it already says what to run, on what, and how to prove it worked.
 * The point of this module is that a runbook reaches the user as a plan built
 * from the runbook's own steps, not as steps the model invented while reading
 * it.
 *
 * A runbook is plain markdown a user can write in Netcatty's skills:
 *
 *     # Runbook: rotate the proxy certificate
 *     > what this runbook is for
 *     targets: proxy hosts
 *
 *     ## Steps
 *     1. Back up the current certificate
 *        - command: certbot certificates --dry-run
 *        - verify: the dry run reports success
 *     2. Renew
 *        - command: certbot renew
 *        - verify: systemctl reload reports no error
 *
 * Everything is optional except the `# Runbook:` heading and at least one step,
 * so a half-written runbook is still readable — validation reports what is
 * missing instead of refusing to load it.
 */

import type { PlanStep } from './types';

export const RUNBOOK_HEADING = /^#\s+Runbook:\s*(.+)$/im;
export const RUNBOOK_TARGETS_LINE = /^targets:\s*(.+)$/im;
export const RUNBOOK_DESCRIPTION_LINE = /^>\s*(.+)$/im;
const RUNBOOK_STEPS_HEADING = /^##\s+Steps\s*$/im;

export interface RunbookStep {
  id: string;
  title: string;
  command?: string;
  verify?: string;
}

export interface Runbook {
  name: string;
  description?: string;
  targets?: string;
  steps: RunbookStep[];
  /** Raw body of the Steps section, kept for round-tripping. */
  body: string;
}

export interface RunbookValidationIssue {
  stepId?: string;
  message: string;
}

/** True when the text looks like a runbook rather than free-form skill guidance. */
export function isRunbook(text: string): boolean {
  return RUNBOOK_HEADING.test(text);
}

/**
 * Parse a runbook out of skill text.
 *
 * Returns null when the text is not a runbook. A runbook whose Steps section is
 * missing or empty still parses, with `steps: []`, so validation can report it.
 */
export function parseRunbook(text: string): Runbook | null {
  const heading = text.match(RUNBOOK_HEADING);
  if (!heading) return null;

  const descriptionMatch = text.match(RUNBOOK_DESCRIPTION_LINE);
  const targetsMatch = text.match(RUNBOOK_TARGETS_LINE);

  const stepsHeading = text.match(RUNBOOK_STEPS_HEADING);
  const body = stepsHeading && stepsHeading.index != null
    ? text.slice(stepsHeading.index + stepsHeading[0].length)
    : '';

  return {
    name: heading[1].trim(),
    ...(descriptionMatch ? { description: descriptionMatch[1].trim() } : {}),
    ...(targetsMatch ? { targets: targetsMatch[1].trim() } : {}),
    steps: parseSteps(body),
    body,
  };
}

/**
 * Report what a runbook is missing.
 *
 * A runbook that cannot be executed safely is reported, not silently repaired:
 * the user wrote it, so they decide what it means.
 */
export function validateRunbook(runbook: Runbook): RunbookValidationIssue[] {
  const issues: RunbookValidationIssue[] = [];
  if (runbook.steps.length === 0) {
    issues.push({ message: 'The runbook has no steps. Add a "## Steps" section with at least one numbered step.' });
    return issues;
  }
  for (const step of runbook.steps) {
    if (!step.command) {
      issues.push({
        stepId: step.id,
        message: `Step "${step.title}" has no command. A runbook step must say what to run.`,
      });
    }
    if (!step.verify) {
      issues.push({
        stepId: step.id,
        message: `Step "${step.title}" has no verification. Say how to tell it worked.`,
      });
    }
  }
  return issues;
}

/**
 * Convert a runbook into plan steps.
 *
 * The conversion is mechanical on purpose: ids, titles, commands, and
 * verification come from the runbook so the plan the user approves is the
 * procedure they wrote. `sessionId` is left undefined — the agent resolves the
 * targets from the runbook's `targets` line and the sessions in scope.
 */
export function runbookStepsToPlanSteps(runbook: Runbook): PlanStep[] {
  return runbook.steps.map(step => ({
    id: step.id,
    title: step.title,
    toolName: 'terminal_execute',
    ...(step.command ? { command: step.command } : {}),
    ...(step.verify ? { verification: step.verify } : {}),
  }));
}

/**
 * Compact rendering for the system prompt.
 *
 * The whole runbook body is already in the skill context the agent reads; this
 * exists so the prompt can point at the authoritative step list without
 * repeating it. Returns null when there is nothing to show.
 */
export function renderRunbookSteps(runbook: Runbook): string | null {
  if (runbook.steps.length === 0) return null;
  const lines = runbook.steps.map((step, index) => {
    const parts = [`${index + 1}. ${step.title}`];
    if (step.command) parts.push(`command: ${step.command}`);
    if (step.verify) parts.push(`verify: ${step.verify}`);
    return parts.join(' — ');
  });
  return lines.join('\n');
}

/** Slug used as the plan goal when the agent expands a runbook. */
export function runbookGoal(runbook: Runbook): string {
  return `Run the runbook "${runbook.name}"`;
}

function parseSteps(body: string): RunbookStep[] {
  const steps: RunbookStep[] = [];
  const lines = body.split('\n');
  let current: RunbookStep | null = null;

  const pushCurrent = () => {
    if (current && current.title.length > 0) steps.push(current);
    current = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const numbered = line.match(/^\s*(\d+)[.)]\s+(.+)$/);
    if (numbered) {
      pushCurrent();
      current = {
        id: `step-${numbered[1]}`,
        title: numbered[2].trim(),
      };
      continue;
    }
    if (!current) continue;
    const field = line.match(/^\s*-\s*(command|verify)\s*:\s*(.+)$/i);
    if (field) {
      const key = field[1].toLowerCase();
      const value = field[2].trim();
      if (key === 'command') current.command = value;
      else current.verify = value;
    }
  }
  pushCurrent();

  return steps;
}
