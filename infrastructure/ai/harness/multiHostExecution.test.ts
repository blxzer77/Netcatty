import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareHostOutputs,
  runCommandOnSessions,
  type HostCommandOutcome,
} from './multiHostExecution';
import { hostWriteQueueKey } from '../shared/sessionExecutionQueue';

const outcome = (
  sessionId: string,
  overrides: Partial<HostCommandOutcome> = {},
): HostCommandOutcome => ({
  sessionId,
  ok: true,
  exitCode: 0,
  stdout: '',
  stderr: '',
  ...overrides,
});

describe('runCommandOnSessions', () => {
  it('runs serially in the given order and reports every host', async () => {
    const order: string[] = [];
    const result = await runCommandOnSessions({
      sessionIds: ['a', 'b', 'c'],
      command: 'uptime',
      runOnHost: async (sessionId) => {
        order.push(sessionId);
        return outcome(sessionId, { stdout: `up ${sessionId}` });
      },
    });

    assert.deepEqual(order, ['a', 'b', 'c']);
    assert.equal(result.mode, 'serial');
    assert.deepEqual(result.summary, { total: 3, succeeded: 3, failed: 0 });
    assert.equal(result.hosts.length, 3);
  });

  it('isolates a failing host from the others', async () => {
    const result = await runCommandOnSessions({
      sessionIds: ['a', 'b', 'c'],
      command: 'systemctl restart nginx',
      runOnHost: async (sessionId) => (sessionId === 'b'
        ? outcome(sessionId, { ok: false, error: 'Session disconnected', exitCode: -1 })
        : outcome(sessionId, { stdout: 'ok' })),
    });

    assert.deepEqual(result.summary, { total: 3, succeeded: 2, failed: 1 });
    const failed = result.hosts.find(host => host.sessionId === 'b');
    assert.equal(failed?.ok, false);
    assert.match(failed?.error ?? '', /disconnected/);
    // The hosts after the failure still ran and kept their own result.
    assert.equal(result.hosts[2]?.sessionId, 'c');
    assert.equal(result.hosts[2]?.stdout, 'ok');
    assert.equal(result.stoppedEarly, undefined);
  });

  it('stops after the first failure when asked (serial only)', async () => {
    const ran: string[] = [];
    const result = await runCommandOnSessions({
      sessionIds: ['a', 'b', 'c'],
      command: 'apt-get upgrade -y',
      stopOnError: true,
      runOnHost: async (sessionId) => {
        ran.push(sessionId);
        return sessionId === 'a'
          ? outcome(sessionId, { ok: false, error: 'exit 1' })
          : outcome(sessionId);
      },
    });

    assert.deepEqual(ran, ['a']);
    assert.equal(result.stoppedEarly, true);
    assert.deepEqual(result.summary, { total: 1, succeeded: 0, failed: 1 });
  });

  it('ignores stopOnError in parallel mode', async () => {
    const result = await runCommandOnSessions({
      sessionIds: ['a', 'b'],
      command: 'df -h',
      mode: 'parallel',
      stopOnError: true,
      runOnHost: async (sessionId) => (sessionId === 'a'
        ? outcome(sessionId, { ok: false, error: 'nope' })
        : outcome(sessionId, { stdout: 'ok' })),
    });

    assert.equal(result.mode, 'parallel');
    assert.equal(result.stoppedEarly, undefined);
    assert.deepEqual(result.summary, { total: 2, succeeded: 1, failed: 1 });
  });

  it('de-duplicates repeated session ids', async () => {
    const ran: string[] = [];
    const result = await runCommandOnSessions({
      sessionIds: ['a', 'a', 'b'],
      command: 'uptime',
      runOnHost: async (sessionId) => {
        ran.push(sessionId);
        return outcome(sessionId);
      },
    });
    assert.deepEqual(ran, ['a', 'b']);
    assert.equal(result.summary.total, 2);
  });

  it('serializes a multi-host run against the host write queue', async () => {
    // A slot reserved for the same host is awaited before that host runs, so a
    // single-host write queued elsewhere cannot interleave with the batch.
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstSlot = { ready: Promise.resolve(), release: () => releaseFirst() };
    const blocking = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const batch = runCommandOnSessions({
      sessionIds: ['a'],
      command: 'systemctl reload nginx',
      reserveSlot: (sessionId) => (events.push(`reserve:${sessionId}`), firstSlot),
      runOnHost: async () => {
        events.push('run:a');
        await blocking;
        return outcome('a');
      },
    });
    releaseFirst();
    await batch;

    assert.deepEqual(events, ['reserve:a', 'run:a']);
  });

  it('releases slots even when a host throws', async () => {
    const reserved: string[] = [];
    await assert.rejects(
      runCommandOnSessions({
        sessionIds: ['a'],
        command: 'uptime',
        reserveSlot: (sessionId) => {
          reserved.push(sessionId);
          return { ready: Promise.resolve(), release: () => reserved.push(`release:${sessionId}`) };
        },
        runOnHost: async () => { throw new Error('bridge exploded'); },
      }),
      /bridge exploded/,
    );
    assert.deepEqual(reserved, ['a', 'release:a']);
  });
});

