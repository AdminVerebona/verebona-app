/**
 * Lancement manuel batch — CDC BO IA WF-11, OPS-016, T1-021, T1-UI-12,
 * T3-UI-08, T4-UI-07, WF-13 (lot IA 2).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUE LE CDC DEMANDE
 *
 * Choisir un compte, plusieurs comptes ou tout le périmètre pertinent ;
 * afficher une estimation ; confirmer ; créer une NOUVELLE exécution même si
 * un job automatique équivalent existe (bypass de la déduplication),
 * identifiable `origin = manual`. Seule précondition : pas d'arrêt d'urgence.
 * Un traitement désactivé ou suspendu ACCEPTE la demande (WF-07 : « continuer
 * d'accepter les nouvelles demandes ») : elle attend en file sa réactivation,
 * et l'écran le dit.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * PÉRIMÈTRE PAR TRAITEMENT
 *
 *   · T1 — un job par fichier non supprimé des comptes choisis (réanalyse).
 *     Non facturé au compte (`billable: false`) : c'est une décision
 *     d'exploitation, elle ne doit ni consommer les crédits d'analyse de
 *     l'utilisateur ni être refusée parce qu'il les a épuisés.
 *   · T3 — un contrôle compte complet par compte (même chemin que la route
 *     `reconciliation/accounts/[accountId]`).
 *   · T4 — NON lançable seul : ses entrées sont les candidats d'échéance
 *     produits par T1 et portés par le job (voir agenda/index.ts) ; les
 *     reconstruire depuis la base dégraderait T4. Un nouveau passage T4 se
 *     force par une réanalyse T1 du même périmètre, qui le met en file.
 *     Refus explicite plutôt qu'un bouton qui ne ferait rien.
 *
 * La configuration utilisée est celle de l'environnement au DÉMARRAGE du job
 * (WF-11 étape 67, VER-016) : rien n'est figé à la mise en file.
 */
import type { Treatment } from '../config/treatments';

export type ManualTreatment = 'T1' | 'T3';

export class ManualLaunchRefused extends Error {
  constructor(readonly code: 'EMERGENCY_STOP' | 'NOT_LAUNCHABLE' | 'EMPTY_SCOPE' | 'SCOPE_TOO_LARGE', message: string) {
    super(message);
    this.name = 'ManualLaunchRefused';
  }
}

/** Plafond d'un lancement : au-delà, découper (la file et le fournisseur suivent). */
export const MANUAL_LAUNCH_MAX_JOBS = 5_000;

export interface ManualScope {
  /** Comptes ciblés ; ignoré si `all`. */
  accountIds?: number[];
  /** Tout le périmètre pertinent du traitement. */
  all?: boolean;
}

export interface ManualLaunchDeps {
  emergencyStopActive(): Promise<boolean>;
  canStart(t: Treatment): Promise<boolean>;
  /** T1 : fichiers à réanalyser (id, compte). */
  listFiles(accountIds: number[] | null, limit: number): Promise<Array<{ id: number; accountId: number }>>;
  /** T3 : comptes pertinents (au moins un bien actif). */
  listAccounts(accountIds: number[] | null, limit: number): Promise<number[]>;
  enqueue: typeof import('./job-queue.repository').enqueue;
}

export interface ManualLaunchResult {
  treatment: ManualTreatment;
  dryRun: boolean;
  /** Estimation (dryRun) ou nombre de jobs créés. */
  objects: number;
  accounts: number;
  jobIds: number[];
  /** Traitement coupé (hors arrêt d'urgence) : les jobs attendront la réactivation. */
  waitsForReactivation: boolean;
}

export function assertLaunchable(treatment: string): asserts treatment is ManualTreatment {
  if (treatment === 'T4') {
    throw new ManualLaunchRefused(
      'NOT_LAUNCHABLE',
      'T4 ne se lance pas seul : ses entrées sont les échéances candidates produites par T1. '
      + 'Lancez une réanalyse T1 du même périmètre : chaque document réanalysé remet T4 en file.',
    );
  }
  if (treatment !== 'T1' && treatment !== 'T3') {
    throw new ManualLaunchRefused('NOT_LAUNCHABLE', `${treatment} n'est pas un traitement batch lançable.`);
  }
}

/** Normalise le périmètre : identifiants entiers positifs, dédoublonnés. */
export function normalizeScope(scope: ManualScope): number[] | null {
  if (scope.all) return null;
  const ids = [...new Set((scope.accountIds ?? []).filter((n) => Number.isInteger(n) && n > 0))];
  if (ids.length === 0) {
    throw new ManualLaunchRefused('EMPTY_SCOPE', 'Choisissez au moins un compte, ou tout le périmètre.');
  }
  return ids;
}

