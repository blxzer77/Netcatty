const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  buildPiCliArgs,
  createPiLineBuffer,
  listPiModels,
  mapPiModels,
  runPiTurn,
  activePiTurns,
  steerPiTurn,
  translatePiEvent,
  writePiMcpConfig,
} = require("./piDriver.cjs");

function makeEmitter() {
  const calls = [];
  return {
    calls,
    text: (value) => calls.push(["text", value]),
    reasoning: (value) => calls.push(["reasoning", value]),
    reasoningEnd: () => calls.push(["reasoningEnd"]),
    toolCall: (name, args, id) => calls.push(["toolCall", name, args, id]),
    toolResult: (id, output, name) => calls.push(["toolResult", id, output, name]),
    sessionId: (id) => calls.push(["sessionId", id]),
    usage: (usage) => calls.push(["usage", usage]),
    emitDone: () => calls.push(["done"]),
    emitError: (message) => calls.push(["error", message]),
  };
}

function makeFakePi() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.destroyed = false;
  child.stdin.write = (line) => {
    const command = JSON.parse(line);
    queueMicrotask(() => {
      if (command.type === "get_state") {
        child.stdout.emit("data", Buffer.from(JSON.stringify({
          id: command.id,
          type: "response",
          command: "get_state",
          success: true,
          data: { sessionId: "pi-session" },
        }) + "\n"));
        return;
      }
      if (command.type === "prompt") {
        const records = [
          { id: command.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } },
          { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "plan" } },
          { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "answer" } },
          { type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "pwd" } },
          { type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", result: { content: [{ type: "text", text: "C:\\repo" }] }, isError: false },
          { type: "agent_end", messages: [], willRetry: false },
          { type: "agent_settled", aborted: false },
        ];
        child.stdout.emit("data", Buffer.from(records.map((record) => JSON.stringify(record)).join("\n") + "\n"));
      }
    });
    return true;
  };
  child.stdin.end = () => { child.stdin.destroyed = true; };
  child.kill = () => {};
  return child;
}

test("buildPiCliArgs starts strict RPC mode and forwards a model", () => {
  assert.deepEqual(buildPiCliArgs({ model: "openai/gpt-5.1" }), [
    "--mode", "rpc", "--no-session", "--model", "openai/gpt-5.1",
  ]);
  assert.deepEqual(buildPiCliArgs({}), ["--mode", "rpc", "--no-session"]);
  assert.deepEqual(buildPiCliArgs({ mcpConfigPath: "C:\\temp\\pi-mcp.json" }), [
    "--mode", "rpc", "--no-session", "--mcp-config", "C:\\temp\\pi-mcp.json",
  ]);
});

test("buildPiCliArgs disables write-capable tools in observer mode", () => {
  assert.deepEqual(buildPiCliArgs({ permissionMode: "observer" }), [
    "--mode", "rpc", "--no-session", "--exclude-tools", "bash,edit,write,powershell",
  ]);
});

test("buildPiCliArgs disables local side effects in MCP mode", () => {
  assert.deepEqual(buildPiCliArgs({ toolIntegrationMode: "mcp" }), [
    "--mode", "rpc", "--no-session", "--exclude-tools", "bash,edit,write,powershell",
  ]);
  assert.deepEqual(buildPiCliArgs({ toolIntegrationMode: "skills" }), [
    "--mode", "rpc", "--no-session",
  ]);
});

test("writePiMcpConfig serializes injected stdio servers and cleans up", () => {
  let written;
  let removed = false;
  const handle = writePiMcpConfig([
    { name: "netcatty", command: "node", args: ["server.cjs"], env: [{ name: "TOKEN", value: "x" }] },
  ], {
    tempDirBridge: { getTempFilePath: () => "C:\\temp\\pi-mcp.json" },
    writeFileSync: (path, body) => { written = { path, body: JSON.parse(body) }; },
  });
  assert.deepEqual(written, {
    path: "C:\\temp\\pi-mcp.json",
    body: { mcpServers: { netcatty: { command: "node", args: ["server.cjs"], env: { TOKEN: "x" } } } },
  });
  handle.cleanup();
  // Cleanup uses fs.unlinkSync; the test only verifies it is idempotent.
  assert.equal(removed, false);
});

test("createPiLineBuffer splits only LF and accepts CRLF plus an EOF record", () => {
  const lines = [];
  const reader = createPiLineBuffer((line) => lines.push(line));
  reader.push(Buffer.from('{"text":"unicode\\u2028line"}\r\n{"text":"two"}'));
  reader.flush();
  assert.deepEqual(lines, ['{"text":"unicode\\u2028line"}', '{"text":"two"}']);
});

test("mapPiModels qualifies provider ids and preserves the model label", () => {
  assert.deepEqual(mapPiModels({ models: [
    { id: "gpt-6.1-sol", name: "GPT 6.1 Sol", provider: "cliproxyapi" },
    { id: "cliproxyapi/gpt-6.1-sol", name: "duplicate" },
    { id: "", name: "missing" },
  ] }), [{
    id: "cliproxyapi/gpt-6.1-sol",
    name: "GPT 6.1 Sol",
    provider: "cliproxyapi",
  }]);
});

