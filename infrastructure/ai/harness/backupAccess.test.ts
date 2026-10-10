import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKUP_ACCESS_CHECK_IDS,
  inferProxyRisk,
  parseBackupAccessDeclarations,
  verifyBackupAccess,
  type BackupAccessHost,
} from './backupAccess';

const hosts: BackupAccessHost[] = [
  { sessionId: 's-1', hostId: 'host-1', hostname: 'proxy.example', connected: true },
  { sessionId: 's-2', hostId: 'host-1', hostname: 'proxy.example', connected: true },
  { sessionId: 's-3', hostId: 'host-2', hostname: 'web.example', connected: true },
  { sessionId: 's-4', hostId: 'host-2', hostname: 'web.example', connected: false },
];

const allDeclared = {
  'backup-connection': { ok: true, detail: 'second session s-2 is live' },
  'alternate-route': { ok: true, detail: '203.0.113.9:22 reachable from vault host gw' },
  'config-backup': { ok: true, detail: 'nginx.conf copied to /root/nginx.conf.bak' },
  'recovery-plan': { ok: true, detail: 'restore from /root/nginx.conf.bak and systemctl reload nginx' },
};

describe('proxy-risk inference', () => {
  it('cannot be disabled by setting proxyRisk false in the tool call', () => {
    assert.equal(inferProxyRisk([
      { id: 's1', title: 'Reload', toolName: 'terminal_execute', sessionId: 's-1', command: 'systemctl reload nginx' },
    ]), true);
    assert.equal(inferProxyRisk([
      { id: 's1', title: 'Read', toolName: 'terminal_execute', sessionId: 's-1', command: 'uptime' },
    ]), false);
    assert.equal(inferProxyRisk([
      { id: 's1', title: 'Indirect reload', toolName: 'terminal_execute', sessionId: 's-1', command: 'systemctl $(printf reload) nginx' },
    ]), true);
  });
});

describe('verifyBackupAccess', () => {
  it('fails closed when act-based checks have only model declarations', () => {
    const result = verifyBackupAccess({
      declarations: allDeclared,
      hosts,
      targets: [{ hostId: 'host-1' }],
    });

    assert.equal(result.ok, false);
    assert.match(result.blockReason ?? '', /only declared by the model/);
    assert.equal(result.checks.length, BACKUP_ACCESS_CHECK_IDS.length);
    const verified = result.checks.filter(check => check.verified).map(check => check.id);
    assert.deepEqual(verified, ['backup-connection', 'recovery-plan']);
    assert.equal(result.checks.find(check => check.id === 'alternate-route')?.ok, false);
    assert.equal(result.checks.find(check => check.id === 'config-backup')?.ok, false);
  });

  it('blocks a plan targeting a host that has only one live session', () => {
    const result = verifyBackupAccess({
      declarations: allDeclared,
      hosts,
      targets: [{ hostId: 'host-2', hostname: 'web.example' }],
    });

    assert.equal(result.ok, false);
    assert.match(result.blockReason ?? '', /Only one live connection to web\.example/);
    const check = result.checks.find(entry => entry.id === 'backup-connection');
    assert.equal(check?.ok, false);
    assert.equal(check?.verified, true);
  });

  it('counts only connected sessions as fallbacks', () => {
    const result = verifyBackupAccess({
      declarations: allDeclared,
      hosts: [hosts[2], hosts[3]],
      targets: [{ hostId: 'host-2' }],
    });
    assert.equal(result.ok, false);
  });

  it('treats every host as a target when none are named', () => {
    const result = verifyBackupAccess({
      declarations: allDeclared,
      // host-2 has only one live session, so the unnamed case must fail.
      hosts,
    });
    assert.equal(result.ok, false);
    assert.match(result.blockReason ?? '', /web\.example/);
  });

  it('fails a missing check instead of assuming it passed', () => {
    const { 'recovery-plan': _omitted, ...withoutRecovery } = allDeclared;
    const result = verifyBackupAccess({
      declarations: withoutRecovery,
      hosts,
      targets: [{ hostId: 'host-1' }],
    });

    assert.equal(result.ok, false);
    const check = result.checks.find(entry => entry.id === 'recovery-plan');
    assert.equal(check?.ok, false);
    assert.match(check?.reason ?? '', /Missing backup-access check/);
  });

  it('requires the recovery procedure to actually be written', () => {
    const result = verifyBackupAccess({
      declarations: {
        ...allDeclared,
        'recovery-plan': { ok: true, detail: '   ' },
      },
      hosts,
      targets: [{ hostId: 'host-1' }],
    });

    assert.equal(result.ok, false);
    const check = result.checks.find(entry => entry.id === 'recovery-plan');
    assert.equal(check?.verified, true);
    assert.match(check?.reason ?? '', /must be written/);
  });

  it('does not mark an act it cannot verify as verified', () => {
    const result = verifyBackupAccess({
      declarations: allDeclared,
      hosts,
      targets: [{ hostId: 'host-1' }],
    });
    for (const id of ['alternate-route', 'config-backup'] as const) {
      const check = result.checks.find(entry => entry.id === id);
      assert.equal(check?.verified, false, `${id} must stay unverified`);
      assert.equal(check?.ok, false);
    }
  });

  it('reports every failure, not just the first', () => {
    const result = verifyBackupAccess({
      declarations: {
        'backup-connection': { ok: true },
        'alternate-route': { ok: false },
      },
      hosts,
      targets: [{ hostId: 'host-2' }],
    });

    assert.equal(result.ok, false);
    const failed = result.checks.filter(check => !check.ok).map(check => check.id);
    assert.deepEqual(failed, ['backup-connection', 'alternate-route', 'config-backup', 'recovery-plan']);
    assert.match(result.blockReason ?? '', /Only one live connection/);
  });
});

describe('parseBackupAccessDeclarations', () => {
  it('parses a JSON object keyed by check id and ignores unknown keys', () => {
    const parsed = parseBackupAccessDeclarations(JSON.stringify({
      'backup-connection': { ok: true, detail: 's-2 live' },
      'made-up-check': { ok: true },
    }));

    assert.equal(parsed.error, undefined);
    assert.deepEqual(parsed.declarations, {
      'backup-connection': { ok: true, detail: 's-2 live' },
    });
  });

  it('defaults a missing ok to false', () => {
    const parsed = parseBackupAccessDeclarations({ 'config-backup': { detail: 'copied' } });
    assert.equal(parsed.declarations?.['config-backup']?.ok, false);
  });

  it('rejects malformed payloads', () => {
    assert.match(parseBackupAccessDeclarations('{oops').error ?? '', /JSON object/);
    assert.match(parseBackupAccessDeclarations('["a"]').error ?? '', /JSON object/);
  });

  it('returns nothing when the field is absent', () => {
    assert.deepEqual(parseBackupAccessDeclarations(undefined), {});
    assert.deepEqual(parseBackupAccessDeclarations(null), {});
  });
});
