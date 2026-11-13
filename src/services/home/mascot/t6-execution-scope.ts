/**
 * Lot 113AO (Trello #748, B) — PORTÉE D'EXÉCUTION d'un traitement T6.
 *
 * Cause démontrée (appel 15112, trace 7084ff42…) : la fin d'une analyse T1
 * (`notifyLotCompleted`, travail de file `T1:job:3575`) programme la
 * pré-génération de la mascotte par une minuterie ; la minuterie, puis la
 * pré-génération et l'appel `t6_formulate`, HÉRITENT du contexte asynchrone du
 * travail T1 (AsyncLocalStorage) — exécution métier, job, tentative,
 * déclencheur, configuration figée. La trace rattachait donc l'appel T6 à
 * `T1:job:3575`, et l'exécution réelle `T6F:7084ff42…` comptait zéro appel.
 *
 * Tout traitement T6 (pré-génération, FORMULATE, EVALUATE) s'exécute désormais
 * dans SA portée : hors du travail de file, hors de l'instantané de
 * configuration de l'appelant, contexte métier T6 explicite. Le déclencheur
 * (T1…) est conservé à part, comme lien de causalité (`causedByExecutionId`).
 */
import { inheritedCausalExecutionId, runAsT6Execution } from '@/services/ai/business-execution/context';
import { runOutsideJobContext } from '@/services/ai/queue/job-context';
import { runOutsideConfigSnapshot } from '@/services/ai/config/execution-snapshot';

/** Exécute `fn` comme traitement T6 autonome ; `causedBy` : déclencheur (défaut : exécution non T6 du contexte). */
export function inT6Execution<T>(fn: () => Promise<T>, opts: { causedBy?: string | null } = {}): Promise<T> {
  const causedBy = opts.causedBy ?? inheritedCausalExecutionId();
  return runOutsideJobContext(() => runOutsideConfigSnapshot(() => runAsT6Execution(fn, { causedBy })));
}

/** Déclencheur métier du contexte courant (à mémoriser avec une demande différée), ou null. */
export function currentT6Trigger(): string | null {
  return inheritedCausalExecutionId();
}
