/**
 * « Reconsolider ce compte » — action BO (lot 48, O10 ; point ouvert du lot
 * 47 ; CDC Opérations V1 C26.2 « correction du code/données puis
 * reconsolidation », INV-032 ; décision PO Q9).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUE FAIT L'ACTION — ET CE QU'ELLE NE FAIT PAS
 *
 * Met en file, pour UN compte :
 *   · le travail T3 Opérations du compte (sorte `business_operations`
 *     existante, clé de déduplication par compte, `append_events`) avec
 *     l'événement C4 `admin_reconsolidation` : passage COMPLET (données
 *     structurées de tous les biens, attentes réexaminées, chaque Opération
 *     active recalculée depuis ses sources — `runOperationsJob`) ;
 *   · la projection Agenda complète du compte (sorte
 *     `business_operations_agenda`, dédoublonnée), même corrélation.
 *
 * Ce n'est PAS une édition d'Opération (Q9, INV-032) : aucune valeur n'est
 * saisie par l'administrateur, le moteur T3 de production recalcule l'état
 * depuis les preuves. Un compte déjà cohérent n'est pas modifié (INV-040).
 * Si un travail du compte attend déjà, la demande s'y ajoute (aucun doublon).
 * Arrêt d'urgence ou T3 coupé : la demande est acceptée et attend la
 * réactivation (WF-07), l'écran le dit.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { randomUUID } from 'node:crypto';

export interface AccountReconsolidationResult {
  accountId: number;
  /** Travail T3 Opérations (créé ou absorbant). */
  operationsJobId: number | null;
  /** Travail de projection Agenda (créé ou absorbant). */
  agendaJobId: number | null;
  correlationId: string;
  /** T3 ne peut pas démarrer maintenant (arrêt d'urgence, traitement coupé) : la demande attend. */
  waitsForReactivation: boolean;
}

export interface AccountReconsolidationDeps {
  accountExists(accountId: number): Promise<boolean>;
  requestOperations: typeof import('./consolidation/queue').requestOperationsConsolidation;
  requestAgenda: typeof import('./agenda-projection/queue').requestAgendaProjection;
  canStartT3(): Promise<boolean>;
}

async function defaultDeps(): Promise<AccountReconsolidationDeps> {
  const [{ pgClient }, ops, agenda, repo] = await Promise.all([
    import('@/db'),
    import('./consolidation/queue'),
    import('./agenda-projection/queue'),
    import('@/services/ai/queue/job-queue.repository'),
  ]);
  return {
    accountExists: async (id) => ((await pgClient.unsafe(`SELECT 1 FROM accounts WHERE id = $1`, [id] as never[])) as unknown as unknown[]).length > 0,
    requestOperations: ops.requestOperationsConsolidation,
    requestAgenda: agenda.requestAgendaProjection,
    canStartT3: () => repo.canStart('T3'),
  };
}

export class AccountNotFoundError extends Error {
  constructor(readonly accountId: number) {
    super(`Compte ${accountId} introuvable.`);
    this.name = 'AccountNotFoundError';
  }
}

/** Met en file la reconsolidation complète d'un compte (travail T3 + projection Agenda). */
export async function requestAccountReconsolidation(
  accountId: number, opts: { adminId: number }, deps?: AccountReconsolidationDeps,
): Promise<AccountReconsolidationResult> {
  if (!Number.isSafeInteger(accountId) || accountId <= 0) throw new AccountNotFoundError(accountId);
  const d = deps ?? await defaultDeps();
  if (!(await d.accountExists(accountId))) throw new AccountNotFoundError(accountId);
  const correlationId = `bo-reconsolidation:${accountId}:${opts.adminId}:${randomUUID()}`;
  const operationsJobId = await d.requestOperations(accountId, { trigger: 'admin_reconsolidation', correlationId });
  const agendaJobId = await d.requestAgenda(accountId, { all: true, correlationId });
  return { accountId, operationsJobId, agendaJobId, correlationId, waitsForReactivation: !(await d.canStartT3()) };
}
