/**
 * T3 — réconciliation globale au niveau du COMPTE.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * T1 produit les preuves ; T3 exploite les preuves existantes pour contrôler
 * la cohérence globale.
 *
 * Jusqu'ici, le moteur ne tournait que bien par bien, juste après une
 * analyse T1 (`reconcileAsset` sur le bien du document). Rien ne contrôlait
 * la cohérence d'un compte indépendamment du dernier document traité.
 *
 * `reconcileAccount` est un ORCHESTRATEUR, pas un second moteur :
 *   · il sélectionne le périmètre (tous les biens éligibles, ou un périmètre
 *     incrémental) ;
 *   · il exécute pour chacun le moteur commun (`reconcileAsset` : matrice
 *     d'autorité, normalisation, décision, conflits, protection des valeurs
 *     utilisateur, résolution IA éventuelle, pont « À traiter ») ;
 *   · il consolide les résultats, objet par objet, sans qu'une erreur sur un
 *     bien n'interrompe les autres ;
 *   · il trace une exécution globale, à laquelle chaque run local est
 *     rattaché (reconciliation_runs.account_run_id).
 *
 * Il ne relit AUCUN fichier et ne relance aucune extraction : s'il manque une
 * preuve, le moteur le constate.
 *
 * Lot 34E (réconciliation CONTINUE) : après les biens, l'exécution reprend la
 * CONNAISSANCE OUVERTE du compte (`continuous/open-knowledge.service.ts`) —
 * faits sans cible rapprochables d'un équipement / d'un bien, documents en
 * NO_CANDIDATE / ABSTAINED / MULTI_ASSET dont le contexte pertinent a changé
 * depuis la révision de connaissance évaluée. Déterministe d'abord ; un
 * contexte inchangé est confirmé sans IA.
 *
 * Lot 49B (ticket « T3 — Réexaminer systématiquement les À traiter ouverts ») :
 * phase « OPEN ACTIONS » en fin d'exécution (`continuous/open-actions.service.ts`)
 * — TOUTES les lignes « À traiter » ouvertes du compte sont parcourues et
 * routées vers leur résolveur (LINK-ASSET réexaminé à chaque passage, même à
 * empreinte identique) ; le périmètre des biens comprend ceux qui portent une
 * carte DATA-* ouverte (réconciliation T3 du bien à chaque passage).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { OUT_OF_PORTFOLIO_ASSET_STATUSES } from '@/lib/asset-status';
import { randomUUID } from 'crypto';
import { pgClient } from '@/db';
import type { ReconcileInput } from './reconciliation-engine';
import type { ReconciliationRun } from './types';
import { isExecutionCancelled } from '../queue/execution-control';
import { envNumber } from '@/lib/env-number';

export type T3TriggerType = 'manual' | 'scheduled' | 'event';

export interface T3Trigger {
  type: T3TriggerType;
  /** Événement métier (event) : document_linked, document_unlinked, arbitration, asset_updated… */
  event?: string;
  objectType?: 'asset' | 'document' | 'equipment' | 'to_process_action';
  objectId?: number;
  correlationId?: string;
  requestedByUserId?: number | null;
}

export type ObjectOutcome = 'SUCCESS' | 'CONFLICT' | 'ERROR' | 'SKIPPED';

export interface ObjectResult {
  objectType: 'asset';
  objectId: number;
  status: ObjectOutcome;
  localRunId?: number;
  applied: number;
  conflicts: number;
  aiReviews: number;
  reason?: string;
}

export interface AccountRunResult {
  runId: number;
  accountId: number;
  triggerType: T3TriggerType;
  scope: 'full' | 'incremental';
  /** `skipped_blocked` : T3 désactivé, suspendu, ou arrêt d'urgence (OPS-008, OPS-011). */
  status: 'completed' | 'partial' | 'failed' | 'skipped_concurrent' | 'skipped_blocked';
  startedAt: string;
  finishedAt: string;
  objectsExamined: number;
  objectsModified: number;
  decisionsApplied: number;
  conflictsCreated: number;
  arbitrationsNeeded: number;
  errors: number;
  aiCalls: number;
  details: ObjectResult[];
  /** Connaissance ouverte reprise (lot 34E) ; absente si la phase n'a pas tourné. */
  openKnowledge?: import('./continuous/open-knowledge.service').OpenKnowledgeResult;
  /** Lot 49B : lignes « À traiter » ouvertes examinées ; absente si la phase n'a pas tourné. */
  openActions?: import('./continuous/open-actions.service').OpenActionsResult;
  /** Lot 61 : harmonisation du nommage documentaire ; absente si la phase n'a pas tourné. */
  documentNaming?: import('./document-naming/phase').DocumentNamingPhaseResult;
  /** Lot 57B : état de CHAQUE phase obligatoire (jamais « non exécutée » présentée comme « zéro résultat »). */
  phases?: RunPhases;
  /** Lot 57B : réussite complète, partielle, abstention métier ou échec technique. */
  outcome?: RunOutcome;
}

/**
 * Lot 57B (défaut A) — phases d'un passage T3 global. `NOT_RUN` : la phase n'a
 * pas été exécutée (interruption, phase précédente en échec, dépendance
 * absente) ; `FAILED` : elle a levé ; `PARTIAL` : certaines cartes / certains
 * biens en erreur ; `NOT_CONFIGURED` : phase absente de cet orchestrateur
 * (tests), jamais obligatoire.
 */
