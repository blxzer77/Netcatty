import type { ToolApprovalConfiguration } from 'ai';
import type { AIPermissionMode } from '../types';
import { requestApproval as defaultRequestApproval } from '../shared/approvalGate';
import { hasApprovedPlanScope, isToolCoveredByApprovedPlan } from '../shared/planGate';
import { resolveCapabilityId } from './permissionGrants';
import cattyToolSpecs from './generated/cattyToolSpecs.json';

type CattyToolPolicySpec = {
  toolName: string;
  capabilityId: string;
  policy: {
    write: boolean;
    bypassesApproval: boolean;
    bypassesObserverBlock?: boolean;
  };
};

const policyByToolName = new Map<string, CattyToolPolicySpec>(
  (cattyToolSpecs as CattyToolPolicySpec[]).map((spec) => [spec.toolName, spec]),
);

function needsUserApproval(
  toolName: string,
  permissionMode: AIPermissionMode,
): boolean {
  if (permissionMode !== 'confirm') return false;
  const spec = policyByToolName.get(toolName);
  if (!spec) return false;
  return spec.policy.write && !spec.policy.bypassesApproval;
}

export function buildCattyToolApproval(input: {
  permissionMode: AIPermissionMode;
  chatSessionId?: string;
  requestApproval?: typeof defaultRequestApproval;
}): ToolApprovalConfiguration<Record<string, never>, import('./cattyRuntimeContext').CattyRuntimeContext> {
  const { permissionMode, chatSessionId, requestApproval = defaultRequestApproval } = input;

  return async ({ toolCall }) => {
    const spec = policyByToolName.get(toolCall.toolName);
    if (!spec?.policy.write) {
      return undefined;
    }

    const args = (toolCall.input ?? {}) as Record<string, unknown>;

    if (permissionMode === 'observer' && !spec.policy.bypassesObserverBlock) {
      return { type: 'denied' as const, reason: 'Observer mode blocks write operations.' };
    }

    if (!needsUserApproval(toolCall.toolName, permissionMode)) {
      return undefined;
    }

    // An approved plan is the unit of consent for the exact steps it names. A
    // tool call must match the same tool, target session(s), and structured
    // arguments; anything the plan did not name still goes through the gate.
    if (isToolCoveredByApprovedPlan(chatSessionId, toolCall.toolName, args)) {
      return undefined;
    }
    if (hasApprovedPlanScope(chatSessionId)) {
      return {
        type: 'denied' as const,
        reason: 'This write is outside the approved plan. Submit a new plan for it.',
      };
    }
    const approved = await requestApproval(
      toolCall.toolCallId,
      toolCall.toolName,
      args,
      chatSessionId,
      undefined,
      spec.capabilityId ?? resolveCapabilityId(toolCall.toolName),
    );

    if (approved) {
      return { type: 'approved' as const };
    }
    return { type: 'denied' as const, reason: 'User denied tool execution.' };
  };
}
