"use strict";

const { CAPABILITY_STATUS, CAPABILITY_SURFACES, PERMISSION_MODES } = require("../../capabilities/constants.cjs");
const { getCapabilityByRpcMethod } = require("../../capabilities/registry.cjs");
const { getMcpToolNameForRpcMethod } = require("../../capabilities/adapters/mcpAdapter.cjs");
const { createVaultService } = require("../../capabilities/services/vaultService.cjs");
const { createPortForwardService } = require("../../capabilities/services/portforwardService.cjs");
const { createSessionService } = require("../../capabilities/services/sessionService.cjs");

const CANCELLATION_SETTLEMENT_TIMEOUT_MS = 5000;

const UNROUTED = Symbol("capability-rpc-unrouted");

const SERVICE_BINDINGS = Object.freeze({
  "vault.host.get": { domain: "vault", method: "getHost" },
  "vault.host.list": { domain: "vault", method: "listHosts" },
  "vault.host.open": { domain: "vault", method: "openHost" },
  "vault.hosts.create": { domain: "vault", method: "createHosts" },
  "vault.host.update": { domain: "vault", method: "updateHost" },
  "vault.host.delete": { domain: "vault", method: "deleteHost" },
  "vault.host.import": { domain: "vault", method: "importHosts" },
  "vault.host.notes.get": { domain: "vault", method: "getHostNotes" },
  "vault.host.notes.set": { domain: "vault", method: "setHostNotes" },
  "vault.note.list": { domain: "vault", method: "listNotes" },
  "vault.note.get": { domain: "vault", method: "getNote" },
  "vault.note.create": { domain: "vault", method: "createNote" },
  "vault.note.update": { domain: "vault", method: "updateNote" },
  "vault.note.delete": { domain: "vault", method: "deleteNote" },
  "vault.note.import": { domain: "vault", method: "importNotes" },
  "vault.identity.list": { domain: "vault", method: "listIdentities" },
  "vault.proxyProfile.list": { domain: "vault", method: "listProxyProfiles" },
  "vault.group.list": { domain: "vault", method: "listGroups" },
  "vault.group.create": { domain: "vault", method: "createGroup" },
  "vault.group.update": { domain: "vault", method: "updateGroup" },
  "vault.group.delete": { domain: "vault", method: "deleteGroup" },
  "vault.snippets.list": { domain: "vault", method: "listSnippets" },
  "vault.snippets.get": { domain: "vault", method: "getSnippet" },
  "vault.snippets.run": { domain: "vault", method: "runSnippet" },
  "vault.snippets.create": { domain: "vault", method: "createSnippet" },
  "vault.snippets.update": { domain: "vault", method: "updateSnippet" },
  "vault.snippets.delete": { domain: "vault", method: "deleteSnippet" },
  "vault.scripts.list": { domain: "vault", method: "listScripts" },
  "vault.scripts.get": { domain: "vault", method: "getScript" },
  "vault.scripts.create": { domain: "vault", method: "createScript" },
  "vault.scripts.update": { domain: "vault", method: "updateScript" },
  "vault.scripts.delete": { domain: "vault", method: "deleteScript" },
  "vault.scripts.run": { domain: "vault", method: "runScript" },
  "vault.scripts.reference": { domain: "vault", method: "getScriptReference" },
  "vault.scripts.runs.list": { domain: "vault", method: "listScriptRuns" },
  "vault.scripts.run.stop": { domain: "vault", method: "stopScriptRun" },
  "vault.scripts.run.pause": { domain: "vault", method: "pauseScriptRun" },
  "vault.scripts.run.resume": { domain: "vault", method: "resumeScriptRun" },
  "vault.scripts.targets.set": { domain: "vault", method: "setScriptTargets" },
  "vault.host.connectScripts.list": { domain: "vault", method: "listHostConnectScripts" },
  "vault.host.connectScripts.set": { domain: "vault", method: "setHostConnectScripts" },
  "portforward.rules.list": { domain: "portforward", method: "listRules" },
  "portforward.rules.create": { domain: "portforward", method: "createRule" },
  "portforward.rules.update": { domain: "portforward", method: "updateRule" },
  "portforward.rules.duplicate": { domain: "portforward", method: "duplicateRule" },
  "portforward.rules.delete": { domain: "portforward", method: "deleteRule" },
  "portforward.tunnels.list": { domain: "portforward", method: "listTunnels" },
  "portforward.start": { domain: "portforward", method: "start" },
  "portforward.stop": { domain: "portforward", method: "stop" },
  "session.close": { domain: "session", method: "close" },
});

