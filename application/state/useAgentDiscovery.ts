import { startTransition, useCallback, useEffect, useRef, useState } from 'react';
import type { DiscoveredAgent, ExternalAgentConfig } from '../../infrastructure/ai/types';
import { getExternalAgentSdkBackend, isPiAgentConfig } from '../../infrastructure/ai/managedAgents';

interface NetcattyBridge {
  aiDiscoverAgents(options?: { refreshShellEnv?: boolean }): Promise<DiscoveredAgent[]>;
}

function getBridge(): NetcattyBridge | undefined {
  return (window as unknown as { netcatty?: NetcattyBridge }).netcatty;
}

const AGENT_DISCOVERY_CACHE_TTL_MS = 60_000;
let agentDiscoveryCache: {
  agents: DiscoveredAgent[];
  updatedAt: number;
} | null = null;
const agentDiscoveryPromises = new Map<string, Promise<DiscoveredAgent[]>>();
let agentDiscoveryWriteGeneration = 0;

function isPiDiscoveredAgent(agent: DiscoveredAgent): boolean {
  return isPiAgentConfig({
    id: `discovered_${agent.command}`,
    command: agent.command,
    sdkBackend: agent.sdkBackend,
  });
}

function filterPiDiscoveredAgents(agents: DiscoveredAgent[]): DiscoveredAgent[] {
  return agents.filter(isPiDiscoveredAgent);
}