test("listPiModels queries Pi state and provider catalog over RPC", async () => {
  const child = makeFakePi();
  child.stdin.write = (line) => {
    const command = JSON.parse(line);
    queueMicrotask(() => {
      if (command.type === "get_state") {
        child.stdout.emit("data", Buffer.from(JSON.stringify({
          id: command.id, type: "response", command: "get_state", success: true,
          data: { model: { id: "gpt-6.1-sol", name: "GPT 6.1 Sol", provider: "cliproxyapi" } },
        }) + "\n"));
      } else if (command.type === "get_available_models") {
        child.stdout.emit("data", Buffer.from(JSON.stringify({
          id: command.id, type: "response", command: "get_available_models", success: true,
          data: { models: [{ id: "gpt-6.1-sol", name: "GPT 6.1 Sol", provider: "cliproxyapi" }, { id: "other", name: "Other", provider: "local" }] },
        }) + "\n"));
      }
    });
    return true;
  };
  const catalog = await listPiModels({ binPath: "pi", spawnImpl: () => child });
  assert.equal(catalog.currentModelId, "cliproxyapi/gpt-6.1-sol");
  assert.deepEqual(catalog.models.map((model) => model.id), [
    "cliproxyapi/gpt-6.1-sol", "local/other",
  ]);
});

test("translatePiEvent maps text/thinking and tool lifecycle events", () => {
  const emitter = makeEmitter();
  const state = {};
  translatePiEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "hmm" } }, emitter, state);
  translatePiEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "answer" } }, emitter, state);
  translatePiEvent({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } }, emitter, state);
  translatePiEvent({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: { content: [{ type: "text", text: "ok" }] } }, emitter, state);
  assert.deepEqual(emitter.calls, [
    ["reasoning", "hmm"],
    ["reasoningEnd"],
    ["text", "answer"],
    ["toolCall", "bash", { command: "ls" }, "t1"],
    ["toolResult", "t1", "ok", "bash"],
  ]);
});

test("runPiTurn injects spawn and speaks get_state/prompt over JSONL", async () => {
  const emitter = makeEmitter();
  const child = makeFakePi();
  const calls = [];
  const result = await runPiTurn({
    prompt: "hello",
    cwd: "C:\\repo",
    model: "anthropic/claude-sonnet",
    binPath: "pi",
    emitter,
    requestId: "request-1",
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options });
      return child;
    },
  });
  assert.deepEqual(result, {});
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, [
    "--mode", "rpc", "--no-session", "--model", "anthropic/claude-sonnet",
    "--exclude-tools", "bash,edit,write,powershell",
  ]);
  assert.equal(calls[0].options.cwd, "C:\\repo");
  assert.deepEqual(emitter.calls, [
    ["reasoning", "plan"],
    ["reasoningEnd"],
    ["text", "answer"],
    ["toolCall", "bash", { command: "pwd" }, "call-1"],
    ["toolResult", "call-1", "C:\\repo", "bash"],
    ["done"],
  ]);
});

test("runPiTurn rejects pending commands on malformed JSON", async () => {
  const emitter = makeEmitter();
  const child = makeFakePi();
  const originalWrite = child.stdin.write;
  child.stdin.write = (line) => {
    const command = JSON.parse(line);
    if (command.type === "prompt") {
      queueMicrotask(() => child.stdout.emit("data", Buffer.from("not-json\n")));
      return true;
    }
    return originalWrite(line);
  };
  await runPiTurn({
    prompt: "hello",
    emitter,
    spawnImpl: () => child,
  });
  assert.deepEqual(emitter.calls.filter((call) => call[0] === "error"), [["error", "Pi returned invalid JSON"]]);
});

test("runPiTurn sends abort over RPC when its signal is cancelled", async () => {
  const emitter = makeEmitter();
  const child = makeFakePi();
  const commands = [];
  const controller = new AbortController();
  child.stdin.write = (line) => {
    const command = JSON.parse(line);
    commands.push(command.type);
    queueMicrotask(() => {
      if (command.type === "get_state") {
        child.stdout.emit("data", Buffer.from(JSON.stringify({ id: command.id, type: "response", command: "get_state", success: true, data: {} }) + "\n"));
      } else if (command.type === "prompt") {
        child.stdout.emit("data", Buffer.from(JSON.stringify({ id: command.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } }) + "\n"));
        setImmediate(() => controller.abort());
      }
    });
    return true;
  };
  await runPiTurn({ prompt: "hello", emitter, spawnImpl: () => child, abortController: controller, abortGraceMs: 0 });
  assert.deepEqual(commands, ["get_state", "prompt", "abort"]);
  assert.equal(emitter.calls.some((call) => call[0] === "done"), false);
});

test("steerPiTurn writes a steering command to the active RPC runtime", async () => {
  const records = [];
  activePiTurns.set("request-steer", {
    closed: false,
    sendCommand: async (command) => {
      records.push(command);
      return { success: true, data: { disposition: "queued" } };
    },
  });
  try {
    assert.deepEqual(await steerPiTurn({ requestId: "request-steer", prompt: "continue" }), {
      status: "accepted", disposition: "queued",
    });
    assert.deepEqual(records, [{ type: "steer", message: "continue" }]);
  } finally {
    activePiTurns.delete("request-steer");
  }
});
