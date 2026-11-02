/**
 * Contexte SERVEUR d'utilisation du compte technique de qualification — lot
 * 103G (ticket P1 « compte technique de qualification », point B).
 *
 * Les exemptions du compte technique (éligibilité C-Q10, plafond de coût)
 * n'existent QUE dans ce contexte, ouvert par le code serveur d'une campagne
 * de qualification (ou d'un test BO) APRÈS le précontrôle
 * `checkCorpusAccount` réussi. Un `accountId` transmis par un appelant — même
 * égal à `CORPUS_ACCOUNT_ID` — ne vaut jamais exemption hors de ce contexte.
 *
 * Module sans dépendance (AsyncLocalStorage seul) : importable par la
 * passerelle et par `processing-eligibility` sans cycle.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface TechnicalAccountContext {
  /** Compte technique VÉRIFIÉ (marqueur + identité) par le précontrôle. */
  accountId: number;
  /** Origine : campagne de qualification (n°), test BO… — journal seulement. */
  purpose: string;
}

const store = new AsyncLocalStorage<TechnicalAccountContext>();

/** Marque de provenance : seul un contrôle réussi ouvre le contexte. */
interface VerifiedCorpusAccount { ok: true; accountId: number | null }

/**
 * Exécute `fn` dans le contexte du compte technique vérifié. Refuse (lève) si
 * le contrôle n'a pas réussi : aucune exemption sans précontrôle.
 */
export function runWithTechnicalAccount<T>(verified: VerifiedCorpusAccount | { ok: boolean; accountId: number | null }, purpose: string, fn: () => T): T {
  if (!verified.ok || !verified.accountId) throw new Error('compte technique non vérifié : aucun contexte d’exemption');
  return store.run({ accountId: verified.accountId, purpose: purpose.slice(0, 120) }, fn);
}

/** Contexte courant (ou null). */
export function currentTechnicalAccountContext(): TechnicalAccountContext | null {
  return store.getStore() ?? null;
}

/** Ce compte est-il le compte technique VÉRIFIÉ du contexte serveur courant ? */
export function technicalAccountInContext(accountId: number | null | undefined): boolean {
  const c = store.getStore();
  return Boolean(c && accountId && c.accountId === accountId);
}
