"use strict";

/**
 * Pi coding agent RPC driver.
 *
 * Pi's RPC mode is a long-lived JSONL process.  Keep the transport here rather
 * than using readline: Pi treats only LF as a record delimiter and U+2028 /
 * U+2029 are valid JSON string contents.
 */
const { spawn } = require("node:child_process");
const { StringDecoder } = require("node:string_decoder");
const fs = require("node:fs");
const { prepareCommandForSpawn } = require("../../ai/shellUtils.cjs");
const { mcpEnvPairsToObject } = require("./injectMcp.cjs");
const defaultTempDirBridge = require("../../tempDirBridge.cjs");

const DEFAULT_PI_COMMAND = "pi";
const PI_ABORT_GRACE_MS = 1_500;
const PI_MAX_LINE_BYTES = 10 * 1024 * 1024;
const PI_MODEL_LIST_TIMEOUT_MS = 15_000;
const PI_MCP_DISALLOWED_LOCAL_TOOLS = ["bash", "edit", "write", "powershell"];

// A turn owns one Pi RPC process.  Keeping this small registry also gives the
// SDK registry's steerTurn entry point a way to address the active process.
const activePiTurns = new Map();

function resolvePiSpawnSpec(cliPath, args) {
  return prepareCommandForSpawn(
    String(cliPath || DEFAULT_PI_COMMAND).trim() || DEFAULT_PI_COMMAND,
    Array.isArray(args) ? args : [],
  );
}

function spawnPiProcess(spawnImpl, cliPath, args, options = {}) {
  const spawnFn = spawnImpl || spawn;
  const spec = resolvePiSpawnSpec(cliPath, args);
  return spawnFn(spec.command, spec.args, {
    ...options,
    shell: spec.shell,
  });
}

function buildPiCliArgs({ model, mcpConfigPath, permissionMode, toolIntegrationMode } = {}) {
  const args = ["--mode", "rpc", "--no-session"];
  const selectedModel = String(model || "").trim();
  if (selectedModel) args.push("--model", selectedModel);
  if (mcpConfigPath) args.push("--mcp-config", String(mcpConfigPath));
  const mode = String(toolIntegrationMode || "").toLowerCase();
  if (mode === "mcp" || String(permissionMode || "").toLowerCase() === "observer") {
    // In MCP mode Netcatty owns side-effecting tools (and their approval UI).
    // Disable Pi's local equivalents so a turn cannot bypass that policy.
    args.push("--exclude-tools", PI_MCP_DISALLOWED_LOCAL_TOOLS.join(","));
  }
  return args;
}

function writePiMcpConfig(injectedMcpServers, {
  toolIntegrationMode = "mcp",
  tempDirBridge = defaultTempDirBridge,
  writeFileSync = fs.writeFileSync,
  unlinkSync = fs.unlinkSync,
} = {}) {
  if (String(toolIntegrationMode || "mcp").toLowerCase() !== "mcp") return null;
  const servers = {};
  for (const config of Array.isArray(injectedMcpServers) ? injectedMcpServers : []) {
    if (!config || !config.name || !config.command) continue;
    servers[String(config.name)] = {
      command: String(config.command),
      args: Array.isArray(config.args) ? config.args.map(String) : [],
      env: mcpEnvPairsToObject(config.env),
    };
  }
  if (Object.keys(servers).length === 0) return null;
  const getTempFilePath = tempDirBridge?.getTempFilePath;
  if (typeof getTempFilePath !== "function") throw new Error("Netcatty temp directory is unavailable");
  const configPath = getTempFilePath("pi-mcp.json");
  writeFileSync(configPath, JSON.stringify({ mcpServers: servers }), { encoding: "utf8", mode: 0o600 });
  return {
    path: configPath,
    cleanup() {
      try { unlinkSync(configPath); } catch { /* best effort */ }
    },
  };
}

/**
 * Read strict LF-delimited JSONL records.  The buffer intentionally does not
 * trim records: whitespace is valid JSON and trimming would obscure framing
 * bugs in callers/tests.  A final record without LF is accepted on EOF.
 */
