/**
 * Multi-host execution and comparison for the server-management agent.
 *
 * The agent manages a handful of hosts, so "run the same thing on each of them
 * and tell me what differs" is a first-class task. This module owns that
 * orchestration without touching a single host itself: the caller supplies the
 * per-host runner, so the command path (blocklist, scope, bridge, output
 * fitting, write replay) stays exactly the one `terminal.execute` uses.
 *
 * Two properties matter more than throughput:
 *
 * - **Failure isolation.** One host failing must not hide or corrupt the
 *   others' results, so every host carries its own outcome.
 * - **Host-level ordering.** A host is only ever running one command from this
 *   agent at a time, which is enforced by the session queue the caller reserves
 *   through here.
 */

export interface HostCommandOutcome {
  sessionId: string;
  ok: boolean;
  error?: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Handle id when the output was archived behind `tool_output_read`. */
  handleId?: string;
  /** Total characters before fitting, when known. */
  totalChars?: number;
}

export interface BatchSummary {
  total: number;
  succeeded: number;
  failed: number;
}

export interface BatchExecutionResult {
  command: string;
  mode: 'serial' | 'parallel';
  hosts: HostCommandOutcome[];
  summary: BatchSummary;
  /** Set when the run stopped early in serial mode. */
  stoppedEarly?: boolean;
}

export interface RunCommandOnSessionsInput {
  sessionIds: readonly string[];
  command: string;
  mode?: 'serial' | 'parallel';
  /** Stop after the first failing host (serial mode only). */
  stopOnError?: boolean;
  /** Reserve the host for this run so two panels cannot write it at once. */
  reserveSlot?: (sessionId: string) => { ready: Promise<void>; release: () => void } | null;
  signal?: AbortSignal;
  runOnHost: (sessionId: string) => Promise<HostCommandOutcome>;
}

const MAX_COMPARE_LINES_PER_HOST = 20;

/**
 * Run one command across several hosts.
 *
 * Serial mode is the default: the agent's turns are operator turns, and a
 * serial run keeps the machines from being hammered at once and keeps the
 * stop-on-error semantics meaningful. Parallel mode is opt-in for read-only
 * fan-out.
 */
export async function runCommandOnSessions(
  input: RunCommandOnSessionsInput,
): Promise<BatchExecutionResult> {
  const mode = input.mode === 'parallel' ? 'parallel' : 'serial';
  const sessionIds = dedupe(input.sessionIds);
  const stopOnError = input.stopOnError === true && mode === 'serial';
  const hosts: HostCommandOutcome[] = [];
  let stoppedEarly = false;

  const runHost = async (sessionId: string): Promise<HostCommandOutcome> => {
    const slot = input.reserveSlot?.(sessionId) ?? null;
    try {
      await slot?.ready;
      if (input.signal?.aborted) return cancelledOutcome(sessionId);
      return await input.runOnHost(sessionId);
    } catch (error) {
      return {
        sessionId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        exitCode: null,
        stdout: '',
        stderr: '',
      };
    } finally {
      slot?.release();
    }
  };

  if (mode === 'parallel') {
    const outcomes = await Promise.all(sessionIds.map(sessionId => runHost(sessionId)));
    hosts.push(...outcomes);
  } else {
    for (const sessionId of sessionIds) {
      const outcome = await runHost(sessionId);
      hosts.push(outcome);
      if (stopOnError && !outcome.ok) {
        stoppedEarly = true;
        break;
      }
    }
  }

  return {
    command: input.command,
    mode,
    hosts,
    summary: summarize(hosts),
    ...(stoppedEarly ? { stoppedEarly } : {}),
  };
}

export interface HostOutputComparison {
  command: string;
  /** True when every host that answered returned byte-identical output. */
  identical: boolean;
  /** Hosts grouped by their exact output, largest group first. */
  groups: Array<{ members: string[]; lineCount: number }>;
  /** Hosts whose output differs from the largest group. */
  differingHosts: string[];
  /** Bounded per-group detail: the lines that are unique to that group. */
  differences: Array<{ members: string[]; lines: string[] }>;
  conclusion: string;
  hostsThatFailed: string[];
}

/**
 * Compare the output of the same read across hosts.
 *
 * The comparison is deterministic on purpose: grouping by exact output plus the
 * set of lines unique to a host gives the model a small, checkable artifact
 * instead of N full outputs to hold in context.
 */
