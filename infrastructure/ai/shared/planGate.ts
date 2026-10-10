/**
 * planGate — plan-level approval for the Catty server-management loop.
 *
 * The agent's unit of work is a plan, not a single tool call: the model proposes
 * steps (target host, command, reason, verification), the user approves the plan
 * once, and the agent executes it. Per-tool approval stays for anything the
 * approved plan does not cover (see `cattyToolApproval.ts`).
 *
 * Design mirrors `approvalGate.ts` on purpose — same idle/hard deadline semantics,
 * same trace events, same listener replay — so the two gates behave consistently
 * in the UI and in the trace.
 *
 * Timeout denies. Approval is never inferred from silence.
 */

import {
  CATTY_APPROVAL_TIMEOUT_MS,
  resolveCattyApprovalDeadlines,
} from './approvalConstants';
import { globalTraceStore } from '../harness/traceStore';
import { redactSecretsForModel } from '../harness/modelSecretRedaction';
import type {
  PlanPreconditionResult,
  PlanProposedEvent,
  PlanResolvedEvent,
  PlanStep,
} from '../harness/types';

export interface ProposedPlan {
  planId: string;
  goal: string;
  steps: PlanStep[];
  preconditions?: PlanPreconditionResult[];
  /** Chat session the plan belongs to; used to scope grants and cleanup. */
  chatSessionId?: string;
}

export type PlanOutcome = 'approved' | 'denied' | 'timeout';

export interface PlanDecision {
  outcome: PlanOutcome;
  note?: string;
}

export type PlanProposedListener = (plan: ProposedPlan) => void;
export type PlanResolvedListener = (planId: string, decision: PlanDecision) => void;
export type PlanClearedListener = (planIds: string[]) => void;

interface PendingPlanEntry {
  plan: ProposedPlan;
  presentedPlan: ProposedPlan;
  resolve: (decision: PlanDecision) => void;
  /** Re-checks safety-critical preconditions immediately before approval. */
  validateApproval?: () => PlanDecision | void;
  /** Re-checks session/host identity immediately before each execution. */
  validateExecution?: () => string | null;
  /** Clears the idle auto-deny timer without resolving the plan. */
  cancelTimeout?: () => void;
  /** Drops the idle timer because the plan already settled. */
  dispose?: () => void;
}

interface ApprovedPlanScope {
  planId: string;
  steps: PlanStep[];
  /** Re-checks session/host identity immediately before each execution. */
  validateExecution?: () => string | null;
  /** The next executable step that may be claimed by a write tool call. */
  nextStepIndex: number;
}

const pendingPlans = new Map<string, PendingPlanEntry>();
const consumedPlanIds = new Map<string, number>();
const CONSUMED_PLAN_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CONSUMED_PLAN_IDS = 4096;
const approvedPlansByChatSession = new Map<string, ApprovedPlanScope[]>();

function pruneConsumedPlanIds(now = Date.now()): void {
  for (const [planId, consumedAt] of consumedPlanIds) {
    if (now - consumedAt > CONSUMED_PLAN_TTL_MS) consumedPlanIds.delete(planId);
  }
  while (consumedPlanIds.size > MAX_CONSUMED_PLAN_IDS) {
    const oldest = consumedPlanIds.keys().next().value;
    if (oldest === undefined) break;
    consumedPlanIds.delete(oldest);
  }
}

function isConsumedPlanId(planId: string): boolean {
  pruneConsumedPlanIds();
  return consumedPlanIds.has(planId);
}

function markPlanIdConsumed(planId: string): void {
  consumedPlanIds.delete(planId);
  consumedPlanIds.set(planId, Date.now());
  pruneConsumedPlanIds();
}

const proposedListeners = new Set<PlanProposedListener>();
const resolvedListeners = new Set<PlanResolvedListener>();
const clearedListeners = new Set<PlanClearedListener>();

let planEventCounter = 0;