function resolveCapabilitySurface(rpcMethod) {
  for (const surface of [
    CAPABILITY_SURFACES.PUBLIC,
    CAPABILITY_SURFACES.GLOBAL,
    CAPABILITY_SURFACES.BUILTIN,
  ]) {
    if (rpcMethod.startsWith("netcatty/") && surface !== CAPABILITY_SURFACES.BUILTIN) {
      continue;
    }
    const capability = getCapabilityByRpcMethod(rpcMethod, surface);
    if (capability) {
      return { capability, surface };
    }
  }
  return null;
}

function createCapabilityRpcDispatcher(deps) {
  const {
    invokeVaultAgent,
    evaluatePermissionWithGrants,
    isChatSessionCancelled,
    requestApprovalFromRenderer,
    USER_DENIED_MESSAGE,
    getScopedSessionIds,
    getSessionMeta,
  } = deps;

  const vaultService = createVaultService({ invokeVaultAgent });
  const portforwardService = createPortForwardService({
    invokeVaultAgent,
    listPortForwards: deps.listPortForwards,
  });
  const sessionService = deps.sessionService || createSessionService({
    invokeSessionAgent: invokeVaultAgent,
    validateClose: deps.validateSessionClose,
    beforeClose: deps.beforeSessionClose,
    afterClose: deps.afterSessionClose,
    onClosed: deps.onSessionClosed,
  });
  const services = {
    vault: vaultService,
    portforward: portforwardService,
    session: sessionService,
  };
  const activeChatCancellations = new Map();
  const activePortForwardStarts = new Set();

  const registerChatCancellation = (chatSessionId, cancel) => {
    if (!chatSessionId || typeof cancel !== "function") return () => {};
    let cancellations = activeChatCancellations.get(chatSessionId);
    if (!cancellations) {
      cancellations = new Set();
      activeChatCancellations.set(chatSessionId, cancellations);
    }
    cancellations.add(cancel);
    return () => {
      cancellations.delete(cancel);
      if (cancellations.size === 0) activeChatCancellations.delete(chatSessionId);
    };
  };

  const awaitOperationSettlement = async (operationPromise) => {
    if (!operationPromise) return true;
    let timer;
    try {
      return await Promise.race([
        Promise.resolve(operationPromise).then(() => true, () => true),
        new Promise(resolve => {
          timer = setTimeout(() => resolve(false), CANCELLATION_SETTLEMENT_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const cancelChatSessionOperations = async (chatSessionId) => {
    const cancellations = activeChatCancellations.get(chatSessionId);
    if (!cancellations || cancellations.size === 0) return;
    const results = await Promise.allSettled([...cancellations].map(cancel => Promise.resolve().then(cancel)));
    const failure = results.find(result => result.status === "rejected");
    if (failure) throw failure.reason instanceof Error ? failure.reason : new Error(String(failure.reason));
  };

  const dispatchCapabilityRpc = async function dispatchCapabilityRpc(rpcMethod, params = {}, approvalContext = {}) {
    if (typeof rpcMethod !== "string" || rpcMethod.startsWith("netcatty/")) {
      return UNROUTED;
    }

    const resolved = resolveCapabilitySurface(rpcMethod);
    if (!resolved) {
      return UNROUTED;
    }

    const { capability, surface } = resolved;
    if (capability.status !== CAPABILITY_STATUS.IMPLEMENTED) {
      return {
        ok: false,
        code: "CAPABILITY_NOT_IMPLEMENTED",
        error: `Capability "${capability.id}" is not implemented yet.`,
      };
    }

    const binding = SERVICE_BINDINGS[capability.id];
    if (!binding) {
      return UNROUTED;
    }
    const requiresTrustedChatSession = surface === CAPABILITY_SURFACES.GLOBAL
      && ["vault.host.notes.get", "vault.host.notes.set", "portforward.start", "portforward.stop"].includes(capability.id);
    if (requiresTrustedChatSession && typeof approvalContext.chatSessionId !== "string") {
      return { ok: false, error: "A trusted Catty chat scope is required for this capability." };
    }
    const trustedChatSessionId = typeof approvalContext.chatSessionId === "string"
      ? approvalContext.chatSessionId
      : surface === CAPABILITY_SURFACES.GLOBAL
        ? undefined
        : typeof params?.chatSessionId === "string" ? params.chatSessionId : undefined;
    let scopedParams = trustedChatSessionId
      ? { ...params, chatSessionId: trustedChatSessionId }
      : params;
    let cattyAuthorization;
    if (approvalContext.catty === true && capability.policy?.write) {
      if (typeof approvalContext.cattyPlanToken !== "string" || typeof trustedChatSessionId !== "string") {
        return { ok: false, error: "A main-process Catty plan authorization is required." };
      }
      const cattyToolName = getMcpToolNameForRpcMethod(rpcMethod, surface) || capability.id;
      cattyAuthorization = deps.validateCattyPlanStep
        ? deps.validateCattyPlanStep({
            token: approvalContext.cattyPlanToken,
            chatSessionId: trustedChatSessionId,
            toolName: cattyToolName,
            args: scopedParams,
            sessionId: scopedParams.sessionId,
          })
        : { ok: false, error: "Catty plan authorization is unavailable." };
      if (!cattyAuthorization.ok) return cattyAuthorization;
      scopedParams = {
        ...scopedParams,
        expectedHostId: cattyAuthorization.targetIdentity.hostId,
        expectedHostname: cattyAuthorization.targetIdentity.hostname,
        expectedProtocol: cattyAuthorization.targetIdentity.protocol,
        ...(cattyAuthorization.notesFingerprint
          ? { expectedNotesFingerprint: cattyAuthorization.notesFingerprint }
          : {}),
      };
    }
    if (
      capability.policy?.write
      && !["session.close", "vault.host.delete"].includes(capability.id)
      && typeof scopedParams.sessionId === "string"
      && (
        typeof scopedParams.expectedHostId !== "string"
        || !scopedParams.expectedHostId
        || typeof scopedParams.expectedHostname !== "string"
        || !scopedParams.expectedHostname
        || typeof scopedParams.expectedProtocol !== "string"
        || !scopedParams.expectedProtocol
      )
    ) {
      return { ok: false, error: "Execution target identity is missing or incomplete; submit a new plan." };
    }

    // Only session.close executes against params.sessionId. host.open instead
    // targets its requested vault host; other vault/script operations must not
    // borrow an unrelated session's host grant.
    let approvalTarget = capability.id === "session.close"
      ? (deps.getApprovalTarget?.(params) || null)
      : null;
    if (capability.id === "vault.host.open" && deps.permissionMode === PERMISSION_MODES.CONFIRM) {
      const requestedHostId = typeof params?.hostId === "string" ? params.hostId.trim() : "";
      let lookup = null;
      if (requestedHostId) {
        try {
          lookup = await vaultService.getHost({ hostId: requestedHostId });
        } catch {
          // The metadata lookup is best-effort; without it, approval cannot
          // offer a persistent host grant.
        }
      }
      const host = lookup?.host?.id === requestedHostId ? lookup.host : null;
      approvalTarget = {
        sessionId: "",
        hostId: host && host.ephemeral !== true && host.protocol !== "serial" && host.protocol !== "local"
          ? requestedHostId
          : "",
        label: host?.label || host?.hostname || requestedHostId,
        hostname: host?.hostname || "",
      };
    }
    if (scopedParams.expectedHostId && scopedParams.sessionId) {
      const meta = typeof getSessionMeta === "function"
        ? getSessionMeta(scopedParams.sessionId, trustedChatSessionId)
        : null;
      if (!meta || meta.connected !== true || (meta.hostId || meta.savedHostId) !== scopedParams.expectedHostId) {
        return { ok: false, error: "Execution target host identity changed; submit a new plan." };
      }
      if (scopedParams.expectedHostname
        && (!meta.hostname
          || String(meta.hostname).trim().toLowerCase() !== String(scopedParams.expectedHostname).trim().toLowerCase())) {
        return { ok: false, error: "Execution target hostname changed or is incomplete; submit a new plan." };
      }
      if (scopedParams.expectedProtocol
        && (!meta.protocol
          || String(meta.protocol).toLowerCase() !== String(scopedParams.expectedProtocol).toLowerCase())) {
        return { ok: false, error: "Execution target protocol changed or is incomplete; submit a new plan." };
      }
    }

    if (
      typeof trustedChatSessionId === "string"
      && ["vault.host.notes.get", "vault.host.notes.set", "portforward.start", "portforward.stop"].includes(capability.id)
    ) {
      const requestedHostId = typeof params?.hostId === "string" ? params.hostId.trim() : "";
      const scopedSessionIds = typeof getScopedSessionIds === "function"
        ? getScopedSessionIds(trustedChatSessionId)
        : [];
      const inScope = requestedHostId && scopedSessionIds.some((sessionId) => {
        const meta = typeof getSessionMeta === "function"
          ? getSessionMeta(sessionId, trustedChatSessionId)
          : null;
        return meta?.connected === true
          && (meta.hostId || meta.savedHostId) === requestedHostId;
      });
      if (!inScope) {
        return {
          ok: false,
          error: `Host "${requestedHostId || "(missing)"}" is not connected in the current chat scope.`,
        };
      }
    }

    const permission = evaluatePermissionWithGrants({
      rpcMethod,
      surface,
      permissionMode: deps.permissionMode,
      params: scopedParams,
      context: {
        chatSessionCancelled: isChatSessionCancelled(trustedChatSessionId),
        hostId: approvalTarget?.hostId,
      },
    }, deps.permissionGrantsSnapshot);

    if (!permission.allowed) {
      return { ok: false, error: permission.error };
    }

    if (permission.requiresApproval && !deps.hasSessionApproval?.(approvalContext.externalSocket)) {
      const { chatSessionId, ...toolArgs } = scopedParams || {};
      const toolName = getMcpToolNameForRpcMethod(rpcMethod, surface)
        || capability.surfaces?.[CAPABILITY_SURFACES.PUBLIC]?.mcpTool
        || capability.id;
      const approved = await requestApprovalFromRenderer(toolName, toolArgs, chatSessionId, {
        ...approvalContext,
        target: approvalTarget,
      });
      if (!approved) {
        return { ok: false, error: USER_DENIED_MESSAGE };
      }
    }

    const service = services[binding.domain];
    const handler = service?.[binding.method];
    if (typeof handler !== "function") {
      return {
        ok: false,
        error: `Capability handler "${capability.id}" is unavailable.`,
      };
    }

    const hostOpenGeneration = capability.id === "vault.host.open"
      ? deps.captureHostOpenScope?.(trustedChatSessionId)
      : null;
    const shouldCancelPortForwardStart = capability.id === "portforward.start"
      && typeof trustedChatSessionId === "string"
      && typeof scopedParams?.ruleId === "string";
    const shouldTrackChatOperation = typeof trustedChatSessionId === "string";
    let ownsPortForwardStartLock = false;
    if (shouldCancelPortForwardStart) {
      if (activePortForwardStarts.has(scopedParams.ruleId)) {
        return { ok: false, error: "A port-forward start for this rule is already in progress." };
      }
      activePortForwardStarts.add(scopedParams.ruleId);
      ownsPortForwardStartLock = true;
      let existing;
      try {
        existing = await service.listTunnels?.();
      } catch (error) {
        activePortForwardStarts.delete(scopedParams.ruleId);
        ownsPortForwardStartLock = false;
        return { ok: false, error: error?.message || String(error) };
      }
      if (!existing || existing.ok === false) {
        activePortForwardStarts.delete(scopedParams.ruleId);
        ownsPortForwardStartLock = false;
        return { ok: false, error: existing?.error || "Unable to verify existing port-forward tunnels before starting." };
      }
      const activeTunnels = Array.isArray(existing.tunnels) ? existing.tunnels : [];
      if (activeTunnels.some(tunnel => tunnel?.ruleId === scopedParams.ruleId)) {
        activePortForwardStarts.delete(scopedParams.ruleId);
        ownsPortForwardStartLock = false;
        return { ok: false, error: "Port-forward rule already has an active tunnel; stop it explicitly before starting it again." };
      }
    }
    let operationPromise;
    const unregisterCancellation = shouldTrackChatOperation
      ? registerChatCancellation(trustedChatSessionId, async () => {
          // Do not acknowledge a generic capability cancellation while the
          // underlying handler is still running. Port-forward starts also need
          // an explicit stop after a late tunnel creation completes. The
          // deadline prevents a broken native handler from hanging the turn.
          const settled = await awaitOperationSettlement(operationPromise);
          if (shouldCancelPortForwardStart && typeof invokeVaultAgent === "function") {
            const result = await invokeVaultAgent("portforward.stop", {
              ruleId: scopedParams.ruleId,
              hostId: scopedParams.hostId,
              chatSessionId: trustedChatSessionId,
            });
            if (!result || result.ok === false) {
              throw new Error(result?.error || "Port-forward cancellation was not confirmed.");
            }
          }
          if (!settled) {
            throw new Error("Capability cancellation timed out before the handler settled.");
          }
        })
      : () => {};
    try {
      operationPromise = Promise.resolve(handler(scopedParams));
      const result = await operationPromise;
      if (cattyAuthorization?.ok && approvalContext.cattyPlanToken) {
        deps.settleCattyPlanStep?.(
          approvalContext.cattyPlanToken,
          Boolean(result && typeof result === "object" && result.ok !== false && !result.error),
        );
      }
      if (capability.id === "vault.host.open" && result?.ok !== false && result?.sessionId) {
        await deps.onHostOpened?.(trustedChatSessionId, result.sessionId, hostOpenGeneration, result);
      }
      return result;
    } catch (error) {
      if (cattyAuthorization?.ok && approvalContext.cattyPlanToken) {
        deps.settleCattyPlanStep?.(approvalContext.cattyPlanToken, false);
      }
      throw error;
    } finally {
      unregisterCancellation();
      if (ownsPortForwardStartLock) activePortForwardStarts.delete(scopedParams.ruleId);
    }
  };
  dispatchCapabilityRpc.cancelChatSessionOperations = cancelChatSessionOperations;
  return dispatchCapabilityRpc;
}

module.exports = {
  UNROUTED,
  createCapabilityRpcDispatcher,
  SERVICE_BINDINGS,
};
