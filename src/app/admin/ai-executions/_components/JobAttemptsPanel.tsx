"use client";

/**
 * Tentatives du job et mécanisme de retry — BO › Exécutions IA, lot 34C
 * (ticket « ne plus exposer les erreurs techniques IA aux utilisateurs et
 * fiabiliser leur suivi dans BO › Exécutions IA »).
 *
 * Distingue explicitement :
 *   · les TENTATIVES DU JOB (« Tentative du job : 2 / 5 », historique) ;
 *   · les APPELS MODÈLE de chaque tentative (principal, fallback 1, fallback 2).
 * Affiche le retry automatique (oui / non, état, motif, prochaine tentative),
 * le statut TECHNIQUE du job séparé du résultat MÉTIER, et ce que
 * l'application montre à l'utilisateur (statut fonctionnel). Réutilise les
 * rapports d'appel du lot 33D (`CallReportView`).
 */
import type { CallReportView } from './ExecutionDiagnosisPanel';

export interface JobAttemptView {
  attempt: number;
  status: 'QUEUED' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'INTERRUPTED' | 'DEFERRED' | 'ABANDONED';
  startedAt: string | null;
  endedAt: string | null;
  calls: CallReportView[];
  modelCalls: number;
  runningCall: { label: string; rank: string } | null;
  cause: string | null;
  technicalError: string | null;
  retryScheduled: boolean | null;
  nextAttemptAt: string | null;
}

export interface JobExecutionViewDto {
  jobId: number;
  jobStatus: string;
  businessResult: string | null;
  attemptsCount: number;
  attempts: JobAttemptView[];
  retry: {
    currentAttempt: number; maxAttempts: number | null; automatic: boolean;
    state: 'QUEUED' | 'RUNNING' | 'SUCCESS' | 'FAILED' | null; scheduled: boolean;
    reason: string | null; nextAttempt: string | null; policy: string | null;
  };
  legacyCalls: CallReportView[];
}

export interface UserViewDto { processingStatus: string; userMessageCode: string | null; retryScheduled: boolean }

const TONE: Record<string, string> = {
  FAILED: 'text-red-400', ABANDONED: 'text-red-400', SUCCESS: 'text-emerald-500',
  RUNNING: 'text-[color:var(--accent)]', QUEUED: 'text-amber-500', INTERRUPTED: 'text-amber-500', DEFERRED: 'text-amber-500',
};
const CALL_STATUS: Record<CallReportView['status'], string> = { SUCCEEDED: 'SUCCESS', REPAIRED: 'SUCCESS (corrigé)', FAILED: 'FAILED' };