export async function launchManual(
  treatment: string,
  scope: ManualScope,
  adminUserId: number,
  options: { dryRun?: boolean },
  deps: ManualLaunchDeps,
): Promise<ManualLaunchResult> {
  assertLaunchable(treatment);
  const accountIds = normalizeScope(scope);

  // Précondition WF-11 : « traitement non bloqué par Emergency Stop ».
  if (await deps.emergencyStopActive()) {
    throw new ManualLaunchRefused('EMERGENCY_STOP', 'L’arrêt d’urgence est engagé : aucun lancement n’est accepté.');
  }
  const waitsForReactivation = !(await deps.canStart(treatment));

  // Un de plus que le plafond : savoir qu'on le dépasse sans tout charger.
  const probeLimit = MANUAL_LAUNCH_MAX_JOBS + 1;
  const objets: Array<{ accountId: number; fileId?: number }> = treatment === 'T1'
    ? (await deps.listFiles(accountIds, probeLimit)).map((f) => ({ accountId: f.accountId, fileId: f.id }))
    : (await deps.listAccounts(accountIds, probeLimit)).map((a) => ({ accountId: a }));

  if (objets.length > MANUAL_LAUNCH_MAX_JOBS) {
    throw new ManualLaunchRefused(
      'SCOPE_TOO_LARGE',
      `Plus de ${MANUAL_LAUNCH_MAX_JOBS} objets : découpez le lancement par comptes.`,
    );
  }
  const accounts = new Set(objets.map((o) => o.accountId)).size;
  if (options.dryRun) {
    return { treatment, dryRun: true, objects: objets.length, accounts, jobIds: [], waitsForReactivation };
  }
  if (objets.length === 0) {
    throw new ManualLaunchRefused('EMPTY_SCOPE', 'Aucun objet à traiter dans ce périmètre.');
  }

  const jobIds: number[] = [];
  for (const o of objets) {
    // `origin: 'manual'` : hors de l'index de déduplication (queue-policy) —
    // une nouvelle exécution même si un job automatique équivalent attend
    // (OPS-016 : « deux manuels possibles sur même périmètre »).
    const { jobId } = treatment === 'T1'
      ? await deps.enqueue({
        treatment: 'T1',
        scope: { accountId: o.accountId, targetType: 'asset_file', targetId: o.fileId! },
        origin: 'manual',
        triggerCode: 'manual',
        payload: { fileId: o.fileId, userId: null, origin: 'admin/manual', billable: false, requestedByUserId: adminUserId },
      })
      : await deps.enqueue({
        treatment: 'T3',
        scope: { accountId: o.accountId },
        origin: 'manual',
        triggerCode: 'manual',
        payload: { kind: 'account', scope: 'full', requestedByUserId: adminUserId },
      });
    if (jobId !== null) jobIds.push(jobId);
  }
  console.info(
    `[manual-launch] ${treatment} : ${jobIds.length} job(s) manuel(s) sur ${accounts} compte(s) par l'administrateur ${adminUserId}.`,
  );
  return { treatment, dryRun: false, objects: jobIds.length, accounts, jobIds, waitsForReactivation };
}

/** Dépendances branchées sur la base. */
export async function defaultManualLaunchDeps(): Promise<ManualLaunchDeps> {
  const [{ pgClient }, repo] = await Promise.all([import('@/db'), import('./job-queue.repository')]);
  return {
    emergencyStopActive: async () => (await repo.getEmergencyStop()).active,
    canStart: repo.canStart,
    enqueue: repo.enqueue,
    async listFiles(accountIds, limit) {
      const rows = (await pgClient.unsafe(
        `SELECT id, account_id FROM asset_files
          WHERE deleted_at IS NULL AND account_id IS NOT NULL
            AND ($1::int[] IS NULL OR account_id = ANY($1::int[]))
          ORDER BY account_id, id LIMIT $2`,
        [accountIds, limit] as never[],
      )) as unknown as Array<{ id: number; account_id: number }>;
      return rows.map((r) => ({ id: Number(r.id), accountId: Number(r.account_id) }));
    },
    async listAccounts(accountIds, limit) {
      const rows = (await pgClient.unsafe(
        `SELECT a.id FROM accounts a
          WHERE ($1::int[] IS NULL OR a.id = ANY($1::int[]))
            AND EXISTS (SELECT 1 FROM assets s WHERE s.account_id = a.id AND s.deleted_at IS NULL)
          ORDER BY a.id LIMIT $2`,
        [accountIds, limit] as never[],
      )) as unknown as Array<{ id: number }>;
      return rows.map((r) => Number(r.id));
    },
  };
}