function createPiLineBuffer(onLine, maxBufferBytes = PI_MAX_LINE_BYTES) {
  let buffer = "";
  let bufferedBytes = 0;
  let overflowed = false;
  const decoder = new StringDecoder("utf8");
  return {
    push(chunk) {
      if (overflowed) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ""));
      bufferedBytes += bytes.length;
      buffer += decoder.write(bytes);
      let index;
      let consumed = false;
      while ((index = buffer.indexOf("\n")) >= 0) {
        let line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        consumed = true;
        if (line.trim()) onLine(line);
      }
      if (consumed) bufferedBytes = Buffer.byteLength(buffer, "utf8") + decoder.lastNeed;
      if (bufferedBytes > maxBufferBytes) {
        overflowed = true;
        buffer = "";
        const error = new Error(`Pi RPC message exceeded ${maxBufferBytes} bytes`);
        error.code = "PI_LINE_LIMIT";
        throw error;
      }
    },
    flush() {
      if (overflowed) return;
      buffer += decoder.end();
      let line = buffer;
      buffer = "";
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.trim()) onLine(line);
    },
  };
}

function resultToText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(resultToText).filter(Boolean).join("\n");
  if (typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    if (typeof value.content === "string") return value.content;
    if (Array.isArray(value.content)) return resultToText(value.content);
    if (typeof value.output === "string") return value.output;
    if (typeof value.message === "string") return value.message;
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}

function extractPiError(value, fallback = "Pi RPC turn failed") {
  if (value == null) return fallback;
  if (typeof value === "string") return value || fallback;
  if (typeof value === "object") {
    return String(value.error || value.message || value.reason || value.data?.error || fallback);
  }
  return String(value);
}

/**
 * Map Pi's `Usage` onto AgentUsage and report it once per distinct snapshot.
 *
 * Pi follows Anthropic semantics: `input` excludes cache reads/writes and
 * `totalTokens` is their sum, while AgentUsage expects `inputTokens` to be the
 * whole prompt with `cachedInputTokens` as the cached subset (same convention as
 * the Claude/CodeBuddy drivers).  A snapshot is skipped when it carries no
 * usable numbers, because many providers leave the streaming cumulative usage
 * at zero and only fill it in on the completed message.
 */
function emitPiUsage(emitter, usage, state) {
  if (!usage || typeof usage !== "object" || typeof emitter?.usage !== "function") return false;
  const uncachedInputTokens = Number(usage.inputTokens ?? usage.input) || 0;
  const cachedInputTokens = Number(usage.cachedInputTokens ?? usage.cacheRead) || 0;
  const cacheWriteTokens = Number(usage.cacheWrite) || 0;
  const outputTokens = Number(usage.outputTokens ?? usage.output) || 0;
  const reasoningTokens = Number(usage.reasoningTokens ?? usage.reasoning) || 0;
  const inputTokens = uncachedInputTokens + cachedInputTokens + cacheWriteTokens;
  let totalTokens = Number(usage.totalTokens ?? usage.total) || 0;
  if (!totalTokens && (inputTokens || outputTokens)) totalTokens = inputTokens + outputTokens;
  if (!inputTokens && !outputTokens && !reasoningTokens && !totalTokens) return false;

  const snapshotKey = `${inputTokens}:${cachedInputTokens}:${outputTokens}:${reasoningTokens}:${totalTokens}`;
  if (state) {
    if (state.usageKey === snapshotKey) return true;
    state.usageKey = snapshotKey;
  }
  emitter.usage({
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens,
  });
  return true;
}

function closePiReasoning(state, emitter) {
  if (state.reasoningOpen) {
    emitter.reasoningEnd?.();
    state.reasoningOpen = false;
  }
}

function ensurePiToolCall(event, emitter, state) {
  const id = event?.toolCallId || event?.id || "";
  if (!id) return null;
  state.toolCalls ||= new Map();
  if (!state.toolCalls.has(id)) {
    const name = String(event.toolName || event.tool_name || "tool");
    const args = event.args && typeof event.args === "object" ? event.args : {};
    state.toolCalls.set(id, { name, args });
    emitter.toolCall?.(name, args, id);
  }
  return id;
}

