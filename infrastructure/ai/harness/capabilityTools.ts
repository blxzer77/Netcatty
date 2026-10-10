import { tool } from 'ai';
import { z } from 'zod';
import type { ExecutorContext, NetcattyBridge } from '../cattyAgent/executor';
import type { TerminalContextReadRange } from '../../../domain/terminalContextRead';
import type { AIPermissionMode } from '../types';
import type { WebSearchConfig } from '../types';
import { isWebSearchReady } from '../types';
import {
  executeTerminalExecute,
  executeWorkspaceGetInfo,
  executeWorkspaceGetSessionInfo,
  executeWebSearch,
  executeUrlFetch,
  type ToolDeps,
  type ToolExecResult,
} from '../shared/toolExecutors';
import { reserveSessionSlot, hostWriteQueueKey } from '../shared/sessionExecutionQueue';
import {
  commitToolCoveredByApprovedPlan,
  failToolCoveredByApprovedPlan,
  hasUnsafePlanCommand,
  proposePlan,
  type PlanDecision,
} from '../shared/planGate';
import type { PlanPreconditionResult, PlanStep } from './types';
import {
  compareHostOutputs,
  isReadOnlyCompareCommand,
  runCommandOnSessions,
  type HostCommandOutcome,
} from './multiHostExecution';
import {
  BACKUP_ACCESS_LABELS,
  inferProxyRisk,
  parseBackupAccessDeclarations,
  verifyBackupAccess,
} from './backupAccess';
import { fitTerminalExecuteResultForModel } from './terminalCompression';
import { fitLargeToolResultForModel } from './toolResultFitting';
import { redactSecretsForModel } from './modelSecretRedaction';
import {
  globalTerminalMonitorGuard,
  isStreamingMonitorCommand,
} from './terminalMonitorGuard';
import type { ToolOutputStore } from './toolOutputStore';
import { mergeMachineRecord, parseMachineRecord } from './machineRecord';
import { runbookStepsToPlanSteps, validateRunbook, type Runbook } from './runbook';
import { TOOL_OUTPUT_READ_MAX_CHARS } from './toolOutputStore';
import {
  buildTerminalWriteFingerprint,
  hashScopeKey,
  hashToolResult,
  previewToolResult,
  type ToolResultDedup,
} from './toolResultDedup';
import cattyToolSpecs from './generated/cattyToolSpecs.json';
import {
  cattyToolContextSchema,
  toolDepsFromContext,
  type CattyToolContext,
} from './cattyRuntimeContext';

type FieldShape = {
  type: string;
  optional?: boolean;
  description?: string;
};

type CattyToolSpec = {
  capabilityId: string;
  toolName: string;
  rpcMethod: string | null;
  localExecution?: boolean;
  description: string;
  inputShape: Record<string, FieldShape>;
  policy: {
    write: boolean;
    bypassesApproval: boolean;
  };
};

export type CattyToolsBundle = {
  tools: Record<string, ReturnType<typeof tool>>;
  toolsContext: Record<string, CattyToolContext>;
};

function buildZodObject(shape: Record<string, FieldShape>): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const entries: Record<string, z.ZodTypeAny> = {};
  for (const [key, field] of Object.entries(shape)) {
    let schema: z.ZodTypeAny = field.type === 'number' ? z.number() : z.string();
    if (field.description) {
      schema = schema.describe(field.description);
    }
    entries[key] = field.optional ? schema.optional() : schema;
  }
  return z.object(entries);
}

function unwrap<T>(r: ToolExecResult<T>): T | { error: string } {
  if (r.ok === false) return { error: r.error };
  return r.data;
}

async function invokeCapabilityRpc(
  bridge: NetcattyBridge,
  rpcMethod: string,
  params: Record<string, unknown>,
  chatSessionId?: string,
  abortSignal?: AbortSignal,
): Promise<unknown> {
  if (!bridge.aiCapability) {
    return { error: 'Capability bridge is unavailable in this environment.' };
  }
  if (abortSignal?.aborted) return { error: 'Capability call cancelled before it could start.' };

  let cancel: (() => void) | undefined;
  const cancellation = abortSignal
    ? new Promise<unknown>(resolve => {
        cancel = () => {
          // The main process owns the active SFTP/tunnel/RPC operation. Do not
          // resolve this tool until its cancellation fan-out acknowledges the
          // request; a renderer-only Promise.race would release the queue while
          // the side effect could still be running.
          const acknowledgement = chatSessionId && bridge.aiSetChatSessionCancelled
            ? bridge.aiSetChatSessionCancelled(chatSessionId, true)
            : Promise.resolve({ ok: false, error: 'No main-process cancellation bridge is available.' });
          void acknowledgement.then(result => {
            resolve(result?.ok === false
              ? { error: result.error || 'Capability cancellation was not acknowledged.' }
              : { error: 'Capability call cancelled with the owning turn.' });
          }).catch(() => {
            resolve({ error: 'Capability cancellation was not acknowledged.' });
          });
        };
        abortSignal.addEventListener('abort', cancel, { once: true });
      })
    : null;
  try {
    const request = bridge.aiCapability(rpcMethod, params, chatSessionId);
    const result = await (cancellation ? Promise.race([request, cancellation]) : request);
    if (result && typeof result === 'object' && 'ok' in result && (result as { ok: boolean }).ok === false) {
      return { error: (result as { error?: string }).error || 'Capability call failed.' };
    }
    return result;
  } finally {
    if (cancel) abortSignal?.removeEventListener('abort', cancel);
  }
}

async function tryFetchHostEnvironment(
  bridge: NetcattyBridge,
  chatSessionId?: string,
): Promise<Record<string, unknown> | null> {
  if (!bridge.aiCapability || !chatSessionId) return null;
  try {
    const environment = await invokeCapabilityRpc(
      bridge,
      'netcatty/getContext',
      {},
      chatSessionId,
    );
    if (environment && typeof environment === 'object' && !('error' in environment)) {
      return environment as Record<string, unknown>;
    }
  } catch {
    // IPC failures must not block read-only harness tools.
  }
  return null;
}

function applyToolDedup(
  toolName: string,
  fingerprint: string,
  result: unknown,
  dedup?: ToolResultDedup,
): unknown {
  if (!dedup) return result;
  const cached = dedup.check(fingerprint);
  if (cached) {
    return dedup.buildCachedNotice(cached);
  }
  dedup.remember(toolName, fingerprint, previewToolResult(result));
  return result;
}

function fitCapabilityResultForModel(
  result: unknown,
  spec: CattyToolSpec,
  chatSessionId?: string,
  toolOutputStore?: ToolOutputStore,
  args?: Record<string, unknown>,
  toolResultDedup?: ToolResultDedup,
): unknown {
  if (spec.capabilityId === 'harness.tool_output.read') {
    return result;
  }

  const resultRecord = result && typeof result === 'object'
    ? result as Record<string, unknown>
    : undefined;
  const jobId = typeof args?.jobId === 'string'
    ? args.jobId
    : typeof resultRecord?.jobId === 'string' ? resultRecord.jobId : undefined;
  const terminalSessionId = typeof args?.sessionId === 'string'
    ? args.sessionId
    : typeof resultRecord?.sessionId === 'string'
      ? resultRecord.sessionId
      : jobId ? toolResultDedup?.terminalSessionForJob(jobId) : undefined;

  return fitLargeToolResultForModel({
    result,
    capabilityId: spec.capabilityId,
    chatSessionId,
    toolOutputStore,
    terminalSessionId,
    normalizeStrings: spec.capabilityId.startsWith('terminal.')
      || spec.capabilityId === 'harness.terminal.read_context',
  });
}