export type PhaseStatus = 'DONE' | 'PARTIAL' | 'FAILED' | 'NOT_RUN' | 'NOT_CONFIGURED' | 'DEFERRED';
/**
 * Lot 72B (E8) : `DEFERRED` — phase FACULTATIVE dont le travail reste dû
 * (plafond, délai de reprise, prompt inutilisable) sans échec : jamais DONE,
 * jamais un échec du passage. `state` : état détaillé de la phase, identique
 * à celui du rapport d'exécution et de la synthèse du job.
 */
export interface PhaseReport { status: PhaseStatus; error: string | null; counts?: Record<string, number>; state?: string }
export type RunPhaseName = 'ASSETS' | 'OPEN_KNOWLEDGE' | 'OPEN_ACTIONS' | 'JOURNAL';
/**
 * Lot 61 : phase FACULTATIVE `DOCUMENT_NAMING` (harmonisation du nommage
 * documentaire) — jamais obligatoire : son échec rend le passage partiel,
 * jamais en échec technique, et n'interrompt aucune autre mission.
 */
export type RunPhases = Record<RunPhaseName, PhaseReport> & {
  DOCUMENT_NAMING?: PhaseReport;
  /**
   * Lot 76J : rattrapage automatique du contrôle exhaustif de l'onglet
   * « Informations » (stock historique) — FACULTATIF : DONE quand plus aucun
   * bien n'attend, DEFERRED (reprise au passage suivant, quota par passage)
   * sinon ; jamais un échec du passage.
   */
  INFORMATION_BACKFILL?: PhaseReport;
};
export type RunOutcome = 'SUCCESS' | 'PARTIAL_SUCCESS' | 'BUSINESS_ABSTENTION' | 'TECHNICAL_FAILURE';

/**
 * Issue d'un passage (pure, testée). Une phase obligatoire en échec ou non
 * exécutée → TECHNICAL_FAILURE (le journal seul en échec : PARTIAL_SUCCESS —
 * les écritures métier sont faites, la traçabilité est dégradée) ; une phase
 * partielle → PARTIAL_SUCCESS ; sinon des cartes encore ouvertes faute de
 * preuve → BUSINESS_ABSTENTION ; sinon SUCCESS.
 */
export function runOutcome(phases: RunPhases, p: { changes: number; keptOpen: number }): RunOutcome {
  const obligatoires: RunPhaseName[] = ['ASSETS', 'OPEN_KNOWLEDGE', 'OPEN_ACTIONS'];
  if (obligatoires.some((n) => phases[n].status === 'FAILED' || phases[n].status === 'NOT_RUN')) return 'TECHNICAL_FAILURE';
  if (Object.values(phases).some((ph) => ph.status === 'PARTIAL' || ph.status === 'FAILED')) return 'PARTIAL_SUCCESS';
  if (p.keptOpen > 0 && p.changes === 0) return 'BUSINESS_ABSTENTION';
  return 'SUCCESS';
}

/** Phases mises à jour par l'orchestrateur (pure). */
export function initialPhases(deps: Pick<AccountReconciliationDeps, 'reconcileOpenKnowledge' | 'reconcileOpenActions' | 'reconcileDocumentNaming'>): RunPhases {
  return {
    ASSETS: { status: 'NOT_RUN', error: null },
    OPEN_KNOWLEDGE: { status: deps.reconcileOpenKnowledge ? 'NOT_RUN' : 'NOT_CONFIGURED', error: null },
    OPEN_ACTIONS: { status: deps.reconcileOpenActions ? 'NOT_RUN' : 'NOT_CONFIGURED', error: null },
    JOURNAL: { status: deps.reconcileOpenActions ? 'NOT_RUN' : 'NOT_CONFIGURED', error: null },
    ...(deps.reconcileDocumentNaming ? { DOCUMENT_NAMING: { status: 'NOT_RUN' as const, error: null } } : {}),
  };
}

/**
 * Lot 72B (E8) — phase DOCUMENT_NAMING du passage (pure) : jamais DONE tant
 * qu'il reste des lots à examiner, des écritures à reprendre ou un stock non
 * couvert ; motifs et travail restant chiffrés.
 */