const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleString('fr-FR') : '—');
const fmtDuration = (ms: number | null) => (ms === null ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(1).replace('.', ',')} s` : `${ms} ms`);
const fmtInt = (n: number | null) => (n === null ? '—' : n.toLocaleString('fr-FR'));
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function CallLine({ c }: { c: CallReportView }) {
  return (
    <li className="grid grid-cols-[7rem,1fr] gap-x-2" data-testid="job-attempt-call">
      <span className="text-[color:var(--text-muted)]">{cap(c.label)}</span>
      <span>
        {c.model ?? 'modèle inconnu'} · <span className={c.status === 'FAILED' ? 'text-red-400' : 'text-emerald-500'}>{CALL_STATUS[c.status]}</span>
        {c.cause && <> · {c.cause}</>}
        {' · '}{fmtDuration(c.durationMs)}
        {(c.inputTokens !== null || c.outputTokens !== null) && <> · {fmtInt(c.inputTokens)} + {fmtInt(c.outputTokens)} tokens</>}
      </span>
    </li>
  );
}

export function JobAttemptsPanel({ view, userView, treatment }: { view: JobExecutionViewDto; userView: UserViewDto | null; treatment: string }) {
  const { retry } = view;
  const failed = view.businessResult === 'FAILED';
  return (
    <section className="space-y-2" data-testid="job-attempts">
      <h3 className="text-sm font-semibold text-[color:var(--text-primary)]">Tentatives du job et retry</h3>

      <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-0.5 text-xs text-[color:var(--text-secondary)]" data-testid="job-retry">
        <dt className="text-[color:var(--text-muted)]">Statut du job</dt>
        <dd>{view.jobStatus}{view.jobStatus === 'DONE' && <span className="text-[color:var(--text-muted)]"> (traitement technique terminé — pas une preuve de réussite)</span>}</dd>
        <dt className="text-[color:var(--text-muted)]">Résultat {treatment}</dt>
        <dd className={failed ? 'text-red-400 font-medium' : ''}>{view.businessResult ?? '—'}</dd>
        <dt className="text-[color:var(--text-muted)]">Tentative du job</dt>
        <dd>{retry.currentAttempt}{retry.maxAttempts ? ` / ${retry.maxAttempts}` : ''} <span className="text-[color:var(--text-muted)]">(tentatives exécutées : {view.attemptsCount})</span></dd>
        <dt className="text-[color:var(--text-muted)]">Retry automatique</dt>
        <dd className={retry.automatic ? 'font-medium' : ''}>{retry.automatic ? 'OUI' : 'NON'}</dd>
        {retry.state && (<><dt className="text-[color:var(--text-muted)]">État du retry</dt><dd className={TONE[retry.state]}>{retry.state}</dd></>)}
        {retry.reason && (<><dt className="text-[color:var(--text-muted)]">Motif du retry</dt><dd className="break-all">{retry.reason}</dd></>)}
        <dt className="text-[color:var(--text-muted)]">Nouvelle tentative prévue</dt>
        <dd>{retry.scheduled ? 'OUI' : 'NON'}</dd>
        {retry.scheduled && (
          <><dt className="text-[color:var(--text-muted)]">Prochaine tentative</dt><dd>{retry.nextAttempt === 'IMMEDIATE' ? 'Immédiate' : fmtDate(retry.nextAttempt)}</dd></>
        )}
        {retry.policy && (<><dt className="text-[color:var(--text-muted)]">Règle de reprise</dt><dd>{retry.policy}</dd></>)}
        {userView && (
          <>
            <dt className="text-[color:var(--text-muted)]">Vu par l’utilisateur</dt>
            <dd data-testid="job-user-view">
              {userView.processingStatus}{userView.userMessageCode ? ` · ${userView.userMessageCode}` : ''}
              {userView.retryScheduled ? ' · retry en file' : ''}
            </dd>
          </>
        )}
      </dl>

      <div className="space-y-2">
        {view.attempts.map((a, i) => (
          <div key={`${a.attempt}-${i}`} className="rounded-lg border border-[color:var(--border-subtle)] p-3 text-xs text-[color:var(--text-secondary)] space-y-1" data-testid="job-attempt">
            <p className="font-medium text-[color:var(--text-primary)]">
              Tentative job #{a.attempt} · <span className={TONE[a.status] ?? ''}>{a.status}</span>
              <span className="font-normal text-[color:var(--text-muted)]"> · {a.modelCalls} appel(s) modèle</span>
            </p>
            {(a.startedAt || a.endedAt) && <p className="text-[color:var(--text-muted)]">{fmtDate(a.startedAt)} → {fmtDate(a.endedAt)}</p>}
            {(a.calls.length > 0 || a.runningCall) && (
              <ul className="space-y-0.5">
                {a.calls.map((c) => <CallLine key={c.callId} c={c} />)}
                {a.runningCall && (
                  <li className="grid grid-cols-[7rem,1fr] gap-x-2" data-testid="job-attempt-running-call">
                    <span className="text-[color:var(--text-muted)]">{cap(a.runningCall.label)}</span>
                    <span className="text-[color:var(--accent)]">RUNNING (appel en cours)</span>
                  </li>
                )}
              </ul>
            )}
            {a.cause && <p>Cause : {a.cause}</p>}
            {a.technicalError && <p className="text-[color:var(--text-muted)] break-all">Motif enregistré : {a.technicalError}</p>}
            {a.retryScheduled !== null && (
              <p>Retry du job après cette tentative : {a.retryScheduled ? `OUI${a.nextAttemptAt ? ` — prévu le ${fmtDate(a.nextAttemptAt)}` : ''}` : 'NON'}</p>
            )}
          </div>
        ))}
        {view.legacyCalls.length > 0 && (
          <div className="rounded-lg border border-[color:var(--border-subtle)] p-3 text-xs text-[color:var(--text-secondary)] space-y-1">
            <p className="font-medium text-[color:var(--text-primary)]">Appels non rattachés à une tentative (traces antérieures au lot 34)</p>
            <ul className="space-y-0.5">{view.legacyCalls.map((c) => <CallLine key={c.callId} c={c} />)}</ul>
          </div>
        )}
      </div>
    </section>
  );
}
