import test from 'node:test';
import assert from 'node:assert/strict';
import {
  filterSupportedExternalAgents,
  getExternalAgentSdkBackend,
  isPiAgentConfig,
  matchesManagedAgentConfig,
} from './managedAgents';

test('Pi support accepts discovered, SDK-backed, and Windows shim configurations', () => {
  assert.equal(isPiAgentConfig({ id: 'discovered_pi', command: '/opt/pi', sdkBackend: undefined }), true);
  assert.equal(isPiAgentConfig({ id: 'custom', command: 'pi.cmd', sdkBackend: undefined }), true);
  assert.equal(isPiAgentConfig({ id: 'custom', command: '/opt/pi', sdkBackend: 'pi' }), true);
  assert.equal(isPiAgentConfig({ id: 'custom', command: 'codex', sdkBackend: 'codex' }), false);
});

test('Pi product filter drops stale external-agent configurations', () => {
  const agents = filterSupportedExternalAgents([
    { id: 'discovered_pi', name: 'Pi', command: 'pi', enabled: true, sdkBackend: 'pi' },
    { id: 'discovered_codex', name: 'Codex', command: 'codex', enabled: true, sdkBackend: 'codex' },
  ]);
  assert.deepEqual(agents.map((agent) => agent.id), ['discovered_pi']);
});

test('managed Claude matching ignores legacy adapter command-only configs', () => {
  assert.equal(
    matchesManagedAgentConfig(
      {
        id: 'custom-claude-adapter',
        command: 'claude-agent-acp',
        acpCommand: 'custom-acp',
      },
      'claude',
    ),
    false,
  );
});

test('managed Claude matching ignores legacy adapter configs', () => {
  assert.equal(
    matchesManagedAgentConfig(
      {
        id: 'custom-claude-adapter',
        command: 'claude-agent-acp',
        acpCommand: 'claude-agent-acp',
      },
      'claude',
    ),
    false,
  );
});

test('codex managed config no longer matches legacy adapter backend values', () => {
  assert.equal(
    matchesManagedAgentConfig({ id: 'x', command: 'codex', sdkBackend: 'codex' }, 'codex'),
    true,
  );
  assert.equal(
    matchesManagedAgentConfig({ id: 'x', command: 'other', acpCommand: 'codex-acp' }, 'codex'),
    false,
  );
});

test('cursor managed config matches by sdk backend and discovered id', () => {
  assert.equal(
    matchesManagedAgentConfig({ id: 'discovered_cursor', command: 'cursor', sdkBackend: 'cursor' }, 'cursor'),
    true,
  );
  assert.equal(
    matchesManagedAgentConfig({ id: 'x', command: 'other', sdkBackend: 'cursor' }, 'cursor'),
    true,
  );
});

test('claude managed config matches by sdk backend value', () => {
  assert.equal(
    matchesManagedAgentConfig({ id: 'discovered_claude', command: 'claude', sdkBackend: 'claude' }, 'claude'),
    true,
  );
});

test('legacy backend field is still accepted for saved settings', () => {
  assert.equal(
    getExternalAgentSdkBackend({ acpCommand: 'codex' }),
    'codex',
  );
});

test('grok managed config matches by sdk backend and discovered id', () => {
  assert.equal(
    matchesManagedAgentConfig({ id: 'discovered_grok', command: 'grok', sdkBackend: 'grok' }, 'grok'),
    true,
  );
  assert.equal(
    matchesManagedAgentConfig({ id: 'x', command: 'other', sdkBackend: 'grok' }, 'grok'),
    true,
  );
  assert.equal(
    matchesManagedAgentConfig({ id: 'x', command: 'C:\\\\Tools\\\\grok.exe', sdkBackend: 'grok' }, 'grok'),
    true,
  );
});