/** Map one Pi RPC session event to Netcatty's canonical emitter events. */
function translatePiEvent(event, emitter, state = {}) {
  if (!event || typeof event !== "object") return { settled: false, error: false, content: false };
  const type = String(event.type || "");

  if (type === "message_update") {
    const update = event.assistantMessageEvent || event.messageEvent || event.event || {};
    if (event.usage) emitPiUsage(emitter, event.usage, state);
    switch (String(update.type || "")) {
      case "thinking_delta":
        if (update.delta) {
          emitter.reasoning?.(String(update.delta));
          state.reasoningOpen = true;
        }
        return { settled: false, error: false, content: Boolean(update.delta) };
      case "text_delta":
        closePiReasoning(state, emitter);
        if (update.delta) emitter.text?.(String(update.delta));
        return { settled: false, error: false, content: Boolean(update.delta) };
      case "error":
        closePiReasoning(state, emitter);
        state.failed = true;
        emitter.emitError?.(extractPiError(update.error || update.reason));
        return { settled: false, error: true, content: false };
      default:
        return { settled: false, error: false, content: false };
    }
  }

  if (type === "tool_execution_start" || type === "tool_execution_update" || type === "tool_execution_end") {
    closePiReasoning(state, emitter);
    const id = ensurePiToolCall(event, emitter, state);
    if (type === "tool_execution_end" && id) {
      state.toolResults ||= new Set();
      if (!state.toolResults.has(id)) {
        state.toolResults.add(id);
        const call = state.toolCalls.get(id);
        emitter.toolResult?.(id, resultToText(event.result), call?.name || event.toolName || "tool");
      }
    }
    return { settled: false, error: false, content: true };
  }

  if (type === "message_end" || type === "turn_end") {
    // Pi only attaches provider-exact usage to the completed assistant message;
    // the message_update snapshots can stay all zero for the whole stream.
    const message = event.message;
    if (message?.role === "assistant" && message.usage) {
      emitPiUsage(emitter, message.usage, state);
    }
    return { settled: false, error: false, content: false };
  }

  if (type === "agent_end") {
    closePiReasoning(state, emitter);
    state.agentEnded = true;
    if (event.usage) emitPiUsage(emitter, event.usage, state);
    return { settled: false, error: false, content: false };
  }

  if (type === "agent_settled") {
    closePiReasoning(state, emitter);
    state.settled = true;
    state.aborted = event.aborted === true;
    return { settled: true, error: false, content: false };
  }

  if (type === "error" || type === "extension_error") {
    closePiReasoning(state, emitter);
    state.failed = true;
    emitter.emitError?.(extractPiError(event.error || event.message || event.reason));
    return { settled: false, error: true, content: false };
  }

  // Pi emits a response for every command.  Command failures are handled by
  // the pending command promise, but malformed/unsolicited responses should
  // still be visible as a turn error when they carry an error payload.
  if (type === "response" && event.success === false && !event.id) {
    state.failed = true;
    emitter.emitError?.(extractPiError(event.error));
    return { settled: false, error: true, content: false };
  }

  return { settled: false, error: false, content: false };
}

function buildPiImages(attachments) {
  const images = [];
  for (const attachment of Array.isArray(attachments) ? attachments : []) {
    if (!attachment) continue;
    if (typeof attachment.data === "string") {
      images.push({ type: "image", data: attachment.data, mimeType: String(attachment.mediaType || "image/png") });
      continue;
    }
    if (!attachment.filePath) continue;
    try {
      images.push({
        type: "image",
        data: fs.readFileSync(attachment.filePath).toString("base64"),
        mimeType: String(attachment.mediaType || "image/png"),
      });
    } catch {
      // Missing staged attachments are reported by the prompt/error path.
    }
  }
  return images;
}

function activePiTurnKey({ requestId, chatSessionId } = {}) {
  return String(requestId || chatSessionId || "");
}

function normalizePiModelId(model) {
  if (typeof model === "string") return model.trim() || null;
  if (!model || typeof model !== "object") return null;
  const id = String(model.id || model.modelId || "").trim();
  if (!id) return null;
  const provider = String(model.provider || model.providerId || model.providerID || "").trim();
  // Pi accepts provider/model ids in --model.  Keep an already-qualified id as
  // is, and qualify the provider metadata exposed by get_state/list models.
  return provider && !id.includes("/") ? `${provider}/${id}` : id;
}

