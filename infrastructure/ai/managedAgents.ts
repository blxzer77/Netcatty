import type { DiscoveredAgent, ExternalAgentConfig } from './types';
import { getCommandBasename, isPathLikeCommand } from './shared/pathLikeCommand';

export { isPathLikeCommand, getCommandBasename };

export type ManagedAgentKey = 'codex' | 'claude' | 'copilot' | 'cursor' | 'codebuddy' | 'opencode' | 'grok' | 'mimo' | 'pi';

const MANAGED_AGENT_META: Record<ManagedAgentKey, { commandNames: string[]; sdkBackend: string }> = {
  codex: { commandNames: ['codex'], sdkBackend: 'codex' },
  claude: { commandNames: ['claude'], sdkBackend: 'claude' },
  copilot: { commandNames: ['copilot'], sdkBackend: 'copilot' },
  cursor: { commandNames: ['cursor'], sdkBackend: 'cursor' },
  codebuddy: { commandNames: ['codebuddy'], sdkBackend: 'codebuddy' },
  opencode: { commandNames: ['opencode'], sdkBackend: 'opencode' },
  grok: { commandNames: ['grok'], sdkBackend: 'grok' },
  mimo: { commandNames: ['mimo'], sdkBackend: 'mimo' },
  pi: { commandNames: ['pi'], sdkBackend: 'pi' },
};

function matchesPrimaryCliBasename(command: string | undefined, agentKey: ManagedAgentKey): boolean {
  const basename = getCommandBasename(command);
  return basename === agentKey || basename.startsWith(`${agentKey}.`);
}

export function isSettingsManagedDiscoveredAgent(
  agent: Pick<DiscoveredAgent, 'command'>,
): agent is Pick<DiscoveredAgent, 'command'> & { command: ManagedAgentKey } {
  return agent.command === 'codex'
    || agent.command === 'claude'
    || agent.command === 'copilot'
    || agent.command === 'cursor'
    || agent.command === 'codebuddy'
    || agent.command === 'opencode'
    || agent.command === 'grok'
    || agent.command === 'mimo'
    || agent.command === 'pi';
}

export function matchesManagedAgentConfig(
  agent: Pick<ExternalAgentConfig, 'id' | 'command' | 'sdkBackend' | 'acpCommand'>,
  agentKey: ManagedAgentKey,
): boolean {
  const meta = MANAGED_AGENT_META[agentKey];
  const basename = getCommandBasename(agent.command);
  if (agentKey === 'claude') {
    return (
      agent.id === 'discovered_claude' ||
      basename === 'claude' ||
      basename.startsWith('claude.')
    );
  }
  return (
    agent.id === `discovered_${agentKey}` ||
    getExternalAgentSdkBackend(agent) === meta.sdkBackend ||
    meta.commandNames.some((commandName) => basename === commandName || basename.startsWith(`${commandName}.`))
  );
}

export function getExternalAgentSdkBackend(
  agent: Pick<ExternalAgentConfig, 'sdkBackend' | 'acpCommand'> | undefined,
): string | undefined {
  return agent?.sdkBackend || agent?.acpCommand || undefined;
}

/**
 * Netcatty's Pi-only product surface accepts only the Pi managed agent.
 * Keep this predicate in the shared managed-agent layer so stale configs from
 * older builds cannot leak into selectors or default-agent settings.
 */
export function isPiAgentConfig(
  agent: Pick<ExternalAgentConfig, 'id' | 'command' | 'sdkBackend'> | undefined,
): boolean {
  if (!agent) return false;
  if (agent.id === 'discovered_pi' || agent.sdkBackend === 'pi') return true;
  const basename = getCommandBasename(agent.command);
  return basename === 'pi' || basename.startsWith('pi.');
}

export function filterSupportedExternalAgents(
  agents: ExternalAgentConfig[],
): ExternalAgentConfig[] {
  return agents.filter((agent) => isPiAgentConfig(agent));
}

export function getManagedAgentStoredPath(
  agents: ExternalAgentConfig[],
  agentKey: ManagedAgentKey,
): string | null {
  const managedId = `discovered_${agentKey}`;
  const preferredAgent = agents.find(
    (agent) =>
      agent.id === managedId &&
      isPathLikeCommand(agent.command) &&
      matchesPrimaryCliBasename(agent.command, agentKey),
  );
  if (preferredAgent) {
    return preferredAgent.command;
  }

  const fallbackAgent = agents.find(
    (agent) =>
      matchesManagedAgentConfig(agent, agentKey) &&
      isPathLikeCommand(agent.command) &&
      matchesPrimaryCliBasename(agent.command, agentKey),
  );
  return fallbackAgent?.command ?? null;
}

export function getManualAgentCommand(
  config: Pick<ExternalAgentConfig, 'command' | 'commandSource'> | null | undefined,
): string | undefined {
  const command = String(config?.command || '').trim();
  return config?.commandSource === 'manual' && command ? command : undefined;
}
