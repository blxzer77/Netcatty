import type { ExternalAgentConfig } from "../../../../infrastructure/ai/types";
import {
  type ManagedAgentKey,
  filterSupportedExternalAgents,
  isPathLikeCommand,
} from "../../../../infrastructure/ai/managedAgents";
import type { AgentPathInfo } from "./types";
import { AGENT_DEFAULTS, isCursorAvailableForMode } from "./types";
import { buildCodebuddyEnv } from "./codebuddyConfigEnv";

// Kept only for migration code that can still receive a legacy persisted entry.
// These values are intentionally not exported or offered by the Pi-only settings UI.
const LEGACY_AGENT_DEFAULTS: Record<string, typeof AGENT_DEFAULTS.pi> = {
  codex: { name: "Codex CLI", args: ["exec", "--full-auto", "--json", "{prompt}"], icon: "openai", sdkBackend: "codex" },
  claude: { name: "Claude Code", args: ["-p", "--output-format", "text", "{prompt}"], icon: "claude", sdkBackend: "claude" },
  copilot: { name: "GitHub Copilot CLI", args: ["-p", "{prompt}"], icon: "copilot", sdkBackend: "copilot" },
  cursor: { name: "Cursor", args: ["{prompt}"], icon: "cursor", sdkBackend: "cursor" },
  codebuddy: { name: "CodeBuddy Code", args: [], icon: "codebuddy", sdkBackend: "codebuddy" },
  opencode: { name: "OpenCode", args: [], icon: "opencode", sdkBackend: "opencode" },
  grok: { name: "Grok Build", args: [], icon: "grok", sdkBackend: "grok" },
  mimo: { name: "MiMo Code", args: [], icon: "mimo", sdkBackend: "mimo" },
  pi: AGENT_DEFAULTS.pi,
};

function getAutoManagedAgentStoredPath(
  agents: ExternalAgentConfig[],
  agentKey: ManagedAgentKey,
): string | null {
  const managed = agents.find((agent) => agent.id === `discovered_${agentKey}`);
  if (managed?.commandSource === "auto") return null;
  return isPathLikeCommand(managed?.command) ? managed?.command ?? null : null;
}

