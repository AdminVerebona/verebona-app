'use client';

/**
 * Supervision T3 — lot 52A (ticket « [P1] T3 — non-déclenchement des
 * exécutions manuelles et horaires », COR-04, COR-05).
 *
 * Une seule carte, lisible sur mobile comme sur ordinateur (une colonne, puis
 * deux à partir de `sm`), composants et jetons existants seulement :
 *   · boucleur : instances vivantes / connues (TOUTES les instances, lues en
 *     base — jamais l'état du seul processus qui répond), dernière activité ;
 *   · exécutant T3 : disponible, ou motif de non-démarrage ;
 *   · dernier passage T3 manuel et automatique, dernier balayage horaire :
 *     création, début, fin, durée, objets examinés / modifiés, résultat
 *     métier (NO_CHANGE compris), appels modèle, motif.
 */
import { Activity, CheckCircle2, AlertTriangle } from 'lucide-react';

export type ExecutionPhase =
  | 'CREATED_NOT_STARTED' | 'WAITING_RETRY' | 'STARTED' | 'DONE_NO_CHANGE' | 'DONE_CHANGED' | 'DONE' | 'FAILED' | 'CANCELLED';

export const PHASE_LABEL: Record<ExecutionPhase, string> = {
  CREATED_NOT_STARTED: 'Créé, non démarré',
  WAITING_RETRY: 'En attente d’une nouvelle tentative',
  STARTED: 'Démarré',
  DONE_NO_CHANGE: 'Terminé sans modification',
  DONE_CHANGED: 'Terminé avec modifications',
  DONE: 'Terminé',
  FAILED: 'En échec',
  CANCELLED: 'Annulé',
};

export interface T3JobSummary {
  id: number;
  accountId: number | null;
  origin: string;
  triggerCode: string | null;
  kind: string | null;
  status: string;
  phase: ExecutionPhase;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  attempts: number;
  objectsExamined: number | null;
  objectsModified: number | null;
  openActionsExamined: number | null;
  aiCalls: number | null;
  businessResult: string | null;
  reason: string | null;
}

export interface T3SupervisionData {
  generatedAt: string;
  workers: {
    state: 'OK' | 'NO_LIVE_WORKER' | 'NO_T3_EXECUTOR' | 'UNKNOWN';
    liveInstances: number;
    knownInstances: number;
    t3ExecutorInstances: number;
    lastTickAt: string | null;
    lastClaimAt: string | null;
  };
  executor: { available: boolean; reason: string | null; code: string };
  queue: { pending: number; pendingReady: number; running: number; failedLast24h: number; oldestReadyCreatedAt: string | null };
  schedule: { triggerCode: string | null; periodHours: number | null; lastRootCreatedAt: string | null; nextDueAt: string | null };
  lastManual: T3JobSummary | null;
  lastAutomatic: T3JobSummary | null;
  lastSweep: T3JobSummary | null;
}

const dt = (v: string | null) => (v ? new Date(v).toLocaleString('fr-FR') : '—');

