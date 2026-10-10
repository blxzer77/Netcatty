"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { CAPABILITY_STATUS } = require("../constants.cjs");
const { ALL_CAPABILITIES } = require("../catalog/index.cjs");
const { TOOL_INPUT_FIELDS } = require("../schemas/toolInputs.cjs");
const {
  listMcpTools,
  listCattyToolSpecs,
  listAgentToolSpecs,
  CATTY_CAPABILITY_DENYLIST,
  isCattyEligible,
} = require("./toolSurfaces.cjs");
const { registerMcpTools, buildZodShapeObject, isEmptyMcpInputShape } = require("./mcpToolRegistry.cjs");

function mcpToolHandler(schemaOrHandler, maybeHandler) {
  return typeof schemaOrHandler === "function" ? schemaOrHandler : maybeHandler;
}

test("listCattyToolSpecs includes terminal long-running tools", () => {
  const specs = listCattyToolSpecs();
  const names = specs.map((spec) => spec.toolName);
  assert.ok(names.includes("terminal_execute"));
  assert.ok(names.includes("terminal_start"));
  assert.ok(names.includes("terminal_poll"));
  assert.ok(names.includes("terminal_stop"));
});

test("listCattyToolSpecs includes SFTP write tools but not attachments", () => {
  const capabilityIds = listCattyToolSpecs().map((spec) => spec.capabilityId);
  // Attachments are chat input for a general assistant; the server-ops agent
  // does not import host lists into the vault.
  assert.ok(!capabilityIds.includes("attachment.list"));
  assert.ok(!capabilityIds.includes("attachment.read"));
  assert.ok(capabilityIds.includes("sftp.write"));
  assert.ok(capabilityIds.includes("sftp.mkdir"));
  assert.ok(capabilityIds.includes("sftp.delete"));
  assert.ok(capabilityIds.includes("sftp.rename"));
  assert.ok(capabilityIds.includes("sftp.chmod"));
  assert.ok(!capabilityIds.includes("meta.status"));
  assert.ok(!capabilityIds.includes("session.cancel"));
});

test("listCattyToolSpecs keeps SFTP transport and only the machine-record host notes", () => {
  const capabilityIds = listCattyToolSpecs().map((spec) => spec.capabilityId);
  assert.ok(capabilityIds.includes("sftp.download"));
  assert.ok(capabilityIds.includes("sftp.upload"));
  // Host notes are the machine record: the agent reads them before working on a
  // host and updates them afterwards. Everything else in the vault is
  // inventory the Netcatty UI and CLI manage.
  assert.ok(capabilityIds.includes("vault.host.notes.get"));
  assert.ok(capabilityIds.includes("vault.host.notes.set"));
  for (const inventoryId of [
    "vault.host.get",
    "vault.host.list",
    "vault.hosts.create",
    "vault.host.update",
    "vault.host.delete",
    "vault.host.import",
    "vault.note.create",
    "vault.note.list",
    "vault.group.list",
    "vault.snippets.list",
    "vault.scripts.list",
  ]) {
    assert.ok(!capabilityIds.includes(inventoryId), `${inventoryId} must leave the sidebar agent`);
  }
});

test("host_open stays on MCP and global agent, not sidebar Catty", () => {
  const { AGENT_KINDS, listAgentToolSpecs } = require("./toolSurfaces.cjs");
  const sidebarIds = listAgentToolSpecs(AGENT_KINDS.SIDEBAR).map((spec) => spec.capabilityId);
  const globalIds = listAgentToolSpecs(AGENT_KINDS.GLOBAL).map((spec) => spec.capabilityId);
  const mcpHostOpen = listMcpTools().find((tool) => tool.mcpTool === "host_open");

  assert.ok(!sidebarIds.includes("vault.host.open"));
  assert.ok(globalIds.includes("vault.host.open"));
  assert.ok(mcpHostOpen);
  assert.equal(mcpHostOpen.capabilityId, "vault.host.open");
});

