"use strict";

const portForwardingBridge = require("../../bridges/portForwardingBridge.cjs");

/**
 * Port forwarding domain service. Tunnels live in the configured runtime
 * (terminal worker in the current architecture); rules live in renderer vault.
 */
function createPortForwardService(ctx = {}) {
  const { invokeVaultAgent } = ctx;
  const listPortForwards = typeof ctx.listPortForwards === "function"
    ? ctx.listPortForwards
    : () => portForwardingBridge.listPortForwards();

  return {
    listRules: async () => {
      if (typeof invokeVaultAgent !== "function") {
        return { ok: false, error: "Vault agent bridge is unavailable." };
      }
      return invokeVaultAgent("portforward.rules.list", {});
    },
    createRule: async (params = {}) => {
      if (typeof invokeVaultAgent !== "function") return { ok: false, error: "Vault agent bridge is unavailable." };
      return invokeVaultAgent("portforward.rules.create", params);
    },
    updateRule: async (params = {}) => {
      if (typeof invokeVaultAgent !== "function") return { ok: false, error: "Vault agent bridge is unavailable." };
      return invokeVaultAgent("portforward.rules.update", params);
    },
    duplicateRule: async (params = {}) => {
      if (typeof invokeVaultAgent !== "function") return { ok: false, error: "Vault agent bridge is unavailable." };
      return invokeVaultAgent("portforward.rules.duplicate", params);
    },
    deleteRule: async (params = {}) => {
      if (typeof invokeVaultAgent !== "function") return { ok: false, error: "Vault agent bridge is unavailable." };
      return invokeVaultAgent("portforward.rules.delete", params);
    },
    listTunnels: async () => {
      const tunnels = await listPortForwards();
      return { ok: true, tunnels };
    },
    start: async (params = {}) => {
      if (typeof invokeVaultAgent !== "function") {
        return { ok: false, error: "Vault agent bridge is unavailable." };
      }
      return invokeVaultAgent("portforward.start", {
        ruleId: params.ruleId,
        hostId: params.hostId,
        chatSessionId: params.chatSessionId,
      });
    },
    stop: async (params = {}) => {
      if (typeof invokeVaultAgent !== "function") {
        return { ok: false, error: "Vault agent bridge is unavailable." };
      }
      return invokeVaultAgent("portforward.stop", {
        ruleId: params.ruleId,
        hostId: params.hostId,
        chatSessionId: params.chatSessionId,
      });
    },
  };
}

module.exports = {
  createPortForwardService,
};
