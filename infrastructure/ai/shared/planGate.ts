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
  resolve: (decision: PlanDecision) => void;
  /** Clears the idle auto-deny timer without resolving the plan. */
  cancelTimeout?: () => void;
  /** Drops the idle timer because the plan already settled. */
  dispose?: () => void;
}

interface ApprovedPlanScope {
  planId: string;
  steps: PlanStep[];
}

const pendingPlans = new Map<string, PendingPlanEntry>();
const approvedPlansByChatSession = new Map<string, ApprovedPlanScope[]>();

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

function trace(plan: ProposedPlan, event: PlanTraceEvent): void {
  const base = {
    sessionId: plan.chatSessionId ?? 'global',
    chatSessionId: plan.chatSessionId,
    backend: 'catty' as const,
    timestamp: Date.now(),
  };
  // Each branch restores the discriminant the Omit above stripped, so the event
  // stays assignable to the shared AgentEvent union the trace store accepts.
  const appended = event.type === 'plan_proposed'
    ? { ...base, ...event, type: 'plan_proposed' as const }
    : { ...base, ...event, type: 'plan_resolved' as const };
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
}

/**
 * Propose a plan and wait for the user's decision.
 *
 * Re-proposing with the same `planId` returns the pending decision instead of
 * raising a second request, so a retried tool call cannot stack two cards.
 */
export function proposePlan(input: ProposePlanInput): Promise<PlanDecision> {
  const planId = input.planId ?? nextPlanEventId('plan');
  const plan: ProposedPlan = {
    planId,
    goal: input.goal,
    steps: input.steps,
    preconditions: input.preconditions,
    chatSessionId: input.chatSessionId,
  };

  const existing = pendingPlans.get(planId);
  if (existing) {
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
    const denyTimedOut = () => {
      if (!pendingPlans.has(planId)) return;
      pendingPlans.delete(planId);
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
      resolve: settle,
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
      dispose: clearTimer,
    });

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
      try { listener(plan); } catch { /* ignore listener errors */ }
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
 * approved step (same tool, same target session) no longer ask for per-tool
 * approval inside that chat session. Everything outside the scope still asks.
 */
export function resolvePlan(planId: string, decision: boolean | PlanDecision): void {
  const outcome: PlanOutcome = typeof decision === 'boolean'
    ? (decision ? 'approved' : 'denied')
    : decision.outcome;
  const note = typeof decision === 'boolean' ? undefined : decision.note;
  const normalized: PlanDecision = { outcome, ...(note ? { note } : {}) };

  const entry = pendingPlans.get(planId);
  if (!entry) {
    // Stale UI click after the entry was already drained — do not fan out a
    // second resolution.
    return;
  }
  pendingPlans.delete(planId);
  entry.dispose?.();
  entry.resolve(normalized);

  if (normalized.outcome === 'approved') {
    registerApprovedPlan(entry.plan);
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

function registerApprovedPlan(plan: ProposedPlan): void {
  const chatSessionId = plan.chatSessionId;
  if (!chatSessionId) return;
  const scopes = approvedPlansByChatSession.get(chatSessionId) ?? [];
  scopes.push({ planId: plan.planId, steps: plan.steps });
  approvedPlansByChatSession.set(chatSessionId, scopes);
}

/**
 * True when a tool call is covered by an approved plan in this chat session.
 *
 * A step covers a call when it names the same tool and either names no target
 * session or names the same one. Multi-host tools (`terminal_batch`,
 * `compare_machines`) carry `sessionIds` instead of `sessionId`, so a step
 * naming one of the listed hosts still counts as covered.
 */
export function isToolCoveredByApprovedPlan(
  chatSessionId: string | undefined,
  toolName: string,
  args: Record<string, unknown>,
): boolean {
  if (!chatSessionId) return false;
  const scopes = approvedPlansByChatSession.get(chatSessionId);
  if (!scopes?.length) return false;
  const sessionId = typeof args.sessionId === 'string' ? args.sessionId : undefined;
  const sessionIds = Array.isArray(args.sessionIds)
    ? args.sessionIds.filter((entry): entry is string => typeof entry === 'string')
    : [];
  return scopes.some(scope => scope.steps.some(step => {
    if (step.toolName !== toolName) return false;
    if (!step.sessionId) return true;
    return step.sessionId === sessionId || sessionIds.includes(step.sessionId);
  }));
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
    pendingPlans.delete(planId);
    entry.dispose?.();
    entry.resolve({ outcome: 'denied', note: 'Chat session was stopped.' });
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
export function replayPendingPlans(listener: PlanProposedListener): void {
  for (const [, entry] of pendingPlans) {
    try { listener(entry.plan); } catch { /* ignore listener errors */ }
  }
}

/** Test-only: drop all plan state. */
export function resetPlanGateForTests(): void {
  for (const [, entry] of pendingPlans) {
    entry.dispose?.();
    entry.resolve({ outcome: 'denied', note: 'Plan gate reset.' });
  }
  pendingPlans.clear();
  approvedPlansByChatSession.clear();
  proposedListeners.clear();
  resolvedListeners.clear();
  clearedListeners.clear();
  planEventCounter = 0;
}
