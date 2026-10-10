"use strict";

/**
 * SDK driver registry for external agents.
 *
 * Catty is Netcatty's built-in agent and does not use this registry. Pi is the
 * only supported external agent in this build; keeping the allowlist here
 * prevents stale local configurations from reaching removed drivers.
 */
const pi = require("./piDriver.cjs");

const DRIVER_REGISTRY = {
  pi: {
    async runTurn(ctx) {
      return pi.runPiTurn({
        prompt: ctx.prompt,
        attachments: ctx.attachments,
        cwd: ctx.cwd,
        model: ctx.model,
        permissionMode: ctx.permissionMode,
        env: ctx.env,
        binPath: ctx.binPath,
        injectedMcpServers: ctx.injectedMcpServers,
        toolIntegrationMode: ctx.toolIntegrationMode,
        emitter: ctx.emitter,
        signal: ctx.signal,
        abortController: ctx.abortController,
        spawnImpl: ctx.spawnImpl,
        requestId: ctx.requestId,
        chatSessionId: ctx.chatSessionId,
      });
    },
    async steerTurn(ctx) {
      return pi.steerPiTurn({
        requestId: ctx.requestId,
        chatSessionId: ctx.chatSessionId,
        prompt: ctx.prompt,
        attachments: ctx.attachments,
      });
    },
    async listModels(ctx) {
      return pi.listPiModels({
        env: ctx.env,
        binPath: ctx.binPath,
        cwd: ctx.cwd,
        abortController: ctx.abortController,
        signal: ctx.signal,
        spawnImpl: ctx.spawnImpl,
      });
    },
  },
};

function getDriver(backend) {
  const driver = DRIVER_REGISTRY[backend];
  if (!driver) throw new Error(`No SDK driver registered for backend: ${backend}`);
  return driver;
}

function listBackends() {
  return Object.keys(DRIVER_REGISTRY);
}

module.exports = {
  DRIVER_REGISTRY,
  getDriver,
  listBackends,
};
