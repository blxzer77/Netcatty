/**
 * Machine record: the structured block the agent keeps inside a host's notes.
 *
 * Host notes are the user's free text. The agent's cross-session memory lives
 * there too, so the contract is deliberately non-destructive: the agent owns
 * exactly one marked block and touches nothing outside it. A user editing the
 * prose around the block must never lose their words, and a user editing the
 * block itself must not break the next read.
 *
 * The format is a contract between the system prompt (which tells the agent
 * what to write) and these helpers (which parse and merge it). Keep both in
 * sync: the prompt test asserts the markers appear.
 */

import { redactSecretsForModel } from './modelSecretRedaction';

export const MACHINE_RECORD_START = '<!-- netcatty:agent-record:start -->';
export const MACHINE_RECORD_END = '<!-- netcatty:agent-record:end -->';

/** Keys the agent is expected to maintain, in render order. */
export const MACHINE_RECORD_KEYS = [
  'role',
  'updated',
  'last-action',
  'watch',
] as const;

export type MachineRecordKey = typeof MACHINE_RECORD_KEYS[number];

export interface MachineRecord {
  role?: string;
  updated?: string;
  'last-action'?: string;
  watch?: string[];
  /** Keys that were present but are not in {@link MACHINE_RECORD_KEYS}. */
  extra?: Record<string, string[]>;
}


function blockRegex(): RegExp {
  return new RegExp(
    `${MACHINE_RECORD_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n([\\s\\S]*?)\\n?${MACHINE_RECORD_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
  );
}

export function hasMachineRecord(notes: string): boolean {
  return notes.includes(MACHINE_RECORD_START) && notes.includes(MACHINE_RECORD_END);
}

/**
 * Parse the agent block out of a host's notes.
 *
 * Returns null when there is no block. Malformed lines are kept verbatim in
 * `extra` so a partial or hand-edited block round-trips instead of being
 * silently dropped on the next write.
 */
export function parseMachineRecord(notes: string): MachineRecord | null {
  if (!hasMachineRecord(notes)) return null;
  const match = notes.match(blockRegex());
  if (!match) return null;

  const record: MachineRecord = {};
  const extra: Record<string, string[]> = {};
  for (const rawLine of match[1].split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const separator = line.indexOf(':');
    if (separator <= 0) {
      (extra['_unparsed'] ??= []).push(line);
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (value.length === 0) continue;
    if (key === 'watch') {
      record.watch = [...(record.watch ?? []), value];
      continue;
    }
    if ((MACHINE_RECORD_KEYS as readonly string[]).includes(key)) {
      // `watch` is the only list-valued key; it is handled above, so every
      // remaining known key is a scalar.
      (record as Record<string, string>)[key] = value;
      continue;
    }
    (extra[key] ??= []).push(value);
  }

  if (Object.keys(extra).length > 0) record.extra = extra;
  return record;
}

/**
 * Render the agent block. `watch` entries keep their one-item-per-line shape so
 * several follow-ups survive a read/write cycle.
 */
export function renderMachineRecord(record: MachineRecord): string {
  const lines: string[] = [];
  if (record.role) lines.push(`role: ${record.role}`);
  if (record.updated) lines.push(`updated: ${record.updated}`);
  if (record['last-action']) lines.push(`last-action: ${record['last-action']}`);
  for (const watch of record.watch ?? []) lines.push(`watch: ${watch}`);
  for (const [key, values] of Object.entries(record.extra ?? {})) {
    for (const value of values) lines.push(`${key}: ${value}`);
  }
  return [MACHINE_RECORD_START, ...lines, MACHINE_RECORD_END].join('\n');
}

/**
 * Write the block into a host's notes without touching anything else.
 *
 * An existing block is replaced in place, so its position (and the prose around
 * it) survives. When there is no block, it is prepended: the freshest context is
 * the first thing the agent reads next time.
 *
 * Unknown keys found in the existing block are carried over unless the incoming
 * record overrides them, so a partial write by the agent cannot silently delete
 * a key it does not know about.
 */
export function mergeMachineRecord(notes: string, record: MachineRecord): string {
  const block = renderMachineRecord(carryOverUnknownKeys(notes, record));
  const match = notes.match(blockRegex());
  if (!match) {
    const trimmed = notes.trim();
    return trimmed.length === 0 ? block : `${block}\n\n${trimmed}`;
  }
  return `${notes.slice(0, match.index)}${block}${notes.slice(match.index + match[0].length)}`;
}

/**
 * Merge the existing block's unknown keys under the incoming record. Known keys
 * are replaced wholesale; unknown keys and unparsable lines are appended so
 * nothing the user typed inside the block is lost.
 */
function carryOverUnknownKeys(notes: string, record: MachineRecord): MachineRecord {
  const previous = parseMachineRecord(notes);
  if (!previous?.extra) return record;
  const merged: Record<string, string[]> = { ...previous.extra };
  for (const [key, values] of Object.entries(record.extra ?? {})) {
    merged[key] = values;
  }
  return { ...record, extra: merged };
}

/** One-line summary for logs, prompts, and the compact activity view. */
const MAX_MACHINE_RECORD_SUMMARY_CHARS = 1_000;

function safeSummaryText(value: string): string {
  return redactSecretsForModel(value)
    .replace(/[\r\n]+/g, ' ')
    .replaceAll(String.fromCharCode(0), ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function summarizeMachineRecord(record: MachineRecord | null): string | null {
  if (!record) return null;
  const parts: string[] = [];
  if (record.role) parts.push(safeSummaryText(record.role));
  if (record['last-action']) parts.push(safeSummaryText(record['last-action']));
  if (record.watch?.length) parts.push(`watch: ${record.watch.map(safeSummaryText).join('; ')}`);
  if (parts.length === 0) return null;
  const summary = parts.filter(Boolean).join(' | ');
  return summary.length > MAX_MACHINE_RECORD_SUMMARY_CHARS
    ? `${summary.slice(0, MAX_MACHINE_RECORD_SUMMARY_CHARS)}…`
    : summary;
}

/**
 * Build the one-line machine record per host for the system prompt.
 *
 * The whole notes field never enters the prompt: only the agent's own block is
 * summarized, so the per-turn cost is one bounded line per host and the user's
 * prose stays out of the context window. A host whose notes cannot be read is
 * simply omitted — a missing record must not fail the turn.
 */
export async function collectMachineRecordSummaries(input: {
  hosts: Array<{ sessionId: string; hostId?: string }>;
  readNotes: (hostId: string, signal?: AbortSignal) => Promise<string | null>;
  signal?: AbortSignal;
}): Promise<Map<string, string>> {
  const hostIds = new Set(input.hosts.map(host => host.hostId).filter((id): id is string => Boolean(id)));
  const summaries = new Map<string, string>();
  if (hostIds.size === 0 || input.signal?.aborted) return summaries;

  await Promise.all([...hostIds].map(async (hostId) => {
    try {
      if (input.signal?.aborted) return;
      const notes = await input.readNotes(hostId, input.signal);
      if (input.signal?.aborted) return;
      const summary = summarizeMachineRecord(notes ? parseMachineRecord(notes) : null);
      if (summary) summaries.set(hostId, summary);
    } catch {
      // A host whose record cannot be read is described without one.
    }
  }));

  return summaries;
}