export function applyMonitorStopResult(
  poll: Record<string, unknown>,
  stopResult: unknown,
  suppressedCount: number,
): Record<string, unknown> {
  const stopFailed = Boolean(
    stopResult && typeof stopResult === 'object'
    && (
      (stopResult as { ok?: boolean }).ok === false
      || (
        typeof (stopResult as { error?: unknown }).error === 'string'
        && (stopResult as { error: string }).error.trim().length > 0
      )
    ),
  );
  return stopFailed
    ? {
        ...poll,
        output: `[automatic monitor stop failed after sustained overload; ${suppressedCount} batches were suppressed. The job may still be running; poll/stop it explicitly and narrow the command before continuing.]`,
      }
    : {
        ...poll,
        status: 'stopping',
        output: `[monitor stop requested after sustained overload; ${suppressedCount} batches were suppressed. Narrow the command with grep/awk before restarting it.]`,
      };
}

interface LocalExecutionContext {
  deps: ToolDeps;
  spec: CattyToolSpec;
  args: Record<string, unknown>;
  toolOutputStore?: ToolOutputStore;
  toolResultDedup?: ToolResultDedup;
  chatSessionId?: string;
  toolCallId?: string;
  abortSignal?: AbortSignal;
  selectedRunbook?: Runbook;
}

/**
 * Parse the plan payload the model submitted. The tool schema carries `steps`
 * and `preconditions` as JSON strings because the generated shapes are scalar
 * fields, so the plan is decoded here.
 */
function parsePlanSessionIds(raw: unknown): string[] | undefined {
  let parsed = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { return undefined; }
  }
  if (!Array.isArray(parsed)) return undefined;
  return parsed.filter((id): id is string => typeof id === 'string');
}

function parsePlanPayload(raw: unknown): { steps?: PlanStep[]; preconditions?: PlanPreconditionResult[]; error?: string } {
  let parsed: unknown;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return { error: 'Plan steps must be a JSON array of step objects.' };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { error: 'A plan needs at least one step.' };
  }
  const malformedArgs = parsed.find((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    if (!Object.prototype.hasOwnProperty.call(entry, 'args')) return false;
    const args = (entry as { args?: unknown }).args;
    return args !== undefined && (!args || typeof args !== 'object' || Array.isArray(args));
  });
  if (malformedArgs) {
    return { error: 'Every plan step args field must be a JSON object when present.' };
  }
  const steps = parsed.map((entry, index) => {
    const step = (entry ?? {}) as Partial<PlanStep>;
    const args = step.args && typeof step.args === 'object' && !Array.isArray(step.args)
      ? step.args as Record<string, unknown>
      : undefined;
    const argCommand = typeof args?.command === 'string' ? args.command : undefined;
    const argSessionId = typeof args?.sessionId === 'string' ? args.sessionId : undefined;
    const argSessionIds = parsePlanSessionIds(args?.sessionIds);
    return {
      id: typeof step.id === 'string' && step.id.trim() ? step.id : `step-${index + 1}`,
      title: typeof step.title === 'string' && step.title.trim()
        ? step.title
        : String(step.command ?? argCommand ?? `Step ${index + 1}`),
      ...(typeof step.toolName === 'string' ? { toolName: step.toolName } : {}),
      ...(typeof step.sessionId === 'string' ? { sessionId: step.sessionId } : argSessionId ? { sessionId: argSessionId } : {}),
      ...(Array.isArray(step.sessionIds)
        ? { sessionIds: step.sessionIds.filter((id): id is string => typeof id === 'string') }
        : argSessionIds ? { sessionIds: argSessionIds } : {}),
      ...(args ? { args } : {}),
      ...(typeof step.command === 'string' ? { command: step.command } : argCommand ? { command: argCommand } : {}),
      ...(typeof step.reason === 'string' ? { reason: step.reason } : {}),
      ...(typeof step.verification === 'string' ? { verification: step.verification } : {}),
      ...(typeof step.risk === 'string' ? { risk: step.risk as PlanStep['risk'] } : {}),
    } satisfies PlanStep;
  });
  const validToolNames = new Set((cattyToolSpecs as CattyToolSpec[])
    .filter(spec => spec.policy.write)
    .map(spec => spec.toolName));
  const invalidToolStep = steps.find(step => !step.toolName || !validToolNames.has(step.toolName));
  if (invalidToolStep) {
    return { error: `Plan step "${invalidToolStep.title}" names a tool that is not an approved Catty write capability.` };
  }
  const incompleteDescriptionStep = steps.find(step => !step.reason?.trim() || !step.verification?.trim());
  if (incompleteDescriptionStep) {
    return { error: `Plan step "${incompleteDescriptionStep.title}" must include a reason and verification.` };
  }
  const invalidArgsStep = steps.find(step => {
    const spec = (cattyToolSpecs as CattyToolSpec[]).find(entry => entry.toolName === step.toolName);
    if (!spec || !step.args) return true;
    const args = step.args;
    const fields = spec.inputShape;
    if (Object.keys(args).some(key => !Object.prototype.hasOwnProperty.call(fields, key))) return true;
    return Object.entries(fields).some(([key, field]) => {
      if (!Object.prototype.hasOwnProperty.call(args, key)) return !field.optional;
      return field.type === 'number' ? typeof args[key] !== 'number' : typeof args[key] !== 'string';
    });
  });
  if (invalidArgsStep) {
    return { error: `Plan step "${invalidArgsStep.title}" has arguments that do not match its Catty tool schema.` };
  }
  const unsafeCommandStep = steps.find(step => {
    if (!['terminal_execute', 'terminal_start', 'terminal_batch'].includes(step.toolName ?? '')) return false;
    const command = step.command ?? (typeof step.args?.command === 'string' ? step.args.command : '');
    return hasUnsafePlanCommand(command);
  });
  if (unsafeCommandStep) {
    return { error: `Plan step "${unsafeCommandStep.title}" contains shell composition or dynamic command execution, which is not allowed in an approved plan.` };
  }
  const inconsistent = steps.find(step => {
    const args = step.args;
    if (!args) return false;
    const hasCommand = Object.prototype.hasOwnProperty.call(args, 'command');
    const hasSessionId = Object.prototype.hasOwnProperty.call(args, 'sessionId');
    const hasSessionIds = Object.prototype.hasOwnProperty.call(args, 'sessionIds');
    if (hasCommand && typeof args.command !== 'string') return true;
    if (hasSessionId && typeof args.sessionId !== 'string') return true;
    if (hasCommand && step.command !== args.command) return true;
    if (hasSessionId && step.sessionId !== args.sessionId) return true;
    const argSessionIds = parsePlanSessionIds(args.sessionIds);
    if (hasSessionIds && argSessionIds === undefined) return true;
    return argSessionIds !== undefined
      && JSON.stringify(step.sessionIds ?? []) !== JSON.stringify(argSessionIds);
  });
  if (inconsistent) {
    return { error: `Plan step "${inconsistent.title}" repeats a command or target inconsistently between its summary fields and args.` };
  }
  const readOnlyStep = steps.find(step => step.risk === 'read');
  if (readOnlyStep) {
    return { error: `Plan step "${readOnlyStep.title}" is marked read-only. Run read-only checks outside a write plan.` };
  }
  const incomplete = steps.find(step => {
    if (!step.toolName || !step.args) return true;
    const args = step.args;
    const toolName = step.toolName;
    const hasTarget = ['sessionId', 'sessionIds', 'hostId']
      .some(key => Object.prototype.hasOwnProperty.call(args, key));
    if (!hasTarget) return true;
    if (['terminal_execute', 'terminal_start', 'terminal_batch', 'compare_machines'].includes(toolName)) {
      return typeof args.command !== 'string' || args.command !== step.command;
    }
    return false;
  });
  if (incomplete) {
    return { error: `Plan step "${incomplete.title}" must name a tool, an exact args object, and its target.` };
  }
  return { steps };
}