export function areExternalAgentListsEqual(
  left: ExternalAgentConfig[],
  right: ExternalAgentConfig[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((agent, index) => JSON.stringify(agent) === JSON.stringify(right[index]));
}

export function buildManagedAgentState(
  prevAgents: ExternalAgentConfig[],
  defaultAgentId: string,
  agentKey: ManagedAgentKey,
  pathInfo: AgentPathInfo | null,
  commandSource: "manual" | "auto" = "auto",
): { agents: ExternalAgentConfig[]; defaultAgentId: string } {
  const managedId = `discovered_${agentKey}`;
  const managedAgents = prevAgents.filter((agent) => agent.id === managedId);
  const otherAgents = prevAgents.filter((agent) => agent.id !== managedId);

  if (!pathInfo?.available || !pathInfo.path) {
    const existingManaged = managedAgents.find((agent) => agent.id === managedId);
    if (agentKey === "cursor" && (existingManaged?.apiKey || existingManaged?.cursorAuthMode === "cli-login")) {
      const defaults = LEGACY_AGENT_DEFAULTS[agentKey];
      const {
        acpCommand: _legacyCommand,
        acpArgs: _legacyArgs,
        ...existingManagedWithoutLegacy
      } = existingManaged;
      return {
        agents: [
          ...otherAgents,
          {
            ...existingManagedWithoutLegacy,
            ...defaults,
            id: managedId,
            command: pathInfo?.path || existingManaged.command || "cursor",
            // Preserve enable preference when probe is temporarily unavailable
            // (e.g. wrong apiKeyPresent gating). Send requires available too.
            enabled: existingManaged.enabled ?? true,
            available: false,
            // Preserve stored API key across mode / temporary unavailability.
            ...(existingManaged.apiKey ? { apiKey: existingManaged.apiKey } : {}),
            cursorAuthMode: existingManaged.cursorAuthMode === "cli-login" ? "cli-login" : "api-key",
          },
        ],
        defaultAgentId: existingManaged.id === defaultAgentId ? "catty" : defaultAgentId,
      };
    }
    if (agentKey === "codebuddy") {
      const hasSavedCodebuddyConfig = Boolean(
        (existingManaged?.env && Object.keys(existingManaged.env).length > 0) ||
        (
          existingManaged?.codebuddyOptions &&
          Object.keys(existingManaged.codebuddyOptions).length > 0
        ),
      );
      if (hasSavedCodebuddyConfig) {
        return {
          agents: [
            ...otherAgents,
            {
              ...existingManaged,
              ...LEGACY_AGENT_DEFAULTS.codebuddy,
              id: managedId,
              command: existingManaged.command || "codebuddy",
              enabled: false,
              available: false,
            },
          ],
          defaultAgentId: existingManaged.id === defaultAgentId ? "catty" : defaultAgentId,
        };
      }
    }
    return {
      agents: otherAgents,
      defaultAgentId: managedAgents.some((agent) => agent.id === defaultAgentId)
        ? "catty"
        : defaultAgentId,
    };
  }

  const existingManaged = managedAgents.find((agent) => agent.id === managedId);
  const {
    acpCommand: _legacyCommand,
    acpArgs: _legacyArgs,
    ...existingManagedWithoutLegacy
  } = existingManaged ?? {};
  const defaults = LEGACY_AGENT_DEFAULTS[agentKey];
  const managedEnv =
    agentKey === "claude"
      ? { ...(existingManaged?.env ?? {}), CLAUDE_CODE_EXECUTABLE: pathInfo.path }
      : agentKey === "codebuddy"
        ? { ...(existingManaged?.env ?? {}), CODEBUDDY_CODE_PATH: pathInfo.path }
        : agentKey === "opencode"
          ? { ...(existingManaged?.env ?? {}), OPENCODE_BIN: pathInfo.path }
          : agentKey === "mimo"
            ? { ...(existingManaged?.env ?? {}), MIMOCODE_BIN: pathInfo.path }
            : existingManaged?.env;
  const cursorAuthMode = agentKey === "cursor"
    ? (existingManaged?.cursorAuthMode
      ?? (pathInfo.authSource === "cli-login" || pathInfo.cliLoginOk ? "cli-login" : "api-key"))
    : undefined;
  const cursorModeAvailable = agentKey === "cursor"
    ? isCursorAvailableForMode(pathInfo, cursorAuthMode === "cli-login" ? "cli-login" : "api-key", {
      hasStoredApiKey: Boolean(existingManaged?.apiKey),
    })
    : true;

  const nextManagedAgent: ExternalAgentConfig = {
    ...existingManagedWithoutLegacy,
    ...defaults,
    id: managedId,
    command: agentKey === "cursor" && cursorAuthMode === "cli-login"
      ? (pathInfo.cliBinPath || pathInfo.path)
      : pathInfo.path,
    commandSource,
    // Persist probed --version so the chat model picker can gate GPT-5.6+
    // even when this custom path is not the PATH discovery binary.
    ...(pathInfo.version ? { cliVersion: pathInfo.version } : {}),
    ...(managedEnv ? { env: managedEnv } : {}),
    available: cursorModeAvailable,
    // Do not force-disable when only the current auth mode is temporarily
    // unavailable (user may switch modes). Send paths already require available.
    enabled: managedAgents.length === 0
      || (agentKey === "codebuddy" && existingManaged && !isPathLikeCommand(existingManaged.command))
      ? true
      : managedAgents.some((agent) => agent.enabled) || managedAgents.every((agent) => agent.available === false),
    ...(agentKey === "cursor" ? {
      cursorAuthMode,
      // Keep stored API key in both modes; CLI turns omit it via env wiring.
      ...(existingManaged?.apiKey ? { apiKey: existingManaged.apiKey } : {}),
    } : {}),
  };

  return {
    agents: [...otherAgents, nextManagedAgent],
    defaultAgentId: managedAgents.some((agent) => agent.id === defaultAgentId)
      ? managedId
      : defaultAgentId,
  };
}

export function updateCodebuddyManagedEnv(
  prevAgents: ExternalAgentConfig[],
  internetEnv: string,
  envText: string,
): ExternalAgentConfig[] {
  const managedId = "discovered_codebuddy";
  const existingManaged = prevAgents.find((agent) => agent.id === managedId);
  const nextEnv = buildCodebuddyEnv(existingManaged?.env, internetEnv, envText);

  if (existingManaged) {
    if (!nextEnv && !isPathLikeCommand(existingManaged.command)) {
      return prevAgents.filter((agent) => agent.id !== managedId);
    }
    return prevAgents.map((agent) =>
      agent.id === managedId
        ? { ...agent, ...(nextEnv ? { env: nextEnv } : { env: undefined }) }
        : agent,
    );
  }

  if (!nextEnv) return prevAgents;

  return [
    ...prevAgents,
    {
      ...LEGACY_AGENT_DEFAULTS.codebuddy,
      id: managedId,
      command: "codebuddy",
      enabled: false,
      env: nextEnv,
    },
  ];
}

export function updateCodebuddyManagedOptions(
  prevAgents: ExternalAgentConfig[],
  options: ExternalAgentConfig['codebuddyOptions'],
): ExternalAgentConfig[] {
  const managedId = "discovered_codebuddy";
  const existingManaged = prevAgents.find((agent) => agent.id === managedId);

  if (existingManaged) {
    if (
      !options &&
      (!existingManaged.env || Object.keys(existingManaged.env).length === 0) &&
      !isPathLikeCommand(existingManaged.command)
    ) {
      return prevAgents.filter((agent) => agent.id !== managedId);
    }
    return prevAgents.map((agent) =>
      agent.id === managedId
        ? { ...agent, codebuddyOptions: options }
        : agent,
    );
  }

  if (!options) return prevAgents;

  return [
    ...prevAgents,
    {
      ...LEGACY_AGENT_DEFAULTS.codebuddy,
      id: managedId,
      command: "codebuddy",
      enabled: false,
      codebuddyOptions: options,
    },
  ];
}

export function getInitialManagedAgentPaths(agents: ExternalAgentConfig[]) {
  return {
    pi: getAutoManagedAgentStoredPath(agents, "pi") ?? "",
  };
}

/** Drop persisted external-agent entries that are outside the Pi-only product surface. */
export function filterSupportedManagedAgents(agents: ExternalAgentConfig[]): ExternalAgentConfig[] {
  return filterSupportedExternalAgents(agents);
}