test("listMcpTools includes vault host update and delete for external MCP clients", () => {
  const tools = listMcpTools();
  const create = tools.find((tool) => tool.mcpTool === "vault_hosts_create");
  const update = tools.find((tool) => tool.mcpTool === "vault_hosts_update");
  const remove = tools.find((tool) => tool.mcpTool === "vault_hosts_delete");
  assert.match(create?.inputShape.hosts?.description ?? "", /passphrase/i);
  assert.equal(update?.capabilityId, "vault.host.update");
  assert.equal(update?.publicRpcMethod, "public/vault/hosts/update");
  assert.ok(update?.inputShape.keyPath);
  assert.ok(update?.inputShape.keypath);
  assert.ok(update?.inputShape.savePassword);
  assert.ok(update?.inputShape.passphrase);
  assert.equal(remove?.capabilityId, "vault.host.delete");
  assert.equal(remove?.publicRpcMethod, "public/vault/hosts/delete");
});

test("listMcpTools includes host_open for external MCP clients", () => {
  const tools = listMcpTools();
  const hostOpen = tools.find((tool) => tool.mcpTool === "host_open");
  assert.ok(hostOpen);
  assert.equal(hostOpen.capabilityId, "vault.host.open");
  assert.equal(hostOpen.publicRpcMethod, "public/vault/hosts/open");
});

test("core MCP descriptions strongly route live terminal work through Netcatty", () => {
  const tools = listMcpTools();
  const environment = tools.find((tool) => tool.mcpTool === "get_environment");
  const execute = tools.find((tool) => tool.mcpTool === "terminal_execute");
  const start = tools.find((tool) => tool.mcpTool === "terminal_start");
  const vaultHosts = tools.find((tool) => tool.mcpTool === "vault_hosts_list");

  assert.match(environment?.description || "", /Call this first/i);
  assert.match(environment?.description || "", /label or hostname/i);
  assert.match(execute?.description || "", /instead of the local shell/i);
  assert.match(execute?.description || "", /get_environment first/i);
  assert.match(start?.description || "", /instead of the local shell/i);
  assert.match(vaultHosts?.description || "", /host_open/i);
});

test("session_close stays on MCP and the global agent, not the ops agent", () => {
  const mcpTool = listMcpTools().find((tool) => tool.mcpTool === "session_close");
  assert.ok(mcpTool);
  assert.equal(mcpTool.capabilityId, "session.close");
  assert.equal(mcpTool.publicRpcMethod, "public/session/close");

  // Closing a session the user opened is a Netcatty UI action now.
  assert.ok(!listCattyToolSpecs().some((tool) => tool.toolName === "session_close"));
  const globalClose = listAgentToolSpecs("global").find((spec) => spec.toolName === "session_close");
  assert.ok(globalClose);
  assert.equal(globalClose.rpcMethod, "session/close");
});

test("host_open tells agents to close sessions after use", () => {
  const hostOpen = listMcpTools().find((tool) => tool.mcpTool === "host_open");
  assert.match(hostOpen?.description || "", /session_close/i);
});

test("vault host import tool description routes unknown attached host text to host creation", () => {
  // Host import is inventory management: the sidebar agent no longer carries it,
  // so the routing guidance is asserted against the MCP-facing description.
  const importSpec = listMcpTools().find((tool) => tool.capabilityId === "vault.host.import");
  assert.ok(importSpec);
  assert.match(importSpec.description, /known export formats/i);
  assert.match(importSpec.description, /FinalShell/);
  assert.match(importSpec.description, /unknown/i);
  assert.match(importSpec.description, /read_attachment/i);
  assert.match(importSpec.description, /vault_hosts_create/i);
});

test("listAgentToolSpecs binds vault note tools to global RPC methods", () => {
  const specs = listAgentToolSpecs("global");
  const noteCreate = specs.find((spec) => spec.capabilityId === "vault.note.create");
  assert.equal(noteCreate?.rpcMethod, "vault/notes/create");
  const noteList = specs.find((spec) => spec.capabilityId === "vault.note.list");
  assert.equal(noteList?.rpcMethod, "vault/notes/list");
});

test("listCattyToolSpecs binds vault and portforward tools to global RPC methods", () => {
  const specs = listCattyToolSpecs();
  const hostNotesSet = specs.find((spec) => spec.capabilityId === "vault.host.notes.set");
  assert.equal(hostNotesSet?.rpcMethod, "vault/host/notes/set");
  const portforwardStart = specs.find((spec) => spec.capabilityId === "portforward.start");
  assert.equal(portforwardStart?.rpcMethod, "portforward/start");
});

