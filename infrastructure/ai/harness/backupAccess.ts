import type { PlanStep } from './types';

/**
 * Backup-access preconditions for work that could cut the proxy path.
 *
 * The owner's proxy is their own way in and out, so a plan that can interrupt it
 * has to prove it left a way back before it runs. Four checks are required:
 *
 * - `backup-connection` — a second live connection to the same host exists.
 * - `alternate-route` — an alternate route to the host was actually tested.
 * - `config-backup` — the current configuration was backed up.
 * - `recovery-plan` — the recovery procedure is written down.
 *
 * Two of these can be verified mechanically from what the agent already knows
 * (the live session list, and whether the plan carries a recovery procedure).
 * The other two are acts, not facts: only the agent can perform them. Those are
 * declared, carried into the plan the user reads, and reported as unverified —
 * the harness never claims to have checked something it cannot check.
 */

const PROXY_RISK_TOOL_NAMES = new Set([
  'portforward_start',
  'portforward_stop',
  'portforward.start',
  'portforward.stop',
]);

const PROXY_RISK_PATTERN = /(?:proxy|nginx|haproxy|traefik|caddy|squid|v2ray|xray|frp|clash|envoy|iptables|nftables?|firewall|ip\s+route|route\s+(?:add|del|change)|resolv\.conf|dns|netplan|networkmanager|(?:systemctl|service|rc-service|launchctl)\s+(?:\S+\s+)?(?:start|restart|reload|stop|disable|mask|enable)|\$|`|\beval\b|\b(?:sh|bash|zsh)\s+-c)/i;

/** Infer proxy-path risk from the actual planned tools and payloads. */
export function inferProxyRisk(steps: readonly PlanStep[]): boolean {
  return steps.some((step) => {
    if (step.toolName && PROXY_RISK_TOOL_NAMES.has(step.toolName)) return true;
    const payload = [
      step.command ?? '',
      step.args ? JSON.stringify(step.args) : '',
    ].join(' ');
    return PROXY_RISK_PATTERN.test(payload);
  });
}

export const BACKUP_ACCESS_CHECK_IDS = [
  'backup-connection',
  'alternate-route',
  'config-backup',
  'recovery-plan',
] as const;

export type BackupAccessCheckId = typeof BACKUP_ACCESS_CHECK_IDS[number];

/** Checks the harness can verify itself, and how. */
export const BACKUP_ACCESS_VERIFIABLE: Partial<Record<BackupAccessCheckId, string>> = {
  'backup-connection': 'counted from the live sessions in scope',
  'recovery-plan': 'must be present and non-empty in the plan',
};

/** Human-readable labels, shown in the plan the user approves. */
export const BACKUP_ACCESS_LABELS: Record<BackupAccessCheckId, string> = {
  'backup-connection': 'A second live connection to the host exists',
  'alternate-route': 'An alternate route to the host was tested and reachable',
  'config-backup': 'The current configuration was backed up',
  'recovery-plan': 'The recovery procedure is written down',
};

export interface BackupAccessDeclaration {
  ok: boolean;
  detail?: string;
}

export type BackupAccessDeclarations = Partial<Record<BackupAccessCheckId, BackupAccessDeclaration>>;

export interface BackupAccessHost {
  sessionId: string;
  hostId?: string;
  hostname: string;
  connected: boolean;
}

export interface BackupAccessCheckResult {
  id: BackupAccessCheckId;
  ok: boolean;
  /** True when the harness verified this check itself. */
  verified: boolean;
  detail?: string;
  /** Why a check failed, or why it is missing. */
  reason?: string;
}

export interface BackupAccessVerification {
  ok: boolean;
  checks: BackupAccessCheckResult[];
  /** Short explanation to show the user when the plan is blocked. */
  blockReason?: string;
}

/** Hosts the plan acts on. */
export interface BackupAccessTarget {
  hostId?: string;
  hostname?: string;
}

/**
 * Verify the backup-access checks a plan declared.
 *
 * `targets` are the hosts the plan touches. When it is empty, every host in
 * `hosts` is treated as a target, so a caller that cannot name the targets gets
 * the strict behavior instead of a pass.
 */
export function verifyBackupAccess(input: {
  declarations: BackupAccessDeclarations;
  hosts: readonly BackupAccessHost[];
  targets?: readonly BackupAccessTarget[];
}): BackupAccessVerification {
  const checks: BackupAccessCheckResult[] = [];
  const targets = input.targets && input.targets.length > 0 ? input.targets : undefined;

  for (const id of BACKUP_ACCESS_CHECK_IDS) {
    const declaration = input.declarations[id];
    if (!declaration) {
      checks.push({
        id,
        ok: false,
        verified: false,
        reason: `Missing backup-access check "${id}".`,
      });
      continue;
    }

    if (id === 'backup-connection') {
      const live = countLiveFallbacks(input.hosts, targets);
      if (live.underReserved.length > 0) {
        checks.push({
          id,
          ok: false,
          verified: true,
          detail: declaration.detail,
          reason: `Only one live connection to ${live.underReserved.join(', ')}; a second one must exist before it is changed.`,
        });
        continue;
      }
      checks.push({
        id,
        ok: declaration.ok,
        verified: true,
        detail: declaration.detail,
        ...(declaration.ok ? {} : { reason: 'Backup connection check was declared as failed.' }),
      });
      continue;
    }

    if (id === 'recovery-plan') {
      const written = Boolean(declaration.detail && declaration.detail.trim().length > 0);
      checks.push({
        id,
        ok: written && declaration.ok,
        verified: true,
        detail: declaration.detail,
        ...(written ? {} : { reason: 'Recovery procedure must be written in the plan.' }),
      });
      continue;
    }

    checks.push({
      id,
      ok: declaration.ok,
      verified: false,
      detail: declaration.detail,
      ...(declaration.ok
        ? {}
        : { reason: 'The plan declared this check as failed; it must pass first.' }),
    });
  }

  const failed = checks.filter(check => !check.ok);
  if (failed.length === 0) {
    return { ok: true, checks };
  }
  return {
    ok: false,
    checks,
    blockReason: failed
      .map(check => check.reason ?? `Backup-access check "${check.id}" did not pass.`)
      .join(' '),
  };
}

/**
 * Hosts that the plan targets but that have fewer than two live sessions.
 *
 * A session counts as a fallback for a target when it is connected and matches
 * the target's host id, or — when the target has no host id — its hostname.
 * Matching on hostname keeps serial and local sessions comparable.
 */
function countLiveFallbacks(
  hosts: readonly BackupAccessHost[],
  targets: readonly BackupAccessTarget[] | undefined,
): { underReserved: string[] } {
  const underReserved: string[] = [];
  const pool = targets ?? hosts.map(host => ({ hostId: host.hostId, hostname: host.hostname }));

  for (const target of pool) {
    const live = hosts.filter(host => {
      if (!host.connected) return false;
      if (target.hostId && host.hostId) return host.hostId === target.hostId;
      return host.hostname === target.hostname;
    }).length;
    if (live < 2) {
      underReserved.push(target.hostname || target.hostId || 'the target host');
    }
  }

  return { underReserved };
}

/** Parse the JSON declarations the model submits with a plan. */
export function parseBackupAccessDeclarations(raw: unknown): {
  declarations?: BackupAccessDeclarations;
  error?: string;
} {
  if (raw === undefined || raw === null) return {};
  let parsed: unknown;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return { error: 'backupAccess must be a JSON object keyed by check id.' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'backupAccess must be a JSON object keyed by check id.' };
  }

  const declarations: BackupAccessDeclarations = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!(BACKUP_ACCESS_CHECK_IDS as readonly string[]).includes(key)) continue;
    const entry = value as { ok?: unknown; detail?: unknown } | null;
    declarations[key as BackupAccessCheckId] = {
      ok: entry?.ok === true,
      ...(typeof entry?.detail === 'string' ? { detail: entry.detail } : {}),
    };
  }
  return { declarations };
}