export function documentNamingPhaseReport(dn: import('./document-naming/phase').DocumentNamingPhaseResult): PhaseReport {
  const status: PhaseStatus = dn.status === 'DISABLED' ? 'NOT_CONFIGURED' : dn.status === 'NOT_READY' ? 'NOT_RUN' : dn.status;
  const motifs = Object.entries(dn.remaining?.byReason ?? {}).map(([k, v]) => `${k} ${v}`).join(', ');
  const error = dn.status === 'NOT_READY' ? 'migrations 0450 / 0513 absentes : harmonisation non exécutée'
    : dn.status === 'DONE' || dn.status === 'DISABLED' ? null
      : [
        dn.errors > 0 ? `${dn.errors} lot(s) en erreur` : null,
        dn.failed > 0 ? `${dn.failed} écriture(s) en échec` : null,
        dn.renamesSectionMissing > 0 ? `${dn.renamesSectionMissing} sortie(s) IA incomplète(s)` : null,
        dn.remaining?.groups ? `${dn.remaining.groups} lot(s) / ${dn.remaining.documents} document(s) restant(s)${motifs ? ` (${motifs})` : ''}` : null,
        dn.scan && !dn.scan.complete ? 'lecture du stock en cours' : null,
        // Lot 76B (C1, C2, C5).
        dn.pendingWrites ? `${dn.pendingWrites} écriture(s) à reprendre` : null,
        dn.decisionsUnsaved ? `${dn.decisionsUnsaved} décision(s) non sauvegardée(s) : réexamen IA` : null,
        dn.upgrade?.totals.expected ? `contexte enrichi : ${dn.upgrade.totals.expected} réexamen(s) attendu(s), ${dn.upgrade.totals.reviewed} effectué(s), ${dn.upgrade.totals.technical} migration(s) technique(s)` : null,
      ].filter(Boolean).join(' ; ') || null;
  return {
    status, state: dn.status, error,
    counts: {
      groupsDue: dn.groupsDue, groupsExamined: dn.groupsExamined, proposals: dn.proposals, applied: dn.applied,
      refused: dn.refused, conflicts: dn.conflicts, failed: dn.failed, aiCalls: dn.aiCalls, deferred: dn.deferred,
      promptUnavailable: dn.promptAvailable === false ? 1 : 0, renamesSectionMissing: dn.renamesSectionMissing,
      pendingWrites: dn.pendingWrites ?? 0, writesRetried: dn.writesRetried ?? 0,
      remainingGroups: dn.remaining?.groups ?? 0, remainingDocuments: dn.remaining?.documents ?? 0,
      documents: dn.documents, scanComplete: dn.scan?.complete ? 1 : 0,
      decisionsUnsaved: dn.decisionsUnsaved ?? 0, documentsRevalidated: dn.documentsRevalidated ?? 0,
      upgradeTechnical: dn.upgrade?.totals.technical ?? 0, upgradeExpected: dn.upgrade?.totals.expected ?? 0, upgradeReviewed: dn.upgrade?.totals.reviewed ?? 0,
    },
  };
}

/** Au-delà, un run « en cours » est réputé abandonné (processus arrêté). */
export const STALE_RUN_MINUTES = 30;

/** Correspondance déclencheur T3 → origine tracée du run local. */
const LOCAL_TRIGGER: Record<T3TriggerType, ReconcileInput['triggeredBy']> = {
  manual: 'manual',
  scheduled: 'scheduled',
  event: 'field_changed',
};

export interface AccountReconciliationDeps {
  reconcile(input: ReconcileInput): Promise<ReconciliationRun>;
  /** Connaissance ouverte (lot 34E). Absente : phase omise (tests de l'orchestrateur). */
  reconcileOpenKnowledge?: typeof import('./continuous/open-knowledge.service').reconcileOpenKnowledge;
  /** Lot 49B : phase « open actions ». Absente : phase omise (tests de l'orchestrateur). */
  reconcileOpenActions?: typeof import('./continuous/open-actions.service').reconcileOpenToProcessActions;
  /** Lot 61 : harmonisation du nommage documentaire. Absente : phase omise (tests de l'orchestrateur). */
  reconcileDocumentNaming?: typeof import('./document-naming/phase').runDocumentNamingPhase;
}

const defaultDeps: AccountReconciliationDeps = {
  async reconcile(input) {
    const { reconcileAsset } = await import('./reconciliation-engine');
    return reconcileAsset(input);
  },
  async reconcileOpenKnowledge(accountId, opts) {
    const { reconcileOpenKnowledge } = await import('./continuous/open-knowledge.service');
    return reconcileOpenKnowledge(accountId, opts);
  },
  async reconcileOpenActions(accountId, opts) {
    const { reconcileOpenToProcessActions } = await import('./continuous/open-actions.service');
    return reconcileOpenToProcessActions(accountId, opts);
  },
  async reconcileDocumentNaming(accountId, opts) {
    const { runDocumentNamingPhase } = await import('./document-naming/phase');
    return runDocumentNamingPhase(accountId, opts);
  },
};

/** Règles « À traiter » d'une donnée de BIEN décidée par T3 (producteur RECONCILIATION_BRIDGE). */
async function assetDataRuleCodes(): Promise<string[]> {
  const { PROCESSING_RULES } = await import('@/services/to-process/rules-catalog');
  return PROCESSING_RULES.filter((r) => r.producer === 'RECONCILIATION_BRIDGE' && r.targetType === 'ASSET').map((r) => r.code);
}

/** Consolidation — pure, testée sans base. */
export function consolidate(details: ObjectResult[]): Pick<AccountRunResult,
  'objectsExamined' | 'objectsModified' | 'decisionsApplied' | 'conflictsCreated' | 'arbitrationsNeeded' | 'errors' | 'aiCalls' | 'status'> {
  const examined = details.filter((d) => d.status !== 'SKIPPED');
  const errors = details.filter((d) => d.status === 'ERROR').length;
  return {
    objectsExamined: examined.length,
    objectsModified: details.filter((d) => d.applied > 0).length,
    decisionsApplied: details.reduce((n, d) => n + d.applied, 0),
    conflictsCreated: details.reduce((n, d) => n + d.conflicts, 0),
    arbitrationsNeeded: details.filter((d) => d.conflicts > 0).length,
    errors,
    aiCalls: details.reduce((n, d) => n + d.aiReviews, 0),
    status: errors === 0 ? 'completed' : errors < examined.length ? 'partial' : 'failed',
  };
}

// ── Périmètre ──────────────────────────────────────────────────────────────

interface Candidate {
  id: number; eligible: boolean; reason?: string;
  /** Lot 76J : retenu par le seul rattrapage du stock (sans revue IA). */
  backfill?: boolean;
}

