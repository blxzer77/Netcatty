/**
 * Settings AI Tab - AI provider configuration, agent CLI detection, and safety settings
 *
 * Sub-components live in ./ai/ directory:
 *   - ProviderCard, ProviderConfigForm, AddProviderDropdown
 *   - ModelSelector
 *   - SafetySettings
 */
import { AlertTriangle, Bot, FolderOpen, RefreshCcw } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AIPermissionMode,
  AIProviderId,
  AIToolIntegrationMode,
  ExternalAgentConfig,
  ProviderConfig,
  WebSearchConfig,
} from "../../../infrastructure/ai/types";
import type { ManagedAgentKey } from "../../../infrastructure/ai/managedAgents";
import { PROVIDER_PRESETS } from "../../../infrastructure/ai/types";
import { useI18n } from "../../../application/i18n/I18nProvider";
import { Button } from "../../ui/button";
import { ConfirmDialog } from "../../ui/confirm-dialog";
import { Select, SettingCard, SettingsAnchor, SettingsSection, SettingsTabContent, SettingRow, Toggle } from "../settings-ui";
import { useOptionalSettingsFocus } from "../SettingsFocusContext";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui/tabs";
import { AgentIconBadge } from "../../ai/AgentIconBadge";
import { canSendWithAgent } from "../../ai/agentSendEligibility";
import { notifyUserSkillsStatusChanged } from "../../ai/userSkillsStatusEvents";

import type {
  AgentPathInfo,
  UserSkillsStatusResult,
} from "./ai/types";
import {
  getBridge,
} from "./ai/types";
import { ProviderCard } from "./ai/ProviderCard";
import { AddProviderDropdown } from "./ai/AddProviderDropdown";
import { CopilotCliCard } from "./ai/CopilotCliCard";
import { SafetySettings } from "./ai/SafetySettings";
import { ExternalMcpCard } from "./ai/ExternalMcpCard";
import { ToolAccessGuidance } from "./ai/ToolAccessGuidance";
import { PermissionGrantsSettings } from "./ai/PermissionGrantsSettings";
import { useAIPermissionGrantsState } from "../../../application/state/useAIPermissionGrantsState";
import { WebSearchSettings } from "./ai/WebSearchSettings";
import { QuickMessagesSettings } from "./ai/QuickMessagesSettings";
import type { AIQuickMessage } from "../../../infrastructure/ai/quickMessages";
import {
  areExternalAgentListsEqual,
  buildManagedAgentState,
  filterSupportedManagedAgents,
  getInitialManagedAgentPaths,
} from "./ai/managedAgentState";

type IdleWindow = Window & {
  requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
  cancelIdleCallback?: (handle: number) => void;
};

function scheduleAfterFirstPaint(callback: () => void, delayMs = 0): () => void {
  let cancelled = false;
  let idleHandle: number | null = null;
  const timeoutHandle = window.setTimeout(() => {
    if (cancelled) return;
    const idleWindow = window as IdleWindow;
    if (typeof idleWindow.requestIdleCallback === "function") {
      idleHandle = idleWindow.requestIdleCallback(() => {
        if (!cancelled) callback();
      }, { timeout: 1200 });
      return;
    }
    callback();
  }, delayMs);

  return () => {
    cancelled = true;
    window.clearTimeout(timeoutHandle);
    if (idleHandle !== null) {
      (window as IdleWindow).cancelIdleCallback?.(idleHandle);
    }
  };
}

type AISettingsSubTab = "providers" | "agents" | "tools" | "search" | "safety";