export function formatDuration(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1_000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${String(s % 60).padStart(2, '0')} s`;
}

function JobBlock({ titre, job, onOpen }: { titre: string; job: T3JobSummary | null; onOpen: (id: number) => void }) {
  return (
    <div className="rounded-lg border border-[color:var(--border-subtle)] p-3 space-y-1 min-w-0">
      <p className="text-xs font-semibold text-[color:var(--text-primary)]">{titre}</p>
      {!job ? (
        <p className="text-xs text-[color:var(--text-muted)]">Aucun passage enregistré.</p>
      ) : (
        <>
          <p className="text-xs text-[color:var(--text-secondary)] break-words">
            <button type="button" className="text-[color:var(--accent)] hover:underline" onClick={() => onOpen(job.id)}>#{job.id}</button>
            {job.accountId ? ` · compte ${job.accountId}` : ''}
            {job.triggerCode ? ` · ${job.triggerCode}` : ''}
            {' · '}<span className="font-medium">{PHASE_LABEL[job.phase] ?? job.status}</span>
            {job.businessResult ? ` (${job.businessResult})` : ''}
          </p>
          <p className="text-xs text-[color:var(--text-muted)] break-words">
            Créé {dt(job.createdAt)} · début {dt(job.startedAt)} · fin {dt(job.finishedAt)} · durée {formatDuration(job.durationMs)}
          </p>
          {(job.objectsExamined != null || job.aiCalls != null) && (
            <p className="text-xs text-[color:var(--text-muted)] break-words">
              {job.objectsExamined != null && `${job.objectsExamined} objet(s) examiné(s) · ${job.objectsModified ?? 0} modifié(s)`}
              {job.openActionsExamined != null && ` · ${job.openActionsExamined} « À traiter » réexaminé(s)`}
              {job.aiCalls != null && (job.aiCalls === 0 ? ' · sans appel au modèle' : ` · ${job.aiCalls} appel(s) au modèle`)}
            </p>
          )}
          {job.reason && <p className="text-xs text-amber-500 break-words">{job.reason}</p>}
        </>
      )}
    </div>
  );
}

export function T3Supervision({ data, onOpenJob }: { data: T3SupervisionData | null; onOpenJob: (id: number) => void }) {
  if (!data) return null;
  const w = data.workers;
  const boucleur = w.state === 'UNKNOWN'
    ? 'État des instances inconnu (battements indisponibles).'
    : `${w.liveInstances} instance(s) active(s) sur ${w.knownInstances} connue(s) · ${w.t3ExecutorInstances} avec l’exécutant T3`;
  return (
    <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Activity className="w-4 h-4 text-[color:var(--text-muted)] shrink-0" />
        <h2 className="text-sm font-semibold text-[color:var(--text-primary)]">Supervision T3</h2>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1 min-w-0">
          <p className="text-xs text-[color:var(--text-secondary)] break-words">Boucleur : {boucleur}</p>
          <p className="text-xs text-[color:var(--text-muted)] break-words">
            Dernier tour {dt(w.lastTickAt)} · dernier prélèvement {dt(w.lastClaimAt)}
          </p>
          <p className={`text-xs flex items-start gap-1.5 ${data.executor.available ? 'text-emerald-500' : 'text-amber-500'}`}>
            {data.executor.available
              ? <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              : <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />}
            <span className="break-words">
              {data.executor.available ? 'Exécutant T3 disponible.' : 'Exécutant T3 indisponible.'}
              {data.executor.reason ? ` ${data.executor.reason}` : ''}
            </span>
          </p>
        </div>
        <div className="space-y-1 min-w-0">
          <p className="text-xs text-[color:var(--text-secondary)] break-words">
            File T3 : {data.queue.pending} en attente ({data.queue.pendingReady} prêt(s)) · {data.queue.running} en cours · {data.queue.failedLast24h} échec(s) sur 24 h
          </p>
          {data.queue.oldestReadyCreatedAt && (
            <p className="text-xs text-[color:var(--text-muted)]">Plus ancien job prêt : créé {dt(data.queue.oldestReadyCreatedAt)}</p>
          )}
          <p className="text-xs text-[color:var(--text-muted)] break-words">
            {data.schedule.triggerCode
              ? `Planification ${data.schedule.triggerCode} · dernier balayage ${dt(data.schedule.lastRootCreatedAt)} · prochain attendu ${dt(data.schedule.nextDueAt)}`
              : 'Aucune planification T3 active.'}
          </p>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <JobBlock titre="Dernier passage manuel" job={data.lastManual} onOpen={onOpenJob} />
        <JobBlock titre="Dernier passage automatique (compte)" job={data.lastAutomatic} onOpen={onOpenJob} />
        <JobBlock titre="Dernier balayage planifié" job={data.lastSweep} onOpen={onOpenJob} />
      </div>
    </div>
  );
}