/** Lot 76J : rattrapage du contrôle exhaustif de l'onglet « Informations » (périmètre du passage). */
interface BackfillScope { selected: number[]; remaining: number }

/**
 * Objets à examiner. `full` : tous les biens du compte. `incremental` :
 * biens modifiés depuis la dernière exécution T3 réussie, biens ayant reçu
 * une preuve depuis, biens portant un conflit ouvert, et l'objet déclencheur.
 * L'incrémental est une STRATÉGIE : sans exécution de référence, tout est
 * examiné.
 */
async function selectScope(accountId: number, scope: 'full' | 'incremental', trigger: T3Trigger): Promise<{ candidates: Candidate[]; backfill: BackfillScope | null }> {
  const all = (await pgClient.unsafe(
    `SELECT id, coalesce(status, 'EN_SERVICE') AS status, updated_at
       FROM assets WHERE account_id = $1 AND deleted_at IS NULL ORDER BY id`,
    [accountId] as never[],
  )) as unknown as Array<{ id: number; status: string; updated_at: Date | null }>;

  let retenus = new Set(all.map((a) => a.id));
  // Lot 76J : tout le compte est examiné (complet, ou sans passage de référence).
  let toutLeCompte = true;
  if (scope === 'incremental') {
    const [last] = (await pgClient.unsafe(
      `SELECT max(finished_at) AS at FROM account_reconciliation_runs
        WHERE account_id = $1 AND status IN ('completed', 'partial')`,
      [accountId] as never[],
    )) as unknown as Array<{ at: Date | null }>;
    if (last?.at) {
      toutLeCompte = false;
      const since = new Date(last.at).toISOString();
      const touches = (await pgClient.unsafe(
        `SELECT DISTINCT id FROM (
           SELECT a.id FROM assets a WHERE a.account_id = $1 AND a.updated_at > $2::timestamptz
           UNION SELECT fe.asset_id FROM field_evidence fe WHERE fe.account_id = $1 AND fe.extracted_at > $2::timestamptz
           UNION SELECT c.asset_id FROM inconsistency_registry c WHERE c.account_id = $1 AND c.status = 'open'
         ) s WHERE id IS NOT NULL`,
        [accountId, since] as never[],
      ).catch(() => all.map((a) => ({ id: a.id })))) as unknown as Array<{ id: number }>;
      retenus = new Set(touches.map((t) => t.id));
      if (trigger.objectType === 'asset' && trigger.objectId) retenus.add(trigger.objectId);
      // Lot 49B : un bien qui porte une carte DATA-* ouverte (problème actif)
      // est réconcilié à CHAQUE passage, même sans modification.
      const ouverts = (await pgClient.unsafe(
        `SELECT DISTINCT target_id AS id FROM to_process_actions
          WHERE account_id = $1 AND target_type = 'ASSET' AND resolved_at IS NULL AND rule_code = ANY($2::text[])`,
        [accountId, await assetDataRuleCodes()] as never[],
      ).catch(() => [])) as unknown as Array<{ id: number }>;
      for (const o of ouverts) retenus.add(Number(o.id));
      // Lot 76J : agenda « achat », Opérations d'acquisition, candidats
      // Opération modifiés depuis → confrontation de l'onglet « Informations ».
      const { assetsWithChangedSources } = await import('./information-check/store');
      for (const id of await assetsWithChangedSources(accountId, since)) retenus.add(id);
    }
  }

  // Lot 76J : RATTRAPAGE AUTOMATIQUE du stock — biens jamais contrôlés dans
  // la version courante du contrôle exhaustif, au plus N par passage
  // (`T3_INFORMATION_BACKFILL_MAX_ASSETS`) ; reprenable (marque écrite après
  // un contrôle complet). Sans revue IA : aucune réanalyse, aucun appel.
  let backfill: BackfillScope | null = null;
  const rattrapage = new Set<number>();
  try {
    const store = await import('./information-check/store');
    const b = await store.backfillScope(accountId, toutLeCompte ? 100_000 : store.informationBackfillMaxAssets(), OUT_OF_PORTFOLIO_ASSET_STATUSES);
    if (b) {
      backfill = { selected: b.ids, remaining: b.remaining };
      for (const id of b.ids) if (!retenus.has(id)) { rattrapage.add(id); retenus.add(id); }
    }
  } catch (e) {
    console.error(`[t3] rattrapage « Informations » du compte ${accountId} non évalué :`, (e as Error).message);
  }

  const candidates = all
    .filter((a) => retenus.has(a.id))
    .map((a) => (OUT_OF_PORTFOLIO_ASSET_STATUSES as readonly string[]).includes(a.status)
      ? { id: a.id, eligible: false, reason: `bien ${a.status.toLowerCase()}` }
      : { id: a.id, eligible: true, ...(rattrapage.has(a.id) ? { backfill: true } : {}) });
  return { candidates, backfill };
}

// ── Exécution ──────────────────────────────────────────────────────────────

/**
 * Prend l'exécution du compte : au plus une en cours. Une exécution restée
 * « running » au-delà de STALE_RUN_MINUTES est close en échec (processus
 * arrêté) avant une nouvelle tentative.
 *
 * Lot 52A (NR-10) : une exécution « running » portée par un job de file qui
 * n'est plus RUNNING avec le même jeton (processus tué par un redéploiement,
 * job repris après expiration du bail) est ORPHELINE : close tout de suite.
 * Avant, elle bloquait le compte 30 minutes — plus que les cinq tentatives du
 * job repris (≈ 7 min 30 de backoff) : le job passait FAILED « exécution T3
 * déjà en cours » sans jamais avoir été exécuté.
 */
