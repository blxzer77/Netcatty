import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../../application/i18n/I18nProvider';
import { PlanApprovalCard } from './PlanApprovalCard';
import type { ProposedPlan } from '../../infrastructure/ai/shared/planGate';

const renderCard = (plan: ProposedPlan) => renderToStaticMarkup(
  React.createElement(I18nProvider, {
    locale: 'en',
    children: React.createElement(PlanApprovalCard, {
      plan,
      onApprove: () => {},
      onReject: () => {},
    }),
  }),
);

const plan: ProposedPlan = {
  planId: 'plan-1',
  chatSessionId: 'chat-1',
  goal: 'Restart nginx and confirm it serves again',
  steps: [
    {
      id: 's1',
      title: 'Back up the current config',
      toolName: 'terminal_execute',
      sessionId: 'session-a',
      command: 'cp /etc/nginx/nginx.conf /etc/nginx/nginx.conf.bak',
      reason: 'The change edits nginx.conf',
      verification: 'Backup file exists',
      risk: 'low',
    },
    {
      id: 's2',
      title: 'Reload the service',
      toolName: 'terminal_execute',
      sessionId: 'session-a',
      command: 'systemctl reload nginx',
      args: { sessionId: 'session-a', command: 'systemctl reload nginx', API_TOKEN: 'tok_live_1234567890' },
      reason: 'Apply the new configuration',
      verification: 'curl localhost returns 200',
      risk: 'high',
    },
  ],
  preconditions: [
    { id: 'p1', label: 'A second live connection to the host exists', ok: true },
    { id: 'p2', label: 'Alternate route tested and reachable', ok: true, detail: 'via 203.0.113.9:22' },
  ],
};

test('PlanApprovalCard renders the plan the user has to approve', () => {
  const markup = renderCard(plan);

  assert.match(markup, /Plan awaiting approval/);
  assert.match(markup, /Restart nginx and confirm it serves again/);
  assert.match(markup, /Preconditions/);
  assert.match(markup, /A second live connection to the host exists/);
  assert.match(markup, /via 203\.0\.113\.9:22/);
  assert.match(markup, /Back up the current config/);
  assert.match(markup, /cp \/etc\/nginx\/nginx\.conf \/etc\/nginx\/nginx\.conf\.bak/);
  assert.match(markup, /Apply the new configuration/);
  assert.match(markup, /args:/);
  assert.match(markup, /\[redacted\]/);
  assert.doesNotMatch(markup, /tok_live_1234567890/);
  assert.match(markup, /curl localhost returns 200/);
  assert.match(markup, /terminal_execute @ session-a/);
  assert.match(markup, /high risk/);
  assert.match(markup, /Approve and run/);
  assert.match(markup, /Reject/);
});

test('PlanApprovalCard redacts secrets in visible free-text fields', () => {
  const markup = renderCard({
    ...plan,
    goal: 'deploy with API_TOKEN=tok_live_1234567890',
    steps: [{
      ...plan.steps[0],
      command: 'curl -H "Authorization: Bearer secret-token-value" https://example.test',
      reason: 'sshpass -p super-secret is unavailable',
    }],
    preconditions: [{
      id: 'p-secret',
      label: 'Authorization: Bearer precondition',
      ok: false,
      detail: 'privateKey=-----BEGIN PRIVATE KEY-----secret-----END PRIVATE KEY-----',
    }],
  });

  assert.doesNotMatch(markup, /tok_live_1234567890|secret-token-value|super-secret/);
  assert.match(markup, /REDACTED|redacted/);
});

test('PlanApprovalCard warns when a precondition blocks the plan', () => {
  const markup = renderCard({
    ...plan,
    preconditions: [
      { id: 'p1', label: 'A second live connection to the host exists', ok: false, detail: 'only one session in scope' },
    ],
  });

  assert.match(markup, /did not pass/);
  assert.match(markup, /only one session in scope/);
});

test('PlanApprovalCard renders a plan without preconditions', () => {
  const markup = renderCard({ ...plan, preconditions: undefined });

  assert.match(markup, /Plan awaiting approval/);
  assert.doesNotMatch(markup, /Preconditions/);
  assert.doesNotMatch(markup, /did not pass/);
});
