import React from 'react';
import { ListChecks, ShieldCheck, ShieldAlert } from 'lucide-react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { Button } from '../ui/button';
import type { PlanStepRisk } from '../../infrastructure/ai/harness/types';
import type { ProposedPlan } from '../../infrastructure/ai/shared/planGate';

/**
 * Approval card for a proposed server-operations plan.
 *
 * The plan is the unit of consent: the user reads the goal, the preconditions
 * that gate risky work, and the steps with their commands and verification,
 * then approves or rejects once. Nothing executes before that decision.
 */
export const PlanApprovalCard: React.FC<{
  plan: ProposedPlan;
  onApprove: () => void;
  onReject: () => void;
}> = ({ plan, onApprove, onReject }) => {
  const { t } = useI18n();
  const preconditions = plan.preconditions ?? [];
  const failedPreconditions = preconditions.filter((check) => !check.ok);

  return (
    <div
      className="rounded-lg border border-border/70 bg-card/70 p-3 space-y-3"
      data-testid="plan-approval-card"
    >
      <div className="flex items-start gap-2">
        <ListChecks size={16} className="mt-0.5 shrink-0 text-blue-500" />
        <div className="min-w-0">
          <div className="text-sm font-medium">{t('ai.plan.title')}</div>
          <div className="text-xs text-muted-foreground leading-5">
            {t('ai.plan.description')}
          </div>
        </div>
      </div>

      <div className="space-y-0.5">
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
          {t('ai.plan.goal')}
        </div>
        <div className="text-sm leading-5">{plan.goal}</div>
      </div>

      {preconditions.length > 0 && (
        <div className="space-y-1">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
            {t('ai.plan.preconditions')}
          </div>
          <ul className="space-y-0.5">
            {preconditions.map((check) => (
              <li key={check.id} className="flex items-start gap-1.5 text-xs leading-5">
                {check.ok ? (
                  <ShieldCheck size={13} className="mt-0.5 shrink-0 text-emerald-500" />
                ) : (
                  <ShieldAlert size={13} className="mt-0.5 shrink-0 text-destructive" />
                )}
                <span className="min-w-0">
                  <span className={check.ok ? '' : 'text-destructive'}>{check.label}</span>
                  {check.detail ? (
                    <span className="block text-muted-foreground">{check.detail}</span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="space-y-1.5">
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
          {t('ai.plan.steps')}
        </div>
        <ol className="space-y-1.5">
          {plan.steps.map((step, index) => (
            <li
              key={step.id}
              className="rounded-md border border-border/50 px-2.5 py-2 text-xs"
            >
              <div className="flex items-baseline gap-1.5">
                <span className="font-mono text-muted-foreground">{index + 1}.</span>
                <span className="font-medium leading-5">{step.title}</span>
                <RiskBadge risk={step.risk} />
              </div>
              {step.command ? (
                <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words rounded bg-muted/50 px-1.5 py-1 font-mono text-[11px] leading-4">
                  {step.command}
                </pre>
              ) : null}
              <div className="mt-1 space-y-0.5 text-muted-foreground leading-4">
                {(step.toolName || step.sessionId) ? (
                  <div>
                    {t('ai.plan.target')}: {step.toolName ?? '-'}
                    {step.sessionId ? ` @ ${step.sessionId}` : ''}
                  </div>
                ) : null}
                {step.reason ? <div>{t('ai.plan.reason')}: {step.reason}</div> : null}
                {step.verification ? <div>{t('ai.plan.verify')}: {step.verification}</div> : null}
              </div>
            </li>
          ))}
        </ol>
      </div>

      {failedPreconditions.length > 0 ? (
        <div className="text-[11px] text-destructive">
          {t('ai.plan.preconditionBlocked')}
        </div>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onReject}>
          {t('ai.plan.reject')}
        </Button>
        <Button size="sm" onClick={onApprove}>
          {t('ai.plan.approve')}
        </Button>
      </div>
    </div>
  );
};

const RiskBadge: React.FC<{ risk?: PlanStepRisk }> = ({ risk }) => {
  const { t } = useI18n();
  if (!risk || risk === 'read') return null;
  const tone = risk === 'high'
    ? 'border-destructive/40 text-destructive'
    : 'border-border/60 text-muted-foreground';
  const label = risk === 'high' ? t('ai.plan.risk.high') : t('ai.plan.risk.low');
  return (
    <span className={`rounded border px-1 py-px text-[10px] leading-none ${tone}`}>
      {label}
    </span>
  );
};