export function compareHostOutputs(
  command: string,
  hosts: readonly HostCommandOutcome[],
): HostOutputComparison {
  const answered = hosts.filter(host => host.ok);
  const hostsThatFailed = hosts.filter(host => !host.ok).map(host => host.sessionId);
  const byOutput = new Map<string, string[]>();
  for (const host of answered) {
    const key = comparisonText(host);
    const members = byOutput.get(key) ?? [];
    members.push(host.sessionId);
    byOutput.set(key, members);
  }

  const groups = [...byOutput.entries()]
    .map(([output, members]) => ({ members, lineCount: countLines(output) }))
    .sort((a, b) => b.members.length - a.members.length || a.lineCount - b.lineCount);
  const baselineLines = groups.length > 0
    ? lineSet(firstHostOutput(answered, groups[0]?.members ?? []))
    : new Set<string>();

  const differences = groups.slice(1).map(group => {
    const members = group.members;
    const memberHost = answered.find(host => members.includes(host.sessionId));
    const baselineHost = answered.find(host => (groups[0]?.members ?? []).includes(host.sessionId));
    const unique = memberHost
      ? splitLines(memberHost.stdout).filter(line => !baselineLines.has(line))
      : [];
    if (unique.length === 0 && memberHost && baselineHost) {
      if (memberHost.stderr !== baselineHost.stderr) {
        unique.push(`[stderr] ${memberHost.stderr || '(empty)'}`);
      }
      if (memberHost.exitCode !== baselineHost.exitCode) {
        unique.push(`[exitCode] ${memberHost.exitCode ?? 'null'}`);
      }
    }
    return {
      members,
      lines: unique.slice(0, MAX_COMPARE_LINES_PER_HOST),
    };
  });

  const differingHosts = groups.slice(1).flatMap(group => group.members);
  const identical = answered.length > 0 && differingHosts.length === 0 && hostsThatFailed.length === 0;

  return {
    command,
    identical,
    groups,
    differingHosts,
    differences,
    hostsThatFailed,
    conclusion: buildConclusion({
      total: hosts.length,
      answered: answered.length,
      identical,
      differingHosts,
      hostsThatFailed,
    }),
  };
}

function buildConclusion(input: {
  total: number;
  answered: number;
  identical: boolean;
  differingHosts: string[];
  hostsThatFailed: string[];
}): string {
  if (input.answered === 0) {
    return `No host answered: ${input.hostsThatFailed.join(', ') || 'unknown'} failed.`;
  }
  if (input.identical) {
    return `All ${input.answered} hosts that answered returned identical output.`;
  }
  const parts: string[] = [];
  const agreeing = input.answered - input.differingHosts.length;
  if (input.differingHosts.length > 0) {
    parts.push(`${agreeing} of ${input.answered} hosts agree`);
    parts.push(`differing: ${input.differingHosts.join(', ')}`);
  } else {
    parts.push(`${agreeing} hosts answered the same`);
  }
  if (input.hostsThatFailed.length > 0) {
    parts.push(`failed: ${input.hostsThatFailed.join(', ')}`);
  }
  return `${parts.join('; ')}.`;
}

function firstHostOutput(
  hosts: readonly HostCommandOutcome[],
  members: readonly string[],
): string {
  const host = hosts.find(entry => members.includes(entry.sessionId));
  return host ? comparisonText(host) : '';
}

function comparisonText(host: HostCommandOutcome): string {
  return [
    host.stdout,
    host.stderr ? `[stderr]\n${host.stderr}` : '',
    `[exitCode] ${host.exitCode ?? 'null'}`,
  ].filter(Boolean).join('\n');
}

function splitLines(output: string): string[] {
  return output.split('\n');
}

function countLines(output: string): number {
  return output.length === 0 ? 0 : splitLines(output).length;
}

function lineSet(output: string): Set<string> {
  return new Set(splitLines(output).filter(line => line.trim().length > 0));
}

function dedupe(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

function cancelledOutcome(sessionId: string): HostCommandOutcome {
  return {
    sessionId,
    ok: false,
    error: 'Tool call cancelled.',
    exitCode: null,
    stdout: '',
    stderr: '',
  };
}

function summarize(hosts: readonly HostCommandOutcome[]): BatchSummary {
  return {
    total: hosts.length,
    succeeded: hosts.filter(host => host.ok).length,
    failed: hosts.filter(host => !host.ok).length,
  };
}