describe('compareHostOutputs', () => {
  it('reports identical output across hosts', () => {
    const comparison = compareHostOutputs('nginx -v', [
      outcome('a', { stdout: 'nginx version: nginx/1.24.0' }),
      outcome('b', { stdout: 'nginx version: nginx/1.24.0' }),
    ]);

    assert.equal(comparison.identical, true);
    assert.deepEqual(comparison.differingHosts, []);
    assert.match(comparison.conclusion, /All 2 hosts/);
  });

  it('groups hosts by output and lists the lines that differ', () => {
    const comparison = compareHostOutputs('df -h /', [
      outcome('a', { stdout: 'Filesystem\n/dev/sda1\n100G' }),
      outcome('b', { stdout: 'Filesystem\n/dev/sda1\n100G' }),
      outcome('c', { stdout: 'Filesystem\n/dev/sdb1\n200G\nEXTRA' }),
    ]);

    assert.equal(comparison.identical, false);
    assert.deepEqual(comparison.differingHosts, ['c']);
    assert.equal(comparison.groups.length, 2);
    // The largest group is the baseline put first.
    assert.deepEqual(comparison.groups[0].members, ['a', 'b']);
    assert.deepEqual(comparison.differences[0].members, ['c']);
    assert.deepEqual(comparison.differences[0].lines, ['/dev/sdb1', '200G', 'EXTRA']);
    assert.match(comparison.conclusion, /2 of 3 hosts agree/);
    assert.match(comparison.conclusion, /differing: c/);
  });

  it('separates hosts that failed from hosts that differ', () => {
    const comparison = compareHostOutputs('nginx -v', [
      outcome('a', { stdout: 'v1' }),
      outcome('b', { stdout: 'v1' }),
      outcome('c', { ok: false, error: 'Connection refused', exitCode: -1 }),
    ]);

    assert.equal(comparison.identical, false);
    assert.deepEqual(comparison.hostsThatFailed, ['c']);
    assert.deepEqual(comparison.differingHosts, []);
    // No field differs, so the conclusion names the failure and nothing else.
    assert.match(comparison.conclusion, /2 hosts answered the same/);
    assert.match(comparison.conclusion, /failed: c/);
    assert.doesNotMatch(comparison.conclusion, /differing:/);
  });

  it('says so when no host answered', () => {
    const comparison = compareHostOutputs('uptime', [
      outcome('a', { ok: false, error: 'timeout', exitCode: -1 }),
    ]);
    assert.match(comparison.conclusion, /No host answered: a/);
  });

  it('caps the per-host difference lines', () => {
    const big = Array.from({ length: 50 }, (_, index) => `line-${index}`).join('\n');
    const comparison = compareHostOutputs('env', [
      outcome('a', { stdout: 'baseline' }),
      outcome('b', { stdout: `${big}` }),
    ]);

    assert.equal(comparison.differences[0].lines.length, 20);
  });
});

describe('hostWriteQueueKey', () => {
  it('is scoped to the host, not the chat session', () => {
    assert.equal(hostWriteQueueKey('session-1'), 'session:session-1');
  });
});