function mapPiModel(model) {
  const id = normalizePiModelId(model);
  if (!id) return null;
  const rawName = typeof model === "object" ? model.name : "";
  const name = String(rawName || (id.includes("/") ? id.slice(id.indexOf("/") + 1) : id)).trim() || id;
  const mapped = { id, name };
  if (typeof model === "object") {
    const provider = String(model.provider || model.providerId || model.providerID || "").trim();
    if (provider) mapped.provider = provider;
    const reasoning = model.reasoning ?? model.supportsReasoning ?? model.thinking;
    if (reasoning != null) mapped.supportsReasoning = Boolean(reasoning);
  }
  return mapped;
}

function mapPiModels(value) {
  const raw = Array.isArray(value)
    ? value
    : (Array.isArray(value?.models) ? value.models : []);
  const seen = new Set();
  const models = [];
  for (const entry of raw) {
    const mapped = mapPiModel(entry);
    if (!mapped || seen.has(mapped.id)) continue;
    seen.add(mapped.id);
    models.push(mapped);
  }
  return models;
}

function extractPiCurrentModelId(stateResponse) {
  const data = stateResponse?.data || stateResponse?.state || stateResponse;
  return normalizePiModelId(data?.model || data?.currentModel || data?.current_model);
}

/** Query Pi's live provider catalog through the same RPC protocol as turns. */
async function listPiModels({
  env,
  binPath,
  cwd,
  spawnImpl,
  abortController,
  signal,
  timeoutMs = PI_MODEL_LIST_TIMEOUT_MS,
  abortGraceMs = PI_ABORT_GRACE_MS,
} = {}) {
  const abortSignal = signal || abortController?.signal;
  if (abortSignal?.aborted) return { currentModelId: null, models: [] };
  const childEnv = env ? { ...process.env, ...env } : process.env;
  const args = buildPiCliArgs({ toolIntegrationMode: "skills" });

  return await new Promise((resolve) => {
    let child;
    let lineBuffer;
    let settled = false;
    let commandCounter = 0;
    let timeout;
    let killTimer;
    let abortHandler;
    const pending = new Map();
    let stateResponse = null;
    let modelsResponse = null;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      if (abortSignal && abortHandler) abortSignal.removeEventListener("abort", abortHandler);
      try { child?.stdin?.end?.(); } catch {}
      resolve(value || { currentModelId: null, models: [] });
    };
    const rejectPending = (error) => {
      for (const request of pending.values()) request.reject(error);
      pending.clear();
    };
    const fail = (error = new Error("Pi model query failed")) => {
      rejectPending(error);
      try { child?.kill?.("SIGTERM"); } catch {}
      finish({ currentModelId: null, models: [] });
    };

    try {
      child = spawnPiProcess(spawnImpl, binPath || DEFAULT_PI_COMMAND, args, {
        cwd: String(cwd || process.cwd()),
        env: childEnv,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
      });
    } catch {
      fail();
      return;
    }

    const sendCommand = (command) => {
      const id = `netcatty-model-${++commandCounter}`;
      const responsePromise = new Promise((resolveRequest, rejectRequest) => {
        pending.set(id, { command: command.type, resolve: resolveRequest, reject: rejectRequest });
      });
      try {
        const result = writePiRecord(child, { id, ...command });
        return Promise.resolve(result).then(() => responsePromise);
      } catch (error) {
        pending.delete(id);
        return Promise.reject(error);
      }
    };
    const handleLine = (line) => {
      let event;
      try { event = JSON.parse(line); } catch { rejectPending(new Error("Pi returned invalid JSON")); fail(); return; }
      if (event?.type !== "response") return;
      let responseId = event.id && pending.has(event.id) ? event.id : null;
      if (!responseId && !event.id) {
        responseId = [...pending.entries()].find(([, request]) => request.command === event.command)?.[0]
          || (pending.size === 1 ? pending.keys().next().value : null);
      }
      if (!responseId) return;
      const request = pending.get(responseId);
      pending.delete(responseId);
      if (event.success === false) request.reject(new Error(extractPiError(event.error)));
      else request.resolve(event);
      if (event.command === "get_state") stateResponse = event;
      if (event.command === "get_available_models") modelsResponse = event;
      if (stateResponse && modelsResponse) {
        const currentModelId = extractPiCurrentModelId(stateResponse);
        const models = mapPiModels(modelsResponse.data || modelsResponse);
        if (currentModelId && !models.some((model) => model.id === currentModelId)) {
          const currentModel = mapPiModel(stateResponse.data?.model || stateResponse.state?.model);
          models.unshift(currentModel || { id: currentModelId, name: currentModelId });
        }
        finish({ currentModelId, models });
      }
    };
    lineBuffer = createPiLineBuffer(handleLine);
    child.stdout?.on("data", (chunk) => {
      try { lineBuffer.push(chunk); } catch { rejectPending(new Error("Pi returned an oversized JSONL message")); fail(); }
    });
    child.on?.("error", () => { rejectPending(new Error("Pi RPC process failed")); fail(); });
    child.on?.("close", () => {
      try { lineBuffer.flush(); } catch {}
      if (!settled) fail();
    });

    const abort = () => {
      if (settled) return;
      rejectPending(new Error("Pi model query aborted"));
      try { child.kill?.("SIGTERM"); } catch {}
      killTimer = setTimeout(() => {
        if (settled) return;
        try { child.kill?.("SIGKILL"); } catch {}
        fail();
      }, Math.max(0, abortGraceMs));
      killTimer.unref?.();
    };
    abortHandler = abort;
    if (abortSignal) {
      if (abortSignal.aborted) { abort(); return; }
      abortSignal.addEventListener("abort", abortHandler, { once: true });
    }
    timeout = setTimeout(() => { abort(); }, Math.max(0, timeoutMs));
    timeout.unref?.();
    Promise.all([sendCommand({ type: "get_state" }), sendCommand({ type: "get_available_models" })]).catch(() => fail());
  });
}