function parsePlanPreconditions(raw: unknown): { preconditions?: PlanPreconditionResult[]; error?: string } {  if (raw === undefined || raw === null) return {};
  let parsed: unknown;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return { error: 'Plan preconditions must be a JSON array of {id, label, ok, detail?} objects.' };
  }
  if (!Array.isArray(parsed)) return { error: 'Plan preconditions must be a JSON array.' };
  return {
    preconditions: parsed.map((entry) => {
      const precondition = (entry ?? {}) as Partial<PlanPreconditionResult>;
      return {
        id: String(precondition.id ?? 'check'),
        label: String(precondition.label ?? precondition.id ?? 'check'),
        ok: precondition.ok === true,
        // Model-provided checks are declarations, never harness evidence.
        verified: false,
        ...(typeof precondition.detail === 'string' ? { detail: precondition.detail } : {}),
      };
    }),
  };
}

/** Handle id embedded in an output-fit notice, when the output was archived. */
const HANDLE_ID_PATTERN = /handleId=(tool-output-[^\]\s]+)/;

function extractHandleId(text: string): string | undefined {
  return text.match(HANDLE_ID_PATTERN)?.[1];
}

/** Parse a JSON array of session ids from a tool argument. */
function parseSessionIdList(raw: unknown): { ids: string[]; error?: string } {
  let parsed: unknown;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return { ids: [], error: 'sessionIds must be a JSON array of session IDs.' };
  }
  if (!Array.isArray(parsed)) return { ids: [], error: 'sessionIds must be a JSON array of session IDs.' };
  const ids = parsed
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.trim());
  return { ids };
}

interface HostCommandDeps {
  deps: ToolDeps;
  chatSessionId?: string;
  toolOutputStore?: ToolOutputStore;
  toolResultDedup?: ToolResultDedup;
  abortSignal?: AbortSignal;
}

/**
 * Run one command on one host through exactly the path `terminal_execute`
 * uses: scope and observer checks, shell-aware blocklist, bridge call, output
 * fitting with an archived handle, and write-fingerprint replay so a batch
 * retried after compaction does not re-run on any host.
 */
async function runSingleHostCommand(
  ctx: HostCommandDeps,
  sessionId: string,
  command: string,
): Promise<HostCommandOutcome> {
  const { deps, chatSessionId, toolOutputStore, toolResultDedup, abortSignal } = ctx;
  const fingerprint = buildTerminalWriteFingerprint(
    'terminal_execute',
    deps.chatSessionId,
    { sessionId, command },
  );
  const replay = fingerprint ? toolResultDedup?.replayCompletedWrite(fingerprint) : undefined;
  if (replay !== undefined) {
    const replayed = replay as { stdout?: string; stderr?: string; exitCode?: number | null; error?: string };
    return {
      sessionId,
      ok: !replayed.error,
      ...(replayed.error ? { error: replayed.error } : {}),
      exitCode: replayed.exitCode ?? null,
      stdout: replayed.stdout ?? '',
      stderr: replayed.stderr ?? '',
      handleId: extractHandleId(replayed.stdout ?? ''),
    };
  }

  const target = (typeof deps.context === 'function' ? deps.context() : deps.context).sessions
    .find(session => session.sessionId === sessionId);
  const result = await executeTerminalExecute(
    deps,
    { sessionId, command },
    {
      abortSignal,
      expectedTarget: target ? {
        hostId: target.hostId,
        hostname: target.hostname,
        protocol: target.protocol,
      } : undefined,
    },
  );
  const data = result.data ?? { stdout: '', stderr: '', exitCode: null };
  const fitted = fitTerminalExecuteResultForModel(
    { ...data, command, sessionId },
    { chatSessionId, toolOutputStore },
  );
  if (fingerprint) toolResultDedup?.rememberCompletedWrite(fingerprint, fitted);
  return {
    sessionId,
    ok: result.ok,
    ...(result.ok === false ? { error: result.error } : {}),
    exitCode: fitted.exitCode,
    stdout: fitted.stdout,
    stderr: fitted.stderr,
    handleId: extractHandleId(fitted.stdout),
  };
}

function runbookTargetMismatch(
  steps: readonly PlanStep[],
  runbook: Runbook,
  context: ExecutorContext,
): string | null {
  if (!runbook.targets?.trim()) return null;
  const selectors = runbook.targets.split(/[,;]+/).map(value => value.trim()).filter(Boolean);
  if (selectors.length === 0) return 'The runbook targets field must name at least one exact session, host ID, hostname, or host label.';

  const expectedHostIds = new Set<string>();
  const expectedSessionIds = new Set<string>();
  for (const selector of selectors) {
    const matches = context.sessions.filter(session => session.connected && [
      session.sessionId,
      session.hostId,
      session.hostname,
      session.label,
    ].some(value => value?.toLowerCase() === selector.toLowerCase()));
    if (matches.length !== 1 || !matches[0].hostId) {
      return `Runbook target "${selector}" must identify exactly one connected session, not only a shared host.`;
    }
    const match = matches[0];
    expectedHostIds.add(match.hostId);
    expectedSessionIds.add(match.sessionId);
  }

  const actualSessionIds = new Set<string>();
  const actualHostIds = new Set<string>();
  for (const step of steps) {
    const sessionIds = [
      ...(step.sessionId ? [step.sessionId] : []),
      ...(step.sessionIds ?? []),
      ...(typeof step.args?.sessionId === 'string' ? [step.args.sessionId] : []),
      ...(parsePlanSessionIds(step.args?.sessionIds) ?? []),
    ];
    for (const sessionId of sessionIds) {
      const session = context.sessions.find(entry => entry.sessionId === sessionId && entry.connected);
      if (session?.hostId) {
        actualHostIds.add(session.hostId);
        actualSessionIds.add(session.sessionId);
      }
    }
    if (typeof step.args?.hostId === 'string') actualHostIds.add(step.args.hostId);
  }
  if (
    expectedSessionIds.size > 0
    && ([...expectedSessionIds].some(sessionId => !actualSessionIds.has(sessionId))
      || [...actualSessionIds].some(sessionId => !expectedSessionIds.has(sessionId)))
  ) {
    return `Plan sessions do not match the exact runbook session targets (${selectors.join(', ')}).`;
  }
  if (actualHostIds.size === 0 || [...actualHostIds].some(hostId => !expectedHostIds.has(hostId))) {
    return `Plan targets do not match the runbook targets (${selectors.join(', ')}).`;
  }
  if ([...expectedHostIds].some(hostId => !actualHostIds.has(hostId))) {
    return `Plan omits one or more runbook targets (${selectors.join(', ')}).`;
  }
  return null;
}

function runbookPlanMismatch(steps: PlanStep[], runbook: Runbook): string | null {
  const expected = runbookStepsToPlanSteps(runbook);
  if (steps.length !== expected.length) {
    return `The plan must contain exactly the ${expected.length} steps from runbook "${runbook.name}".`;
  }
  for (let index = 0; index < expected.length; index += 1) {
    const actual = steps[index];
    const required = expected[index];
    if (
      actual.id !== required.id
      || actual.title !== required.title
      || actual.toolName !== required.toolName
      || actual.command !== required.command
      || actual.verification !== required.verification
    ) {
      return `Plan step ${index + 1} does not match runbook step "${required.title}". Do not add, drop, or rewrite runbook steps.`;
    }
  }
  return null;
}

async function prepareMachineNotesWrite(
  deps: ToolDeps,
  args: Record<string, unknown>,
  abortSignal?: AbortSignal,
): Promise<Record<string, unknown> | { error: string }> {
  const hostId = typeof args.hostId === 'string' ? args.hostId : '';
  const notes = typeof args.notes === 'string' ? args.notes : '';
  if (!hostId || !notes) return { error: 'host_notes_set requires hostId and a non-empty agent record.' };
  if (!deps.bridge.aiCapability) return { error: 'Host notes bridge is unavailable.' };

  const current = await invokeCapabilityRpc(
    deps.bridge,
    'vault/host/notes/get',
    { hostId },
    deps.chatSessionId,
    abortSignal,
  );
  if (current && typeof current === 'object' && 'error' in current) {
    return { error: `Unable to read existing host notes before merging: ${String((current as { error: unknown }).error)}` };
  }
  const existingNotes = current && typeof current === 'object' && typeof (current as { notes?: unknown }).notes === 'string'
    ? (current as { notes: string }).notes
    : '';
  const safeIncoming = redactSecretsForModel(notes);
  const incomingRecord = parseMachineRecord(safeIncoming);
  if (!incomingRecord) {
    return {
      error: 'host_notes_set requires the <!-- netcatty:agent-record:start --> ... end block. User prose is merged by Netcatty; do not replace the whole notes field.',
    };
  }
  return {
    hostId,
    notes: mergeMachineRecord(existingNotes, incomingRecord),
  };
}

