"use strict";

const { AGENT_KINDS, CAPABILITY_STATUS, CAPABILITY_SURFACES } = require("../constants.cjs");
const { ALL_CAPABILITIES } = require("../catalog/index.cjs");
const { TOOL_INPUT_FIELDS, MODEL_DESCRIPTION_HINTS } = require("../schemas/toolInputs.cjs");

function buildZodShape(fields) {
  const shape = {};
  for (const [key, field] of Object.entries(fields || {})) {
    shape[key] = {
      type: field.type,
      optional: Boolean(field.optional),
      description: field.description || "",
    };
  }
  return shape;
}

function getMcpToolName(capability) {
  return capability.surfaces?.public?.mcpTool
    || capability.surfaces?.builtin?.mcpTool
    || null;
}

function getCattyToolName(capability) {
  return capability.surfaces?.[CAPABILITY_SURFACES.CATTY]?.toolName
    || getMcpToolName(capability)
    || capability.id.replace(/\./g, "_");
}

function getCattyRpcMethod(capability) {
  return capability.surfaces?.builtin?.rpcMethod
    || capability.surfaces?.global?.rpcMethod
    || capability.surfaces?.public?.rpcMethod
    || null;
}

function getAgentToolName(capability, agentKind) {
  if (agentKind === AGENT_KINDS.GLOBAL) {
    return capability.surfaces?.[CAPABILITY_SURFACES.GLOBAL_AGENT]?.toolName
      || getMcpToolName(capability)
      || capability.id.replace(/\./g, "_");
  }
  return getCattyToolName(capability);
}

function getAgentRpcMethod(capability) {
  return getCattyRpcMethod(capability);
}

function buildToolDescription(capability) {
  const hint = MODEL_DESCRIPTION_HINTS[capability.id];
  if (!hint) return capability.description;
  return `${capability.description} ${hint}`;
}

function listToolSurfaces(options = {}) {
  const {
    surface = CAPABILITY_SURFACES.PUBLIC,
    status = CAPABILITY_STATUS.IMPLEMENTED,
    includeCatty = true,
  } = options;

  const tools = [];

  for (const capability of ALL_CAPABILITIES) {
    if (capability.status !== status) continue;
    const binding = capability.surfaces?.[surface] || capability.surfaces?.public || capability.surfaces?.builtin;
    if (!binding) continue;

    const mcpTool = getMcpToolName(capability);
    const cattyToolName = getCattyToolName(capability);
    if (!includeCatty && !mcpTool) continue;

    const builtinRpc = capability.surfaces?.builtin?.rpcMethod || binding.rpcMethod || null;

    tools.push({
      capabilityId: capability.id,
      domain: capability.domain,
      toolName: cattyToolName,
      mcpTool,
      rpcMethod: builtinRpc,
      publicRpcMethod: capability.surfaces?.public?.rpcMethod || null,
      description: buildToolDescription(capability),
      policy: capability.policy,
      inputShape: buildZodShape(TOOL_INPUT_FIELDS[capability.id]),
      cattyEnabled: includeCatty && Boolean(TOOL_INPUT_FIELDS[capability.id] != null || mcpTool),
    });
  }

  return tools;
}

function listMcpTools() {
  return listToolSurfaces({ surface: CAPABILITY_SURFACES.PUBLIC, includeCatty: false })
    .filter((tool) => tool.mcpTool);
}

/** Capabilities excluded from Catty even when implemented (CLI-only / meta). */
const CATTY_CAPABILITY_DENYLIST = new Set([
  "meta.status",
  "session.cancel",
  "session.resume",
  "session.get",
]);

/**
 * Toolset the sidebar agent (Catty, the server-management agent) is allowed to
 * use. The capability catalog marks each server-ops entry with
 * `agentToolsets: ["server-ops"]`; everything else — Vault inventory, snippets,
 * scripts, port-forward rules, attachments — stays managed in the Netcatty UI
 * and on MCP/CLI, and is no longer advertised to the sidebar agent.
 *
 * Failing closed is deliberate: a capability that forgets the annotation
 * disappears from the sidebar instead of leaking a management tool into an ops
 * turn. The golden list test in toolSurfaces.test.cjs keeps that loud.
 */
const SIDEBAR_AGENT_TOOLSETS = new Set(["server-ops"]);

function hasSidebarToolset(capability) {
  const toolsets = capability.agentToolsets;
  if (!Array.isArray(toolsets)) return false;
  return toolsets.some((name) => SIDEBAR_AGENT_TOOLSETS.has(name));
}

function isCattyOnlyCapability(capability) {
  return isAgentLocalOnlyCapability(capability, AGENT_KINDS.SIDEBAR);
}

