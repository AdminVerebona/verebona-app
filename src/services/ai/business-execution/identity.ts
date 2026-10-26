/**
 * Identifiants d'exécution métier — lot 83C (SEM-01 : identifiants persistants
 * existants d'abord, corrélation minimale ensuite). PUR.
 *
 *   T1   `T1:<uuid>`              tiré au DÉBUT d'une analyse hors file (analyse
 *                                 demandée, réanalyse) et porté par ses appels,
 *                                 ses rapports (`sources.businessExecutionId`) et
 *                                 ses travaux de reprise (`payload.businessExecution`) ;
 *        `T1:job:<id>`            analyse démarrée par un travail de file sans
 *                                 référence (dépôt, lancement manuel du BO,
 *                                 travail antérieur au lot 83) ;
 *        `T1:report:<id>`         analyse directe multi-fichiers ou antérieure au lot 83.
 *        Une REPRISE (remise en file, reprise serveur, rejeu, reprise ciblée)
 *        porte l'identifiant de l'exécution reprise (R22).
 *   T2   `T2:<request_id>`        demande de l'assistant.
 *   T3   `T3:<job_id>`            travail de file (ses tentatives = reprises).
 *   T4   `T4:<job_id>`            idem.
 *   T6   `T6F:<trace_id>`         génération FORMULATE (une exécution de la passerelle) ;
 *        `T6E:<échéance>:<ms>`    évaluation EVALUATE d'une échéance, par demande
 *                                 (`requested_at`, inchangé par les nouveaux essais).
 */
import { randomUUID } from 'node:crypto';

/** Nouvel identifiant d'exécution T1 (début d'une analyse). */
export function newT1ExecutionId(): string {
  return `T1:${randomUUID()}`;
}

export const t1LegacyJobExecutionId = (jobId: number): string => `T1:job:${jobId}`;
export const t1LegacyReportExecutionId = (reportId: number): string => `T1:report:${reportId}`;
export const t2ExecutionId = (requestId: string): string => `T2:${requestId}`;
export const jobExecutionId = (treatment: 'T3' | 'T4', jobId: number): string => `${treatment}:${jobId}`;
export const t6FormulateExecutionId = (traceId: string): string => `T6F:${traceId}`;
export function t6EvaluateExecutionId(agendaItemId: number, requestedAt: Date | string): string {
  const ms = requestedAt instanceof Date ? requestedAt.getTime() : new Date(requestedAt).getTime();
  return `T6E:${agendaItemId}:${Number.isFinite(ms) ? ms : 0}`;
}

type ParsedExecutionId =
  | { treatment: 'T1'; kind: 'uuid'; value: string }
  | { treatment: 'T1'; kind: 'job'; jobId: number }
  | { treatment: 'T1'; kind: 'report'; reportId: number }
  | { treatment: 'T2'; requestId: string }
  | { treatment: 'T3' | 'T4'; jobId: number }
  | { treatment: 'T6'; mode: 'FORMULATE'; traceId: string }
  | { treatment: 'T6'; mode: 'EVALUATE'; agendaItemId: number; requestedAtMs: number };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTIER = /^[1-9]\d{0,15}$/;
const TEXTE = /^[A-Za-z0-9._:-]{1,120}$/;

/** Lecture d'un identifiant (entrée d'URL comprise) ; null s'il est illisible. Pur. */
export function parseExecutionId(raw: string | null | undefined): ParsedExecutionId | null {
  const s = String(raw ?? '').trim();
  if (s.length === 0 || s.length > 160) return null;
  const [prefix, ...rest] = s.split(':');
  const tail = rest.join(':');
  switch (prefix) {
    case 'T1': {
      if (UUID.test(tail)) return { treatment: 'T1', kind: 'uuid', value: s };
      const [k, n] = rest;
      if (rest.length === 2 && ENTIER.test(n ?? '') && k === 'job') return { treatment: 'T1', kind: 'job', jobId: Number(n) };
      if (rest.length === 2 && ENTIER.test(n ?? '') && k === 'report') return { treatment: 'T1', kind: 'report', reportId: Number(n) };
      return null;
    }
    case 'T2': return TEXTE.test(tail) ? { treatment: 'T2', requestId: tail } : null;
    case 'T3': case 'T4': return rest.length === 1 && ENTIER.test(tail) ? { treatment: prefix, jobId: Number(tail) } : null;
    case 'T6F': return TEXTE.test(tail) ? { treatment: 'T6', mode: 'FORMULATE', traceId: tail } : null;
    case 'T6E': {
      const [a, ms] = rest;
      return rest.length === 2 && ENTIER.test(a ?? '') && /^\d{1,16}$/.test(ms ?? '')
        ? { treatment: 'T6', mode: 'EVALUATE', agendaItemId: Number(a), requestedAtMs: Number(ms) } : null;
    }
    default: return null;
  }
}

/** Référence d'exécution portée par un travail de file T1 (`payload.businessExecution`). */
interface JobBusinessExecutionRef {
  id: string;
  /** `start` : début d'une analyse ; `resume` : reprise d'une exécution existante. */
  role: 'start' | 'resume';
}

/** Référence lue dans un contexte de travail (tolérante : travail antérieur = null). Pur. */
export function readJobExecutionRef(payload: unknown): JobBusinessExecutionRef | null {
  const be = (payload as { businessExecution?: { id?: unknown; role?: unknown } } | null)?.businessExecution;
  if (!be || typeof be.id !== 'string' || parseExecutionId(be.id)?.treatment !== 'T1') return null;
  return { id: be.id, role: be.role === 'resume' ? 'resume' : 'start' };
}

/**
 * Identifiant d'exécution métier d'un travail de file (pur) :
 *   T1 avec compte et fichier → référence portée, sinon `T1:job:<id>` ;
 *   T1 sans fichier (passage planifié = orchestration de reprises) → null ;
 *   T3 / T4 → `T3:<id>` / `T4:<id>` (passage planifié sans compte compris :
 *   sa NATURE est technique, voir la projection).
 */
export function executionIdOfJob(job: { id: number; treatment: string; payload?: unknown; targetType?: string | null }): string | null {
  if (job.treatment === 'T1') {
    if (job.targetType !== undefined && job.targetType !== 'asset_file') return null;
    return readJobExecutionRef(job.payload)?.id ?? t1LegacyJobExecutionId(job.id);
  }
  if (job.treatment === 'T3' || job.treatment === 'T4') return jobExecutionId(job.treatment, job.id);
  return null;
}
