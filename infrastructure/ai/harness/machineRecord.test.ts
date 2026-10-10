import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MACHINE_RECORD_END,
  MACHINE_RECORD_START,
  collectMachineRecordSummaries,
  hasMachineRecord,
  mergeMachineRecord,
  parseMachineRecord,
  renderMachineRecord,
  summarizeMachineRecord,
} from './machineRecord';

const record = {
  role: 'reverse proxy',
  updated: '2026-10-10T12:00:00.000Z',
  'last-action': 'reloaded nginx after the config change',
  watch: ['cert expires 2026-11-02', 'disk at 78%'],
};

test('renders and parses a record round-trip', () => {
  const rendered = renderMachineRecord(record);
  assert.match(rendered, /role: reverse proxy/);
  assert.match(rendered, /last-action: reloaded nginx after the config change/);

  const parsed = parseMachineRecord(rendered);
  assert.ok(parsed);
  assert.equal(parsed.role, 'reverse proxy');
  assert.equal(parsed.updated, '2026-10-10T12:00:00.000Z');
  assert.equal(parsed['last-action'], 'reloaded nginx after the config change');
  assert.deepEqual(parsed.watch, ['cert expires 2026-11-02', 'disk at 78%']);
});

test('a rendered block is detected as a machine record', () => {
  assert.equal(hasMachineRecord(renderMachineRecord(record)), true);
  assert.equal(hasMachineRecord('just the user notes'), false);
  assert.equal(hasMachineRecord(MACHINE_RECORD_START), false);
});

test('merging into empty notes creates only the block', () => {
  const notes = mergeMachineRecord('', record);
  assert.equal(notes, renderMachineRecord(record));
});

test('merging replaces the block in place and preserves the user prose', () => {
  const notes = [
    'Hand-maintained runbook',
    '',
    MACHINE_RECORD_START,
    'role: old value',
    MACHINE_RECORD_END,
    '',
    'Do not restart without checking the backup first.',
  ].join('\n');

  const merged = mergeMachineRecord(notes, record);

  assert.match(merged, /Hand-maintained runbook/);
  assert.match(merged, /Do not restart without checking the backup first\./);
  assert.match(merged, /role: reverse proxy/);
  assert.doesNotMatch(merged, /role: old value/);
  // Position survived: the block stays between the two prose parts.
  assert.ok(merged.indexOf('Hand-maintained runbook') < merged.indexOf(MACHINE_RECORD_START));
  assert.ok(merged.indexOf(MACHINE_RECORD_END) < merged.indexOf('Do not restart'));
});

test('merging without a block prepends it and keeps the user text intact', () => {
  const notes = 'Bought 2026-01. Owner: me.';
  const merged = mergeMachineRecord(notes, record);
  assert.ok(merged.startsWith(MACHINE_RECORD_START));
  assert.match(merged, /Bought 2026-01\. Owner: me\./);
  const parsed = parseMachineRecord(merged);
  assert.equal(parsed?.role, 'reverse proxy');
});

test('an unknown key and an unparsable line survive a write', () => {
  const notes = [
    MACHINE_RECORD_START,
    'role: proxy',
    'owner: alice',
    'this line has no separator',
    MACHINE_RECORD_END,
  ].join('\n');

  const parsed = parseMachineRecord(notes);
  assert.deepEqual(parsed?.extra, { owner: ['alice'], _unparsed: ['this line has no separator'] });

  const rewritten = mergeMachineRecord(notes, { role: 'proxy', 'last-action': 'restarted' });
  assert.match(rewritten, /owner: alice/);
  assert.match(rewritten, /this line has no separator/);
  assert.match(rewritten, /last-action: restarted/);
});

test('a hand-edited block without markers is left alone', () => {
  const notes = 'role: proxy\nupdated: yesterday';
  assert.equal(parseMachineRecord(notes), null);
  assert.equal(mergeMachineRecord(notes, record).includes('role: proxy\nupdated: yesterday'), true);
});

test('parse returns null when the end marker is missing', () => {
  const notes = [MACHINE_RECORD_START, 'role: proxy'].join('\n');
  assert.equal(hasMachineRecord(notes), false);
  assert.equal(parseMachineRecord(notes), null);
});

test('summary names the role, the last action and the watch list', () => {
  assert.equal(
    summarizeMachineRecord(record),
    'reverse proxy | reloaded nginx after the config change | watch: cert expires 2026-11-02; disk at 78%',
  );
  assert.equal(summarizeMachineRecord(null), null);
  assert.equal(summarizeMachineRecord({}), null);
});

describe('collectMachineRecordSummaries', () => {
  it('summarizes one bounded line per host and skips hosts it cannot read', async () => {
    const notesByHost: Record<string, string> = {
      'host-1': [
        '<!-- netcatty:agent-record:start -->',
        'role: reverse proxy',
        'last-action: reloaded nginx',
        'watch: cert expires 2026-11-02',
        '<!-- netcatty:agent-record:end -->',
        '',
        'user prose that must not enter the prompt',
      ].join('\n'),
      'host-2': 'no record here',
    };
    const summaries = await collectMachineRecordSummaries({
      hosts: [
        { sessionId: 's1', hostId: 'host-1' },
        { sessionId: 's2', hostId: 'host-2' },
        { sessionId: 's3', hostId: 'host-broken' },
      ],
      readNotes: async (hostId) => {
        if (hostId === 'host-broken') throw new Error('bridge down');
        return notesByHost[hostId] ?? null;
      },
    });

    assert.equal(summaries.size, 1);
    assert.equal(
      summaries.get('host-1'),
      'reverse proxy | reloaded nginx | watch: cert expires 2026-11-02',
    );
  });

  it('de-duplicates hosts shared by several sessions', async () => {
    const reads: string[] = [];
    const summaries = await collectMachineRecordSummaries({
      hosts: [
        { sessionId: 's1', hostId: 'host-1' },
        { sessionId: 's2', hostId: 'host-1' },
        { sessionId: 's3' },
      ],
      readNotes: async (hostId) => {
        reads.push(hostId);
        return '<!-- netcatty:agent-record:start -->\nrole: db\n<!-- netcatty:agent-record:end -->';
      },
    });

    assert.deepEqual(reads, ['host-1']);
    assert.equal(summaries.get('host-1'), 'db');
  });
});
