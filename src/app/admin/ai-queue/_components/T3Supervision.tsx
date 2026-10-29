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
 *     métier (NO_CHANGE compris), appels modèle, motif ;
 *   · lot 54A — création des jobs (phase A) : constats (arrêt d'urgence,
 *     migrations, boucleur, planification coupée / bloquée / absorbée,
 *     dernière demande manuelle refusée), code déployé par instance,
 *     dernière évaluation de la planification, dernières demandes T3 et
 *     leur motif — le PO tranche sans SQL.
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
  /** Lot 99A : réponses du cache et décisions réutilisées (sans appel). */
  aiCacheResponses?: number | null;
  aiDecisionsReused?: number | null;
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
  /** Lot 54A : phase A (création des jobs) — absents d'une version antérieure du serveur. */
  build?: {
    commit: string | null; commitSource: string | null; container: string | null;
    instances: Array<{ workerId: string; commit: string | null; alive: boolean; lastTickAt: string }>;
  };
  migrations?: { heartbeats0338: boolean; enqueueTrace0370: boolean };
  scheduleEvaluation?: {
    at: string; workerId: string; due: boolean; decision: string; reasonCode: string | null; jobId: number | null;
    nextDueAt: string | null; error: string | null;
  } | null;
  requests?: Array<{
    id: number; createdAt: string; origin: string; triggerCode: string | null; accountId: number | null;
    targetType: string | null; targetId: string | null; decision: string; reasonCode: string | null; reasonLabel: string | null;
    jobId: number | null; persisted: boolean | null; error: string | null;
  }> | null;
  creation?: Array<{ code: string; level: 'ok' | 'warn' | 'error'; message: string }>;
}

const DECISION_LABEL: Record<string, string> = {
  create: 'job créé', skip: 'absorbée', coalesce: 'fusionnée', refused: 'refusée', error: 'erreur', none: '—',
};

const shortCommit = (c: string | null | undefined) => (c ? c.slice(0, 12) : 'inconnu');