test("generic snippet agent tools expose dynamic group targets", () => {
  for (const kind of ["global"]) {
    const specs = listAgentToolSpecs(kind);
    for (const capabilityId of ["vault.snippets.create", "vault.snippets.update"]) {
      const spec = specs.find((entry) => entry.capabilityId === capabilityId);
      assert.ok(spec, `${capabilityId} should be exposed to ${kind}`);
      assert.match(spec.inputShape.targetGroups?.description ?? "", /group paths/i);
    }
  }
});

test("listAgentToolSpecs splits sidebar harness tools from shared RPC tools", () => {
  const { AGENT_KINDS, listAgentToolSpecs } = require("./toolSurfaces.cjs");
  const sidebarIds = listAgentToolSpecs(AGENT_KINDS.SIDEBAR).map((spec) => spec.capabilityId);
  const globalIds = listAgentToolSpecs(AGENT_KINDS.GLOBAL).map((spec) => spec.capabilityId);

  assert.ok(sidebarIds.includes("harness.workspace.get_info"));
  assert.ok(!globalIds.includes("harness.workspace.get_info"));

  assert.ok(sidebarIds.includes("terminal.execute"));
  assert.ok(globalIds.includes("terminal.execute"));
  assert.ok(globalIds.includes("vault.note.create"));

  assert.ok(globalIds.every((id) => sidebarIds.includes(id) || id.startsWith("harness.") === false));
});

test("listCattyToolSpecs includes renderer harness tools and the shared terminal read entry", () => {
  const specs = listCattyToolSpecs();
  assert.ok(specs.length >= 20);
  const harness = specs.filter((spec) => spec.capabilityId.startsWith("harness."));
  assert.equal(harness.length, 7);
  for (const spec of harness) {
    const screenRead = spec.capabilityId === "harness.terminal.read_context";
    assert.equal(spec.localExecution, !screenRead);
    assert.equal(spec.rpcMethod, screenRead ? "netcatty/readContext" : null);
  }
  const harnessIds = harness.map((spec) => spec.capabilityId);
  assert.ok(harnessIds.includes("harness.tool_output.read"));
  assert.ok(harnessIds.includes("harness.workspace.get_info"));
  assert.ok(harnessIds.includes("harness.terminal.read_context"));
  // The plan gate is a sidebar-only entry: no MCP or CLI surface, because
  // there is no chat session elsewhere to approve against.
  assert.ok(harnessIds.includes("harness.plan.submit"));
  const mcpIds = listMcpTools().map((tool) => tool.capabilityId);
  assert.ok(!mcpIds.includes("harness.plan.submit"));
  const planEntry = ALL_CAPABILITIES.find((cap) => cap.id === "harness.plan.submit");
  assert.ok(planEntry, "harness.plan.submit must exist in the catalog");
  assert.deepEqual(Object.keys(planEntry.surfaces), ["catty"]);
  assert.ok(!CATTY_CAPABILITY_DENYLIST.has("harness.plan.submit"));
});

test("the sidebar agent advertises exactly the server-ops toolset", () => {
  const sidebarNames = listCattyToolSpecs().map((spec) => spec.toolName).sort();
  assert.deepEqual(sidebarNames, [
    "get_environment",
    "host_notes_get",
    "host_notes_set",
    "portforward_start",
    "portforward_stop",
    "portforward_tunnels_list",
    "sftp_chmod",
    "sftp_delete",
    "sftp_download",
    "sftp_home",
    "sftp_list",
    "sftp_mkdir",
    "sftp_read_file",
    "sftp_rename",
    "sftp_stat",
    "sftp_upload",
    "sftp_write_file",
    "submit_plan",
    "terminal_execute",
    "terminal_poll",
    "terminal_read_context",
    "terminal_start",
    "terminal_stop",
    "tool_output_read",
    "url_fetch",
    "web_search",
    "workspace_get_info",
    "workspace_get_session_info",
  ]);
  // Netcatty inventory and knowledge management stays out of the ops agent.
  for (const name of sidebarNames) {
    assert.ok(!name.startsWith("vault_") || name.startsWith("vault_host_notes"), name);
    assert.ok(!name.startsWith("snippets_"), name);
    assert.ok(!name.startsWith("scripts_"), name);
    assert.ok(!name.startsWith("portforward_rules_"), name);
    assert.ok(!name.startsWith("list_attachments"), name);
  }
});