function getSavedManagedAgentPathInfo(
  agents: ExternalAgentConfig[],
  agentKey: ManagedAgentKey,
): AgentPathInfo | null {
  const managed = agents.find((agent) => agent.id === `discovered_${agentKey}`);
  const command = typeof managed?.command === "string" ? managed.command.trim() : "";
  if (!managed || !command) return null;
  const savedAvailable = managed.available === true || managed.enabled === true;

  return {
    path: command,
    binPath: command,
    version: managed.cliVersion ?? null,
    available: savedAvailable,
    installed: true,
    authenticated: undefined,
    authSource: null,
  };
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface SettingsAITabProps {
  providers: ProviderConfig[];
  addProvider: (provider: ProviderConfig) => void;
  updateProvider: (id: string, updates: Partial<ProviderConfig>) => void;
  removeProvider: (id: string) => void;
  activeProviderId: string;
  setActiveProviderId: (id: string) => void;
  activeModelId: string;
  setActiveModelId: (id: string) => void;
  globalPermissionMode: AIPermissionMode;
  setGlobalPermissionMode: (mode: AIPermissionMode) => void;
  toolIntegrationMode: AIToolIntegrationMode;
  setToolIntegrationMode: (mode: AIToolIntegrationMode) => void;
  externalAgents: ExternalAgentConfig[];
  setExternalAgents: (value: ExternalAgentConfig[] | ((prev: ExternalAgentConfig[]) => ExternalAgentConfig[])) => void;
  defaultAgentId: string;
  setDefaultAgentId: (id: string) => void;
  commandBlocklist: string[];
  setCommandBlocklist: (value: string[]) => void;
  commandTimeout: number;
  setCommandTimeout: (value: number) => void;
  responseIdleTimeout: number;
  setResponseIdleTimeout: (value: number) => void;
  maxIterations: number;
  setMaxIterations: (value: number) => void;
  webSearchConfig: WebSearchConfig | null;
  setWebSearchConfig: (config: WebSearchConfig | null) => void;
  quickMessages: AIQuickMessage[];
  setQuickMessages: (value: AIQuickMessage[] | ((prev: AIQuickMessage[]) => AIQuickMessage[])) => void;
  showTerminalSelectionAIAction: boolean;
  setShowTerminalSelectionAIAction: (value: boolean | ((prev: boolean) => boolean)) => void;
}

// ---------------------------------------------------------------------------
// Main Tab Component
// ---------------------------------------------------------------------------

const SettingsAITab: React.FC<SettingsAITabProps> = ({
  providers,
  addProvider,
  updateProvider,
  removeProvider,
  activeProviderId,
  setActiveProviderId,
  activeModelId: _activeModelId,
  setActiveModelId,
  globalPermissionMode,
  setGlobalPermissionMode,
  toolIntegrationMode,
  setToolIntegrationMode,
  externalAgents,
  setExternalAgents,
  defaultAgentId,
  setDefaultAgentId,
  commandBlocklist,
  setCommandBlocklist,
  commandTimeout,
  setCommandTimeout,
  responseIdleTimeout,
  setResponseIdleTimeout,
  maxIterations,
  setMaxIterations,
  webSearchConfig,
  setWebSearchConfig,
  quickMessages,
  setQuickMessages,
  showTerminalSelectionAIAction,
  setShowTerminalSelectionAIAction,
}) => {
  const {
    permissionGrants,
    addGrant,
    updateGrant,
    removeGrant,
    importGrants,
    exportGrants,
  } = useAIPermissionGrantsState();
  const { t } = useI18n();
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);
  const [removeProviderConfirm, setRemoveProviderConfirm] = useState<{ id: string; name: string } | null>(null);
  const initialManagedPathsRef = useRef<{ pi: string } | null>(null);
  if (!initialManagedPathsRef.current) {
    initialManagedPathsRef.current = getInitialManagedAgentPaths(externalAgents);
  }

  // Remove stale external-agent entries written by older Netcatty versions.
  useEffect(() => {
    const filtered = filterSupportedManagedAgents(externalAgents);
    if (filtered.length !== externalAgents.length) {
      setExternalAgents(filtered);
    }
  }, [externalAgents, setExternalAgents]);

  const [activeSubTab, setActiveSubTab] = useState<AISettingsSubTab>("providers");
  const settingsFocus = useOptionalSettingsFocus();

  const [piPathInfo, setPiPathInfo] = useState<AgentPathInfo | null>(
    () => getSavedManagedAgentPathInfo(externalAgents, "pi"),
  );
  const [piCustomPath, setPiCustomPath] = useState(() => initialManagedPathsRef.current?.pi ?? "");
  const [isResolvingPi, setIsResolvingPi] = useState(false);

  const [userSkillsStatus, setUserSkillsStatus] = useState<UserSkillsStatusResult | null>(null);
  const [isLoadingUserSkills, setIsLoadingUserSkills] = useState(false);

  // Ref to read current defaultAgentId without adding it as a dependency.
  const defaultAgentIdRef = useRef(defaultAgentId);
  defaultAgentIdRef.current = defaultAgentId;
  const autoResolvedAgentStateRef = useRef<Partial<Record<ManagedAgentKey, "pending" | "done">>>({});
  const userSkillsLoadedRef = useRef(false);
  const mountedRef = useRef(true);
  const agentPathRequestIdRef = useRef<Partial<Record<ManagedAgentKey, number>>>({});
  useEffect(() => {
    mountedRef.current = true;
    const agentPathRequestIds = agentPathRequestIdRef.current;
    return () => {
      mountedRef.current = false;
      agentPathRequestIds.pi = (agentPathRequestIds.pi ?? 0) + 1;
    };
  }, []);

  const applyResolvedAgentPath = useCallback((
    agentKey: ManagedAgentKey,
    result: AgentPathInfo | null,
    commandSource: "manual" | "auto" = "auto",
  ) => {
    setPiPathInfo(result);

    let nextDefaultId: string | null = null;
    setExternalAgents((prev) => {
      const state = buildManagedAgentState(prev, defaultAgentIdRef.current, agentKey, result, commandSource);
      if (state.defaultAgentId !== defaultAgentIdRef.current) {
        nextDefaultId = state.defaultAgentId;
        defaultAgentIdRef.current = state.defaultAgentId;
      }
      return areExternalAgentListsEqual(prev, state.agents) ? prev : state.agents;
    });
    if (nextDefaultId !== null) {
      setDefaultAgentId(nextDefaultId);
    }
  }, [setDefaultAgentId, setExternalAgents]);

  const resolveAgentPath = useCallback(async (
    agentKey: ManagedAgentKey,
    customPath = "",
    options?: {
      refreshShellEnv?: boolean;
      commandSource?: "manual" | "auto";
      removeUnavailableManualPath?: boolean;
    },
  ) => {
    const bridge = getBridge();
    if (!bridge?.aiResolveCli) return null;

    setIsResolvingPi(true);
    const requestId = (agentPathRequestIdRef.current[agentKey] ?? 0) + 1;
    agentPathRequestIdRef.current[agentKey] = requestId;
    const isCurrentRequest = () => (
      mountedRef.current
      && agentPathRequestIdRef.current[agentKey] === requestId
    );
    try {
      const result = await bridge.aiResolveCli({
        command: agentKey,
        customPath: customPath.trim(),
        refreshShellEnv: Boolean(options?.refreshShellEnv),
      });
      if (!isCurrentRequest()) return null;
      if (
        options?.commandSource === "manual"
        && customPath.trim()
        && !result?.available
        && !options.removeUnavailableManualPath
      ) {
        setPiPathInfo(result);
        return result;
      }
      applyResolvedAgentPath(agentKey, result, options?.commandSource ?? "auto");

      return result;
    } catch (err) {
      console.error("Path resolution failed:", err);
      return null;
    } finally {
      if (isCurrentRequest()) {
        setIsResolvingPi(false);
      }
    }
  }, [applyResolvedAgentPath]);

  useEffect(() => {
    if (activeSubTab !== "agents") return;

    const initialPaths = initialManagedPathsRef.current;
    const tasks: Array<{ key: ManagedAgentKey; delayMs: number; path: string }> = [
      { key: "pi", delayMs: 240, path: initialPaths?.pi ?? "" },
    ];
    const cancelTasks = tasks
      .filter((task) => !autoResolvedAgentStateRef.current[task.key])
      .map((task) => scheduleAfterFirstPaint(() => {
        autoResolvedAgentStateRef.current[task.key] = "pending";
        void resolveAgentPath(task.key, task.path, {
          commandSource: task.path ? "manual" : "auto",
          removeUnavailableManualPath: Boolean(task.path),
        }).finally(() => {
          autoResolvedAgentStateRef.current[task.key] = "done";
        });
      }, task.delayMs));
    return () => {
      for (const cancel of cancelTasks) cancel();
    };
  }, [activeSubTab, resolveAgentPath]);

  // Add a new provider from preset
  const handleAddProvider = useCallback(
    (providerId: AIProviderId) => {
      const preset = PROVIDER_PRESETS[providerId];
      const id = `provider_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      addProvider({
        id,
        providerId,
        name: preset.name,
        baseURL: preset.defaultBaseURL,
        enabled: false,
      });
      // Auto-open config form
      setEditingProviderId(id);
    },
    [addProvider],
  );

  // Remove provider with confirmation
  const handleRemoveProvider = useCallback(
    (id: string) => {
      const provider = providers.find((p) => p.id === id);
      const name = provider?.name || id;
      setRemoveProviderConfirm({ id, name });
    },
    [providers],
  );

  const handleConfirmRemoveProvider = useCallback(
    () => {
      if (!removeProviderConfirm) return;
      const { id } = removeProviderConfirm;
      removeProvider(id);
      if (editingProviderId === id) {
        setEditingProviderId(null);
      }
      setRemoveProviderConfirm(null);
    },
    [removeProvider, editingProviderId, removeProviderConfirm],
  );

  // Agent options for default agent
  const agentOptions = useMemo(() => [
    { value: "catty", label: t('ai.defaultAgent.catty'), icon: <AgentIconBadge agent={{ id: "catty", type: "builtin" }} size="xs" variant="plain" /> },
    ...externalAgents
      .filter((a) => (a.id === "discovered_pi" || a.sdkBackend === "pi") && canSendWithAgent(a.id, externalAgents))
      .map((a) => ({ value: a.id, label: a.name, icon: <AgentIconBadge agent={a} size="xs" variant="plain" /> })),
  ], [externalAgents, t]);

  useEffect(() => {
    if (!agentOptions.some((option) => option.value === defaultAgentId)) {
      setDefaultAgentId("catty");
    }
  }, [agentOptions, defaultAgentId, setDefaultAgentId]);

  useEffect(() => {
    const bridge = getBridge();
    if (!bridge?.aiPrewarmShellEnv) return;
    return scheduleAfterFirstPaint(() => {
      void bridge.aiPrewarmShellEnv?.();
    }, 900);
  }, []);

  // Validate a custom path for an agent.
  const handleCheckCustomPath = useCallback(async (agentKey: ManagedAgentKey) => {
    const customPath = agentKey === "pi" ? piCustomPath : "";
    await resolveAgentPath(agentKey, customPath, {
      refreshShellEnv: true,
      commandSource: customPath.trim() ? "manual" : "auto",
    });
  }, [piCustomPath, resolveAgentPath]);

  const handleResetCustomPath = useCallback(async (agentKey: ManagedAgentKey) => {
    if (agentKey === "pi") setPiCustomPath("");

    await resolveAgentPath(agentKey, "", {
      refreshShellEnv: true,
      commandSource: "auto",
    });
  }, [resolveAgentPath]);

  const refreshUserSkillsStatus = useCallback(async () => {
    const bridge = getBridge();
    if (!bridge?.aiUserSkillsGetStatus) {
      setUserSkillsStatus({
        ok: false,
        error: t('ai.userSkills.unavailable'),
      });
      return;
    }

    setIsLoadingUserSkills(true);
    try {
      const result = await bridge.aiUserSkillsGetStatus();
      setUserSkillsStatus(result);
      notifyUserSkillsStatusChanged();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setUserSkillsStatus({ ok: false, error: message });
    } finally {
      setIsLoadingUserSkills(false);
    }
  }, [t]);

  useEffect(() => {
    const request = settingsFocus?.request;
    if (request?.tab === "ai" && request.aiSubTab) {
      setActiveSubTab(request.aiSubTab as AISettingsSubTab);
    }
  }, [settingsFocus?.request]);

  useEffect(() => {
    if (activeSubTab !== "tools") return;
    if (userSkillsLoadedRef.current) return;
    return scheduleAfterFirstPaint(() => {
      userSkillsLoadedRef.current = true;
      void refreshUserSkillsStatus();
    }, 520);
  }, [activeSubTab, refreshUserSkillsStatus]);

  const reservedUserSkillSlugs = useMemo(
    () => (userSkillsStatus?.ok && userSkillsStatus.skills
      ? userSkillsStatus.skills
          .filter((skill) => skill.status === 'ready' && typeof skill.slug === 'string' && skill.slug.length > 0)
          .map((skill) => skill.slug)
      : []),
    [userSkillsStatus],
  );

  const handleOpenUserSkillsFolder = useCallback(async () => {
    const bridge = getBridge();
    if (!bridge?.aiUserSkillsOpenFolder) return;

    setIsLoadingUserSkills(true);
    try {
      const result = await bridge.aiUserSkillsOpenFolder();
      setUserSkillsStatus(result);
      notifyUserSkillsStatusChanged();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setUserSkillsStatus({ ok: false, error: message });
    } finally {
      setIsLoadingUserSkills(false);
    }
  }, []);

  return (
    <SettingsTabContent value="ai">
      <Tabs value={activeSubTab} onValueChange={(value) => setActiveSubTab(value as AISettingsSubTab)} className="space-y-5">
        <TabsList className="h-auto flex-wrap justify-start bg-muted/50">
          <TabsTrigger value="providers">{t('ai.providers')}</TabsTrigger>
          <TabsTrigger value="agents">{t('ai.agents')}</TabsTrigger>
          <TabsTrigger value="tools">{t('ai.toolAccess.title')}</TabsTrigger>
          <TabsTrigger value="search">{t("ai.webSearch.title")}</TabsTrigger>
          <TabsTrigger value="safety">{t('ai.safety.title')}</TabsTrigger>
        </TabsList>

        <TabsContent value="providers" className="m-0 space-y-6">
          <SettingsSection
            anchorId="ai-providers"
            title={t('ai.providers')}
            actions={<AddProviderDropdown onAdd={handleAddProvider} />}
          >
            {providers.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border/60 p-6 text-center">
                <Bot size={24} className="mx-auto text-muted-foreground mb-2" />
                <p className="text-sm text-muted-foreground">
                  {t('ai.providers.empty')}
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {providers.map((provider) => (
                  <ProviderCard
                    key={provider.id}
                    provider={provider}
                    isActive={provider.id === activeProviderId}
                    onToggleEnabled={(enabled) => {
                      if (enabled) {
                        setActiveProviderId(provider.id);
                        if (provider.defaultModel) {
                          setActiveModelId(provider.defaultModel);
                        }
                        for (const p of providers) {
                          if (p.id === provider.id) {
                            if (!p.enabled) updateProvider(p.id, { enabled: true });
                          } else if (p.enabled) {
                            updateProvider(p.id, { enabled: false });
                          }
                        }
                      } else {
                        if (activeProviderId === provider.id) {
                          setActiveProviderId("");
                          setActiveModelId("");
                        }
                        updateProvider(provider.id, { enabled: false });
                      }
                    }}
                    onEdit={() =>
                      setEditingProviderId(
                        editingProviderId === provider.id ? null : provider.id,
                      )
                    }
                    onRemove={() => handleRemoveProvider(provider.id)}
                    onUpdate={(updates) => {
                      updateProvider(provider.id, updates);
                      if (provider.id === activeProviderId && updates.defaultModel !== undefined) {
                        setActiveModelId(updates.defaultModel || "");
                      }
                    }}
                    isEditing={editingProviderId === provider.id}
                    onCancelEdit={() => setEditingProviderId(null)}
                  />
                ))}
              </div>
            )}
          </SettingsSection>
        </TabsContent>

        <TabsContent value="agents" className="m-0 space-y-6">
          <SettingsSection
            title={t('ai.pi.title')}
            leading={<AgentIconBadge agent={{ id: "pi", icon: "terminal", name: "Pi" }} variant="plain" className="h-5 w-5 text-muted-foreground/90" />}
          >
            <CopilotCliCard
              pathInfo={piPathInfo}
              isResolvingPath={isResolvingPi}
              customPath={piCustomPath}
              onCustomPathChange={setPiCustomPath}
              onRecheckPath={() => void handleCheckCustomPath("pi")}
              onResetPath={() => void handleResetCustomPath("pi")}
              i18nPrefix="ai.pi"
            />
          </SettingsSection>

          {agentOptions.length > 1 ? (
            <SettingsSection anchorId="ai-default-agent" title={t('ai.defaultAgent')}>
              <SettingCard>
                <SettingRow description={t('ai.defaultAgent.description')}>
                  <Select
                    value={defaultAgentId}
                    options={agentOptions}
                    onChange={setDefaultAgentId}
                    className="w-64"
                  />
                </SettingRow>
              </SettingCard>
            </SettingsSection>
          ) : (
            <SettingsAnchor anchorId="ai-default-agent" />
          )}
        </TabsContent>

        <TabsContent value="tools" className="m-0 space-y-6">
          <SettingsSection title={t('ai.chatShortcuts.title')}>
            <SettingCard divided>
              <SettingRow
                anchorId="ai-chat-shortcuts-selection"
                label={t('ai.chatShortcuts.selectionAction')}
                description={t('ai.chatShortcuts.selectionAction.description')}
              >
                <Toggle
                  checked={showTerminalSelectionAIAction}
                  onChange={setShowTerminalSelectionAIAction}
                  ariaLabel={t('ai.chatShortcuts.selectionAction')}
                />
              </SettingRow>
            </SettingCard>
          </SettingsSection>

          <SettingsSection
            anchorId="ai-tool-access-mode"
            title={t('ai.toolAccess.title')}
          >
            <SettingCard>
              <SettingRow description={t('ai.toolAccess.description')}>
                <Select
                  value={toolIntegrationMode}
                  options={[
                    { value: 'mcp', label: t('ai.toolAccess.mode.mcp') },
                    { value: 'skills', label: t('ai.toolAccess.mode.skills') },
                  ]}
                  onChange={(value) => setToolIntegrationMode(value as AIToolIntegrationMode)}
                  className="w-48"
                />
              </SettingRow>
              <div className="pb-4">
                <ToolAccessGuidance mode={toolIntegrationMode} />
              </div>
            </SettingCard>
          </SettingsSection>

          <SettingsSection anchorId="ai-external-mcp" title={t('ai.externalMcp.title')}>
            <ExternalMcpCard />
          </SettingsSection>

          <SettingsSection
            anchorId="ai-user-skills"
            title={t('ai.userSkills.title')}
            actions={(
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void refreshUserSkillsStatus()}
                  disabled={isLoadingUserSkills}
                >
                  <RefreshCcw size={14} className="mr-2" />
                  {t('ai.userSkills.reload')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleOpenUserSkillsFolder()}
                  disabled={isLoadingUserSkills}
                >
                  <FolderOpen size={14} className="mr-2" />
                  {t('ai.userSkills.openFolder')}
                </Button>
              </>
            )}
          >
            <SettingCard padded className="space-y-3">
              <div className="space-y-1.5">
                <p className="text-xs text-muted-foreground/80 leading-5">
                  {t('ai.userSkills.description')}
                </p>
                {userSkillsStatus?.directoryPath ? (
                  <p className="text-xs text-muted-foreground/80">
                    {t('ai.userSkills.location')}:{" "}
                    <span className="font-mono">{userSkillsStatus.directoryPath}</span>
                  </p>
                ) : null}
              </div>

              <div className="text-xs text-muted-foreground/80">
                {isLoadingUserSkills
                  ? t('ai.userSkills.loading')
                  : userSkillsStatus?.ok
                    ? t('ai.userSkills.summary', {
                        ready: String(userSkillsStatus.readyCount ?? 0),
                        warnings: String(userSkillsStatus.warningCount ?? 0),
                      })
                    : userSkillsStatus?.error || t('ai.userSkills.unavailable')}
              </div>

              {userSkillsStatus?.ok && userSkillsStatus.skills && userSkillsStatus.skills.length > 0 ? (
                <div className="border-t border-border/60 divide-y divide-border/60">
                  {userSkillsStatus.skills.map((skill) => (
                    <div key={skill.id} className="py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 space-y-1">
                          <div className="text-sm font-medium">{skill.name}</div>
                          <div className="text-xs text-muted-foreground leading-5">{skill.description}</div>
                          <div className="text-xs text-muted-foreground/80 font-mono break-all">
                            {skill.directoryName}
                          </div>
                        </div>
                        <span
                          className={
                            skill.status === "ready"
                              ? "text-xs font-medium text-emerald-500 shrink-0"
                              : "text-xs font-medium text-amber-500 shrink-0"
                          }
                        >
                          {skill.status === "ready"
                            ? t('ai.userSkills.status.ready')
                            : t('ai.userSkills.status.warning')}
                        </span>
                      </div>
                      {skill.warnings.length > 0 ? (
                        <div className="mt-2 space-y-1 text-xs text-amber-500">
                          {skill.warnings.map((warning, index) => (
                            <div key={`${skill.id}-${index}`} className="flex items-start gap-2">
                              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                              <span>{warning}</span>
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : userSkillsStatus?.ok ? (
                <div className="border-t border-border/60 pt-3 text-sm text-muted-foreground">
                  {t('ai.userSkills.empty')}
                </div>
              ) : null}
            </SettingCard>
          </SettingsSection>

          <QuickMessagesSettings
            quickMessages={quickMessages}
            setQuickMessages={setQuickMessages}
            reservedUserSkillSlugs={reservedUserSkillSlugs}
          />
        </TabsContent>

        <TabsContent value="search" className="m-0 space-y-6">
          <WebSearchSettings
            webSearchConfig={webSearchConfig}
            setWebSearchConfig={setWebSearchConfig}
          />
        </TabsContent>

        <TabsContent value="safety" className="m-0 space-y-6">
          <SafetySettings
            globalPermissionMode={globalPermissionMode}
            setGlobalPermissionMode={setGlobalPermissionMode}
            commandBlocklist={commandBlocklist}
            setCommandBlocklist={setCommandBlocklist}
            commandTimeout={commandTimeout}
            setCommandTimeout={setCommandTimeout}
            responseIdleTimeout={responseIdleTimeout}
            setResponseIdleTimeout={setResponseIdleTimeout}
            maxIterations={maxIterations}
            setMaxIterations={setMaxIterations}
          />
          <PermissionGrantsSettings
            grants={permissionGrants}
            addGrant={addGrant}
            updateGrant={updateGrant}
            removeGrant={removeGrant}
            importGrants={importGrants}
            exportGrants={exportGrants}
          />
        </TabsContent>
      </Tabs>
      <ConfirmDialog
        open={removeProviderConfirm !== null}
        title={removeProviderConfirm ? t('confirm.removeProvider', { name: removeProviderConfirm.name }) : ''}
        confirmLabel={t('action.remove')}
        destructive
        onOpenChange={(open) => {
          if (!open) setRemoveProviderConfirm(null);
        }}
        onConfirm={handleConfirmRemoveProvider}
      />
    </SettingsTabContent>
  );
};

export default SettingsAITab;
