import type {
  TerminalContextReader,
} from '../../../domain/terminalContextRead';

/**
 * Bridge and scope types for the Catty agent.
 *
 * Catty tools are generated from the capability catalog
 * (`createCattyToolsFromCatalog`), which owns execution, session serialization,
 * write deduplication, and output fitting. There is no per-tool switch here:
 * the legacy `createToolExecutor` that used to live in this file only knew five
 * tool names and had no callers left, so it was removed.
 */

/**
 * Bridge interface for Catty Agent to interact with the Electron main process.
 * This mirrors the AI-related subset of window.netcatty from electron/preload.cjs.
 */
export interface NetcattyBridge {
  aiExec(
    sessionId: string,
    command: string,
    chatSessionId?: string,
    expectedTarget?: { hostId?: string; hostname?: string; protocol?: string },
  ): Promise<{
    ok: boolean;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    error?: string;
  }>;
  /**
   * Cancel any in-flight Catty Agent command execution scoped to the
   * given chat session. Idempotent — safe to call when nothing is
   * running. Used by tools to re-issue cancel during the IPC transit
   * window if the user clicks Stop after we've already dispatched
   * `aiExec` but before the main process has registered it.
   */
  aiCattyCancelExec?(chatSessionId: string): Promise<unknown>;
  aiSetChatSessionCancelled?(chatSessionId: string, cancelled?: boolean): Promise<{ ok: boolean; error?: string }>;
  aiCapability?(
    rpcMethod: string,
    params: Record<string, unknown>,
    chatSessionId?: string,
  ): Promise<unknown>;
}

// Workspace context provided to the executor
export interface ExecutorContext {
  // Available sessions in scope
  sessions: Array<{
    sessionId: string;
    hostId: string;
    hostname: string;
    label: string;
    os?: string;
    username?: string;
    protocol?: string;
    shellType?: string;
    deviceType?: string;
    connected: boolean;
  }>;
  // Workspace info
  workspaceId?: string;
  workspaceName?: string;
  readTerminalContext?: TerminalContextReader;
}