interface PlanTargetIdentity {
  sessionId: string;
  hostId: string;
  hostname: string;
  protocol: string;
}

function capturePlanTargetIdentities(
  steps: readonly PlanStep[],
  context: ExecutorContext,
): PlanTargetIdentity[] {
  const sessionIds = new Set(steps.flatMap(step => [
    ...(step.sessionId ? [step.sessionId] : []),
    ...(step.sessionIds ?? []),
  ]));
  for (const step of steps) {
    const hostId = typeof step.args?.hostId === 'string' ? step.args.hostId : undefined;
    if (!hostId) continue;
    for (const session of context.sessions) {
      if (session.connected && session.hostId === hostId) sessionIds.add(session.sessionId);
    }
  }
  return [...sessionIds].flatMap(sessionId => {
    const session = context.sessions.find(entry => entry.sessionId === sessionId);
    return session
      ? [{
          sessionId,
          hostId: session.hostId,
          hostname: session.hostname.trim().toLowerCase(),
          protocol: session.protocol!.trim().toLowerCase(),
        }]
      : [];
  });
}

function validatePlanTargetIdentities(
  identities: readonly PlanTargetIdentity[],
  context: ExecutorContext,
): string | null {
  for (const identity of identities) {
    const current = context.sessions.find(entry => entry.sessionId === identity.sessionId);
    if (!current || !current.connected) return `Plan target session "${identity.sessionId}" changed or disconnected.`;
    if (
      current.hostId !== identity.hostId
      || current.hostname.trim().toLowerCase() !== identity.hostname
      || (current.protocol ?? '').toLowerCase() !== (identity.protocol ?? '')
    ) {
      return `Plan target session "${identity.sessionId}" changed host identity; submit a new plan.`;
    }
  }
  return null;
}

function validateDirectScopedHostCapability(
  capabilityId: string,
  args: Record<string, unknown>,
  context: ExecutorContext,
): string | null {
  if (![
    'vault.host.notes.get',
    'vault.host.notes.set',
    'portforward.start',
    'portforward.stop',
  ].includes(capabilityId)) return null;
  const hostId = typeof args.hostId === 'string' ? args.hostId.trim() : '';
  if (!hostId) return `${capabilityId} requires a hostId bound to the current scope.`;
  const connected = context.sessions.some(session => session.connected && session.hostId === hostId);
  return connected ? null : `Host "${hostId}" is not connected in the current Catty scope.`;
}

function validatePlanTargets(steps: readonly PlanStep[], context: ExecutorContext): string | null {
  const targetSessionIds = steps.flatMap(step => [
    ...(step.sessionId ? [step.sessionId] : []),
    ...(step.sessionIds ?? []),
  ]);
  for (const sessionId of new Set(targetSessionIds)) {
    const session = context.sessions.find(entry => entry.sessionId === sessionId);
    if (!session) return `Plan target session "${sessionId}" is not in the current scope.`;
    if (!session.connected) return `Plan target session "${sessionId}" is no longer connected.`;
    if (!session.hostId || !session.hostname.trim() || !session.protocol?.trim()) {
      return `Plan target session "${sessionId}" has incomplete host identity; reconnect and submit a new plan.`;
    }
  }
  for (const step of steps) {
    const args = step.args;
    const declaredHostId = typeof args?.hostId === 'string' ? args.hostId : undefined;
    if (!declaredHostId) continue;
    const hostSessions = context.sessions.filter(entry => entry.connected && entry.hostId === declaredHostId);
    if (hostSessions.length === 0) {
      return `Plan target host "${declaredHostId}" is not connected in the current scope.`;
    }
    if (hostSessions.some(session => !session.hostname.trim() || !session.protocol?.trim())) {
      return `Plan target host "${declaredHostId}" has incomplete host identity; reconnect and submit a new plan.`;
    }
    const stepSessionIds = [
      ...(step.sessionId ? [step.sessionId] : []),
      ...(step.sessionIds ?? []),
    ];
    for (const sessionId of stepSessionIds) {
      const session = context.sessions.find(entry => entry.sessionId === sessionId);
      if (session?.hostId !== declaredHostId) {
        return `Plan target host "${declaredHostId}" does not match session "${sessionId}".`;
      }
    }
  }
  return null;
}

