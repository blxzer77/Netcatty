"use strict";

const { CAPABILITY_STATUS } = require("../constants.cjs");

/** Renderer-local harness tools; terminal reading also exposes a scoped MCP entry. */
/** @type {import("../types.cjs").CapabilityDefinition[]} */
const HARNESS_CAPABILITIES = [
  {
    id: "harness.tool_output.read",
    domain: "harness",
    agentToolsets: ["server-ops"],
    status: CAPABILITY_STATUS.IMPLEMENTED,
    description: "Read stored tool output by handle id when a prior tool result was truncated.",
    policy: {
      write: false,
      sensitiveRead: false,
      longRunning: false,
      requiresChatSession: true,
      bypassesObserverBlock: false,
      bypassesApproval: true,
      bypassesChatCancel: true,
    },
    surfaces: {
      catty: { toolName: "tool_output_read" },
    },
  },
  {
    id: "harness.workspace.get_info",
    domain: "harness",
    agentToolsets: ["server-ops"],
    status: CAPABILITY_STATUS.IMPLEMENTED,
    description: "Get information about the current workspace, including all terminal sessions and their connection status.",
    policy: {
      write: false,
      sensitiveRead: false,
      longRunning: false,
      requiresChatSession: true,
      bypassesObserverBlock: false,
      bypassesApproval: true,
      bypassesChatCancel: true,
    },
    surfaces: {
      catty: { toolName: "workspace_get_info" },
    },
  },
  {
    id: "harness.workspace.get_session_info",
    domain: "harness",
    agentToolsets: ["server-ops"],
    status: CAPABILITY_STATUS.IMPLEMENTED,
    description: "Get detailed information about a specific terminal or SFTP session.",
    policy: {
      write: false,
      sensitiveRead: false,
      longRunning: false,
      requiresChatSession: true,
      bypassesObserverBlock: false,
      bypassesApproval: true,
      bypassesChatCancel: true,
    },
    surfaces: {
      catty: { toolName: "workspace_get_session_info" },
    },
  },
  {
    id: "harness.terminal.read_context",
    agentKinds: ["sidebar"],
    domain: "harness",
    agentToolsets: ["server-ops"],
    status: CAPABILITY_STATUS.IMPLEMENTED,
    description: "Read a bounded slice of the current terminal screen or scrollback from the active AI scope.",
    policy: {
      write: false,
      sensitiveRead: false,
      longRunning: false,
      requiresChatSession: true,
      bypassesObserverBlock: false,
      bypassesApproval: true,
      bypassesChatCancel: true,
    },
    surfaces: {
      catty: { toolName: "terminal_read_context" },
      builtin: { rpcMethod: "netcatty/readContext", mcpTool: "terminal_read_context" },
    },
  },
  {
    id: "harness.plan.submit",
    agentKinds: ["sidebar"],
    domain: "harness",
    agentToolsets: ["server-ops"],
    status: CAPABILITY_STATUS.IMPLEMENTED,
    description: "Propose a plan of server operations for the user to approve before anything executes.",
    policy: {
      write: false,
      sensitiveRead: false,
      longRunning: false,
      requiresChatSession: true,
      bypassesObserverBlock: false,
      bypassesApproval: true,
      bypassesChatCancel: false,
    },
    surfaces: {
      catty: { toolName: "submit_plan" },
    },
  },
  {
    id: "harness.terminal.batch",
    agentKinds: ["sidebar"],
    domain: "harness",
    agentToolsets: ["server-ops"],
    status: CAPABILITY_STATUS.IMPLEMENTED,
    description: "Run one command on several sessions in this scope and report each host's result separately.",
    policy: {
      write: true,
      sensitiveRead: false,
      longRunning: true,
      requiresChatSession: true,
      bypassesObserverBlock: false,
      bypassesApproval: false,
      bypassesChatCancel: false,
    },
    surfaces: {
      catty: { toolName: "terminal_batch" },
    },
  },
  {
    id: "harness.machines.compare",
    agentKinds: ["sidebar"],
    domain: "harness",
    agentToolsets: ["server-ops"],
    status: CAPABILITY_STATUS.IMPLEMENTED,
    description: "Run the same read-only command on several sessions and return which hosts agree and how they differ.",
    policy: {
      write: false,
      sensitiveRead: false,
      longRunning: true,
      requiresChatSession: true,
      bypassesObserverBlock: false,
      bypassesApproval: true,
      bypassesChatCancel: false,
    },
    surfaces: {
      catty: { toolName: "compare_machines" },
    },
  },
  {
    id: "harness.web.search",
    domain: "harness",
    agentToolsets: ["server-ops"],
    status: CAPABILITY_STATUS.IMPLEMENTED,
    description: "Search the web for current information when configured in AI settings.",
    policy: {
      write: false,
      sensitiveRead: false,
      longRunning: false,
      requiresChatSession: true,
      bypassesObserverBlock: false,
      bypassesApproval: true,
      bypassesChatCancel: true,
    },
    surfaces: {
      catty: { toolName: "web_search" },
    },
  },
  {
    id: "harness.url.fetch",
    domain: "harness",
    agentToolsets: ["server-ops"],
    status: CAPABILITY_STATUS.IMPLEMENTED,
    description: "Fetch and read the content of an HTTPS URL.",
    policy: {
      write: false,
      sensitiveRead: false,
      longRunning: false,
      requiresChatSession: true,
      bypassesObserverBlock: false,
      bypassesApproval: true,
      bypassesChatCancel: true,
    },
    surfaces: {
      catty: { toolName: "url_fetch" },
    },
  },
];

module.exports = { HARNESS_CAPABILITIES };
