import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  cancelPlanTimeout,
  clearApprovedPlans,
  clearChatSessionPlans,
  isToolCoveredByApprovedPlan,
  onPlanCleared,
  onPlanProposed,
  onPlanResolved,
  proposePlan,
  replayPendingPlans,
  resetPlanGateForTests,
  resolvePlan,
  type ProposedPlan,
} from './planGate';
import type { AgentEvent } from '../harness/types';
import { globalTraceStore } from '../harness/traceStore';

const step = (overrides: Partial<{ id: string; title: string; toolName?: string; sessionId?: string; command?: string; args?: Record<string, unknown> }> = {}) => ({
  id: 's1',
  title: 'install nginx',
  toolName: 'terminal_execute',
  sessionId: 'sess-a',
  command: 'systemctl reload nginx',
  ...overrides,
});

const chatSessionId = 'chat-1';

describe('planGate', () => {
  beforeEach(() => {
    resetPlanGateForTests();
  });

  it('resolves approved and traces a proposed/resolved pair', async () => {
    const plan = proposePlan({
      goal: 'install nginx',
      steps: [step()],
      chatSessionId,
      planId: 'plan-1',
    });

    const resolved = resolvePlan('plan-1', { outcome: 'approved' });
    assert.equal(resolved, undefined);

    const decision = await plan;
    assert.deepEqual(decision, { outcome: 'approved' });
  });

  it('denies a plan with the user note attached', async () => {
    const pending = proposePlan({
      goal: 'drop table',
      steps: [step({ toolName: 'terminal_execute' })],
      chatSessionId,
      planId: 'plan-2',
    });
    resolvePlan('plan-2', { outcome: 'denied', note: 'too risky' });
    assert.deepEqual(await pending, { outcome: 'denied', note: 'too risky' });
  });

  it('denies a pending plan when its owning turn aborts', async () => {
    const controller = new AbortController();
    const pending = proposePlan({
      goal: 'install nginx',
      steps: [step()],
      chatSessionId,
      planId: 'plan-abort',
      signal: controller.signal,
    });
    controller.abort();
    assert.deepEqual(await pending, {
      outcome: 'denied',
      note: 'Plan approval was cancelled with the owning turn.',
    });
    resolvePlan('plan-abort', { outcome: 'approved' });
    assert.equal(isToolCoveredByApprovedPlan(chatSessionId, 'terminal_execute', {
      sessionId: 'sess-a',
      command: 'systemctl reload nginx',
    }), false);
  });

  it('denies on timeout and never infers approval from silence', async () => {
    const pending = proposePlan({
      goal: 'install nginx',
      steps: [step()],
      chatSessionId,
      planId: 'plan-3',
      timeoutMs: 0,
    });
    assert.deepEqual(await pending, {
      outcome: 'timeout',
      note: 'Plan approval timed out.',
    });
  });

  it('returns the pending decision when the same plan is proposed twice', async () => {
    const first = proposePlan({
      goal: 'install nginx',
      steps: [step()],
      chatSessionId,
      planId: 'plan-4',
    });
    const second = proposePlan({
      goal: 'install nginx',
      steps: [step()],
      chatSessionId,
      planId: 'plan-4',
    });
    resolvePlan('plan-4', true);
    assert.deepEqual(await first, { outcome: 'approved' });
    assert.deepEqual(await second, { outcome: 'approved' });
  });

  it('rejects a reused plan id from another chat or payload', async () => {
    const first = proposePlan({
      goal: 'install nginx',
      steps: [step()],
      chatSessionId: 'chat-plan-owner',
      planId: 'plan-reused',
    });
    const differentChat = proposePlan({
      goal: 'remove nginx',
      steps: [step({ command: 'rm -rf /' })],
      chatSessionId: 'chat-plan-attacker',
      planId: 'plan-reused',
    });
    assert.deepEqual(await differentChat, {
      outcome: 'denied',
      note: 'A plan with this id is already pending for a different chat or payload.',
    });
    resolvePlan('plan-reused', { outcome: 'approved' });
    assert.deepEqual(await first, { outcome: 'approved' });
  });

  it('does not allow a resolved plan id to be replayed', async () => {
    const pending = proposePlan({
      goal: 'install nginx',
      steps: [step()],
      chatSessionId,
      planId: 'plan-consumed',
    });
    resolvePlan('plan-consumed', { outcome: 'denied' });
    await pending;
    assert.deepEqual(await proposePlan({
      goal: 'install nginx',
      steps: [step()],
      chatSessionId,
      planId: 'plan-consumed',
    }), {
      outcome: 'denied',
      note: 'This plan id was already consumed; submit a new plan instead of replaying it.',
    });
  });

  it('ignores a resolution for an unknown or already resolved plan', () => {
    resolvePlan('missing-plan', { outcome: 'approved' });
    const pending = proposePlan({
      goal: 'install nginx',
      steps: [step()],
      chatSessionId,
      planId: 'plan-5',
    });
    resolvePlan('plan-5', { outcome: 'approved' });
    resolvePlan('plan-5', { outcome: 'denied' });
    return pending.then((decision) => assert.deepEqual(decision, { outcome: 'approved' }));
  });

  it('notifies listeners on propose, resolve and clear', async () => {
    const proposed: ProposedPlan[] = [];
    const resolved: Array<{ planId: string; outcome: string }> = [];
    const cleared: string[][] = [];
    const offProposed = onPlanProposed((plan) => proposed.push(plan));
    const offResolved = onPlanResolved((planId, decision) => resolved.push({ planId, outcome: decision.outcome }));
    const offCleared = onPlanCleared((ids) => cleared.push(ids));

    const pending = proposePlan({
      goal: 'install nginx',
      steps: [step()],
      chatSessionId,
      planId: 'plan-6',
    });
    assert.equal(proposed.length, 1);
    assert.equal(proposed[0]?.goal, 'install nginx');

    resolvePlan('plan-6', { outcome: 'approved' });
    await pending;
    assert.deepEqual(resolved, [{ planId: 'plan-6', outcome: 'approved' }]);
    assert.deepEqual(cleared, [['plan-6']]);

    offProposed();
    offResolved();
    offCleared();
  });

  it('replays pending plans to a late listener', () => {
    const seen: ProposedPlan[] = [];
    const pending = proposePlan({
      goal: 'install nginx',
      steps: [step()],
      chatSessionId,
      planId: 'plan-7',
    });
    replayPendingPlans((plan) => seen.push(plan));
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.planId, 'plan-7');
    resolvePlan('plan-7', { outcome: 'denied' });
    return pending.then((decision) => assert.equal(decision.outcome, 'denied'));
  });

  it('re-arming the idle timer does not resolve the plan', async () => {
    const pending = proposePlan({
      goal: 'install nginx',
      steps: [step()],
      chatSessionId,
      planId: 'plan-8',
      timeoutMs: 5_000,
    });
    cancelPlanTimeout('plan-8');
    // Settle only through an explicit decision, never through the re-armed timer.
    const race = await Promise.race([
      pending.then((decision) => decision),
      new Promise((resolve) => setTimeout(() => resolve('still-pending'), 30)),
    ]);
    assert.equal(race, 'still-pending');
    resolvePlan('plan-8', { outcome: 'approved' });
    assert.deepEqual(await pending, { outcome: 'approved' });
  });

  describe('approved plan scope', () => {
    it('covers only the exact command and session an approved step named', async () => {
      const pending = proposePlan({
        goal: 'install nginx',
        steps: [step({ toolName: 'terminal_execute', sessionId: 'sess-a' })],
        chatSessionId,
        planId: 'plan-9',
      });
      resolvePlan('plan-9', { outcome: 'approved' });
      await pending;

      assert.equal(isToolCoveredByApprovedPlan(chatSessionId, 'terminal_execute', { sessionId: 'sess-a', command: 'systemctl reload nginx' }), true);
      assert.equal(isToolCoveredByApprovedPlan(chatSessionId, 'terminal_execute', { sessionId: 'sess-a', command: 'rm -rf /' }), false);
      assert.equal(isToolCoveredByApprovedPlan(chatSessionId, 'terminal_execute', { sessionId: 'sess-b', command: 'systemctl reload nginx' }), false);
      assert.equal(isToolCoveredByApprovedPlan(chatSessionId, 'sftp_delete', { sessionId: 'sess-a' }), false);
    });

    it('does not cover a call when the approved step omitted its session', async () => {
      const pending = proposePlan({
        goal: 'read state',
        steps: [{ id: 's1', title: 'check disk', toolName: 'terminal_execute', command: 'systemctl reload nginx' }],
        chatSessionId,
        planId: 'plan-10',
      });
      resolvePlan('plan-10', { outcome: 'approved' });
      await pending;
      assert.equal(isToolCoveredByApprovedPlan(chatSessionId, 'terminal_execute', { sessionId: 'anything', command: 'systemctl reload nginx' }), false);
    });

    it('covers nothing for steps without a tool name or on other sessions', async () => {
      const pending = proposePlan({
        goal: 'vague',
        steps: [{ id: 's1', title: 'do the thing' }],
        chatSessionId,
        planId: 'plan-11',
      });
      resolvePlan('plan-11', { outcome: 'approved' });
      await pending;
      assert.equal(isToolCoveredByApprovedPlan(chatSessionId, 'terminal_execute', { sessionId: 'sess-a' }), false);
      assert.equal(isToolCoveredByApprovedPlan('chat-other', 'terminal_execute', { sessionId: 'sess-a' }), false);
      assert.equal(isToolCoveredByApprovedPlan(undefined, 'terminal_execute', { sessionId: 'sess-a' }), false);
    });

    it('drops grants when the turn ends', async () => {
      const pending = proposePlan({
        goal: 'install nginx',
        steps: [step()],
        chatSessionId,
        planId: 'plan-12',
      });
      resolvePlan('plan-12', { outcome: 'approved' });
      await pending;
      assert.equal(isToolCoveredByApprovedPlan(chatSessionId, 'terminal_execute', { sessionId: 'sess-a', command: 'systemctl reload nginx' }), true);
      clearApprovedPlans(chatSessionId);
      assert.equal(isToolCoveredByApprovedPlan(chatSessionId, 'terminal_execute', { sessionId: 'sess-a', command: 'systemctl reload nginx' }), false);
    });

    it('covers a multi-host step that names one of the target sessions', async () => {
      const pending = proposePlan({
        goal: 'restart nginx on both web hosts',
        steps: [step({
          toolName: 'terminal_batch',
          sessionId: undefined,
          args: { sessionIds: ['sess-a', 'sess-b', 'sess-c'], command: 'systemctl reload nginx' },
        })],
        chatSessionId,
        planId: 'plan-multi',
      });
      resolvePlan('plan-multi', { outcome: 'approved' });
      await pending;

      assert.equal(
        isToolCoveredByApprovedPlan(chatSessionId, 'terminal_batch', {
          sessionIds: JSON.stringify(['sess-a', 'sess-b', 'sess-c']),
          command: 'systemctl reload nginx',
        }),
        true,
      );
      assert.equal(
        isToolCoveredByApprovedPlan(chatSessionId, 'terminal_batch', { sessionIds: ['sess-z'], command: 'systemctl reload nginx' }),
        false,
      );
    });
  });

  it('clearing a chat session denies its pending plans', async () => {
    const pending = proposePlan({
      goal: 'install nginx',
      steps: [step()],
      chatSessionId,
      planId: 'plan-13',
    });
    clearChatSessionPlans(chatSessionId);
    assert.deepEqual(await pending, {
      outcome: 'denied',
      note: 'Chat session was stopped.',
    });
  });

  it('does not drop another chat session when clearing one', async () => {
    const mine = proposePlan({
      goal: 'install nginx',
      steps: [step()],
      chatSessionId: 'chat-1',
      planId: 'plan-14',
    });
    const theirs = proposePlan({
      goal: 'install nginx',
      steps: [step()],
      chatSessionId: 'chat-2',
      planId: 'plan-15',
    });
    clearChatSessionPlans('chat-1');
    resolvePlan('plan-15', { outcome: 'approved' });
    assert.equal((await mine).outcome, 'denied');
    assert.equal((await theirs).outcome, 'approved');
  });

  it('traces plan events into the shared trace store', async () => {
    globalTraceStore.clear(chatSessionId);
    const pending = proposePlan({
      goal: 'install nginx',
      steps: [step()],
      chatSessionId,
      planId: 'plan-16',
    });
    resolvePlan('plan-16', { outcome: 'approved' });
    await pending;

    const traced = globalTraceStore.getEvents(chatSessionId).filter(
      (event): event is Extract<AgentEvent, { type: 'plan_proposed' | 'plan_resolved' }> =>
        event.type === 'plan_proposed' || event.type === 'plan_resolved',
    );
    assert.equal(traced.length, 2);
    assert.equal(traced[0]?.type, 'plan_proposed');
    assert.equal(traced[0]?.backend, 'catty');
    assert.equal(traced[0]?.type === 'plan_proposed' ? traced[0].goal : '', 'install nginx');
    assert.equal(traced[1]?.type === 'plan_resolved' ? traced[1].outcome : '', 'approved');
    globalTraceStore.clear(chatSessionId);
  });

  it('redacts structured secrets before plan events enter the trace', async () => {
    globalTraceStore.clear('chat-trace-secret');
    const pending = proposePlan({
      goal: 'write notes',
      steps: [step({
        args: {
          sessionId: 'sess-a',
          notes: 'API_TOKEN=tok_live_1234567890',
          content: 'private material',
        },
      })],
      chatSessionId: 'chat-trace-secret',
      planId: 'plan-trace-secret',
    });
    resolvePlan('plan-trace-secret', { outcome: 'approved' });
    await pending;
    const proposed = globalTraceStore.getEvents('chat-trace-secret')
      .find(event => event.type === 'plan_proposed');
    const serialized = JSON.stringify(proposed);
    assert.doesNotMatch(serialized, /tok_live_1234567890|private material/);
    assert.match(serialized, /redacted/);
    globalTraceStore.clear('chat-trace-secret');
  });
});
