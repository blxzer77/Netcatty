"use strict";

const { CAPABILITY_STATUS } = require("../constants.cjs");

/** @type {import("../types.cjs").CapabilityDefinition[]} */
const META_CAPABILITIES = [
  {
    id: "session.environment",
    domain: "session",
    // Server-ops toolset: the sidebar agent manages live servers, so the catalog
    // marks which capabilities belong to that toolset. MCP, CLI, and the global
    // agent are unaffected.
    agentToolsets: ["server-ops"],
    status: CAPABILITY_STATUS.IMPLEMENTED,
    description: "List scoped terminal sessions available to the agent.",
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
      builtin: { rpcMethod: "netcatty/getContext", mcpTool: "get_environment" },
      public: { rpcMethod: "public/getEnvironment", mcpTool: "get_environment" },
      cli: { command: ["env"] },
    },
  },
  {
    id: "meta.status",
    domain: "meta",
    status: CAPABILITY_STATUS.IMPLEMENTED,
    description: "Return bridge runtime status and policy configuration.",
    policy: {
      write: false,
      sensitiveRead: false,
      longRunning: false,
      requiresChatSession: false,
      bypassesObserverBlock: false,
      bypassesApproval: true,
      bypassesChatCancel: true,
    },
    surfaces: {
      builtin: { rpcMethod: "netcatty/getStatus" },
      public: { rpcMethod: "public/getStatus" },
      cli: { command: ["status"] },
    },
  },
  {
    id: "attachment.list",
    domain: "attachment",
    status: CAPABILITY_STATUS.IMPLEMENTED,
    description: "List user-attached files in the current AI chat scope.",
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
      builtin: { rpcMethod: "netcatty/listAttachments", mcpTool: "list_attachments" },
      cli: { command: ["attachment", "list"] },
    },
  },
  {
    id: "attachment.read",
    domain: "attachment",
    status: CAPABILITY_STATUS.IMPLEMENTED,
    description: "Read a user-attached file from the current AI chat scope.",
    policy: {
      write: false,
      sensitiveRead: true,
      longRunning: false,
      requiresChatSession: true,
      bypassesObserverBlock: false,
      bypassesApproval: true,
      bypassesChatCancel: true,
    },
    surfaces: {
      builtin: { rpcMethod: "netcatty/readAttachment", mcpTool: "read_attachment" },
      cli: { command: ["attachment", "read"] },
    },
  },
  {
    id: "session.cancel",
    domain: "session",
    status: CAPABILITY_STATUS.IMPLEMENTED,
    description: "Cancel in-flight operations for a chat session.",
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
      builtin: { rpcMethod: "netcatty/setCancelled" },
      cli: { command: ["cancel"] },
    },
  },
  {
    id: "session.resume",
    domain: "session",
    status: CAPABILITY_STATUS.IMPLEMENTED,
    description: "Resume write operations for a cancelled chat session.",
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
      builtin: { rpcMethod: "netcatty/setCancelled" },
      cli: { command: ["resume"] },
    },
  },
  {
    id: "session.get",
    domain: "session",
    status: CAPABILITY_STATUS.IMPLEMENTED,
    description: "Get metadata for a single scoped session.",
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
      builtin: { rpcMethod: "netcatty/getContext" },
      cli: { command: ["session"] },
    },
  },
  {
    id: "session.close",
    domain: "session",
    status: CAPABILITY_STATUS.IMPLEMENTED,
    description: "Close a terminal session previously opened by host_open in the current AI scope.",
    policy: {
      write: true,
      sensitiveRead: false,
      longRunning: false,
      requiresChatSession: true,
      bypassesObserverBlock: true,
      bypassesApproval: true,
      bypassesChatCancel: true,
    },
    surfaces: {
      global: { rpcMethod: "session/close" },
      public: { rpcMethod: "public/session/close", mcpTool: "session_close" },
    },
  },
];

module.exports = { META_CAPABILITIES };