function isAgentLocalOnlyCapability(capability, agentKind) {
  if (agentKind === AGENT_KINDS.GLOBAL) {
    return Boolean(capability.surfaces?.[CAPABILITY_SURFACES.GLOBAL_AGENT]?.toolName)
      && !getAgentRpcMethod(capability)
      && !getMcpToolName(capability);
  }
  return Boolean(capability.surfaces?.[CAPABILITY_SURFACES.CATTY]?.toolName)
    && !getAgentRpcMethod(capability)
    && !getMcpToolName(capability);
}

/**
 * Resolve which agents may use a capability when agentKinds is not set explicitly.
 * - surfaces.globalAgent only → global agent
 * - surfaces.catty only (harness) → sidebar agent
 * - shared RPC/MCP infrastructure in the server-ops toolset → both agents
 * - shared RPC/MCP infrastructure outside that toolset → global agent only
 *
 * The toolset question is deliberately asked after the shared-infrastructure
 * one: a capability the sidebar agent does not use (Vault inventory, snippets,
 * scripts, attachments) keeps its global-agent and MCP/CLI reach. Asking the
 * toolset first would drop it from the global agent too.
 */
function resolveAgentKinds(capability) {
  if (Array.isArray(capability.agentKinds) && capability.agentKinds.length > 0) {
    return capability.agentKinds;
  }
  if (capability.surfaces?.[CAPABILITY_SURFACES.GLOBAL_AGENT]) {
    return [AGENT_KINDS.GLOBAL];
  }
  if (isAgentLocalOnlyCapability(capability, AGENT_KINDS.SIDEBAR)) {
    return [AGENT_KINDS.SIDEBAR];
  }
  // Checked against the global agent on purpose: this is the shared
  // infrastructure predicate (implemented, input fields, RPC or MCP surface)
  // and must not consult the sidebar toolset.
  if (isAgentEligibleForKind(capability, AGENT_KINDS.GLOBAL, { skipAgentKindCheck: true })) {
    return hasSidebarToolset(capability)
      ? [AGENT_KINDS.SIDEBAR, AGENT_KINDS.GLOBAL]
      : [AGENT_KINDS.GLOBAL];
  }
  return [];
}

function isAgentEligibleForKind(capability, agentKind, options = {}) {
  if (capability.status !== CAPABILITY_STATUS.IMPLEMENTED) return false;
  if (CATTY_CAPABILITY_DENYLIST.has(capability.id)) return false;
  if (!options.skipAgentKindCheck && !resolveAgentKinds(capability).includes(agentKind)) {
    return false;
  }
  const hasInputFields = Object.prototype.hasOwnProperty.call(TOOL_INPUT_FIELDS, capability.id);
  if (!hasInputFields) return false;
  if (agentKind === AGENT_KINDS.SIDEBAR && !hasSidebarToolset(capability)) return false;
  if (isAgentLocalOnlyCapability(capability, agentKind)) return true;
  const hasBuiltinRpc = Boolean(capability.surfaces?.builtin?.rpcMethod);
  const hasGlobalRpc = Boolean(capability.surfaces?.global?.rpcMethod);
  return hasBuiltinRpc || hasGlobalRpc || Boolean(getMcpToolName(capability));
}

function isCattyEligible(capability) {
  return isAgentEligibleForKind(capability, AGENT_KINDS.SIDEBAR);
}

function listAgentToolSpecs(agentKind = AGENT_KINDS.SIDEBAR) {
  return ALL_CAPABILITIES
    .filter((capability) => isAgentEligibleForKind(capability, agentKind))
    .map((capability) => {
      const spec = {
        capabilityId: capability.id,
        toolName: getAgentToolName(capability, agentKind),
        rpcMethod: getAgentRpcMethod(capability),
        localExecution: isAgentLocalOnlyCapability(capability, agentKind),
        description: buildToolDescription(capability),
        inputShape: buildZodShape(TOOL_INPUT_FIELDS[capability.id]),
        policy: capability.policy,
      };
      if (agentKind !== AGENT_KINDS.SIDEBAR) {
        spec.agentKind = agentKind;
      }
      return spec;
    });
}

function listCattyToolSpecs() {
  return listAgentToolSpecs(AGENT_KINDS.SIDEBAR);
}

module.exports = {
  AGENT_KINDS,
  buildZodShape,
  buildToolDescription,
  CATTY_CAPABILITY_DENYLIST,
  hasSidebarToolset,
  getAgentRpcMethod,
  getAgentToolName,
  getCattyToolName,
  getCattyRpcMethod,
  isAgentEligibleForKind,
  isAgentLocalOnlyCapability,
  isCattyEligible,
  isCattyOnlyCapability,
  listAgentToolSpecs,
  listToolSurfaces,
  listMcpTools,
  listCattyToolSpecs,
  resolveAgentKinds,
};