/** Lot 54A : diagnostic de la création des jobs T3 (phase A), sans SQL. */
function CreationBlock({ data, onOpen }: { data: T3SupervisionData; onOpen: (id: number) => void }) {
  if (!data.creation) {
    return (
      <p className="text-xs text-[color:var(--text-warning-soft)] break-words">
        Diagnostic de création indisponible : le serveur qui répond exécute un code antérieur au lot 54.
      </p>
    );
  }
  const instancesVivantes = (data.build?.instances ?? []).filter((i) => i.alive);
  const ev = data.scheduleEvaluation;
  return (
    <div className="rounded-lg border border-[color:var(--border-subtle)] p-3 space-y-2 min-w-0">
      <p className="text-xs font-semibold text-[color:var(--text-primary)]">Création des jobs T3 (demande → File IA)</p>
      <ul className="space-y-1">
        {data.creation.map((f) => (
          <li key={f.code} className={`text-xs flex items-start gap-1.5 ${f.level === 'ok' ? 'text-[color:var(--text-success)]' : f.level === 'error' ? 'text-[color:var(--text-danger)]' : 'text-[color:var(--text-warning-soft)]'}`}>
            {f.level === 'ok' ? <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0" /> : <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />}
            <span className="break-words"><span className="font-medium">{f.code}</span> — {f.message}</span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-[color:var(--text-muted)] break-words">
        Code qui répond : {shortCommit(data.build?.commit)}{data.build?.commitSource ? ` (${data.build.commitSource})` : ''}
        {instancesVivantes.length > 0 && ` · instances vivantes : ${instancesVivantes.map((i) => shortCommit(i.commit)).join(', ')}`}
        {data.migrations && ` · migrations 0338 ${data.migrations.heartbeats0338 ? 'OK' : 'absente'}, 0370 ${data.migrations.enqueueTrace0370 ? 'OK' : 'absente'}`}
      </p>
      <p className="text-xs text-[color:var(--text-muted)] break-words">
        {ev
          ? `Dernière évaluation de la planification : ${dt(ev.at)} — ${ev.due ? `échue, ${DECISION_LABEL[ev.decision] ?? ev.decision}` : 'non échue'}`
            + `${ev.reasonCode ? ` (${ev.reasonCode})` : ''}${ev.jobId ? ` · job #${ev.jobId}` : ''}${ev.nextDueAt ? ` · prochaine échéance ${dt(ev.nextDueAt)}` : ''}`
          : 'Aucune évaluation de la planification connue.'}
      </p>
      {data.requests && (
        <div className="space-y-1">
          <p className="text-xs text-[color:var(--text-secondary)]">Dernières demandes T3</p>
          {data.requests.length === 0 && <p className="text-xs text-[color:var(--text-muted)]">Aucune demande enregistrée.</p>}
          <ul className="space-y-0.5">
            {data.requests.map((r) => (
              <li key={r.id} className="text-xs text-[color:var(--text-muted)] break-words">
                {dt(r.createdAt)} · {r.origin === 'manual' ? 'manuel' : r.triggerCode ?? 'automatique'}
                {r.accountId ? ` · compte ${r.accountId}` : ''}
                {' · '}<span className={r.decision === 'create' ? 'text-[color:var(--text-success)]' : 'text-[color:var(--text-warning-soft)]'}>{DECISION_LABEL[r.decision] ?? r.decision}</span>
                {r.reasonCode ? ` (${r.reasonCode}${r.reasonLabel ? ` — ${r.reasonLabel}` : ''})` : ''}
                {r.jobId ? <> · <button type="button" className="text-[color:var(--accent)] hover:underline" onClick={() => onOpen(r.jobId!)}>#{r.jobId}</button></> : ''}
                {r.error ? ` · ${r.error}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
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
              {!!job.aiCacheResponses && ` · ${job.aiCacheResponses} réponse(s) du cache`}
              {!!job.aiDecisionsReused && ` · ${job.aiDecisionsReused} décision(s) réutilisée(s)`}
            </p>
          )}
          {job.reason && <p className="text-xs text-[color:var(--text-warning-soft)] break-words">{job.reason}</p>}
        </>
      )}
    </div>
  );
}

export function T3Supervision({ data, error, onOpenJob }: { data: T3SupervisionData | null; error?: string | null; onOpenJob: (id: number) => void }) {
  if (!data) {
    // Lot 54A : une supervision illisible est dite (route absente = code antérieur au lot 52).
    if (!error) return null;
    return (
      <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4">
        <p className="text-xs text-[color:var(--text-warning-soft)] break-words flex items-start gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>Supervision T3 indisponible : {error}</span>
        </p>
      </div>
    );
  }
  const w = data.workers;
  const boucleur = w.state === 'UNKNOWN'
    ? 'État des instances inconnu (battements indisponibles).'
    : `${w.liveInstances} instance(s) active(s) sur ${w.knownInstances} connue(s) · ${w.t3ExecutorInstances} avec l’exécutant T3`;
  return (
    <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Activity className="w-4 h-4 text-[color:var(--text-muted)] shrink-0" />
        <h2 className="vb-app-section">Supervision T3</h2>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1 min-w-0">
          <p className="text-xs text-[color:var(--text-secondary)] break-words">Boucleur : {boucleur}</p>
          <p className="text-xs text-[color:var(--text-muted)] break-words">
            Dernier tour {dt(w.lastTickAt)} · dernier prélèvement {dt(w.lastClaimAt)}
          </p>
          <p className={`text-xs flex items-start gap-1.5 ${data.executor.available ? 'text-[color:var(--text-success)]' : 'text-[color:var(--text-warning-soft)]'}`}>
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
      <CreationBlock data={data} onOpen={onOpenJob} />
      <div className="grid gap-3 sm:grid-cols-3">
        <JobBlock titre="Dernier passage manuel" job={data.lastManual} onOpen={onOpenJob} />
        <JobBlock titre="Dernier passage automatique (compte)" job={data.lastAutomatic} onOpen={onOpenJob} />
        <JobBlock titre="Dernier balayage planifié" job={data.lastSweep} onOpen={onOpenJob} />
      </div>
    </div>
  );
}