test("leaving the sidebar toolset does not shrink the global agent surface", () => {
  // Regression: resolving agent kinds by sidebar eligibility dropped every
  // non-server-ops capability from the global agent too (68 -> 22 tools).
  const globalNames = listAgentToolSpecs("global").map((spec) => spec.toolName).sort();
  assert.ok(globalNames.length >= 60, `expected the global agent to keep its surface, got ${globalNames.length}`);
  for (const name of [
    "host_get",
    "host_open",
    "vault_hosts_list",
    "vault_hosts_import",
    "vault_notes_list",
    "snippets_list",
    "scripts_list",
    "portforward_rules_list",
    "list_attachments",
    "session_close",
  ]) {
    assert.ok(globalNames.includes(name), `${name} must stay reachable for the global agent`);
  }
  // The sidebar-only plan gate never reaches the global agent.
  assert.ok(!globalNames.includes("submit_plan"));
});

test("only terminal reading is exposed from harness on MCP", () => {
  const mcpCapabilityIds = listMcpTools().map((tool) => tool.capabilityId);
  assert.ok(mcpCapabilityIds.includes("harness.terminal.read_context"));
  for (const capabilityId of mcpCapabilityIds) {
    assert.ok(!capabilityId.startsWith("harness.") || capabilityId === "harness.terminal.read_context");
  }
});

test("listMcpTools descriptions stay aligned with catalog capability ids", () => {
  const mcpTools = listMcpTools();
  assert.ok(mcpTools.length >= 35);
  for (const tool of mcpTools) {
    assert.ok(tool.capabilityId);
    assert.ok(tool.mcpTool);
    assert.ok(tool.description.length > 0);
    assert.ok(tool.rpcMethod);
  }
});

test("catty and mcp terminal tools share capability ids", () => {
  const catty = listCattyToolSpecs().find((spec) => spec.toolName === "terminal_execute");
  const mcp = listMcpTools().find((tool) => tool.mcpTool === "terminal_execute");
  assert.equal(catty?.capabilityId, "terminal.execute");
  assert.equal(mcp?.capabilityId, "terminal.execute");
});

test("implemented catalog tools with inputs are catty-eligible only in the server-ops toolset", () => {
  const implemented = ALL_CAPABILITIES.filter((cap) => cap.status === CAPABILITY_STATUS.IMPLEMENTED);
  for (const capability of implemented) {
    const hasInputs = Object.prototype.hasOwnProperty.call(TOOL_INPUT_FIELDS, capability.id);
    if (!hasInputs) continue;
    const inServerOps = Array.isArray(capability.agentToolsets)
      && capability.agentToolsets.includes("server-ops");
    if (CATTY_CAPABILITY_DENYLIST.has(capability.id) || !inServerOps) {
      assert.equal(isCattyEligible(capability), false);
      continue;
    }
    if (Array.isArray(capability.agentKinds) && capability.agentKinds.length > 0
      && !capability.agentKinds.includes("sidebar")) {
      assert.equal(isCattyEligible(capability), false);
      continue;
    }
    const hasRpc = Boolean(
      capability.surfaces?.builtin?.rpcMethod
      || capability.surfaces?.public?.mcpTool,
    );
    const isLocalHarness = Boolean(capability.surfaces?.catty?.toolName) && !hasRpc;
    if (hasRpc || isLocalHarness) {
      assert.equal(isCattyEligible(capability), true);
    }
  }
});

test("mcp registry builds zod shapes for every MCP tool", () => {
  for (const tool of listMcpTools()) {
    const shape = buildZodShapeObject(tool.inputShape);
    assert.equal(typeof shape, "object");
  }
});