export function useAgentDiscovery(
  externalAgents: ExternalAgentConfig[],
  setExternalAgents?: (value: ExternalAgentConfig[] | ((prev: ExternalAgentConfig[]) => ExternalAgentConfig[])) => void,
  options?: {
    enabled?: boolean;
    schedule?: (task: () => void) => () => void;
  },
) {
  const enabled = options?.enabled ?? true;
  const schedule = options?.schedule;
  const [discoveredAgents, setDiscoveredAgents] = useState<DiscoveredAgent[]>(
    () => filterPiDiscoveredAgents(agentDiscoveryCache?.agents ?? []),
  );
  const [isDiscovering, setIsDiscovering] = useState(false);
  const discoverSeqRef = useRef(0);
  const mountedRef = useRef(true);
  const enabledRef = useRef(enabled);

  enabledRef.current = enabled;

  useEffect(() => () => {
    mountedRef.current = false;
    discoverSeqRef.current += 1;
  }, []);

  const discover = useCallback(async (discoverOptions?: { refreshShellEnv?: boolean }) => {
    if (!enabledRef.current) return;
    const bridge = getBridge();
    if (!bridge) return;

    const forceRefresh = discoverOptions?.refreshShellEnv === true;
    const cacheFresh =
      agentDiscoveryCache
      && Date.now() - agentDiscoveryCache.updatedAt < AGENT_DISCOVERY_CACHE_TTL_MS;

    if (!forceRefresh && cacheFresh) {
      startTransition(() => setDiscoveredAgents(filterPiDiscoveredAgents(agentDiscoveryCache?.agents ?? [])));
      return;
    }

    setIsDiscovering(true);
    const discoverSeq = ++discoverSeqRef.current;
    const writeGeneration = ++agentDiscoveryWriteGeneration;
    const promiseKey = JSON.stringify({ refreshShellEnv: forceRefresh });
    try {
      let discoveryPromise = agentDiscoveryPromises.get(promiseKey) ?? null;
      if (!discoveryPromise) {
        const sharedPromise = bridge.aiDiscoverAgents({
          ...discoverOptions,
        }).then(filterPiDiscoveredAgents).finally(() => {
          if (agentDiscoveryPromises.get(promiseKey) === sharedPromise) {
            agentDiscoveryPromises.delete(promiseKey);
          }
        });
        agentDiscoveryPromises.set(promiseKey, sharedPromise);
        discoveryPromise = sharedPromise;
      }
      const agents = await discoveryPromise;
      if (
        !mountedRef.current
        || !enabledRef.current
        || discoverSeq !== discoverSeqRef.current
        || writeGeneration !== agentDiscoveryWriteGeneration
      ) return;
      const supportedAgents = filterPiDiscoveredAgents(agents);
      agentDiscoveryCache = { agents: supportedAgents, updatedAt: Date.now() };
      startTransition(() => setDiscoveredAgents(supportedAgents));
    } catch (err) {
      console.error('Agent discovery failed:', err);
    } finally {
      if (mountedRef.current && discoverSeq === discoverSeqRef.current) {
        setIsDiscovering(false);
      }
    }
  }, []);

  useEffect(() => {
    discoverSeqRef.current += 1;
    if (!enabled) {
      setIsDiscovering(false);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    const runDiscover = () => {
      if (!cancelled) void discover();
    };

    if (schedule) {
      const cancel = schedule(runDiscover);
      return () => {
        cancelled = true;
        cancel();
      };
    }

    if (typeof requestIdleCallback === 'function') {
      const idleId = requestIdleCallback(runDiscover);
      return () => {
        cancelled = true;
        cancelIdleCallback(idleId);
      };
    }

    const timeoutId = setTimeout(runDiscover, 0);
    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [discover, enabled, schedule]);

  // Auto-update args for already-configured discovered agents when
  // the canonical args from discovery change (e.g. after an app update).
  useEffect(() => {
    if (!setExternalAgents || discoveredAgents.length === 0) return;
    if (!enabled) return;

    setExternalAgents((prev) => {
      let changed = false;
      const next = prev.map((ea) => {
        if (!isPiAgentConfig(ea)) return ea;
        // Only update agents that were auto-discovered (id starts with "discovered_")
        if (!ea.id.startsWith('discovered_')) return ea;

        const match = discoveredAgents.find(
          (da) => ea.command === da.path || ea.command === da.command,
        );
        if (!match) return ea;

        // Check if args, SDK backend, or managed SDK path env differ.
        const currentArgs = JSON.stringify(ea.args || []);
        const newArgs = JSON.stringify(match.args);
        const backend = match.sdkBackend ?? match.command;
        const backendChanged = getExternalAgentSdkBackend(ea) !== backend
          || Boolean(ea.acpCommand)
          || JSON.stringify(ea.acpArgs || []) !== JSON.stringify([]);
        const env = ea.env;
        const versionChanged = Boolean(match.version) && ea.cliVersion !== match.version;
        if (currentArgs !== newArgs || backendChanged || versionChanged) {
          changed = true;
          const { acpCommand: _legacyCommand, acpArgs: _legacyArgs, ...rest } = ea;
          return {
            ...rest,
            args: match.args,
            sdkBackend: backend,
            ...(match.version ? { cliVersion: match.version } : {}),
            ...(env ? { env } : {}),
          };
        }
        return ea;
      });
      return changed ? next : prev;
    });
  }, [discoveredAgents, enabled, setExternalAgents]);

  // Filter out agents that are already configured as external agents
  const unconfiguredAgents = discoveredAgents.filter(
    (da) => isPiDiscoveredAgent(da) && !externalAgents.some(
      (ea) => isPiAgentConfig(ea)
        && (ea.command === da.command || ea.command === da.path || ea.id === `discovered_${da.command}`),
    ),
  );

  // Build ExternalAgentConfig from a discovered agent
  const enableAgent = useCallback(
    (agent: DiscoveredAgent): ExternalAgentConfig => {
      const backend = agent.sdkBackend ?? agent.command;
      return {
        id: `discovered_${agent.command}`,
        name: agent.name,
        command: agent.binPath || agent.path || agent.command,
        args: agent.args,
        icon: agent.icon,
        enabled: true,
        available: agent.available,
        sdkBackend: backend,
        commandSource: 'auto',
        ...(agent.version ? { cliVersion: agent.version } : {}),
        // Pi resolves its executable directly and does not need a managed env var.
      };
    },
    [],
  );

  return {
    discoveredAgents,
    unconfiguredAgents,
    isDiscovering,
    rediscover: () => discover({ refreshShellEnv: true }),
    enableAgent,
  };
}