async function executeLocalCattyCapability(ctx: LocalExecutionContext): Promise<unknown> {
  const { deps, spec, args, toolOutputStore, toolResultDedup, chatSessionId, selectedRunbook } = ctx;
  const resolveContext = () => (typeof deps.context === 'function' ? deps.context() : deps.context);

  switch (spec.capabilityId) {
    case 'harness.plan.submit': {
      // A plan is the unit of approval: nothing executes until the user
      // approves this one artifact, and the approved steps then cover the tool
      // calls they name (see cattyToolApproval).
      if (deps.permissionMode === 'observer') {
        return {
          error: 'Observer mode is read-only, so a plan that changes a host cannot run. Switch to confirm or auto in Settings → AI → Safety, then ask again.',
        };
      }
      if (ctx.abortSignal?.aborted) {
        return { error: 'Tool call cancelled before it could start.' };
      }

      const goal = typeof args.goal === 'string' ? args.goal.trim() : '';
      if (!goal) return { error: 'A plan needs a one-sentence goal.' };

      const parsedSteps = parsePlanPayload(args.steps);
      if (parsedSteps.error) return { error: parsedSteps.error };
      const steps = parsedSteps.steps ?? [];
      const initialContext = resolveContext();
      const initialTargetError = validatePlanTargets(steps, initialContext);
      if (initialTargetError) return { error: initialTargetError };
      const targetIdentities = capturePlanTargetIdentities(steps, initialContext);

      const parsedPreconditions = parsePlanPreconditions(args.preconditions);
      if (parsedPreconditions.error) return { error: parsedPreconditions.error };
      const preconditions = parsedPreconditions.preconditions;
      const unmet = (preconditions ?? []).filter(precondition => !precondition.ok || precondition.verified !== true);
      if (unmet.length > 0) {
        return {
          error: `Plan blocked by unmet preconditions: ${unmet.map(p => p.label).join('; ')}. Run the checks, resolve them, then propose the plan again.`,
          blockedPreconditions: unmet,
        };
      }

      if (selectedRunbook) {
        const runbookIssues = validateRunbook(selectedRunbook);
        if (runbookIssues.length > 0) {
          return {
            error: `Selected runbook is not executable: ${runbookIssues.map(issue => issue.message).join(' ')}`,
          };
        }
        const targetMismatch = runbookTargetMismatch(steps, selectedRunbook, initialContext);
        if (targetMismatch) return { error: targetMismatch };
        const mismatch = runbookPlanMismatch(steps, selectedRunbook);
        if (mismatch) return { error: mismatch };
      }

      // Infer proxy risk from the actual plan. The model may declare additional
      // risk, but it cannot opt out of the red-line checks by omitting the flag.
      const declaredProxyRisk = args.proxyRisk === true || String(args.proxyRisk) === 'true';
      const proxyRisk = declaredProxyRisk || inferProxyRisk(steps);
      const parsedBackupAccess = parseBackupAccessDeclarations(args.backupAccess);
      if (parsedBackupAccess.error) return { error: parsedBackupAccess.error };

      const targetHostsFor = () => {
        const scopeContext = resolveContext();
        const targetSessionIds = steps.flatMap(step => [
          ...(step.sessionId ? [step.sessionId] : []),
          ...(step.sessionIds ?? []),
        ]);
        const targetHostIds = steps.flatMap(step =>
          typeof step.args?.hostId === 'string' ? [step.args.hostId] : [],
        );
        const targetHosts = [...new Set(targetSessionIds)].map(sessionId => {
          const session = scopeContext.sessions.find(entry => entry.sessionId === sessionId);
          return { hostId: session?.hostId, hostname: session?.hostname ?? sessionId };
        });
        for (const hostId of new Set(targetHostIds)) {
          if (targetHosts.some(target => target.hostId === hostId)) continue;
          const session = scopeContext.sessions.find(entry => entry.hostId === hostId);
          targetHosts.push({ hostId, hostname: session?.hostname ?? hostId });
        }
        return { scopeContext, targetHosts };
      };

      let backupAccessChecks: ReturnType<typeof verifyBackupAccess>['checks'] | undefined;
      let verifyCurrentBackupAccess: (() => ReturnType<typeof verifyBackupAccess>) | undefined;
      const validateCurrentTargets = () => {
        const currentContext = resolveContext();
        const targetError = validatePlanTargets(steps, currentContext)
          ?? validatePlanTargetIdentities(targetIdentities, currentContext);
        return targetError
          ? { outcome: 'denied' as const, note: targetError }
          : undefined;
      };
      let validateApproval: (() => PlanDecision | void) | undefined = validateCurrentTargets;
      if (proxyRisk) {
        if (!parsedBackupAccess.declarations) {
          return {
            error: 'This plan could interrupt the proxy path, so backupAccess is required: all four checks (backup-connection, alternate-route, config-backup, recovery-plan) must be declared.',
          };
        }
        const verifyBackup = () => {
          const { scopeContext, targetHosts } = targetHostsFor();
          return verifyBackupAccess({
            declarations: parsedBackupAccess.declarations!,
            hosts: scopeContext.sessions,
            targets: targetHosts,
          });
        };
        verifyCurrentBackupAccess = verifyBackup;
        const verification = verifyBackup();
        backupAccessChecks = verification.checks;
        if (!verification.ok) {
          return {
            error: `Plan blocked by backup-access checks: ${verification.blockReason}`,
            backupAccessChecks,
          };
        }
        validateApproval = () => {
          const targetDecision = validateCurrentTargets();
          if (targetDecision) return targetDecision;
          const current = verifyCurrentBackupAccess();
          return current.ok
            ? undefined
            : {
                outcome: 'denied' as const,
                note: `Backup-access checks no longer pass: ${current.blockReason}`,
              };
        };
      }

      const planPreconditions: PlanPreconditionResult[] = [
        ...(preconditions ?? []),
        ...(backupAccessChecks ?? []).map(check => ({
          id: check.id,
          label: BACKUP_ACCESS_LABELS[check.id],
          ok: check.ok,
          verified: check.verified,
          ...(check.detail ? { detail: check.detail } : {}),
        })),
      ];

      const decision = await proposePlan({
        goal,
        steps,
        preconditions: planPreconditions.length > 0 ? planPreconditions : undefined,
        chatSessionId,
        validateApproval,
        signal: ctx.abortSignal,
        validateExecution: () => {
          const currentContext = resolveContext();
          const targetError = validatePlanTargets(steps, currentContext)
            ?? validatePlanTargetIdentities(targetIdentities, currentContext);
          if (targetError) return targetError;
          const currentBackup = verifyCurrentBackupAccess?.();
          return currentBackup && !currentBackup.ok
            ? `Backup-access checks no longer pass: ${currentBackup.blockReason}`
            : null;
        },
        // The tool call id doubles as the plan id so a retried submission joins
        // the pending decision instead of raising a second request.
        planId: ctx.toolCallId,
      });

      if (decision.outcome !== 'approved') {
        return {
          approved: false,
          reason: decision.note ?? (decision.outcome === 'denied'
            ? 'The user denied the plan.'
            : 'Plan approval timed out.'),
        };
      }

      return {
        approved: true,
        planId: ctx.toolCallId,
        steps: steps.map(step => ({
          id: step.id,
          title: step.title,
          ...(step.toolName ? { toolName: step.toolName } : {}),
          ...(step.args ? { args: step.args } : {}),
        })),
        instruction: 'Plan approved. Execute the steps in order and verify each one before moving on. If reality diverges from the plan, stop and tell the user instead of continuing.',
      };
    }
    case 'harness.terminal.batch':
    case 'harness.machines.compare': {
      // Multi-host work: the same command on several machines, each host
      // reported on its own so one failure cannot hide the others.
      if (deps.permissionMode === 'observer' && spec.capabilityId !== 'harness.machines.compare') {
        return {
          error: 'Observer mode is read-only: a command on several hosts cannot run. Switch to confirm or auto in Settings → AI → Safety, then ask again.',
        };
      }
      if (ctx.abortSignal?.aborted) {
        return { error: 'Tool call cancelled before it could start.' };
      }

      const parsedIds = parseSessionIdList(args.sessionIds);
      if (parsedIds.error) return { error: parsedIds.error };
      const command = typeof args.command === 'string' ? args.command.trim() : '';
      if (!command) return { error: 'A multi-host run needs a command.' };
      if (spec.capabilityId === 'harness.machines.compare' && !isReadOnlyCompareCommand(command)) {
        return { error: 'compare_machines accepts only a single, conservative read-only command. Use terminal_batch for an explicit approved write operation.' };
      }
      if (parsedIds.ids.length === 0) {
        return { error: 'A multi-host run needs at least one session ID in scope.' };
      }

      const isCompare = spec.capabilityId === 'harness.machines.compare';
      // Comparison reads run one host at a time: the point is a stable baseline
      // to diff against, and a slow host should not change the result.
      const mode = isCompare || args.mode !== 'parallel' ? 'serial' : 'parallel';
      const stopOnError = !isCompare && (args.stopOnError === true || String(args.stopOnError) === 'true');

      const batch = await runCommandOnSessions({
        sessionIds: parsedIds.ids,
        command,
        mode,
        stopOnError,
        signal: ctx.abortSignal,
        reserveSlot: (sessionId) => reserveSessionSlot(resolveHostWriteQueueKey(deps.context, sessionId)),
        runOnHost: (sessionId) => runSingleHostCommand(
          { deps, chatSessionId, toolOutputStore, toolResultDedup, abortSignal: ctx.abortSignal },
          sessionId,
          command,
        ),
      });

      const hosts = batch.hosts.map(host => ({
        sessionId: host.sessionId,
        ok: host.ok,
        ...(host.error ? { error: host.error } : {}),
        exitCode: host.exitCode,
        stdout: host.stdout,
        ...(host.stderr ? { stderr: host.stderr } : {}),
        ...(host.handleId ? { handleId: host.handleId } : {}),
      }));

      if (isCompare) {
        const comparison = compareHostOutputs(command, batch.hosts);
        return {
          command,
          identical: comparison.identical,
          conclusion: comparison.conclusion,
          differingHosts: comparison.differingHosts,
          hostsThatFailed: comparison.hostsThatFailed,
          differences: comparison.differences,
          hosts: hosts.map(host => ({
            sessionId: host.sessionId,
            ok: host.ok,
            exitCode: host.exitCode,
            ...(host.handleId ? { handleId: host.handleId } : {}),
          })),
        };
      }

      return {
        command,
        mode: batch.mode,
        hosts,
        summary: batch.summary,
        ...(batch.stoppedEarly ? { stoppedEarly: true } : {}),
      };
    }
    case 'harness.tool_output.read': {
      const { handleId, mode, maxChars, offset, query } = args as {
        handleId: string;
        mode?: 'head' | 'tail' | 'full' | 'range' | 'search';
        maxChars?: number;
        offset?: number;
        query?: string;
      };
      if (!toolOutputStore || !chatSessionId) {
        return { error: 'Tool output store is unavailable.' };
      }
      const requestedChars = Math.min(
        TOOL_OUTPUT_READ_MAX_CHARS,
        typeof maxChars === 'number' && Number.isFinite(maxChars)
          ? Math.max(1, Math.floor(maxChars))
          : TOOL_OUTPUT_READ_MAX_CHARS,
      );
      const grantedChars = toolResultDedup
        ? toolResultDedup.takeBudget('tool-output-read', requestedChars, TOOL_OUTPUT_READ_MAX_CHARS * 2)
        : requestedChars;
      if (grantedChars <= 0) {
        return {
          error: `This turn has reached its ${TOOL_OUTPUT_READ_MAX_CHARS * 2}-character saved-output read budget. Continue in the next turn or narrow the search.`,
        };
      }
      const result = await toolOutputStore.readChunkAsync(
        { handleId, mode, maxChars: grantedChars, offset, query },
        chatSessionId,
      );
      if (result == null) {
        return { error: `Handle "${handleId}" was not found for this chat session.` };
      }
      return { ...result, content: redactSecretsForModel(result.content) };
    }
    case 'harness.workspace.get_info': {
      const scopeCtx = resolveContext();
      const fingerprint = toolResultDedup?.fingerprintFor(
        spec.toolName,
        hashScopeKey([chatSessionId, scopeCtx.workspaceId, String(scopeCtx.sessions?.length ?? 0)]),
      );
      const local = executeWorkspaceGetInfo(deps);
      if (local.ok === false) {
        return unwrap(local);
      }
      let merged: unknown = local.data;
      const environment = await tryFetchHostEnvironment(deps.bridge, chatSessionId);
      if (environment) {
        const hosts = Array.isArray(environment.hosts)
          ? (environment.hosts as Array<Record<string, unknown>>)
          : [];
        const hostBySessionId = new Map(hosts.map((host) => [String(host.sessionId), host]));
        merged = {
          ...local.data,
          sessions: local.data.sessions.map((session) => ({
            ...session,
            ...(hostBySessionId.get(session.sessionId) ?? {}),
          })),
          activePortForwardTunnels: environment.activePortForwardTunnels,
        };
      }
      if (fingerprint) {
        return applyToolDedup(spec.toolName, fingerprint, merged, toolResultDedup);
      }
      return merged;
    }
    case 'harness.workspace.get_session_info': {
      const { sessionId } = args as { sessionId: string };
      const local = executeWorkspaceGetSessionInfo(deps, { sessionId });
      if (local.ok === false) {
        return unwrap(local);
      }
      const environment = await tryFetchHostEnvironment(deps.bridge, chatSessionId);
      if (environment) {
        const hosts = Array.isArray(environment.hosts)
          ? (environment.hosts as Array<Record<string, unknown>>)
          : [];
        const match = hosts.find((host) => String(host.sessionId) === sessionId);
        if (match) {
          return { ...local.data, ...match };
        }
      }
      return local.data;
    }
    case 'harness.terminal.read_context': {
      const scopeCtx = resolveContext();
      const sessions = scopeCtx.sessions ?? [];
      const requestedSessionId = typeof args.sessionId === 'string' && args.sessionId.trim()
        ? args.sessionId.trim()
        : undefined;
      const sessionId = requestedSessionId
        ?? (sessions.length === 1 ? sessions[0].sessionId : undefined);

      if (!sessionId) {
        return {
          ok: false,
          error: 'sessionId is required because the current AI scope contains multiple terminal sessions.',
        };
      }

      const session = sessions.find((entry) => entry.sessionId === sessionId);
      if (!session) {
        return {
          ok: false,
          error: `Terminal session "${sessionId}" is not in the current AI scope.`,
        };
      }

      if (!scopeCtx.readTerminalContext) {
        return {
          ok: false,
          error: 'Terminal context reader is unavailable for this AI scope.',
        };
      }

      const result = await scopeCtx.readTerminalContext({
        sessionId,
        range: typeof args.range === 'string' ? args.range as TerminalContextReadRange : undefined,
        startLine: typeof args.startLine === 'number' ? args.startLine : undefined,
        maxLines: typeof args.maxLines === 'number' ? args.maxLines : undefined,
      });
      if (result.ok === false) return result;
      const normalizedResult = result;
      const fingerprint = toolResultDedup?.fingerprintFor(
        spec.toolName,
        hashScopeKey([
          sessionId,
          String(normalizedResult.startLine),
          String(normalizedResult.endLine),
          normalizedResult.range,
          hashToolResult(normalizedResult.content),
        ]),
      );
      return fingerprint
        ? applyToolDedup(spec.toolName, fingerprint, normalizedResult, toolResultDedup)
        : normalizedResult;
    }
    case 'harness.web.search': {
      const { query, maxResults } = args as { query: string; maxResults?: number };
      return unwrap(await executeWebSearch(deps, { query, maxResults }));
    }
    case 'harness.url.fetch': {
      const { url, maxLength } = args as { url: string; maxLength?: number };
      const fingerprint = toolResultDedup?.fingerprintFor(spec.toolName, url);
      const raw = unwrap(await executeUrlFetch(deps, { url, maxLength }));
      if (fingerprint) {
        return applyToolDedup(spec.toolName, fingerprint, raw, toolResultDedup);
      }
      return raw;
    }
    default:
      return { error: `No local executor registered for "${spec.capabilityId}".` };
  }
}