export function orphanRunCleanupSql(withQueueLink: boolean): string {
  return `UPDATE account_reconciliation_runs r SET status = 'failed', finished_at = now()
      WHERE r.account_id = $1 AND r.status = 'running'
        AND (r.started_at < now() - ($2 || ' minutes')::interval${withQueueLink ? `
             OR (r.queue_job_id IS NOT NULL AND NOT EXISTS (
                   SELECT 1 FROM ai_job_queue q
                    WHERE q.id = r.queue_job_id AND q.status = 'RUNNING'
                      AND q.execution_id IS NOT DISTINCT FROM r.queue_execution_id))` : ''})`;
}

const colonneAbsente = (e: unknown) => (e as { code?: string })?.code === '42703';

async function claim(
  accountId: number, trigger: T3Trigger, scope: 'full' | 'incremental', queuedId?: number,
  queueJob?: { id: number; executionId: string | null } | null,
): Promise<number | null> {
  // Colonnes de la migration 0338 absentes (déploiement partiel) : règle historique seule.
  await pgClient.unsafe(orphanRunCleanupSql(true), [accountId, String(STALE_RUN_MINUTES)] as never[])
    .catch(async (e) => {
      if (!colonneAbsente(e)) throw e;
      await pgClient.unsafe(orphanRunCleanupSql(false), [accountId, String(STALE_RUN_MINUTES)] as never[]);
    });
  try {
    if (queuedId) {
      const rows = (await pgClient.unsafe(
        `UPDATE account_reconciliation_runs SET status = 'running', started_at = now()
          WHERE id = $1 AND status = 'queued' RETURNING id`,
        [queuedId] as never[],
      )) as unknown as Array<{ id: number }>;
      return rows[0]?.id ?? null;
    }
    const valeurs = [accountId, trigger.type, trigger.event ?? null, trigger.objectType ?? null, trigger.objectId ?? null,
      trigger.correlationId ?? randomUUID(), trigger.requestedByUserId ?? null, scope];
    const inserer = (avecLien: boolean) => pgClient.unsafe(
      avecLien
        ? `INSERT INTO account_reconciliation_runs
             (account_id, trigger_type, trigger_event, trigger_object_type, trigger_object_id, correlation_id,
              requested_by_user_id, scope, status, started_at, queue_job_id, queue_execution_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'running', now(), $9, $10::uuid) RETURNING id`
        : `INSERT INTO account_reconciliation_runs
             (account_id, trigger_type, trigger_event, trigger_object_type, trigger_object_id, correlation_id,
              requested_by_user_id, scope, status, started_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'running', now()) RETURNING id`,
      (avecLien ? [...valeurs, queueJob?.id ?? null, queueJob?.executionId ?? null] : valeurs) as never[],
    ) as unknown as Promise<Array<{ id: number }>>;
    const rows = queueJob
      ? await inserer(true).catch((e) => { if (colonneAbsente(e)) return inserer(false); throw e; })
      : await inserer(false);
    return rows[0]?.id ?? null;
  } catch (e) {
    // Violation de l'unicité « une exécution en cours par compte ».
    if (/account_reconciliation_runs_one_running|duplicate key/.test((e as Error).message)) return null;
    throw e;
  }
}

/**
 * T3 peut-il démarrer une exécution ? (CDC BO IA OPS-008, OPS-011, WF-07, WF-08)
 *
 * Jusqu'ici, T3 ne lisait ni son état ni l'arrêt d'urgence : le bouton
 * « Désactiver T3 » était sans effet. Base illisible : on laisse passer — les
 * appels modèle restent de toute façon filtrés par la garde de la passerelle.
 */
async function t3PeutDemarrer(): Promise<boolean> {
  try {
    const { canStart } = await import('../queue/job-queue.repository');
    return await canStart('T3');
  } catch (e) {
    console.warn('[t3] état du traitement illisible, démarrage autorisé :', (e as Error).message);
    return true;
  }
}