function writePiRecord(child, record) {
  const stdin = child?.stdin;
  if (!stdin || stdin.destroyed || typeof stdin.write !== "function") {
    throw new Error("Pi RPC stdin is unavailable");
  }
  const line = `${JSON.stringify(record)}\n`;
  const accepted = stdin.write(line);
  if (accepted === false && typeof stdin.once === "function") {
    return new Promise((resolve, reject) => {
      const onDrain = () => { cleanup(); resolve(); };
      const onError = (error) => { cleanup(); reject(error); };
      const cleanup = () => {
        stdin.removeListener?.("drain", onDrain);
        stdin.removeListener?.("error", onError);
      };
      stdin.once("drain", onDrain);
      stdin.once("error", onError);
    });
  }
  return Promise.resolve();
}

function sendAbortRecord(runtime) {
  if (!runtime || runtime.abortSent || runtime.closed) return Promise.resolve();
  runtime.abortSent = true;
  try {
    return runtime.sendCommand({ type: "abort" }).catch(() => {});
  } catch {
    return Promise.resolve();
  }
}

/** Queue a mid-turn Pi steering message for sdkStreamHandlers. */
async function steerPiTurn({ requestId, chatSessionId, prompt, attachments } = {}) {
  const key = activePiTurnKey({ requestId, chatSessionId });
  const runtime = activePiTurns.get(key);
  if (!runtime || runtime.closed) return { status: "inactive" };
  try {
    const images = buildPiImages(attachments);
    const response = await runtime.sendCommand({
      type: "steer",
      message: String(prompt || ""),
      ...(images.length > 0 ? { images } : {}),
    });
    if (response?.success === false) {
      return { status: "failed", message: extractPiError(response.error, "Pi rejected steering") };
    }
    const disposition = response?.data?.disposition || "queued";
    return { status: disposition === "handled" || disposition === "queued" ? "accepted" : "failed", disposition };
  } catch (error) {
    return { status: "failed", message: extractPiError(error, "Pi could not accept steering") };
  }
}