function resolveHostWriteQueueKey(
  context: ToolDeps['context'],
  sessionId: string,
): string {
  const resolved = typeof context === 'function' ? context() : context;
  const session = resolved.sessions.find(entry => entry.sessionId === sessionId);
  if (session?.hostId) return hostWriteQueueKey(`id:${session.hostId}`);
  if (session?.hostname) {
    const hostname = session.hostname.trim().toLowerCase();
    const canonicalPeer = resolved.sessions.find(entry =>
      entry.hostId
      && entry.hostname?.trim().toLowerCase() === hostname,
    );
    if (canonicalPeer?.hostId) return hostWriteQueueKey(`id:${canonicalPeer.hostId}`);
    const protocol = session.protocol?.toLowerCase() || 'unknown';
    return hostWriteQueueKey(`name:${hostname}:${protocol}`);
  }
  return hostWriteQueueKey(`session:${sessionId}`);
}

function resolveSessionQueueKey(
  spec: CattyToolSpec,
  args: Record<string, unknown>,
  chatSessionId?: string,
  context?: ToolDeps['context'],
): string | null {
  if (spec.capabilityId.startsWith('harness.') && !spec.policy.write) {
    return null;
  }

  const sessionId = typeof args.sessionId === 'string' ? args.sessionId : undefined;
  if (sessionId) {
    // Host writes are serialized process-wide, not per chat session or terminal
    // session: duplicate connections to one host must not interleave.
    return spec.policy.write
      ? resolveHostWriteQueueKey(context ?? { sessions: [] }, sessionId)
      : `${chatSessionId ?? 'global'}:${sessionId}`;
  }
  if (
    ['vault.host.notes.set', 'portforward.start', 'portforward.stop'].includes(spec.capabilityId)
    && typeof args.hostId === 'string'
  ) {
    return hostWriteQueueKey(`id:${args.hostId}`);
  }
  return `${chatSessionId ?? 'global'}:${spec.toolName}`;
}

export function resolveSessionQueueKeyForTests(
  spec: Pick<CattyToolSpec, 'capabilityId' | 'toolName' | 'policy'>,
  args: Record<string, unknown>,
  chatSessionId?: string,
  context?: ToolDeps['context'],
): string | null {
  return resolveSessionQueueKey(spec as CattyToolSpec, args, chatSessionId, context);
}

