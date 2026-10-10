import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildCattyToolApproval } from './cattyToolApproval';
import { proposePlan, resetPlanGateForTests, resolvePlan } from '../shared/planGate';
import type { PlanStep } from './types';

describe('buildCattyToolApproval', () => {
  it('auto-approves read-only tools', async () => {
    const approval = buildCattyToolApproval({ permissionMode: 'confirm', chatSessionId: 'chat-1' });
    const result = await approval({
      toolCall: {
        toolCallId: 'call-1',
        toolName: 'terminal_read_context',
        input: { range: 'viewport' },
      },
    } as Parameters<typeof approval>[0]);
    assert.equal(result, undefined);
  });

  it('allows observer-bypass write tools in observer mode', async () => {
    const approval = buildCattyToolApproval({ permissionMode: 'observer', chatSessionId: 'chat-1' });
    const result = await approval({
      toolCall: {
        toolCallId: 'call-stop',
        toolName: 'terminal_stop',
        input: { jobId: 'job-1' },
      },
    } as Parameters<typeof approval>[0]);
    assert.equal(result, undefined);
  });

  it('denies write tools in observer mode', async () => {
    const approval = buildCattyToolApproval({ permissionMode: 'observer', chatSessionId: 'chat-1' });
    const result = await approval({
      toolCall: {
        toolCallId: 'call-2',
        toolName: 'sftp_write_file',
        input: { path: '/tmp/x', content: 'hi' },
      },
    } as Parameters<typeof approval>[0]);
    assert.deepEqual(result, {
      type: 'denied',
      reason: 'Observer mode blocks write operations.',
    });
  });

  it('auto-approves write tools in auto mode', async () => {
    const approval = buildCattyToolApproval({ permissionMode: 'auto', chatSessionId: 'chat-1' });
    const result = await approval({
      toolCall: {
        toolCallId: 'call-3',
        toolName: 'sftp_write_file',
        input: { path: '/tmp/x', content: 'hi' },
      },
    } as Parameters<typeof approval>[0]);
    assert.equal(result, undefined);
  });

  it('awaits user approval in confirm mode for write tools', async () => {
    let approvalRequested = false;
    const approval = buildCattyToolApproval({
      permissionMode: 'confirm',
      chatSessionId: 'chat-1',
      requestApproval: async (toolCallId, toolName) => {
        approvalRequested = true;
        assert.equal(toolCallId, 'call-4');
        assert.equal(toolName, 'sftp_write_file');
        return true;
      },
    });
    const result = await approval({
      toolCall: {
        toolCallId: 'call-4',
        toolName: 'sftp_write_file',
        input: { path: '/tmp/x', content: 'hi' },
      },
    } as Parameters<typeof approval>[0]);
    assert.equal(approvalRequested, true);
    assert.deepEqual(result, { type: 'approved' });
  });

  it('returns denied when confirm-mode approval is rejected', async () => {
    const approval = buildCattyToolApproval({
      permissionMode: 'confirm',
      chatSessionId: 'chat-1',
      requestApproval: async () => false,
    });
    const result = await approval({
      toolCall: {
        toolCallId: 'call-5',
        toolName: 'sftp_write_file',
        input: { path: '/tmp/x', content: 'hi' },
      },
    } as Parameters<typeof approval>[0]);
    assert.deepEqual(result, {
      type: 'denied',
      reason: 'User denied tool execution.',
    });
  });
});

describe('buildCattyToolApproval with an approved plan', () => {
  beforeEach(() => {
    resetPlanGateForTests();
  });

  const approvePlan = async (planId: string, steps: PlanStep[]) => {
    const chatSessionId = 'chat-plan';
    const pending = proposePlan({ goal: 'test plan', steps, chatSessionId, planId });
    await new Promise(resolve => setTimeout(resolve, 0));
    resolvePlan(planId, { outcome: 'approved' });
    await pending;
  };

  it('skips the per-call prompt for a tool call the approved plan named', async () => {
    await approvePlan('plan-call-6', [
      {
        id: 's1',
        title: 'write file',
        toolName: 'sftp_write_file',
        sessionId: 'session-a',
        args: { sessionId: 'session-a', path: '/tmp/x', content: 'hi' },
      },
    ]);
    let asked = false;
    const approval = buildCattyToolApproval({
      permissionMode: 'confirm',
      chatSessionId: 'chat-plan',
      requestApproval: async () => { asked = true; return false; },
    });
    const result = await approval({
      toolCall: {
        toolCallId: 'call-6',
        toolName: 'sftp_write_file',
        input: { sessionId: 'session-a', path: '/tmp/x', content: 'hi' },
      },
    } as Parameters<typeof approval>[0]);

    assert.equal(asked, false);
    assert.equal(result, undefined);
  });

  it('denies a write outside the approved plan instead of falling back to approval', async () => {
    await approvePlan('plan-call-7', [
      {
        id: 's1',
        title: 'write file',
        toolName: 'sftp_write_file',
        sessionId: 'session-a',
        args: { sessionId: 'session-a', path: '/tmp/x', content: 'hi' },
      },
    ]);
    let asked = false;
    const approval = buildCattyToolApproval({
      permissionMode: 'confirm',
      chatSessionId: 'chat-plan',
      requestApproval: async () => { asked = true; return true; },
    });
    const result = await approval({
      toolCall: {
        toolCallId: 'call-7',
        toolName: 'sftp_write_file',
        input: { sessionId: 'session-b', path: '/tmp/y', content: 'ho' },
      },
    } as Parameters<typeof approval>[0]);

    assert.equal(asked, false);
    assert.deepEqual(result, {
      type: 'denied',
      reason: 'This write is outside the approved plan. Submit a new plan for it.',
    });
  });
});