function nextPlanEventId(prefix: string): string {
  planEventCounter += 1;
  return `${prefix}-${Date.now()}-${planEventCounter}`;
}

type PlanTraceEvent =
  | Omit<PlanProposedEvent, 'sessionId' | 'backend' | 'timestamp'>
  | Omit<PlanResolvedEvent, 'sessionId' | 'backend' | 'timestamp'>;

const TRACE_SENSITIVE_KEY = /(?:password|passphrase|private.?key|secret|token|authorization|credential|content|notes)/i;
const TRACE_SECRET_PATTERN = /(?:^|[^A-Za-z0-9])(?:api[_-]?(?:key|token)|access[_-]?token|token|password|secret)\s*[:=]\s*[^\s,;]+/gi;
const TRACE_SSH_PASSWORD_PATTERN = /(\bsshpass\s+-p\s+)(?:"[^"]*"|'[^']*'|\S+)/gi;
const UNSAFE_PLAN_COMMAND_PATTERN = /(?:\$\(|`|\$\{|\beval\b|\b(?:sh|bash|zsh)\s+-c\b|\b(?:python(?:3)?|perl|ruby|node|php|lua)\s+-c\b|[\r\n;&|<>])/i;

/** Approved plans never contain shell composition or dynamic code execution. */
export function hasUnsafePlanCommand(command: string): boolean {
  return UNSAFE_PLAN_COMMAND_PATTERN.test(command);
}

function redactTraceValue(value: unknown, key?: string): unknown {
  if (key && TRACE_SENSITIVE_KEY.test(key)) return '[redacted]';
  if (Array.isArray(value)) return value.map(entry => redactTraceValue(entry));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([entryKey, entryValue]) => [entryKey, redactTraceValue(entryValue, entryKey)]),
    );
  }
  return typeof value === 'string'
    ? redactSecretsForModel(value)
      .replace(TRACE_SECRET_PATTERN, '[redacted]')
      .replace(TRACE_SSH_PASSWORD_PATTERN, '$1[redacted]')
    : value;
}

function redactTraceSteps(steps: PlanStep[]): PlanStep[] {
  return redactTraceValue(steps) as PlanStep[];
}

function trace(plan: ProposedPlan, event: PlanTraceEvent): void {
  const base = {
    sessionId: plan.chatSessionId ?? 'global',
    chatSessionId: plan.chatSessionId,
    backend: 'catty' as const,
    timestamp: Date.now(),
  };
  // Each branch restores the discriminant the Omit above stripped, so the event
  // stays assignable to the shared AgentEvent union the trace store accepts.
  const safeEvent = event.type === 'plan_proposed'
    ? {
        ...event,
        goal: String(redactTraceValue(event.goal)),
        steps: redactTraceSteps(event.steps),
        preconditions: event.preconditions
          ? redactTraceValue(event.preconditions) as PlanPreconditionResult[]
          : undefined,
      }
    : { ...event, ...(event.note ? { note: String(redactTraceValue(event.note)) } : {}) };
  const appended = safeEvent.type === 'plan_proposed'
    ? { ...base, ...safeEvent, type: 'plan_proposed' as const }
    : { ...base, ...safeEvent, type: 'plan_resolved' as const };
  globalTraceStore.append(appended);
}

export interface ProposePlanInput {
  goal: string;
  steps: PlanStep[];
  preconditions?: PlanPreconditionResult[];
  chatSessionId?: string;
  /** Explicit plan id; generated when omitted. */
  planId?: string;
  timeoutMs?: number;
  /** Optional last-moment safety validation before the user approval is granted. */
  validateApproval?: () => PlanDecision | void;
  /** Cancels a pending approval when the owning Catty turn is aborted. */
  signal?: AbortSignal;
  /** Re-checks target session/host identity before each covered execution. */
  validateExecution?: () => string | null;
}

/**
 * Propose a plan and wait for the user's decision.
 *
 * Re-proposing with the same `planId` returns the pending decision instead of
 * raising a second request, so a retried tool call cannot stack two cards.
 */
export function proposePlan(input: ProposePlanInput): Promise<PlanDecision> {
  const planId = input.planId ?? nextPlanEventId('plan');
  const unverifiedPrecondition = input.preconditions?.find(
    precondition => precondition.ok !== true || precondition.verified !== true,
  );
  if (unverifiedPrecondition) {
    return Promise.resolve({
      outcome: 'denied',
      note: `Precondition "${unverifiedPrecondition.label}" is not harness-verified.`,
    });
  }
  if (isConsumedPlanId(planId)) {
    return Promise.resolve({
      outcome: 'denied',
      note: 'This plan id was already consumed; submit a new plan instead of replaying it.',
    });
  }
  const plan: ProposedPlan = {
    planId,
    goal: input.goal,
    steps: input.steps,
    preconditions: input.preconditions,
    chatSessionId: input.chatSessionId,
  };
  const presentedPlan: ProposedPlan = {
    ...plan,
    goal: String(redactTraceValue(plan.goal)),
    steps: redactTraceSteps(plan.steps),
    preconditions: plan.preconditions
      ? redactTraceValue(plan.preconditions) as PlanPreconditionResult[]
      : undefined,
  };

  const existing = pendingPlans.get(planId);
  if (existing) {
    if (
      existing.plan.chatSessionId !== input.chatSessionId
      || canonicalPlanValue(existing.plan.steps) !== canonicalPlanValue(plan.steps)
      || existing.plan.goal !== plan.goal
    ) {
      return Promise.resolve({
        outcome: 'denied',
        note: 'A plan with this id is already pending for a different chat or payload.',
      });
    }
    return new Promise<PlanDecision>((resolve) => {
      const previousResolve = existing.resolve;
      existing.resolve = (decision) => {
        previousResolve(decision);
        resolve(decision);
      };
    });
  }

  const timeoutMs = input.timeoutMs ?? CATTY_APPROVAL_TIMEOUT_MS;
  const { idleMs, hardDeadlineMs } = resolveCattyApprovalDeadlines(timeoutMs);
  const hardDeadlineAt = Date.now() + hardDeadlineMs;

  const promise = new Promise<PlanDecision>((resolve) => {
    let timerId: ReturnType<typeof setTimeout> | null = null;

    const clearTimer = () => {
      if (timerId) {
        clearTimeout(timerId);
        timerId = null;
      }
    };

    const settle = (decision: PlanDecision) => {
      clearTimer();
      resolve(decision);
    };
    const denyAborted = () => {
      if (!pendingPlans.has(planId)) return;
      pendingPlans.delete(planId);
      markPlanIdConsumed(planId);
      const decision: PlanDecision = {
        outcome: 'denied',
        note: 'Plan approval was cancelled with the owning turn.',
      };
      trace(plan, {
        id: nextPlanEventId('plan-resolved'),
        type: 'plan_resolved',
        planId,
        outcome: decision.outcome,
        note: decision.note,
      });
      for (const listener of clearedListeners) {
        try { listener([planId]); } catch { /* ignore listener errors */ }
      }
      for (const listener of resolvedListeners) {
        try { listener(planId, decision); } catch { /* ignore listener errors */ }
      }
      settle(decision);
    };
    const denyTimedOut = () => {
      if (!pendingPlans.has(planId)) return;
      pendingPlans.delete(planId);
      markPlanIdConsumed(planId);
      input.signal?.removeEventListener('abort', denyAborted);
      const decision: PlanDecision = {
        outcome: 'timeout',
        note: 'Plan approval timed out.',
      };
      trace(plan, {
        id: nextPlanEventId('plan-resolved'),
        type: 'plan_resolved',
        planId,
        outcome: decision.outcome,
        note: decision.note,
      });
      for (const listener of clearedListeners) {
        try { listener([planId]); } catch { /* ignore listener errors */ }
      }
      for (const listener of resolvedListeners) {
        try { listener(planId, decision); } catch { /* ignore listener errors */ }
      }
      settle(decision);
    };

    const armTimer = (ms: number) => {
      clearTimer();
      if (ms <= 0) {
        denyTimedOut();
        return;
      }
      timerId = setTimeout(denyTimedOut, ms);
    };

    pendingPlans.set(planId, {
      plan,
      presentedPlan,
      resolve: settle,
      validateApproval: input.validateApproval,
      validateExecution: input.validateExecution,
      cancelTimeout: () => {
        const remainingHard = hardDeadlineAt - Date.now();
        if (remainingHard <= 0) {
          armTimer(0);
          return;
        }
        // Review activity re-arms a full idle window from now, never past the
        // hard deadline.
        armTimer(Math.min(idleMs, remainingHard));
      },
      dispose: () => {
        clearTimer();
        input.signal?.removeEventListener('abort', denyAborted);
      },
    });

    if (input.signal?.aborted) {
      denyAborted();
      return;
    }
    input.signal?.addEventListener('abort', denyAborted, { once: true });

    trace(plan, {
      id: nextPlanEventId('plan-proposed'),
      type: 'plan_proposed',
      planId,
      goal: plan.goal,
      steps: plan.steps,
      preconditions: plan.preconditions,
      expiresAt: hardDeadlineAt,
    });

    for (const listener of proposedListeners) {
      try { listener(presentedPlan); } catch { /* ignore listener errors */ }
    }

    // Armed last: a zero-length idle window must deny after the request has
    // already been traced and announced.
    armTimer(idleMs);
  });

  return promise;
}

/**
 * Re-arm the idle timer while the user is reading or editing the plan. Same
 * contract as `cancelApprovalTimeout`: never auto-approves.
 */
export function cancelPlanTimeout(planId: string): void {
  pendingPlans.get(planId)?.cancelTimeout?.();
}

/**
 * Record the user's decision for a pending plan.
 *
 * Approved plans register their steps as a narrow scope: tool calls that match an
 * approved step (same tool, target session(s), and exact args) no longer asks
 * for per-tool approval inside that chat session. Everything outside the scope
 * still asks.
 */
export function resolvePlan(
  planId: string,
  decision: boolean | PlanDecision,
  expectedChatSessionId?: string,
): void {
  const outcome: PlanOutcome = typeof decision === 'boolean'
    ? (decision ? 'approved' : 'denied')
    : decision.outcome;
  const note = typeof decision === 'boolean' ? undefined : decision.note;
  let normalized: PlanDecision = { outcome, ...(note ? { note } : {}) };

  const entry = pendingPlans.get(planId);
  if (!entry) {
    // Stale UI click after the entry was already drained — do not fan out a
    // second resolution.
    return;
  }
  if (
    expectedChatSessionId !== undefined
    && entry.plan.chatSessionId !== expectedChatSessionId
  ) {
    // The renderer must not be able to resolve a plan belonging to another
    // chat/session, even if a stale callback retained the plan id.
    return;
  }
  if (normalized.outcome === 'approved' && entry.validateApproval) {
    try {
      const validation = entry.validateApproval();
      if (validation) normalized = validation;
    } catch (error) {
      normalized = {
        outcome: 'denied',
        note: `Plan safety validation failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  pendingPlans.delete(planId);
  markPlanIdConsumed(planId);
  entry.dispose?.();
  entry.resolve(normalized);

  if (normalized.outcome === 'approved') {
    registerApprovedPlan(entry.plan, entry.validateExecution);
  }

  trace(entry.plan, {
    id: nextPlanEventId('plan-resolved'),
    type: 'plan_resolved',
    planId,
    outcome: normalized.outcome,
    note: normalized.note,
  });
  for (const listener of clearedListeners) {
    try { listener([planId]); } catch { /* ignore listener errors */ }
  }
  for (const listener of resolvedListeners) {
    try { listener(planId, normalized); } catch { /* ignore listener errors */ }
  }
}

function registerApprovedPlan(
  plan: ProposedPlan,
  validateExecution?: () => string | null,
): void {
  const chatSessionId = plan.chatSessionId;
  if (!chatSessionId) return;
  const scopes = approvedPlansByChatSession.get(chatSessionId) ?? [];
  scopes.push({
    planId: plan.planId,
    steps: plan.steps,
    validateExecution,
    nextStepIndex: 0,
  });
  approvedPlansByChatSession.set(chatSessionId, scopes);
}

/**
 * True when a tool call is covered by an approved plan in this chat session.
 *
 * A step covers a call when it names the same tool and its exact structured
 * args match. Write steps should therefore name their target session(s).
 * Multi-host tools (`terminal_batch`, `compare_machines`) carry `sessionIds`
 * instead of `sessionId`, so the full target list is part of approval.
 */
export function isToolCoveredByApprovedPlan(
  chatSessionId: string | undefined,
  toolName: string,
  args: Record<string, unknown>,
): boolean {
  if (!chatSessionId) return false;
  if (typeof args.command === 'string' && hasUnsafePlanCommand(args.command)) return false;
  const scopes = approvedPlansByChatSession.get(chatSessionId);
  if (!scopes?.length) return false;
  const comparableArgs = normalizePlanArgs(toolName, args);
  const sessionId = typeof comparableArgs.sessionId === 'string' ? comparableArgs.sessionId : undefined;
  const sessionIds = Array.isArray(comparableArgs.sessionIds)
    ? comparableArgs.sessionIds.filter((entry): entry is string => typeof entry === 'string')
    : [];

  for (const scope of scopes) {
    if (scope.validateExecution?.()) continue;
    // Plans submitted by Catty contain executable write steps only. A read step
    // must not be silently skipped because doing so would weaken plan order.
    const step = scope.steps[scope.nextStepIndex];
    if (!step || step.toolName !== toolName) continue;
    if (step.sessionId && step.sessionId !== sessionId && !sessionIds.includes(step.sessionId)) {
      continue;
    }

    const expectedArgs = expectedPlanArgs(step);
    // A plan without an exact payload must never widen into blanket consent.
    if (!expectedArgs || !samePlanArgs(
      normalizePlanArgs(toolName, expectedArgs),
      comparableArgs,
    )) continue;

    return true;
  }
  return false;
}

/** Commit the current approved step only after its tool handler succeeded. */
export function commitToolCoveredByApprovedPlan(
  chatSessionId: string | undefined,
  toolName: string,
  args: Record<string, unknown>,
): boolean {
  if (!chatSessionId) return false;
  const scopes = approvedPlansByChatSession.get(chatSessionId);
  if (!scopes?.length) return false;
  const comparableArgs = normalizePlanArgs(toolName, args);
  const sessionId = typeof comparableArgs.sessionId === 'string' ? comparableArgs.sessionId : undefined;
  const sessionIds = Array.isArray(comparableArgs.sessionIds)
    ? comparableArgs.sessionIds.filter((entry): entry is string => typeof entry === 'string')
    : [];
  for (const scope of scopes) {
    if (scope.validateExecution?.()) continue;
    const step = scope.steps[scope.nextStepIndex];
    if (!step || step.toolName !== toolName) continue;
    if (step.sessionId && step.sessionId !== sessionId && !sessionIds.includes(step.sessionId)) continue;
    const expectedArgs = expectedPlanArgs(step);
    if (!expectedArgs || !samePlanArgs(normalizePlanArgs(toolName, expectedArgs), comparableArgs)) continue;
    scope.nextStepIndex += 1;
    return true;
  }
  return false;
}

function expectedPlanArgs(step: PlanStep): Record<string, unknown> | undefined {
  if (step.args && typeof step.args === 'object' && !Array.isArray(step.args)) {
    return step.args;
  }

  const expected: Record<string, unknown> = {};
  if (step.sessionId) expected.sessionId = step.sessionId;
  if (step.sessionIds) expected.sessionIds = step.sessionIds;
  if (
    step.command
    && (step.toolName === 'terminal_execute'
      || step.toolName === 'terminal_start'
      || step.toolName === 'terminal_batch'
      || step.toolName === 'compare_machines')
  ) {
    expected.command = step.command;
  }
  return Object.keys(expected).length > 0 ? expected : undefined;
}

function samePlanArgs(expected: Record<string, unknown>, actual: Record<string, unknown>): boolean {
  return canonicalPlanValue(expected) === canonicalPlanValue(actual);
}

function normalizePlanArgs(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  if (toolName !== 'terminal_batch' && toolName !== 'compare_machines') return args;
  if (typeof args.sessionIds !== 'string') return args;
  try {
    const parsed = JSON.parse(args.sessionIds) as unknown;
    return Array.isArray(parsed) ? { ...args, sessionIds: parsed } : args;
  } catch {
    return args;
  }
}

function canonicalPlanValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalPlanValue).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalPlanValue((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/** Drop plan scope grants for a chat session (called when its turn ends). */
export function clearApprovedPlans(chatSessionId: string | undefined): void {
  if (!chatSessionId) return;
  approvedPlansByChatSession.delete(chatSessionId);
}

/**
 * Drop everything for a chat session: pending plans are denied so their awaiting
 * tool calls cannot hang, and scope grants are dropped.
 */
export function clearChatSessionPlans(chatSessionId: string | undefined): void {
  if (!chatSessionId) return;
  const dropped: string[] = [];
  for (const [planId, entry] of pendingPlans) {
    if (entry.plan.chatSessionId !== chatSessionId) continue;
    dropped.push(planId);
    markPlanIdConsumed(planId);
    pendingPlans.delete(planId);
    entry.dispose?.();
    const decision = { outcome: 'denied' as const, note: 'Chat session was stopped.' };
    entry.resolve(decision);
    trace(entry.plan, {
      id: nextPlanEventId('plan-resolved'),
      type: 'plan_resolved',
      planId,
      outcome: decision.outcome,
      note: decision.note,
    });
    for (const listener of resolvedListeners) {
      try { listener(planId, decision); } catch { /* ignore listener errors */ }
    }
  }
  approvedPlansByChatSession.delete(chatSessionId);
  if (dropped.length > 0) {
    for (const listener of clearedListeners) {
      try { listener(dropped); } catch { /* ignore listener errors */ }
    }
  }
}

export function onPlanProposed(listener: PlanProposedListener): () => void {
  proposedListeners.add(listener);
  return () => { proposedListeners.delete(listener); };
}

export function onPlanResolved(listener: PlanResolvedListener): () => void {
  resolvedListeners.add(listener);
  return () => { resolvedListeners.delete(listener); };
}

export function onPlanCleared(listener: PlanClearedListener): () => void {
  clearedListeners.add(listener);
  return () => { clearedListeners.delete(listener); };
}

/**
 * Replay currently pending plans to a listener. Used when the chat UI remounts,
 * so a plan requested while no listener was mounted is not silently missed.
 */
export function hasApprovedPlanScope(chatSessionId: string | undefined): boolean {
  return Boolean(chatSessionId && approvedPlansByChatSession.get(chatSessionId)?.length);
}

export function replayPendingPlans(listener: PlanProposedListener): void {
  for (const [, entry] of pendingPlans) {
    try { listener(entry.presentedPlan); } catch { /* ignore listener errors */ }
  }
}

/** Test-only: drop all plan state. */
export function resetPlanGateForTests(): void {
  for (const [, entry] of pendingPlans) {
    entry.dispose?.();
    entry.resolve({ outcome: 'denied', note: 'Plan gate reset.' });
  }
  pendingPlans.clear();
  consumedPlanIds.clear();
  approvedPlansByChatSession.clear();
  proposedListeners.clear();
  resolvedListeners.clear();
  clearedListeners.clear();
  planEventCounter = 0;
}