export async function reconcileAccount(
  accountId: number,
  trigger: T3Trigger,
  options: {
    scope?: 'full' | 'incremental'; queuedRunId?: number; userId?: number;
    /** Garde d'exécution de la file (rollback, arrêt d'urgence, désactivation). */
    guard?: import('../queue/execution-control').ExecutionGuard;
    /** Déclencheur du travail (monitoring des reprises de connaissance ouverte). */
    triggerCode?: string | null;
    /** Lot 52A : job de file porteur (exécution orpheline reconnue après un redéploiement). */
    queueJob?: { id: number; executionId: string | null } | null;
  } = {},
  deps: AccountReconciliationDeps = defaultDeps,
): Promise<AccountRunResult> {
  const scope = options.scope ?? (trigger.type === 'manual' ? 'full' : 'incremental');
  const startedAt = new Date().toISOString();
  // Aucun démarrage si T3 est coupé : la demande en file (`queued`) n'est pas
  // réclamée, elle reste en attente et sera exécutée à la réactivation (WF-07).
  if (!(await t3PeutDemarrer())) {
    return {
      runId: 0, accountId, triggerType: trigger.type, scope, status: 'skipped_blocked', startedAt, finishedAt: startedAt,
      objectsExamined: 0, objectsModified: 0, decisionsApplied: 0, conflictsCreated: 0, arbitrationsNeeded: 0,
      errors: 0, aiCalls: 0, details: [],
    };
  }
  const runId = await claim(accountId, trigger, scope, options.queuedRunId, options.queueJob ?? null);
  if (!runId) {
    return {
      runId: 0, accountId, triggerType: trigger.type, scope, status: 'skipped_concurrent', startedAt, finishedAt: startedAt,
      objectsExamined: 0, objectsModified: 0, decisionsApplied: 0, conflictsCreated: 0, arbitrationsNeeded: 0,
      errors: 0, aiCalls: 0, details: [],
    };
  }

  const details: ObjectResult[] = [];
  let openKnowledge: AccountRunResult['openKnowledge'];
  let openActions: AccountRunResult['openActions'];
  let documentNaming: AccountRunResult['documentNaming'];
  const debutPassage = new Date();
  const phases = initialPhases(deps);
  // Lot 31C : une exécution INTERROMPUE (jeton révoqué, garde) ou arrêtée par
  // une erreur n'est jamais journalisée « completed » — sinon le travail remis
  // en file la croirait achevée (SUPERSEDED) alors qu'une partie des biens
  // n'a pas été vue.
  let interrompue = false;
  try {
    const { candidates, backfill } = await selectScope(accountId, scope, trigger);
    for (const c of candidates) {
      if (!c.eligible) {
        details.push({ objectType: 'asset', objectId: c.id, status: 'SKIPPED', applied: 0, conflicts: 0, aiReviews: 0, reason: c.reason });
        continue;
      }
      // Interrompue par l'administration (WF-06, WF-07) : aucun bien de plus
      // n'est réconcilié. L'erreur remonte au boucleur, qui ne clôt pas le job.
      if (options.guard) await options.guard.assertActive(`bien ${c.id}`);
      try {
        const run = await deps.reconcile({
          accountId, assetId: c.id, userId: options.userId ?? trigger.requestedByUserId ?? undefined,
          triggeredBy: LOCAL_TRIGGER[trigger.type], accountRunId: runId,
          ...(c.backfill ? { aiReview: false } : {}),
        });
        details.push({
          objectType: 'asset', objectId: c.id, localRunId: run.runId,
          status: run.conflictCount > 0 ? 'CONFLICT' : 'SUCCESS',
          applied: run.appliedCount, conflicts: run.conflictCount, aiReviews: run.aiReviewCount,
        });
      } catch (e) {
        // Interruption (jeton révoqué, garde AI_BLOCKED) : on s'arrête là,
        // sans compter le bien en erreur ; le job est remis en file par le
        // boucleur (execution-control, MOD-005).
        if (isExecutionCancelled(e)) throw e;
        // L'échec d'un bien n'empêche pas les autres d'être traités.
        details.push({ objectType: 'asset', objectId: c.id, status: 'ERROR', applied: 0, conflicts: 0, aiReviews: 0, reason: (e as Error).message.slice(0, 300) });
        // Lot 76J : un bien du rattrapage en échec repasse APRÈS les autres (quota jamais bloqué).
        if (backfill?.selected.includes(c.id)) {
          await (await import('./information-check/store')).recordBackfillFailure(accountId, c.id).catch(() => {});
        }
      }
    }
    if (backfill) {
      const restant = backfill.remaining;
      phases.INFORMATION_BACKFILL = {
        status: restant > 0 ? 'DEFERRED' : 'DONE', state: restant > 0 ? 'DEFERRED' : 'DONE',
        error: restant > 0 ? `${restant} bien(s) restant(s) à contrôler (rattrapage borné, repris au passage suivant)` : null,
        counts: { selected: backfill.selected.length, remaining: restant },
      };
    }
    {
      const t = consolidate(details);
      phases.ASSETS = {
        status: t.errors === 0 ? 'DONE' : t.status === 'failed' ? 'FAILED' : 'PARTIAL',
        error: t.errors ? `${t.errors} bien(s) en erreur` : null,
        counts: { examined: t.objectsExamined, modified: t.objectsModified, errors: t.errors },
      };
    }
    // Connaissance ouverte (lot 34E) : faits sans cible, documents non
    // résolus dont le contexte a changé. Non bloquante (sauf interruption).
    if (deps.reconcileOpenKnowledge) {
      if (options.guard) await options.guard.assertActive('connaissance ouverte du compte');
      try {
        openKnowledge = await deps.reconcileOpenKnowledge(accountId, { guard: options.guard, triggerCode: options.triggerCode ?? null });
        phases.OPEN_KNOWLEDGE = { status: 'DONE', error: null };
      } catch (e) {
        if (isExecutionCancelled(e)) throw e;
        // Lot 57B (défaut A) : l'échec est porté par le statut du passage (jamais masqué).
        phases.OPEN_KNOWLEDGE = { status: 'FAILED', error: (e as Error).message.slice(0, 300) };
        console.error(`[t3] connaissance ouverte du compte ${accountId} non reprise :`, (e as Error).message);
      }
    }
    // Lot 49B : toutes les lignes « À traiter » ouvertes, à chaque passage.
    // Lot 54A (écart 5) — CONTRAT : tout passage T3 GLOBAL du compte (manuel,
    // planifié, réconciliation globale) passe ICI et réexamine TOUS les « À
    // traiter » ouverts ; les sous-jobs spécialisés (DOCUMENT_ASSET, ASSET,
    // ENTITY, BUSINESS_OPERATIONS…) ne relancent jamais l'ensemble du compte.
    if (deps.reconcileOpenActions) {
      if (options.guard) await options.guard.assertActive('« À traiter » ouverts du compte');
      try {
        openActions = await deps.reconcileOpenActions(accountId, {
          guard: options.guard, triggerCode: options.triggerCode ?? null, runStartedAt: debutPassage,
          reconciledAssetIds: new Set(details.filter((d) => d.status !== 'SKIPPED').map((d) => d.objectId)),
          // Lot 54A (écart 6) : journal durable rattaché au passage et au job porteur.
          accountRunId: runId, queueJobId: options.queueJob?.id ?? null,
        });
        const oa = openActions;
        phases.OPEN_ACTIONS = {
          status: oa.errors > 0 ? 'PARTIAL' : 'DONE', error: oa.errors > 0 ? `${oa.errors} carte(s) en erreur` : null,
          counts: {
            openAtStart: oa.openAtStart, examined: oa.examined, resolutionAttempted: oa.resolutionAttempted, resolved: oa.resolved,
            keptAmbiguous: oa.keptAmbiguous, delegated: oa.delegated, stalledRecovered: oa.stalledRecovered, errors: oa.errors, aiCalls: oa.aiCalls,
          },
        };
        phases.JOURNAL = {
          status: oa.journalStatus === 'OK' ? 'DONE' : oa.journalStatus === 'PARTIAL' ? 'PARTIAL' : 'FAILED',
          error: oa.journalError, counts: { journaled: oa.journaled ?? 0 },
        };
      } catch (e) {
        if (isExecutionCancelled(e)) throw e;
        // Lot 57B (défaut A) : phase obligatoire en échec → passage en échec technique (repris par la file).
        phases.OPEN_ACTIONS = { status: 'FAILED', error: (e as Error).message.slice(0, 300) };
        console.error(`[t3] « À traiter » ouverts du compte ${accountId} non réexaminés :`, (e as Error).message);
      }
    }
    // Lot 61 : harmonisation du nommage documentaire — EN DERNIER et isolée :
    // les autres missions sont faites quoi qu'il arrive ici ; une erreur rend
    // le passage partiel (jamais un échec technique, jamais une interruption).
    if (deps.reconcileDocumentNaming) {
      if (options.guard) await options.guard.assertActive('harmonisation documentaire du compte');
      try {
        const dn = await deps.reconcileDocumentNaming(accountId, {
          guard: options.guard, accountRunId: runId, triggerCode: options.triggerCode ?? null,
        });
        documentNaming = dn;
        phases.DOCUMENT_NAMING = documentNamingPhaseReport(dn);
      } catch (e) {
        if (isExecutionCancelled(e)) throw e;
        phases.DOCUMENT_NAMING = { status: 'FAILED', error: (e as Error).message.slice(0, 300) };
        console.error(`[t3] harmonisation documentaire du compte ${accountId} en échec :`, (e as Error).message);
      }
    }
  } catch (e) {
    interrompue = true;
    throw e;
  } finally {
    const totals = consolidate(details);
    const issue = interrompue ? 'TECHNICAL_FAILURE' as const : issueDu(phases, totals, openActions);
    const statut = interrompue ? 'failed' : statutDu(details, totals, issue);
    const valeurs = [runId, statut, totals.objectsExamined, totals.objectsModified,
      totals.decisionsApplied, totals.conflictsCreated, totals.arbitrationsNeeded, totals.errors,
      totals.aiCalls, JSON.stringify(details)];
    const ecrire = (avecPhases: boolean) => pgClient.unsafe(
      `UPDATE account_reconciliation_runs SET
         status = $2, finished_at = now(), objects_examined = $3, objects_modified = $4,
         decisions_applied = $5, conflicts_created = $6, arbitrations_needed = $7, errors = $8,
         ai_calls = $9, details_json = $10::jsonb${avecPhases ? ', outcome = $11, phases_json = $12::jsonb' : ''}
       WHERE id = $1`,
      (avecPhases ? [...valeurs, issue, JSON.stringify(phases)] : valeurs) as never[],
    );
    // Colonnes 0410 absentes (déploiement partiel) : statut seul, phases dans le résumé du job.
    await ecrire(true).catch((e) => { if (colonneAbsente(e)) return ecrire(false); throw e; });
  }

  const totals = consolidate(details);
  const outcome = issueDu(phases, totals, openActions);
  return {
    runId, accountId, triggerType: trigger.type, scope, startedAt, finishedAt: new Date().toISOString(),
    details, ...totals, status: statutDu(details, totals, outcome),
    ...(openKnowledge ? { openKnowledge } : {}),
    ...(openActions ? { openActions } : {}),
    ...(documentNaming ? { documentNaming } : {}),
    phases, outcome,
  };
}