function createCatalogTool(spec: CattyToolSpec) {
  const inputSchema = buildZodObject(spec.inputShape);

  // The zod schema is built at runtime from the catalog, so the AI SDK cannot
  // infer this tool's input type at compile time. Declare the signature here and
  // cast it at the `tool()` call instead of leaking `any` through the body.
  const execute = async (
    args: Record<string, unknown>,
    { toolCallId, abortSignal, context }: {
      toolCallId: string;
      abortSignal?: AbortSignal;
      context: CattyToolContext;
    },
  ): Promise<unknown> => {
    const toolContext = context;
      const deps = toolDepsFromContext(toolContext);
      const { toolOutputStore, toolResultDedup } = toolContext;

      const queueKey = resolveSessionQueueKey(
        spec,
        args as Record<string, unknown>,
        deps.chatSessionId,
        deps.context,
      );
      const slot = queueKey ? reserveSessionSlot(queueKey) : null;

      try {
        const result = await (async () => {
        if (abortSignal?.aborted) {
          return { error: 'Tool call cancelled before it could start.' };
        }

        await slot?.ready;

        if (spec.capabilityId === 'terminal.execute') {
          const { sessionId: sid, command } = args as { sessionId: string; command: string };
          const writeFingerprint = buildTerminalWriteFingerprint(
            'terminal_execute',
            deps.chatSessionId,
            { sessionId: sid, command },
          );
          const replay = writeFingerprint
            ? toolResultDedup?.replayCompletedWrite(writeFingerprint)
            : undefined;
          if (replay !== undefined) {
            return {
              ...(typeof replay === 'object' && replay !== null ? replay : { result: replay }),
              replayedCompletedResult: true,
              note: 'The command already executed before request compaction; its recorded result was replayed and the command was not executed again.',
            };
          }
          {
            const target = (typeof deps.context === 'function' ? deps.context() : deps.context).sessions
              .find(session => session.sessionId === sid);
            const result = await executeTerminalExecute(
              deps,
              { sessionId: sid, command },
              {
                abortSignal,
                expectedTarget: target ? {
                  hostId: target.hostId,
                  hostname: target.hostname,
                  protocol: target.protocol,
                } : undefined,
              },
            );
            if (result.ok === false) {
              if (!result.data) return unwrap(result);
              const fittedFailure = {
                error: fitLargeToolResultForModel({
                  result: result.error,
                  capabilityId: 'terminal.execute.error',
                  chatSessionId: deps.chatSessionId,
                  toolOutputStore,
                  terminalSessionId: sid,
                  normalizeStrings: true,
                }),
                ...fitTerminalExecuteResultForModel({
                  ...result.data,
                  command,
                  sessionId: sid,
                }, {
                  chatSessionId: deps.chatSessionId,
                  toolOutputStore,
                }),
              };
              if (writeFingerprint) toolResultDedup?.rememberCompletedWrite(writeFingerprint, fittedFailure);
              return fittedFailure;
            }
            const fitted = fitTerminalExecuteResultForModel({
              ...result.data,
              command,
              sessionId: sid,
            }, {
              chatSessionId: deps.chatSessionId,
              toolOutputStore,
            });
            if (writeFingerprint) toolResultDedup?.rememberCompletedWrite(writeFingerprint, fitted);
            return fitted;
          }
        }

        if (spec.localExecution || spec.capabilityId.startsWith('harness.')) {
          const result = await executeLocalCattyCapability({
            deps,
            spec,
            args: args as Record<string, unknown>,
            toolOutputStore,
            toolResultDedup,
            chatSessionId: deps.chatSessionId,
            toolCallId,
            abortSignal,
            selectedRunbook: toolContext.selectedRunbook,
          });
          return fitCapabilityResultForModel(
            result,
            spec,
            deps.chatSessionId,
            toolOutputStore,
            args as Record<string, unknown>,
            toolResultDedup,
          );
        }

        if (!spec.rpcMethod) {
          return { error: `Capability "${spec.capabilityId}" has no RPC binding.` };
        }

        const terminalStartFingerprint = spec.capabilityId === 'terminal.start'
          ? buildTerminalWriteFingerprint(
              'terminal_start',
              deps.chatSessionId,
              args as { sessionId?: unknown; command?: unknown },
            )
          : undefined;
        const terminalStartReplay = terminalStartFingerprint
          ? toolResultDedup?.replayCompletedWrite(terminalStartFingerprint)
          : undefined;
        if (terminalStartReplay !== undefined) {
          return {
            ...(typeof terminalStartReplay === 'object' && terminalStartReplay !== null
              ? terminalStartReplay
              : { result: terminalStartReplay }),
            replayedCompletedResult: true,
            note: 'The background command already started before request compaction; its recorded job was replayed and no second job was created.',
          };
        }

        let rpcParams = args as Record<string, unknown>;
        const rpcContext = typeof deps.context === 'function' ? deps.context() : deps.context;
        const rpcTarget = typeof rpcParams.sessionId === 'string'
          ? rpcContext.sessions.find(session => session.sessionId === rpcParams.sessionId)
          : undefined;
        if (rpcTarget?.hostId) {
          rpcParams = {
            ...rpcParams,
            expectedHostId: rpcTarget.hostId,
            ...(rpcTarget.hostname ? { expectedHostname: rpcTarget.hostname } : {}),
            ...(rpcTarget.protocol ? { expectedProtocol: rpcTarget.protocol } : {}),
          };
        }
        const directTargetError = validateDirectScopedHostCapability(
          spec.capabilityId,
          rpcParams,
          typeof deps.context === 'function' ? deps.context() : deps.context,
        );
        if (directTargetError) return { error: directTargetError };
        if (spec.capabilityId === 'vault.host.notes.set') {
          const merged = await prepareMachineNotesWrite(deps, rpcParams, abortSignal);
          if ('error' in merged) return merged;
          rpcParams = merged;
        }
        let raw = await invokeCapabilityRpc(
          deps.bridge,
          spec.rpcMethod,
          rpcParams,
          deps.chatSessionId,
          abortSignal,
        );
        if (
          spec.capabilityId === 'terminal.start'
          && raw && typeof raw === 'object'
          && typeof (raw as { jobId?: unknown }).jobId === 'string'
          && typeof (args as { sessionId?: unknown }).sessionId === 'string'
        ) {
          toolResultDedup?.rememberTerminalJobSession(
            (raw as { jobId: string }).jobId,
            (args as { sessionId: string }).sessionId,
          );
        }

        if (
          spec.capabilityId === 'terminal.poll'
          && raw
          && typeof raw === 'object'
          && (raw as { ok?: boolean }).ok !== false
        ) {
          let poll = raw as Record<string, unknown>;
          const monitorKey = `${deps.chatSessionId ?? 'global'}:${String(poll.jobId ?? args.jobId ?? '')}`;
          if (
            isStreamingMonitorCommand(poll.command)
            && typeof poll.output === 'string'
            && poll.output.trim().length > 0
          ) {
            const guarded = globalTerminalMonitorGuard.process(monitorKey, poll.output);
            if (guarded.action === 'stop') {
              const stopResult = await invokeCapabilityRpc(
                deps.bridge,
                'netcatty/jobStop',
                { jobId: poll.jobId ?? args.jobId },
                deps.chatSessionId,
              );
              poll = applyMonitorStopResult(poll, stopResult, guarded.suppressedCount);
            } else if (guarded.action === 'suppress') {
              poll = {
                ...poll,
                output: `[monitor batch suppressed by rate limit; suppressed=${guarded.suppressedCount}]`,
              };
            } else {
              let output = guarded.content;
              if (guarded.sourceTruncated && toolOutputStore && deps.chatSessionId) {
                const jobId = String(poll.jobId ?? args.jobId ?? '');
                const handle = toolOutputStore.store({
                  chatSessionId: deps.chatSessionId,
                  capabilityId: 'terminal.poll.monitor-batch',
                  content: poll.output,
                  sessionId: jobId ? toolResultDedup?.terminalSessionForJob(jobId) : undefined,
                });
                output += [
                  '',
                  `[monitor batch archived before shortening: rawChars=${poll.output.length} handleId=${handle.id}]`,
                  'Use tool_output_read with this handleId to search/read omitted details; the terminal nextOffset already advances past the raw batch.',
                  'This saved output is available only until the app closes. Read this handle before closing the app.',
                ].join('\n');
              }
              poll = { ...poll, output };
            }
          }
          if (poll.status !== 'running' && poll.status !== 'stopping') {
            globalTerminalMonitorGuard.clear(monitorKey);
          }
          raw = poll;
          const fingerprint = toolResultDedup?.fingerprintFor(
            spec.toolName,
            hashScopeKey([
              String(poll.jobId ?? args.jobId ?? ''),
              String(poll.outputBaseOffset ?? ''),
              String(poll.nextOffset ?? ''),
              String(poll.status ?? ''),
              hashToolResult(poll.output ?? ''),
            ]),
          );
          if (fingerprint) {
            return fitCapabilityResultForModel(
              applyToolDedup(spec.toolName, fingerprint, poll, toolResultDedup),
              spec,
              deps.chatSessionId,
              toolOutputStore,
              args as Record<string, unknown>,
              toolResultDedup,
            );
          }
        }

        if (spec.toolName === 'get_environment' || spec.capabilityId === 'session.environment') {
          const ctx = typeof deps.context === 'function' ? deps.context() : deps.context;
          const fingerprint = toolResultDedup?.fingerprintFor(
            spec.toolName,
            hashScopeKey([deps.chatSessionId, ctx.workspaceId, String(ctx.sessions?.length ?? 0)]),
          );
          if (fingerprint) {
            return fitCapabilityResultForModel(
              applyToolDedup(spec.toolName, fingerprint, raw, toolResultDedup),
              spec,
              deps.chatSessionId,
              toolOutputStore,
              args as Record<string, unknown>,
              toolResultDedup,
            );
          }
        }

        if (spec.capabilityId.includes('sftp') && spec.capabilityId.includes('read')) {
          const { sessionId: sid, path } = args as { sessionId?: string; path?: string };
          const fingerprint = toolResultDedup?.fingerprintFor(
            spec.toolName,
            hashScopeKey([sid, path]),
          );
          if (fingerprint) {
            return fitCapabilityResultForModel(
              applyToolDedup(spec.toolName, fingerprint, raw, toolResultDedup),
              spec,
              deps.chatSessionId,
              toolOutputStore,
              args as Record<string, unknown>,
              toolResultDedup,
            );
          }

          if (
            raw
            && typeof raw === 'object'
            && 'content' in raw
            && toolOutputStore
            && deps.chatSessionId
          ) {
            const content = String((raw as { content?: string }).content ?? '');
            const MAX_LIVE_SFTP_READ_CHARS = 24_000;
            if (content.length > MAX_LIVE_SFTP_READ_CHARS) {
              const handle = toolOutputStore.store({
                chatSessionId: deps.chatSessionId,
                capabilityId: spec.capabilityId,
                content,
                sessionId: sid,
              });
              return {
                ok: true,
                path: (raw as { path?: string }).path ?? path,
                preview: handle.preview,
                totalChars: handle.totalChars,
                handleId: handle.id,
                note: 'Full file content is available only until the app closes. Use tool_output_read now.',
              };
            }
          }
        }

        const fittedRaw = fitCapabilityResultForModel(
          raw,
          spec,
          deps.chatSessionId,
          toolOutputStore,
          args as Record<string, unknown>,
          toolResultDedup,
        );
        if (
          terminalStartFingerprint
          && raw && typeof raw === 'object'
          && (raw as { ok?: boolean }).ok !== false
          && typeof (raw as { jobId?: unknown }).jobId === 'string'
        ) {
          toolResultDedup?.rememberCompletedWrite(terminalStartFingerprint, fittedRaw);
        }
        return fittedRaw;
        })();
        if (spec.policy.write && deps.chatSessionId) {
          const failed = Boolean(result && typeof result === 'object' && (
            (result as { ok?: unknown }).ok === false
            || typeof (result as { error?: unknown }).error === 'string'
          ));
          if (failed) {
            failToolCoveredByApprovedPlan(deps.chatSessionId, spec.toolName, args as Record<string, unknown>);
          } else {
            commitToolCoveredByApprovedPlan(deps.chatSessionId, spec.toolName, args as Record<string, unknown>);
          }
        }
        if (toolOutputStore && deps.chatSessionId) {
          await toolOutputStore.flush(deps.chatSessionId);
          return toolOutputStore.resolveRestartPersistenceNotices(result, deps.chatSessionId);
        }
        return result;
      } finally {
        slot?.release();
      }
  }

  return tool({
    description: spec.description,
    inputSchema,
    contextSchema: cattyToolContextSchema,
    execute: execute as Parameters<typeof tool>[0]['execute'],
  });
}