test("registerMcpTools registers one handler per catalog MCP tool", () => {
  const registered = [];
  const fakeServer = {
    tool(name, _description, schemaOrHandler, maybeHandler) {
      registered.push({ name, handler: typeof mcpToolHandler(schemaOrHandler, maybeHandler) });
    },
  };
  const count = registerMcpTools(fakeServer, {
    rpcCall: async () => ({ ok: true }),
    scopeParams: {},
    guardWriteOperation: () => null,
    catalogDescription: (_name, fallback) => fallback,
  });
  assert.equal(count, listMcpTools().length);
  assert.equal(registered.length, listMcpTools().length);
});

test("no-arg MCP tools register without a params schema so omitted arguments are valid (#3049)", () => {
  const registrations = [];
  const fakeServer = {
    tool(name, _description, schemaOrHandler, maybeHandler) {
      registrations.push({
        name,
        hasSchema: typeof schemaOrHandler !== "function",
        handler: mcpToolHandler(schemaOrHandler, maybeHandler),
      });
    },
  };
  registerMcpTools(fakeServer, {
    rpcCall: async () => ({ ok: true }),
    scopeParams: {},
    guardWriteOperation: () => null,
    catalogDescription: (_name, fallback) => fallback,
  });

  const noArgNames = listMcpTools()
    .filter((tool) => isEmptyMcpInputShape(tool.inputShape))
    .map((tool) => tool.mcpTool);
  assert.ok(noArgNames.includes("get_environment"));
  assert.ok(noArgNames.includes("list_attachments"));

  for (const name of noArgNames) {
    const registration = registrations.find((entry) => entry.name === name);
    assert.equal(registration?.hasSchema, false, `${name} should omit the params schema`);
  }

  const execute = registrations.find((entry) => entry.name === "terminal_execute");
  assert.equal(execute?.hasSchema, true);
});

test("get_environment handler runs when MCP arguments are omitted (#3049)", async () => {
  let handler = null;
  const fakeServer = {
    tool(name, _description, schemaOrHandler, maybeHandler) {
      if (name === "get_environment") handler = mcpToolHandler(schemaOrHandler, maybeHandler);
    },
  };
  let rpcMethod = null;
  registerMcpTools(fakeServer, {
    rpcCall: async (method) => {
      rpcMethod = method;
      return { sessions: [] };
    },
    scopeParams: { chatSessionId: "chat-1" },
    guardWriteOperation: () => null,
    catalogDescription: (_name, fallback) => fallback,
  });

  assert.ok(handler, "get_environment handler registered");
  const result = await handler();
  assert.equal(result.isError, undefined);
  assert.equal(rpcMethod, "netcatty/getContext");
  assert.match(result.content?.[0]?.text || "", /sessions/);
});

test("session_close remains available as a cleanup action in observer mode", async () => {
  let handler = null;
  let guardCalls = 0;
  const fakeServer = {
    tool(name, _description, schemaOrHandler, maybeHandler) {
      if (name === "session_close") handler = mcpToolHandler(schemaOrHandler, maybeHandler);
    },
  };
  registerMcpTools(fakeServer, {
    rpcCall: async (_method, params) => ({ ok: true, sessionId: params.sessionId, status: "closed" }),
    scopeParams: { chatSessionId: "chat-1" },
    guardWriteOperation: () => {
      guardCalls += 1;
      return "Observer mode";
    },
    catalogDescription: (_name, fallback) => fallback,
  });

  const result = await handler({ sessionId: "session-1" });
  assert.equal(result.isError, undefined);
  assert.equal(guardCalls, 0);
});

test("terminal_execute MCP response preserves stdout/exitCode on non-zero exit (#2718)", async () => {
  let handler = null;
  const fakeServer = {
    tool(name, _description, schemaOrHandler, maybeHandler) {
      if (name === "terminal_execute") handler = mcpToolHandler(schemaOrHandler, maybeHandler);
    },
  };
  registerMcpTools(fakeServer, {
    rpcCall: async () => ({
      ok: false,
      stdout: "du: cannot access '/missing': No such file or directory",
      stderr: "",
      exitCode: 1,
    }),
    scopeParams: { chatSessionId: "chat-1" },
    guardWriteOperation: () => null,
    catalogDescription: (_name, fallback) => fallback,
  });

  assert.ok(handler, "terminal_execute handler registered");
  const result = await handler({ sessionId: "sess-1", command: "du /missing" });
  assert.equal(result.isError, undefined);
  const text = result.content?.[0]?.text || "";
  assert.match(text, /cannot access '\/missing'/);
  assert.match(text, /\[exit code: 1\]/);
  assert.doesNotMatch(text, /Operation failed/);
});