/** Issue du passage (pure). */
function issueDu(phases: RunPhases, totals: ReturnType<typeof consolidate>, oa: AccountRunResult['openActions']): RunOutcome {
  return runOutcome(phases, {
    changes: totals.decisionsApplied + (oa ? oa.byEffect.CLOSED + oa.byEffect.UPDATED : 0),
    keptOpen: oa ? oa.byEffect.STILL_OPEN + oa.byEffect.UPDATED : 0,
  });
}

/**
 * Statut historique du passage (pure) : `failed` si tous les biens examinés
 * sont en erreur ; lot 57B : `partial` dès qu'une phase est partielle, en
 * échec ou non exécutée (jamais `completed`).
 */
function statutDu(details: ObjectResult[], totals: ReturnType<typeof consolidate>, issue: RunOutcome): AccountRunResult['status'] {
  const base = details.length === 0 ? 'completed' : totals.status;
  if (base === 'failed') return 'failed';
  return issue === 'TECHNICAL_FAILURE' || issue === 'PARTIAL_SUCCESS' ? 'partial' : base;
}

// ── Déclenchement : file durable (CDC BO IA OPS-001, NFR-003, T3-003) ──────

/**
 * Délai laissé à la réconciliation locale post-T1 avant un contrôle global.
 * Appliqué par la file durable (`t3-queue.ts`, `delaySeconds`).
 */