export function buildCattyToolContext(input: {
  bridge: NetcattyBridge;
  context: ToolDeps['context'];
  commandBlocklist?: string[];
  permissionMode: AIPermissionMode;
  webSearchConfig?: WebSearchConfig;
  chatSessionId?: string;
  toolOutputStore?: ToolOutputStore;
  toolResultDedup?: ToolResultDedup;
  selectedRunbook?: Runbook;
}): CattyToolContext {
  return {
    bridge: input.bridge,
    chatSessionId: input.chatSessionId,
    permissionMode: input.permissionMode,
    commandBlocklist: input.commandBlocklist,
    webSearchConfig: input.webSearchConfig,
    getExecutorContext: typeof input.context === 'function'
      ? input.context as () => ExecutorContext
      : () => input.context as ExecutorContext,
    toolOutputStore: input.toolOutputStore,
    toolResultDedup: input.toolResultDedup,
    selectedRunbook: input.selectedRunbook,
  };
}

export function createCattyToolsFromCatalog(
  bridge: NetcattyBridge,
  context: ToolDeps['context'],
  commandBlocklist?: string[],
  permissionMode: AIPermissionMode = 'confirm',
  webSearchConfig?: WebSearchConfig,
  chatSessionId?: string,
  toolOutputStore?: ToolOutputStore,
  toolResultDedup?: ToolResultDedup,
  selectedRunbook?: Runbook,
): CattyToolsBundle {
  const sharedContext = buildCattyToolContext({
    bridge,
    context,
    commandBlocklist,
    permissionMode,
    webSearchConfig,
    chatSessionId,
    toolOutputStore,
    toolResultDedup,
    selectedRunbook,
  });

  const catalogTools: Record<string, ReturnType<typeof tool>> = {};
  const toolsContext: Record<string, CattyToolContext> = {};

  for (const rawSpec of cattyToolSpecs as CattyToolSpec[]) {
    if (rawSpec.capabilityId === 'harness.web.search' && !isWebSearchReady(webSearchConfig)) {
      continue;
    }
    catalogTools[rawSpec.toolName] = createCatalogTool(rawSpec);
    toolsContext[rawSpec.toolName] = sharedContext;
  }

  return { tools: catalogTools, toolsContext };
}

/**
 * Test helper: attach shared context when calling tool.execute directly.
 *
 * `T` is intentionally unconstrained: the catalog tools carry runtime-built zod
 * schemas, which the compiler sees as `never` parameters. Constraining `T` to a
 * callable `execute` made every call site a type error, so the shape is
 * asserted at the call instead and the returned `execute` accepts `unknown`.
 */
export function withCattyToolContext<T extends { execute?: unknown }>(
  toolInstance: T,
  context: CattyToolContext,
  toolCallId = 'test-call',
): Omit<T, 'execute'> & { execute: (input: unknown, options?: Record<string, unknown>) => unknown } {
  const exec = (toolInstance as unknown as {
    execute: (input: unknown, options: Record<string, unknown>) => unknown;
  }).execute.bind(toolInstance);
  return {
    ...toolInstance,
    execute: (input: unknown, options?: Record<string, unknown>) =>
      exec(input, {
        toolCallId,
        messages: [],
        ...options,
        context,
      }),
  } as Omit<T, 'execute'> & { execute: (input: unknown, options?: Record<string, unknown>) => unknown };
}

export { tryFetchHostEnvironment };
