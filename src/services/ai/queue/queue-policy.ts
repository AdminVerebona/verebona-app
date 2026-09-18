/**
 * Règles de la file — CDC BO IA §15.2, MOD-005, SCR-08.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI CES RÈGLES SONT ISOLÉES DE LA BASE
 *
 * Clé de déduplication, temporisation de reprise, ordre de service : ce sont
 * les trois décisions qui déterminent ce qui s'exécute, quand, et combien de
 * fois. Les écrire dans les requêtes SQL les rendrait invérifiables autrement
 * qu'en observant la production.
 *
 * Elles sont donc pures et testées. Le dépôt les applique, il ne les invente pas.
 */
import type { Treatment } from '../config/treatments';

export type JobStatus = 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED' | 'CANCELLED';
export type JobOrigin = 'automatic' | 'manual';

/** Périmètre d'une exécution. Absence de cible = périmètre global. */
export interface JobScope {
  accountId?: number | null;
  targetType?: string | null;
  targetId?: string | number | null;
}

/**
 * Clé de déduplication : traitement + périmètre.
 *
 * ⚠️ Le déclencheur n'y entre PAS (WF-10). Un dépôt de document et une
 * planification qui visent le même objet sont la même exécution — les
 * distinguer produirait deux analyses du même fichier parce qu'elles ont été
 * demandées par deux chemins, ce qui est le défaut n°1 du CDC de refonte.
 *
 * L'origine non plus : elle décide si l'on déduplique, pas de ce qu'on
 * déduplique.
 */
export function dedupeKey(treatment: Treatment, scope: JobScope): string {
  const parts = [
    treatment,
    scope.accountId != null ? `a${scope.accountId}` : 'a*',
    scope.targetType ?? 't*',
    scope.targetId != null ? String(scope.targetId) : 'i*',
  ];
  return parts.join(':');
}

/**
 * Temporisation avant retour en file après échec (MOD-005).
 *
 * Progressive, plafonnée, et bruitée. Le plafond évite qu'un incident long
 * repousse la reprise à plusieurs heures ; le bruit évite que cent jobs
 * échoués au même instant repartent tous ensemble et refassent tomber ce qui
 * venait de se relever.
 */
export const MAX_ATTEMPTS = 5;
const BASE_DELAY_SECONDS = 30;
const MAX_DELAY_SECONDS = 30 * 60;

export function backoffSeconds(attempts: number, random: () => number = Math.random): number {
  const base = Math.min(BASE_DELAY_SECONDS * 2 ** Math.max(0, attempts - 1), MAX_DELAY_SECONDS);
  // ±20 % : suffisant pour disperser une reprise groupée, assez peu pour que la
  // date affichée au SCR-08 reste fidèle à ce qui va se passer.
  const jitter = 1 + (random() - 0.5) * 0.4;
  return Math.round(base * jitter);
}

/** MOD-005 : échec permanent après un nombre de cycles défini dans le code. */
export function isPermanentFailure(attempts: number): boolean {
  return attempts >= MAX_ATTEMPTS;
}

/**
 * Ce que devient un job après un échec.
 *
 * Rendu comme une décision, pas comme un effet : le dépôt écrit ce que cette
 * fonction dit, et un test peut vérifier la règle sans base.
 */
export interface FailureOutcome {
  status: Extract<JobStatus, 'PENDING' | 'FAILED'>;
  retryInSeconds: number | null;
  attempts: number;
}

export function afterFailure(attempts: number, random?: () => number): FailureOutcome {
  const next = attempts + 1;
  if (isPermanentFailure(next)) {
    return { status: 'FAILED', retryInSeconds: null, attempts: next };
  }
  return { status: 'PENDING', retryInSeconds: backoffSeconds(next, random), attempts: next };
}

/**
 * Un nouvel événement pertinent doit-il créer un job, en coalescer un, ou rien ?
 *
 * Le WF-10 distingue les trois cas, et c'est la distinction qui évite à la fois
 * les doublons et les analyses manquées. Un événement arrivé pendant une
 * exécution ne peut pas être ignoré — l'exécution en cours ne verra pas les
 * données qu'il annonce — mais il ne justifie pas un job par événement.
 */
export type QueueDecision = 'create' | 'coalesce' | 'skip';

export function decideQueueing(
  existing: { status: JobStatus } | null,
  origin: JobOrigin,
): QueueDecision {
  // WF-11 : le lancement manuel contourne la déduplication, toujours.
  if (origin === 'manual') return 'create';
  if (!existing) return 'create';
  if (existing.status === 'PENDING') return 'skip';
  if (existing.status === 'RUNNING') return 'coalesce';
  return 'create';
}

/**
 * Ordre de service : tête de file d'abord, puis FIFO (SCR-08).
 *
 * `head_priority` n'est pas une priorité manuelle — le §1.4 les exclut de la
 * V1. C'est la remise en tête d'une exécution interrompue par une
 * désactivation, un Emergency Stop ou un rollback : elle reprend sa place, elle
 * n'en gagne pas une meilleure.
 */
export function compareJobs(
  a: { headPriority: boolean; createdAt: Date },
  b: { headPriority: boolean; createdAt: Date },
): number {
  if (a.headPriority !== b.headPriority) return a.headPriority ? -1 : 1;
  return a.createdAt.getTime() - b.createdAt.getTime();
}