export const EVENT_DEBOUNCE_MS = envNumber('T3_EVENT_DEBOUNCE_MS', 10 * 60_000, { min: 0 });

/**
 * Demande une exécution T3 suite à un événement métier.
 *
 * Passe désormais par `ai_job_queue` (lot IA 2) : temporisation, fusion des
 * événements rapprochés d'un même compte (WF-10), backoff, relance, écran File
 * IA. Rend l'identifiant du job, ou `null` si l'événement ne déclenche rien
 * (hors catalogue, ou déclencheur inactif dans la version effective).
 */
export async function enqueueAccountReconciliation(
  accountId: number,
  event: { event: string; objectType?: T3Trigger['objectType']; objectId?: number; correlationId?: string },
  now: Date = new Date(),
): Promise<number | null> {
  const { enqueueT3ForEvent } = await import('./t3-queue');
  return enqueueT3ForEvent(accountId, event, undefined, now);
}

/** Non bloquant : un événement métier ne doit jamais échouer à cause de T3. */
export function notifyCoherenceEvent(
  accountId: number,
  event: { event: string; objectType?: T3Trigger['objectType']; objectId?: number },
): void {
  void enqueueAccountReconciliation(accountId, event).catch((e) =>
    console.error('[t3] demande de réconciliation non enregistrée :', (e as Error).message));
}

/**
 * Reprise des demandes de l'ancienne file T3 (`account_reconciliation_runs`
 * au statut `queued`) — transition.
 *
 * Plus rien n'y écrit ; les demandes restées en attente au déploiement sont
 * TRANSFÉRÉES dans la file durable (même temporisation résiduelle), puis la
 * ligne `queued` est supprimée : elle n'était qu'une demande, jamais une
 * exécution, et la garder ferait croire à un travail en attente.
 *
 * Conservé sous ce nom parce que la route cron l'appelle : il rend une liste
 * vide d'exécutions, puisque l'exécution appartient désormais au boucleur.
 */
export async function processDueAccountReconciliations(
  limit = 200,
): Promise<AccountRunResult[]> {
  const pending = (await pgClient.unsafe(
    `SELECT id, account_id, trigger_event, trigger_object_type, trigger_object_id, correlation_id,
            GREATEST(EXTRACT(EPOCH FROM (not_before - now())), 0)::int AS delay
       FROM account_reconciliation_runs
      WHERE status = 'queued'
      ORDER BY not_before LIMIT $1`,
    [limit] as never[],
  ).catch(() => [])) as unknown as Array<{ id: number; account_id: number; trigger_event: string | null; trigger_object_type: T3Trigger['objectType'] | null; trigger_object_id: number | null; correlation_id: string; delay: number }>;
  if (pending.length === 0) return [];
  const { enqueue } = await import('../queue/job-queue.repository');
  for (const q of pending) {
    try {
      await enqueue({
        treatment: 'T3',
        scope: { accountId: q.account_id },
        triggerCode: q.trigger_event ?? 'event',
        delaySeconds: q.delay,
        payload: {
          payloadVersion: 1, kind: 'account', scope: 'incremental',
          events: [{ event: q.trigger_event ?? 'event', objectType: q.trigger_object_type ?? undefined, objectId: q.trigger_object_id ?? undefined, correlationId: q.correlation_id }],
        },
        payloadOnDedupe: 'append_events',
      });
      await pgClient.unsafe(`DELETE FROM account_reconciliation_runs WHERE id = $1 AND status = 'queued'`, [q.id] as never[]);
    } catch (e) {
      // SCR-08 : la ligne n'est supprimée qu'une fois le transfert acquitté.
      console.error(`[t3] transfert de la demande ${q.id} impossible :`, (e as Error).message);
    }
  }
  console.info(`[t3] ${pending.length} demande(s) de l'ancienne file transférée(s) dans la file durable.`);
  return [];
}

/**
 * Ancienne planification par variable d'environnement — RETIRÉE (T3-006,
 * T3-UI-05). La planification T3 est désormais portée par les déclencheurs
 * `schedule_*` de la version effective, mis en file par le boucleur
 * (`queue/triggers.ts`) ; sans version renseignée, le défaut du code est
 * horaire (`schedule_hourly`, lot 31C), en balayage paginé (`t3-queue`).
 *
 * Rend une liste vide : la route cron qui l'appelle reste compatible, et deux
 * planificateurs ne tournent jamais ensemble.
 */
export async function runScheduledAccountReconciliations(): Promise<AccountRunResult[]> {
  return [];
}