async function runPiTurn({
  prompt,
  attachments,
  cwd,
  model,
  permissionMode,
  env,
  binPath,
  emitter,
  signal,
  abortController,
  requestId,
  chatSessionId,
  injectedMcpServers,
  spawnImpl,
  tempDirBridge,
  toolIntegrationMode = "mcp",
  writeFileSync,
  unlinkSync,
  abortGraceMs = PI_ABORT_GRACE_MS,
} = {}) {
  const effectiveSignal = signal || abortController?.signal;
  const sessionKey = activePiTurnKey({ requestId, chatSessionId });
  const state = {
    sessionId: null,
    reasoningOpen: false,
    failed: false,
    settled: false,
    aborted: false,
    agentEnded: false,
    content: false,
  };
  let child;
  let lineBuffer;
  let finishResolve;
  let finishReject;
  let finished = false;
  let abortTimer;
  const pending = new Map();
  let commandCounter = 0;
  let stderrText = "";
  let mcpConfigHandle = null;

  const rejectPending = (error = new Error("Pi RPC process closed")) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };

  const finish = (error) => {
    if (finished) return;
    finished = true;
    clearTimeout(abortTimer);
    if (error) finishReject?.(error);
    else finishResolve?.();
  };

  try {
    try {
      mcpConfigHandle = writePiMcpConfig(injectedMcpServers, {
        toolIntegrationMode,
        tempDirBridge,
        writeFileSync,
        unlinkSync,
      });
    } catch (error) {
      emitter?.emitError?.(`Failed to prepare Netcatty MCP for Pi: ${error?.message || error}`);
      return {};
    }
    const args = buildPiCliArgs({
      model,
      mcpConfigPath: mcpConfigHandle?.path,
      permissionMode,
      toolIntegrationMode,
    });
    child = spawnPiProcess(spawnImpl, binPath || DEFAULT_PI_COMMAND, args, {
      cwd: String(cwd || process.cwd()),
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });

    const runtime = {
      child,
      closed: false,
      abortSent: false,
      sendCommand: async (command) => {
        if (runtime.closed) throw new Error("Pi RPC process is closed");
        if (effectiveSignal?.aborted && command.type !== "abort") {
          throw new Error("Pi RPC turn aborted");
        }
        const id = `netcatty-${++commandCounter}`;
        const record = { id, ...command };
        const responsePromise = new Promise((resolve, reject) => pending.set(id, {
          command: command.type,
          resolve,
          reject,
        }));
        try {
          await writePiRecord(child, record);
        } catch (error) {
          pending.delete(id);
          throw error;
        }
        return responsePromise;
      },
    };
    if (sessionKey) activePiTurns.set(sessionKey, runtime);

    const handleLine = (line) => {
      let event;
      try { event = JSON.parse(line); } catch {
        state.failed = true;
        emitter?.emitError?.("Pi returned invalid JSON");
        rejectPending(new Error("Pi returned invalid JSON"));
        finish();
        return;
      }
      if (event?.type === "response") {
        let responseId = event.id && pending.has(event.id) ? event.id : null;
        if (!responseId && !event.id) {
          // Pi includes ids for normal responses. Matching by command keeps the
          // transport tolerant of older builds that omitted them, while still
          // preserving FIFO semantics when multiple commands are outstanding.
          responseId = [...pending.entries()]
            .find(([, request]) => request.command === event.command)?.[0]
            || (pending.size === 1 ? pending.keys().next().value : null);
        }
        if (responseId) {
          const request = pending.get(responseId);
          pending.delete(responseId);
          request.resolve(event);
        }
      }
      const result = translatePiEvent(event, emitter || {}, state);
      if (result.content) state.content = true;
      if (result.error) rejectPending(new Error("Pi RPC reported an error"));
      if (result.settled || result.error) finish();
    };
    lineBuffer = createPiLineBuffer(handleLine);
    child.stdout?.on("data", (chunk) => {
      try { lineBuffer.push(chunk); } catch (error) {
        state.failed = true;
        emitter?.emitError?.(extractPiError(error));
        rejectPending(error);
        finish();
        try { child.kill?.("SIGKILL"); } catch {}
      }
    });
    child.stderr?.on("data", (chunk) => {
      stderrText += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk || "");
      if (stderrText.length > 64 * 1024) stderrText = stderrText.slice(-64 * 1024);
    });
    child.on?.("error", (error) => {
      if (!state.failed && !effectiveSignal?.aborted) {
        state.failed = true;
        emitter?.emitError?.(error?.message || String(error));
      }
      rejectPending(error);
      finish();
    });
    child.on?.("close", (code, exitSignal) => {
      runtime.closed = true;
      if (!effectiveSignal?.aborted && !state.settled && !state.failed) {
        state.failed = true;
        const detail = stderrText.trim() || (code != null ? `Pi exited with code ${code}` : `Pi terminated by ${exitSignal || "signal"}`);
        emitter?.emitError?.(detail);
      }
      rejectPending(new Error("Pi RPC process closed"));
      if (!effectiveSignal?.aborted && !state.settled && state.agentEnded) finish();
      else finish();
    });

    let abortHandler;
    const requestAbort = () => {
      if (runtime.closed || runtime.abortSent) return;
      void sendAbortRecord(runtime);
      // Do not leave get_state/prompt callers waiting after the caller has
      // cancelled the turn. The abort response itself is best effort.
      rejectPending(new Error("Pi RPC turn aborted"));
      abortTimer = setTimeout(() => {
        if (runtime.closed || finished) return;
        try { child.kill?.("SIGTERM"); } catch {}
        finish();
      }, Math.max(0, abortGraceMs));
      abortTimer.unref?.();
    };
    if (effectiveSignal) {
      abortHandler = requestAbort;
      if (effectiveSignal.aborted) requestAbort();
      else effectiveSignal.addEventListener("abort", abortHandler, { once: true });
    }

    // Subscribe to stdout before any command, then query state so the session
    // identity is available to the renderer before streaming text arrives.
    let stateResponse;
    try {
      stateResponse = await runtime.sendCommand({ type: "get_state" });
    } catch (error) {
      if (!effectiveSignal?.aborted && !state.failed) {
        state.failed = true;
        emitter?.emitError?.(extractPiError(error));
      }
      return {};
    }
    // Pi is started with --no-session for every turn. Its get_state sessionId
    // is ephemeral and must not be persisted as a resume id by Netcatty.
    if (stateResponse?.success === false) {
      state.failed = true;
      emitter?.emitError?.(extractPiError(stateResponse.error, "Pi get_state failed"));
      return {};
    }
    if (effectiveSignal?.aborted) return {};

    const images = buildPiImages(attachments);
    let promptResponse;
    try {
      promptResponse = await runtime.sendCommand({
        type: "prompt",
        message: String(prompt || ""),
        ...(images.length > 0 ? { images } : {}),
      });
    } catch (error) {
      if (!effectiveSignal?.aborted && !state.failed) {
        state.failed = true;
        emitter?.emitError?.(extractPiError(error));
      }
      return {};
    }
    if (promptResponse?.success === false) {
      state.failed = true;
      emitter?.emitError?.(extractPiError(promptResponse.error, "Pi rejected prompt"));
      return {};
    }
    const disposition = promptResponse?.data?.disposition;
    if (disposition === "handled") {
      state.settled = true;
      finish();
    } else {
      await new Promise((resolve, reject) => {
        finishResolve = resolve;
        finishReject = reject;
        if (finished) resolve();
      }).catch(() => {});
    }
    if (abortHandler && effectiveSignal) effectiveSignal.removeEventListener("abort", abortHandler);
    closePiReasoning(state, emitter || {});
    if (!effectiveSignal?.aborted && !state.failed && state.settled) emitter?.emitDone?.();
    else if (!effectiveSignal?.aborted && !state.failed) {
      state.failed = true;
      emitter?.emitError?.(stderrText.trim() || "Pi ended before the turn completed");
    }
    return {};
  } catch (error) {
    if (!effectiveSignal?.aborted && !state.failed) emitter?.emitError?.(extractPiError(error));
    return {};
  } finally {
    clearTimeout(abortTimer);
    if (sessionKey && activePiTurns.get(sessionKey)?.child === child) activePiTurns.delete(sessionKey);
    mcpConfigHandle?.cleanup?.();
    try {
      if (child?.stdin && !child.stdin.destroyed) child.stdin.end?.();
    } catch {}
  }
}

module.exports = {
  DEFAULT_PI_COMMAND,
  PI_ABORT_GRACE_MS,
  PI_MAX_LINE_BYTES,
  PI_MODEL_LIST_TIMEOUT_MS,
  PI_MCP_DISALLOWED_LOCAL_TOOLS,
  activePiTurns,
  buildPiCliArgs,
  buildPiImages,
  createPiLineBuffer,
  emitPiUsage,
  extractPiError,
  extractPiCurrentModelId,
  mapPiModel,
  mapPiModels,
  listPiModels,
  resolvePiSpawnSpec,
  resultToText,
  runPiTurn,
  spawnPiProcess,
  steerPiTurn,
  translatePiEvent,
  writePiMcpConfig,
};