test("terminal_execute MCP response keeps operational failures as isError", async () => {
  let handler = null;
  const fakeServer = {
    tool(name, _description, schemaOrHandler, maybeHandler) {
      if (name === "terminal_execute") handler = mcpToolHandler(schemaOrHandler, maybeHandler);
    },
  };
  registerMcpTools(fakeServer, {
    rpcCall: async () => ({ ok: false, error: "Session not found" }),
    scopeParams: { chatSessionId: "chat-1" },
    guardWriteOperation: () => null,
    catalogDescription: (_name, fallback) => fallback,
  });

  const result = await handler({ sessionId: "gone", command: "uptime" });
  assert.equal(result.isError, true);
  assert.equal(result.content?.[0]?.text, "Error: Session not found");
});

test("terminal_execute MCP response includes partial output on timeout", async () => {
  let handler = null;
  const fakeServer = {
    tool(name, _description, schemaOrHandler, maybeHandler) {
      if (name === "terminal_execute") handler = mcpToolHandler(schemaOrHandler, maybeHandler);
    },
  };
  registerMcpTools(fakeServer, {
    rpcCall: async () => ({
      ok: false,
      stdout: "partial lines",
      stderr: "",
      exitCode: -1,
      error: "Command timed out (60s)",
    }),
    scopeParams: { chatSessionId: "chat-1" },
    guardWriteOperation: () => null,
    catalogDescription: (_name, fallback) => fallback,
  });

  const result = await handler({ sessionId: "sess-1", command: "sleep 999" });
  assert.equal(result.isError, true);
  const text = result.content?.[0]?.text || "";
  assert.match(text, /partial lines/);
  assert.match(text, /\[exit code: -1\]/);
  assert.match(text, /\[error\] Command timed out \(60s\)/);
});

test("terminal_execute MCP response uses neutral text for successful empty output (#2724)", async () => {
  let handler = null;
  const fakeServer = {
    tool(name, _description, schemaOrHandler, maybeHandler) {
      if (name === "terminal_execute") handler = mcpToolHandler(schemaOrHandler, maybeHandler);
    },
  };
  // Serial/network-device raw PTY success: ok true, empty streams, exitCode null.
  registerMcpTools(fakeServer, {
    rpcCall: async () => ({
      ok: true,
      stdout: "",
      stderr: "",
      exitCode: null,
    }),
    scopeParams: { chatSessionId: "chat-1" },
    guardWriteOperation: () => null,
    catalogDescription: (_name, fallback) => fallback,
  });

  const result = await handler({ sessionId: "sess-1", command: "configure terminal" });
  assert.equal(result.isError, undefined);
  assert.equal(result.content?.[0]?.text, "Command completed (no output)");
  assert.doesNotMatch(result.content?.[0]?.text || "", /Operation failed/);
});

test("terminal_execute MCP response keeps exit-only non-zero without isError", async () => {
  let handler = null;
  const fakeServer = {
    tool(name, _description, schemaOrHandler, maybeHandler) {
      if (name === "terminal_execute") handler = mcpToolHandler(schemaOrHandler, maybeHandler);
    },
  };
  registerMcpTools(fakeServer, {
    rpcCall: async () => ({
      ok: false,
      stdout: "",
      stderr: "",
      exitCode: 1,
    }),
    scopeParams: { chatSessionId: "chat-1" },
    guardWriteOperation: () => null,
    catalogDescription: (_name, fallback) => fallback,
  });

  const result = await handler({ sessionId: "sess-1", command: "false" });
  assert.equal(result.isError, undefined);
  assert.equal(result.content?.[0]?.text, "[exit code: 1]");
  assert.doesNotMatch(result.content?.[0]?.text || "", /Operation failed/);
});
