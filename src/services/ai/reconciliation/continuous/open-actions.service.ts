/**
 * Phase « OPEN ACTIONS » de T3 (lot 49B — ticket « T3 — Réexaminer
 * systématiquement les « À traiter » ouverts à chaque exécution »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * RÈGLE : une ligne encore ouverte dans « À traiter » est un problème ACTIF.
 * À CHAQUE passage T3 du compte (`reconcileAccount`, après les biens et la
 * connaissance ouverte), cette phase PARCOURT RÉELLEMENT `to_process_actions`
 * (lignes ouvertes au début du passage, par pages de `OPEN_ACTIONS_PAGE_SIZE`
 * avec curseur, jusqu'à épuisement — jamais « LIMIT 200 » rejoué) et route
 * chaque ligne par le registre `PROCESSING_RULES` (producteur de la règle),
 * sans mapping parallèle :
 *
 *   LINK-ASSET           → T3 DOCUMENT_ASSET : réexamen COMPLET (données
 *                          persistées, Candidate Builder, état actuel de tous
 *                          les biens, déterministe, puis IA si nécessaire),
 *                          même empreinte identique ; l'issue précédente n'est
 *                          qu'un historique. Lot 54A : AUCUN quota T3 interne
 *                          (plus jamais AI_DEFERRED) ;
 *   LINK-ASSET-CONFLICT  → T3 conflit document / bien (obsolescence) ;
 *   LINK-ELT             → lot 54A : candidats RECONSTRUITS depuis l'état
 *                          courant (`resolveDocumentElementLink`), déterministe
 *                          puis arbitrage T3 — jamais limité aux anciennes
 *                          propositions ;
 *   DATA-* (RECONCILIATION_BRIDGE) → réconciliation T3 du bien (périmètre du
 *                          passage élargi à ces biens) ;
 *   ENTITY-FIELD(-ROOM)  → réconciliation T3 de l'entité (1 par passage) ;
 *   OPERATION-*          → lot 54A : consolidation Opérations RÉELLEMENT
 *                          relancée (une fois par passage et par compte),
 *                          puis carte relue (CLOSED / UPDATED / STILL_OPEN) ;
 *   T4 et autres         → SKIPPED_NOT_T3 (prompt T3 jamais détourné), après
 *                          contrôle d'obsolescence (cible supprimée).
 *
 * Voie CANONIQUE (§13) : un document dont la carte LINK-ASSET est ouverte est
 * réexaminé ICI ; si un travail DOCUMENT_ASSET est déjà vivant (nouvelle
 * analyse, contexte changé repéré par le balayage), la phase s'efface devant
 * lui (il réexamine tout autant) — jamais deux évaluations dans un cycle.
 * Décisions utilisateur protégées (§12) : une ligne résolue n'est jamais lue ;
 * un rattachement utilisateur n'est jamais remplacé.
 *
 * Rapport (§15) : une entrée par ligne examinée (actionId, ruleCode,
 * targetType, targetId, previousResolution, resolver, candidateCount,
 * deterministicAttempted, aiCalled, newResolution, actionEffect, empreinte à
 * titre informatif) — détail du travail T3 du compte (borné), journal.
 * Lot 54A : `examined` (la carte a été vue) est distingué de
 * `resolutionAttempted` (un VRAI mécanisme de résolution a tourné) et de
 * `evaluationMode` ; TOUTES les cartes sont journalisées durablement
 * (`t3_open_action_evaluations`, migration 0371), au-delà des 500 entrées du
 * résumé du job.
 *
 * PÉRIMÈTRE (lot 54A, écart 5) — contrat : tout passage T3 GLOBAL du compte
 * (manuel, planifié, réconciliation globale : `reconcileAccount`) réexamine
 * TOUS les « À traiter » ouverts. Les sous-jobs techniques spécialisés
 * (DOCUMENT_ASSET, ASSET, ENTITY, BUSINESS_OPERATIONS…) ne relancent PAS
 * l'ensemble du compte (ni boucle, ni double traitement) ; ils restent la
 * voie de leur seul objet.
 *
 * LOT 57B (ticket P0 « T3 — Corriger les À traiter non résolus et fiabiliser
 * les logs ») :
 *   · DATA-CONTRACT-END / DATA-WARRANTY-END / DATA-SUPPLIER (producteur
 *     DOCUMENT_BRIDGE) → `T3_DOCUMENT_FIELD` : reprise ciblée depuis la
 *     connaissance T1 PERSISTÉE par le résolveur du pont
 *     (`resolveDocumentRuleFromKnowledge`) — elles étaient SKIPPED_NOT_T3 ;
 *   · job documentaire délégué : identifiant, statut et dernière activité
 *     tracés ; job BLOQUÉ (bail expiré, attente anormale) repris par
 *     prélèvement atomique (annulé puis traité ici — jamais deux évaluations) ;
 *   · journal par carte enrichi (0410) : motif `reasonCode`, étapes, durée,
 *     sources T1, origine des candidats, IA (opération, trace, erreur),
 *     décision, écriture tentée et VÉRIFIÉE en base ; un journal en échec est
 *     signalé (`journalStatus`) sans annuler les écritures métier ;
 *   · compteurs distincts : cartes ouvertes au début, examinées, réellement
 *     retentées, résolues (fermeture vérifiée), maintenues par ambiguïté,
 *     déléguées, en erreur ; appels IA par opération.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { getRule, type RuleProducer } from '@/services/to-process/rules-catalog';
import type { ExecutionGuard } from '../../queue/execution-control';
import { isExecutionCancelled } from '../../queue/execution-control';
import type { MatchingIndexCache } from '../document-asset/matching-index';

export const OPEN_ACTIONS_PAGE_SIZE = 200;
/** Entrées détaillées conservées dans le rapport (les compteurs couvrent tout). */
export const OPEN_ACTIONS_REPORT_MAX = 500;

export const OPEN_ACTION_EFFECTS = ['CLOSED', 'UPDATED', 'STILL_OPEN', 'SKIPPED_NOT_T3', 'SUPERSEDED', 'ERROR'] as const;
export type OpenActionEffect = (typeof OPEN_ACTION_EFFECTS)[number];

export interface OpenActionEntry {
  actionId: number;
  ruleCode: string;
  targetType: string;
  targetId: number;
  previousResolution: string | null;
  resolver: string;
  candidateCount: number | null;
  deterministicAttempted: boolean;
  aiCalled: boolean;
  newResolution: string | null;
  actionEffect: OpenActionEffect;
  /** DOCUMENT_ASSET : empreinte du contexte, à titre INFORMATIF (jamais une condition de saut). */
  fingerprint?: string | null;
  fingerprintChanged?: boolean | null;
  /** Précision (travail vivant, cible supprimée…). */
  note?: string;
  /** Lot 54A : la carte a été vue par le passage (toujours vrai dans le rapport). */
  examined?: boolean;
  /** Lot 54A : un VRAI mécanisme de résolution a tourné (≠ simple constat). */
  resolutionAttempted?: boolean;
  /** Lot 54A : nature de l'évaluation. */
  evaluationMode?: EvaluationMode;
  /** Lot 57B : motif exploitable de l'issue (`REASON_CODES`). */
  reasonCode?: ReasonCode;
  triggerCode?: string | null;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  /** Dernière étape réussie / étape en échec (`STEPS`). */
  lastStep?: string | null;
  failedStep?: string | null;
  /** Job spécialisé délégué (DOCUMENT_ASSET, BUSINESS_OPERATIONS). */
  delegatedJobId?: number | null;
  delegatedJobStatus?: string | null;
  /** Sources T1 chargées (éléments exploitables par source) et sources absentes / en échec. */
  knowledgeSources?: Record<string, number> | null;
  missingSources?: string[] | null;
  /** Origine des candidats (source → nombre de biens). */
  candidateOrigins?: Record<string, number> | null;
  aiOperation?: string | null;
  aiTraceId?: string | null;
  aiStatus?: 'OK' | 'ERROR' | 'NOT_CALLED' | null;
  aiError?: string | null;
  /** Pourquoi l'IA a (ou n'a pas) été appelée. */
  aiReason?: string | null;
  decision?: string | null;
  confidence?: number | null;
  writeAttempted?: boolean | null;
  /** Écriture et fermeture relues en base. */
  writeVerified?: boolean | null;
}

/**
 * Lot 57B — motifs exploitables (BO, journal). Voir
 * `docs/exploitation/t3-a-traiter-diagnostic.md`.
 */
export const REASON_CODES = [
  'RESOLVED', 'NO_CANDIDATE', 'NO_T1_KNOWLEDGE', 'FIELD_NOT_IN_T1', 'INSUFFICIENT_EVIDENCE', 'UNSUPPORTED_CHOICE', 'AMBIGUOUS',
  'AI_UNAVAILABLE', 'JOB_PENDING', 'DEPENDENCY_STALLED', 'RESOLVER_FAILED', 'PERSISTENCE_FAILED', 'USER_DECISION_PROTECTED',
  'NOT_T3', 'TARGET_GONE', 'ALREADY_LINKED', 'CLOSED_DURING_RUN', 'SUPERSEDED', 'ASSET_NOT_ELIGIBLE', 'AWAITING_USER',
  'CONFLICT_STILL_VALID', 'NO_ASSET',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

/** Étapes du parcours d'une carte (dernière réussie / en échec). */
export const STEPS = ['SELECT', 'DELEGATION', 'KNOWLEDGE', 'RESOLVER', 'DECISION', 'WRITE', 'VERIFY', 'CLOSE'] as const;

/** Job vivant au-delà duquel une délégation est réputée BLOQUÉE (attente anormale d'un PENDING prêt). */
export const DELEGATION_STALL_MINUTES = 30;

/**
 * Entrée du résumé du job (bornée à 500) : l'essentiel du parcours ; le détail
 * complet (sources, origines, traces IA, horodatages) est dans le journal
 * durable — le résumé du job reste léger. Pure.
 */
export function entreeRapport(e: OpenActionEntry): OpenActionEntry {
  const {
    knowledgeSources: _k, missingSources: _m, candidateOrigins: _c, aiTraceId: _t, startedAt: _s, finishedAt: _f, triggerCode: _g,
    aiReason: _r, lastStep: _l, ...reste
  } = e;
  return reste;
}

/** Motif par défaut d'une entrée (pur). */
export function reasonOf(e: Pick<OpenActionEntry, 'actionEffect'> & Partial<Pick<OpenActionEntry, 'note' | 'reasonCode' | 'newResolution'>>): ReasonCode {
  if (e.reasonCode) return e.reasonCode;
  const note = e.note ?? '';
  switch (e.actionEffect) {
    case 'CLOSED': return 'RESOLVED';
    case 'SKIPPED_NOT_T3': return 'NOT_T3';
    case 'ERROR': return 'RESOLVER_FAILED';
    case 'SUPERSEDED':
      if (note === 'user_decision_protected') return 'USER_DECISION_PROTECTED';
      if (/gone/.test(note) || e.newResolution === 'TARGET_DELETED') return 'TARGET_GONE';
      if (note === 'already_linked' || note === 'equipment_link_obsolete') return 'ALREADY_LINKED';
      if (note === 'closed_during_run') return 'CLOSED_DURING_RUN';
      if (/job_pending/.test(note)) return 'JOB_PENDING';
      return 'SUPERSEDED';
    default:
      if (/job_pending/.test(note)) return 'JOB_PENDING';
      if (note === 'user_decision_protected') return 'USER_DECISION_PROTECTED';
      if (note === 'asset_not_eligible') return 'ASSET_NOT_ELIGIBLE';
      if (note === 'document_without_asset') return 'NO_ASSET';
      return 'AWAITING_USER';
  }
}

/** Lot 54A (écart 4) : nature de l'évaluation d'une carte. */
export const EVALUATION_MODES = [
  'FULL_REEVALUATION', 'DETERMINISTIC_REEVALUATION', 'AI_REEVALUATION', 'OBSOLESCENCE_ONLY', 'NOT_T3', 'SUPERSEDED', 'ERROR',
] as const;
export type EvaluationMode = (typeof EVALUATION_MODES)[number];

export interface OpenActionsResult {
  examined: number;
  pages: number;
  byEffect: Record<OpenActionEffect, number>;
  byResolver: Record<string, number>;
  aiCalls: number;
  /** Lot 54A : toujours 0 (plus aucun report pour quota T3) — conservé pour compatibilité. */
  aiDeferred: number;
  /** Lot 54A : cartes pour lesquelles un vrai mécanisme de résolution a tourné. */
  resolutionAttempted: number;
  byEvaluationMode: Partial<Record<EvaluationMode, number>>;
  /** Lot 54A : consolidations Opérations relancées par la phase (0 ou 1). */
  operationsConsolidations: number;
  /** Lot 54A : lignes écrites dans le journal durable (`t3_open_action_evaluations`) ; null : journal indisponible. */
  journaled: number | null;
  entries: OpenActionEntry[];
  /** Entrées non détaillées (au-delà de `OPEN_ACTIONS_REPORT_MAX`). */
  omittedEntries: number;
  /** Lot 57B : cartes ouvertes au début du passage (périmètre du cycle). */
  openAtStart: number;
  /** Lot 57B : cartes résolues et FERMÉES (fermeture vérifiée en base). */
  resolved: number;
  /** Lot 57B : cartes maintenues ouvertes par ambiguïté / preuves insuffisantes. */
  keptAmbiguous: number;
  /** Lot 57B : cartes déléguées ou reportées (job spécialisé vivant). */
  delegated: number;
  /** Lot 57B : jobs délégués bloqués repris par le passage. */
  stalledRecovered: number;
  /** Lot 57B : cartes en erreur. */
  errors: number;
  byReasonCode: Partial<Record<ReasonCode, number>>;
  /** Lot 57B : appels IA par opération. */
  aiCallsByOperation: Record<string, number>;
  /** Lot 57B : état du journal durable (OK, PARTIAL : colonnes 0410 absentes, FAILED : écriture impossible). */
  journalStatus: 'OK' | 'PARTIAL' | 'FAILED';
  journalError: string | null;
}

interface ActionRow {
  id: number;
  rule_code: string;
  target_type: string;
  target_id: number;
  field_key: string | null;
  relation_key: string | null;
  resolved_at: Date | string | null;
  resolution_reason: string | null;
  trigger_context: Record<string, unknown> | string | null;
}

/** Résolveur T3 d'une règle (registre `PROCESSING_RULES`, producteur). Pure. */
export function resolverOf(ruleCode: string): { resolver: string; t3: boolean } {
  if (ruleCode === 'LINK-ASSET') return { resolver: 'T3_DOCUMENT_ASSET', t3: true };
  const rule = getRule(ruleCode);
  if (!rule) return { resolver: 'UNKNOWN_RULE', t3: false };
  const T3: Partial<Record<RuleProducer, string>> = {
    T3_ASSET_CONFLICT: 'T3_ASSET_CONFLICT',
    T3_EQUIPMENT_LINK: 'T3_EQUIPMENT_LINK',
    RECONCILIATION_BRIDGE: 'T3_ASSET',
    T3_ENTITY_FIELDS: 'T3_ENTITY',
    T3_OPERATIONS: 'T3_OPERATIONS',
    // Lot 57B (défaut E) : données documentaires du pont, reprises depuis la connaissance T1 persistée.
    DOCUMENT_BRIDGE: 'T3_DOCUMENT_FIELD',
  };
  const r = T3[rule.producer];
  return r ? { resolver: r, t3: true } : { resolver: rule.producer, t3: false };
}

/** Effet d'une ligne fermée PENDANT le passage (avant cette phase). Pure. */
export function effectOfClosedDuringRun(resolver: string, reason: string | null): OpenActionEffect {
  if (reason === 'OBSOLETE' && (resolver === 'T3_ASSET' || resolver === 'T3_ENTITY' || resolver === 'T3_DOCUMENT_ASSET')) return 'CLOSED';
  return 'SUPERSEDED';
}

export interface OpenActionsDeps {
  resolveDocumentAsset: typeof import('../document-asset/resolve-document-asset.service').resolveDocumentAsset;
  reconcileEntity: (p: { accountId: number; target: { type: 'EQUIPMENT' | 'ROOM'; id: number } }) => Promise<{ skipped: boolean }>;
  closeObsoleteAssetConflicts: (accountId: number) => Promise<number>;
  /** Lot 54A : LINK-ELT — réévaluation depuis l'état courant. */
  resolveElementLink?: typeof import('./document-element-link').resolveDocumentElementLink;
  /** Lot 57B : reprise ciblée d'une donnée documentaire depuis la connaissance T1 (DOCUMENT_BRIDGE). */
  resolveDocumentField?: typeof import('@/services/to-process/document-rule-bridge').resolveDocumentRuleFromKnowledge;
  /** Lot 57B : journal (tests : simulation d'une panne). */
  journal?: (accountId: number, ctx: { accountRunId?: number | null; queueJobId?: number | null }, lot: OpenActionEntry[]) => Promise<JournalResult>;
  /** Lot 54A : relance de la consolidation Opérations du compte (cartes T3_OPERATIONS). */
  consolidateOperations?: (accountId: number, p: { fileIds: number[]; operationIds: number[]; beforeWrite?: (what: string) => Promise<void> }) => Promise<{ changes: number; aiCalls: number }>;
  /** Lot 49B, SUPPRIMÉS au lot 54A (plus aucun quota T3) : ignorés s'ils sont fournis. */
  callsLastDay?: (accountId: number) => Promise<number>;
  maxPerPass?: number;
  maxPerDay?: number;
}

/** Consolidation Opérations du compte, depuis les données ACTUELLES (lot 54A, écart 3). */
async function defaultConsolidateOperations(
  accountId: number, p: { fileIds: number[]; operationIds: number[]; beforeWrite?: (what: string) => Promise<void> },
): Promise<{ changes: number; aiCalls: number }> {
  const { consolidateAccountOperations, reconsolidateOperations } = await import('@/services/business-operations/consolidation/consolidator');
  const r = await consolidateAccountOperations(accountId, {
    fileIds: p.fileIds, reevaluateHolds: true, beforeWrite: p.beforeWrite, correlationId: `t3-open-actions:${accountId}`,
  });
  let changes = r.changes;
  // Questions portées par une Opération (parent Sinistre, montant…) : recalculées
  // même si aucun document n'a changé (sinon la carte ne serait que constatée).
  if (p.operationIds.length) changes += await reconsolidateOperations(accountId, p.operationIds, { beforeWrite: p.beforeWrite });
  return { changes, aiCalls: r.m3?.calls ?? 0 };
}

async function defaultDeps(): Promise<OpenActionsDeps> {
  const [r, e, c, l, b] = await Promise.all([
    import('../document-asset/resolve-document-asset.service'),
    import('../entity-reconciliation'),
    import('@/services/to-process/document-asset-conflict'),
    import('./document-element-link'),
    import('@/services/to-process/document-rule-bridge'),
  ]);
  return {
    resolveDocumentAsset: r.resolveDocumentAsset,
    reconcileEntity: async (p) => e.reconcileEntity({ accountId: p.accountId, target: p.target, triggeredBy: 'manual' }),
    closeObsoleteAssetConflicts: c.closeObsoleteAssetConflicts,
    resolveElementLink: l.resolveDocumentElementLink,
    resolveDocumentField: b.resolveDocumentRuleFromKnowledge,
    consolidateOperations: defaultConsolidateOperations,
  };
}

const vide = (): OpenActionsResult => ({
  examined: 0, pages: 0,
  byEffect: Object.fromEntries(OPEN_ACTION_EFFECTS.map((k) => [k, 0])) as Record<OpenActionEffect, number>,
  byResolver: {}, aiCalls: 0, aiDeferred: 0, resolutionAttempted: 0, byEvaluationMode: {}, operationsConsolidations: 0,
  journaled: 0, entries: [], omittedEntries: 0,
  openAtStart: 0, resolved: 0, keptAmbiguous: 0, delegated: 0, stalledRecovered: 0, errors: 0, byReasonCode: {}, aiCallsByOperation: {},
  journalStatus: 'OK', journalError: null,
});

/**
 * Mode d'évaluation et tentative réelle d'une entrée (pur, testé) — lot 54A,
 * écart 4. Une simple vérification « ancienne proposition encore valable »
 * ou un constat STILL_OPEN n'est JAMAIS présenté comme une résolution.
 */
export function classifyEvaluation(e: OpenActionEntry): { evaluationMode: EvaluationMode; resolutionAttempted: boolean } {
  if (e.evaluationMode) return { evaluationMode: e.evaluationMode, resolutionAttempted: e.resolutionAttempted ?? false };
  if (e.actionEffect === 'ERROR') return { evaluationMode: 'ERROR', resolutionAttempted: false };
  if (e.actionEffect === 'SKIPPED_NOT_T3') return { evaluationMode: 'NOT_T3', resolutionAttempted: false };
  if (e.aiCalled) return { evaluationMode: 'AI_REEVALUATION', resolutionAttempted: true };
  return { evaluationMode: 'OBSOLESCENCE_ONLY', resolutionAttempted: false };
}

export interface JournalResult { n: number; status: 'OK' | 'PARTIAL' | 'FAILED'; error: string | null }

const COLS_0371 = ['account_id', 'account_run_id', 'queue_job_id', 'action_id', 'rule_code', 'target_type', 'target_id', 'resolver',
  'previous_resolution', 'candidate_count', 'deterministic_attempted', 'ai_called', 'resolution_attempted', 'evaluation_mode',
  'new_resolution', 'action_effect', 'fingerprint', 'fingerprint_changed', 'note'];
const COLS_0410 = ['reason_code', 'trigger_code', 'started_at', 'finished_at', 'duration_ms', 'last_step', 'failed_step',
  'delegated_job_id', 'delegated_job_status', 'knowledge_sources', 'missing_sources', 'candidate_origins', 'ai_operation',
  'ai_trace_id', 'ai_status', 'ai_error', 'decision', 'confidence', 'write_attempted', 'write_verified'];
const JSONB_0410 = new Set(['knowledge_sources', 'missing_sources', 'candidate_origins']);

/** Valeurs d'une ligne de journal (pure) — identifiants, codes, compteurs ; jamais de valeur métier. */
export function journalValues(accountId: number, ctx: { accountRunId?: number | null; queueJobId?: number | null }, e: OpenActionEntry, enrichi: boolean): unknown[] {
  const court = (v: string | null | undefined, n: number) => (v ? v.slice(0, n) : null);
  const base = [accountId, ctx.accountRunId ?? null, ctx.queueJobId ?? null, e.actionId, e.ruleCode, e.targetType, e.targetId, e.resolver,
    e.previousResolution, e.candidateCount, e.deterministicAttempted, e.aiCalled, e.resolutionAttempted ?? false,
    e.evaluationMode ?? 'OBSOLESCENCE_ONLY', e.newResolution, e.actionEffect, e.fingerprint ?? null, e.fingerprintChanged ?? null,
    court(e.note, 300)];
  if (!enrichi) return base;
  const j = (v: unknown) => (v == null ? null : JSON.stringify(v));
  return [...base, e.reasonCode ?? null, e.triggerCode ?? null, e.startedAt ?? null, e.finishedAt ?? null, e.durationMs ?? null,
    e.lastStep ?? null, e.failedStep ?? null, e.delegatedJobId ?? null, e.delegatedJobStatus ?? null, j(e.knowledgeSources),
    j(e.missingSources), j(e.candidateOrigins), e.aiOperation ?? null, court(e.aiTraceId, 80), e.aiStatus ?? null, court(e.aiError, 300),
    court(e.decision, 120), e.confidence == null ? null : Math.round(Math.min(1, Math.max(0, e.confidence)) * 1000) / 1000,
    e.writeAttempted ?? null, e.writeVerified ?? null];
}

/**
 * Lot 54A (écart 6) / 57B : journal durable, une ligne par carte. Ne lève
 * jamais. Colonnes 0410 absentes : journal réduit aux colonnes 0371
 * (PARTIAL) ; table absente ou écriture impossible : FAILED — signalé dans
 * le rapport et le statut du passage, sans annuler les écritures métier.
 */
async function journaliser(
  accountId: number, ctx: { accountRunId?: number | null; queueJobId?: number | null }, lot: OpenActionEntry[],
): Promise<JournalResult> {
  if (lot.length === 0) return { n: 0, status: 'OK', error: null };
  const db = await sql();
  const ecrire = async (enrichi: boolean) => {
    const cols = enrichi ? [...COLS_0371, ...COLS_0410] : COLS_0371;
    const params: unknown[] = [];
    const lignes = lot.map((e) => {
      const v = journalValues(accountId, ctx, e, enrichi);
      const ph = v.map((x, i) => { params.push(x); return `$${params.length}${JSONB_0410.has(cols[i]) ? '::jsonb' : ''}`; });
      return `(${ph.join(', ')})`;
    });
    await db.unsafe(`INSERT INTO t3_open_action_evaluations (${cols.join(', ')}) VALUES ${lignes.join(', ')}`, params as never[]);
  };
  try {
    await ecrire(true);
    return { n: lot.length, status: 'OK', error: null };
  } catch (e) {
    if ((e as { code?: string }).code === '42703') {
      try {
        await ecrire(false);
        return { n: lot.length, status: 'PARTIAL', error: 'migration 0410 non appliquée : journal réduit' };
      } catch (e2) { e = e2; }
    }
    const msg = (e as Error).message.slice(0, 200);
    console.error(`[t3-open-actions] compte ${accountId} : journal des réexamens indisponible (${msg}) — rapport du job seul.`);
    return { n: 0, status: 'FAILED', error: msg };
  }
}

/** Rétention du journal (90 jours), par compte. Ne lève jamais. */
async function purgerJournal(accountId: number): Promise<void> {
  try {
    await (await sql()).unsafe(
      `DELETE FROM t3_open_action_evaluations WHERE account_id = $1 AND created_at < now() - interval '90 days'`, [accountId] as never[],
    );
  } catch { /* table absente : rien à purger */ }
}

async function sql() { return (await import('@/db')).pgClient; }

/** Contenu de la carte (nature, propositions) : « mise à jour » seulement s'il change. */
async function cardSnapshot(actionId: number): Promise<string | null> {
  const rows = (await (await sql()).unsafe(
    `SELECT action_kind || '|' || coalesce(proposals_json::text, '') AS s FROM to_process_actions WHERE id = $1 AND resolved_at IS NULL`,
    [actionId] as never[],
  )) as unknown as Array<{ s: string }>;
  return rows[0]?.s ?? null;
}

async function isOpen(actionId: number): Promise<{ open: boolean; reason: string | null }> {
  const rows = (await (await sql()).unsafe(
    `SELECT resolved_at IS NULL AS open, resolution_reason FROM to_process_actions WHERE id = $1`, [actionId] as never[],
  )) as unknown as Array<{ open: boolean; resolution_reason: string | null }>;
  return { open: rows[0]?.open === true, reason: rows[0]?.resolution_reason ?? null };
}

async function closeAction(actionId: number, reason: 'OBSOLETE' | 'TARGET_DELETED'): Promise<boolean> {
  const { resolveAction } = await import('@/services/to-process/to-process-action.service');
  return resolveAction(actionId, reason);
}

/** Job spécialisé délégué (vivant) d'une cible, et son état. */
export interface DelegatedJob {
  id: number;
  status: string;
  lastActivityAt: string | null;
  /** Bloqué : RUNNING au bail expiré, ou PENDING prêt depuis plus de `DELEGATION_STALL_MINUTES`. */
  stalled: boolean;
}

/** Condition SQL « job bloqué » (alias `q`), partagée par la détection et la reprise. */
const STALLED_SQL = `((q.status = 'RUNNING' AND ((q.lease_expires_at IS NOT NULL AND q.lease_expires_at < now())
                        OR (q.lease_expires_at IS NULL AND q.started_at < now() - interval '${DELEGATION_STALL_MINUTES} minutes')))
                   OR (q.status = 'PENDING' AND q.available_at < now() - interval '${DELEGATION_STALL_MINUTES} minutes'))`;

/** Lot 57B (défaut C) : job T3 vivant d'une cible (document, opérations du compte), bloqué ou non. */
export async function delegatedJob(targetType: 'document' | 'business_operations', targetId: number): Promise<DelegatedJob | null> {
  const rows = (await (await sql()).unsafe(
    `SELECT q.id, q.status, coalesce(q.heartbeat_at, q.started_at, q.available_at, q.created_at) AS last, ${STALLED_SQL} AS stalled
       FROM ai_job_queue q
      WHERE q.treatment = 'T3' AND q.target_type = $1 AND q.target_id = $2 AND q.status IN ('PENDING', 'RUNNING')
      ORDER BY q.id LIMIT 1`,
    [targetType, String(targetId)] as never[],
  ).catch(async (e) => {
    // Colonnes de bail absentes (déploiement très ancien) : vivant, jamais réputé bloqué.
    if ((e as { code?: string }).code !== '42703') throw e;
    return (await sql()).unsafe(
      `SELECT id, status, created_at AS last, false AS stalled FROM ai_job_queue
        WHERE treatment = 'T3' AND target_type = $1 AND target_id = $2 AND status IN ('PENDING', 'RUNNING') ORDER BY id LIMIT 1`,
      [targetType, String(targetId)] as never[],
    );
  })) as unknown as Array<{ id: number; status: string; last: Date | string | null; stalled: boolean }>;
  const r = rows[0];
  if (!r) return null;
  return { id: Number(r.id), status: r.status, lastActivityAt: r.last ? new Date(r.last).toISOString() : null, stalled: r.stalled === true };
}

/**
 * Reprise d'un job délégué BLOQUÉ, par prélèvement ATOMIQUE : le job n'est
 * annulé (jeton révoqué : un exécutant fantôme est interrompu par sa garde)
 * que s'il est TOUJOURS bloqué ; le passage traite alors la carte lui-même.
 * Faux : le job a repris vie entre-temps — aucune double évaluation.
 */
export async function takeOverStalledJob(jobId: number): Promise<boolean> {
  const rows = (await (await sql()).unsafe(
    `UPDATE ai_job_queue q SET status = 'CANCELLED', finished_at = now(), execution_id = NULL, lease_expires_at = NULL,
            last_error = 'job bloqué repris par le passage T3 global du compte (lot 57B)'
      WHERE q.id = $1 AND q.status IN ('PENDING', 'RUNNING') AND ${STALLED_SQL} RETURNING q.id`,
    [jobId] as never[],
  )) as unknown as unknown[];
  return rows.length > 0;
}

/** Cible encore existante (document, bien) ; autres types : non contrôlés (vrai). */
async function targetExists(accountId: number, targetType: string, targetId: number): Promise<boolean> {
  const table = targetType === 'DOCUMENT' ? 'asset_files' : targetType === 'ASSET' ? 'assets' : null;
  if (!table) return true;
  const rows = (await (await sql()).unsafe(
    `SELECT 1 FROM ${table} WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL LIMIT 1`, [targetId, accountId] as never[],
  )) as unknown as unknown[];
  return rows.length > 0;
}

const parseCtx = (v: ActionRow['trigger_context']): Record<string, unknown> =>
  (typeof v === 'string' ? (() => { try { return JSON.parse(v) as Record<string, unknown>; } catch { return {}; } })() : v ?? {});

/**
 * Parcourt TOUTES les lignes « À traiter » ouvertes du compte au début du
 * passage et les réexamine selon leur résolveur. Ne lève que pour une
 * interruption d'exécution (une ligne en erreur n'arrête pas les autres).
 */
export async function reconcileOpenToProcessActions(accountId: number, opts: {
  guard?: ExecutionGuard; triggerCode?: string | null;
  /** Début du passage : les lignes fermées depuis (par les biens) sont rapportées CLOSED / SUPERSEDED. */
  runStartedAt?: Date;
  /** Biens réconciliés pendant le passage (DATA-* : résolveur déjà passé). */
  reconciledAssetIds?: ReadonlySet<number>;
  indexes?: MatchingIndexCache;
  deps?: OpenActionsDeps;
  /** Lot 54A : passage du compte et job porteur (journal durable). */
  accountRunId?: number | null;
  queueJobId?: number | null;
} = {}): Promise<OpenActionsResult> {
  const d = opts.deps ?? await defaultDeps();
  const out = vide();
  const debut = opts.runStartedAt ?? new Date();
  const db = await sql();
  const g = async (quoi: string) => { await opts.guard?.assertActive(`T3 À traiter ouverts — ${quoi}`); };

  // Obsolescence des incohérences de rattachement (T3, une requête par compte).
  try { await d.closeObsoleteAssetConflicts(accountId); } catch (e) {
    if (isExecutionCancelled(e)) throw e;
    console.error(`[t3-open-actions] compte ${accountId} : incohérences obsolètes non closes :`, (e as Error).message);
  }

  // Lignes du cycle : ouvertes au début du passage (identifiant ≤ borne) —
  // une carte créée pendant le passage appartient au cycle suivant.
  const [{ max: borne }] = (await db.unsafe(
    `SELECT coalesce(max(id), 0)::int AS max FROM to_process_actions WHERE account_id = $1`, [accountId] as never[],
  )) as unknown as Array<{ max: number }>;
  const [{ n: ouvertes }] = (await db.unsafe(
    `SELECT count(*)::int AS n FROM to_process_actions WHERE account_id = $1 AND id <= $2 AND resolved_at IS NULL`, [accountId, borne] as never[],
  )) as unknown as Array<{ n: number }>;
  out.openAtStart = Number(ouvertes);
  const tampon: OpenActionEntry[] = [];
  const journal = d.journal ?? journaliser;
  const vider = async () => {
    const lot = tampon.splice(0, tampon.length);
    let r: JournalResult;
    try { r = await journal(accountId, { accountRunId: opts.accountRunId, queueJobId: opts.queueJobId }, lot); } catch (e) {
      r = { n: 0, status: 'FAILED', error: (e as Error).message.slice(0, 200) };
    }
    if (r.status === 'FAILED') { out.journalStatus = 'FAILED'; out.journalError = r.error; }
    else if (r.status === 'PARTIAL' && out.journalStatus === 'OK') { out.journalStatus = 'PARTIAL'; out.journalError = r.error; }
    if (out.journaled !== null) out.journaled += r.n;
  };
  const enregistrer = (brute: OpenActionEntry, t0?: number) => {
    const fin = new Date();
    const e: OpenActionEntry = {
      ...brute, examined: true, ...classifyEvaluation(brute), triggerCode: opts.triggerCode ?? null,
      ...(t0 ? { startedAt: new Date(t0).toISOString(), finishedAt: fin.toISOString(), durationMs: fin.getTime() - t0 } : {}),
    };
    e.reasonCode = reasonOf(e);
    if (e.aiCalled && !e.aiOperation) e.aiOperation = e.resolver === 'T3_OPERATIONS' ? 't3_operation_match' : 't3_link_ambiguity';
    out.examined += 1;
    out.byEffect[e.actionEffect] += 1;
    out.byResolver[e.resolver] = (out.byResolver[e.resolver] ?? 0) + 1;
    out.byEvaluationMode[e.evaluationMode!] = (out.byEvaluationMode[e.evaluationMode!] ?? 0) + 1;
    out.byReasonCode[e.reasonCode] = (out.byReasonCode[e.reasonCode] ?? 0) + 1;
    if (e.resolutionAttempted) out.resolutionAttempted += 1;
    if (e.aiCalled) {
      out.aiCalls += 1;
      out.aiCallsByOperation[e.aiOperation!] = (out.aiCallsByOperation[e.aiOperation!] ?? 0) + 1;
    }
    if (e.actionEffect === 'CLOSED') out.resolved += 1;
    if (e.actionEffect === 'ERROR') out.errors += 1;
    if (e.reasonCode === 'JOB_PENDING' || e.reasonCode === 'DEPENDENCY_STALLED') out.delegated += 1;
    if ((e.actionEffect === 'STILL_OPEN' || e.actionEffect === 'UPDATED' || (e.actionEffect === 'SUPERSEDED' && e.note === 'card_replaced'))
      && ['AMBIGUOUS', 'INSUFFICIENT_EVIDENCE', 'UNSUPPORTED_CHOICE', 'NO_CANDIDATE', 'FIELD_NOT_IN_T1', 'AWAITING_USER'].includes(e.reasonCode)) out.keptAmbiguous += 1;
    if (out.entries.length < OPEN_ACTIONS_REPORT_MAX) out.entries.push(entreeRapport(e));
    else out.omittedEntries += 1;
    tampon.push(e);
    if (e.actionEffect !== 'STILL_OPEN' && e.actionEffect !== 'SKIPPED_NOT_T3') {
      console.info(`[t3-open-actions] ${JSON.stringify({ accountId, ...e })}`);
    }
  };

  const ctxAutres: OtherCtx = { reconciledAssetIds: opts.reconciledAssetIds, d, entites: new Set<string>(), guard: opts.guard, borne: Number(borne), operations: null, out };
  let curseur = 0;
  for (;;) {
    await g('page');
    const rows = (await db.unsafe(
      `SELECT id, rule_code, target_type, target_id, field_key, relation_key, resolved_at, resolution_reason, trigger_context
         FROM to_process_actions
        WHERE account_id = $1 AND id > $2 AND id <= $3
          AND (resolved_at IS NULL OR resolved_at >= $4::timestamptz)
        ORDER BY id LIMIT $5`,
      [accountId, curseur, borne, debut.toISOString(), OPEN_ACTIONS_PAGE_SIZE] as never[],
    )) as unknown as ActionRow[];
    if (rows.length === 0) break;
    out.pages += 1;
    curseur = Number(rows[rows.length - 1].id);
    for (const row of rows) {
      const base = {
        actionId: Number(row.id), ruleCode: row.rule_code, targetType: row.target_type, targetId: Number(row.target_id),
      };
      const { resolver, t3 } = resolverOf(row.rule_code);
      const t0 = Date.now();
      const trace: Trace = { step: 'SELECT', done: null };
      try {
        // Fermée pendant le passage (réconciliation des biens, utilisateur) : rapportée.
        if (row.resolved_at !== null) {
          // Lot 54A : fermée par la consolidation Opérations relancée PAR CE PASSAGE → résolue.
          const parConsolidation = resolver === 'T3_OPERATIONS' && ctxAutres.operations?.effets.get(Number(row.id))?.effect === 'CLOSED';
          const effet = parConsolidation ? 'CLOSED' : effectOfClosedDuringRun(resolver, row.resolution_reason);
          enregistrer({
            ...base, previousResolution: null, resolver, candidateCount: null, deterministicAttempted: t3, aiCalled: false,
            newResolution: row.resolution_reason, actionEffect: effet, note: 'closed_during_run',
            // Fermée par la réconciliation T3 du passage : vraie résolution déterministe.
            evaluationMode: effet === 'CLOSED' ? 'DETERMINISTIC_REEVALUATION' : 'SUPERSEDED', resolutionAttempted: effet === 'CLOSED',
            writeVerified: true, lastStep: 'CLOSE',
            ...(effet === 'CLOSED' ? { reasonCode: 'RESOLVED' as const } : { reasonCode: row.resolution_reason === 'TARGET_DELETED' ? 'TARGET_GONE' as const : 'CLOSED_DURING_RUN' as const }),
          }, t0);
          continue;
        }
        if (resolver === 'T3_DOCUMENT_ASSET') {
          // Réexamen complet, IA si nécessaire — lot 54A : jamais reporté pour quota T3.
          enregistrer(await reexamineDocument(accountId, row, base, { ...opts, d, trace, out }), t0);
          continue;
        }
        enregistrer(await reexamineOther(accountId, row, base, resolver, t3, ctxAutres, trace), t0);
      } catch (err) {
        if (isExecutionCancelled(err)) throw err;
        const ia = typeof err === 'object' && err !== null && 'operationCode' in err && 'code' in err;
        enregistrer({
          ...base, previousResolution: null, resolver, candidateCount: null, deterministicAttempted: false, aiCalled: ia,
          newResolution: null, actionEffect: 'ERROR', note: (err as Error).message.slice(0, 200),
          evaluationMode: 'ERROR', resolutionAttempted: t3,
          reasonCode: ia ? 'AI_UNAVAILABLE' : 'RESOLVER_FAILED', lastStep: trace.done, failedStep: trace.step,
          ...(ia ? { aiStatus: 'ERROR' as const, aiError: String((err as unknown as Error).message).slice(0, 200), aiOperation: String((err as { operationCode: unknown }).operationCode) } : {}),
        }, t0);
      }
    }
    await vider();
    if (rows.length < OPEN_ACTIONS_PAGE_SIZE) break;
  }
  await vider();
  if (out.journalStatus === 'FAILED') out.journaled = null;
  if (out.examined > 0) await purgerJournal(accountId);
  if (out.examined > 0) {
    console.info(`[t3-open-actions] compte ${accountId} : ${out.examined} ligne(s) ouverte(s) examinée(s) en ${out.pages} page(s), `
      + `${out.resolutionAttempted} réellement retentée(s) — `
      + `${OPEN_ACTION_EFFECTS.filter((k) => out.byEffect[k] > 0).map((k) => `${k} ${out.byEffect[k]}`).join(', ')}`
      + ` · IA ${out.aiCalls}${out.operationsConsolidations ? ' · consolidation Opérations relancée' : ''}`
      + ` · journal ${out.journaled ?? 'indisponible'} (${out.journalStatus})`
      + ` · ouvertes au début ${out.openAtStart}, résolues ${out.resolved}, maintenues ${out.keptAmbiguous}, déléguées ${out.delegated}, erreurs ${out.errors}`);
  }
  return out;
}

type Base = Pick<OpenActionEntry, 'actionId' | 'ruleCode' | 'targetType' | 'targetId'>;
/** Parcours d'une carte : étape en cours et dernière étape réussie. */
interface Trace { step: (typeof STEPS)[number]; done: (typeof STEPS)[number] | null }
const etape = (t: Trace | undefined, s: Trace['step']) => { if (t) { t.done = t.step; t.step = s; } };

/** Lot 57B : écriture et fermeture d'un rattachement relues en base. */
async function linkVerified(actionId: number, fileId: number): Promise<boolean> {
  const rows = (await (await sql()).unsafe(
    `SELECT (SELECT resolved_at IS NOT NULL FROM to_process_actions WHERE id = $1) AS closed,
            (EXISTS (SELECT 1 FROM asset_files WHERE id = $2 AND asset_id IS NOT NULL)
             OR EXISTS (SELECT 1 FROM document_asset_links WHERE file_id = $2 AND status = 'ACTIVE' AND asset_id IS NOT NULL
                          AND link_role IN ('PRIMARY', 'SECONDARY'))) AS linked`,
    [actionId, fileId] as never[],
  )) as unknown as Array<{ closed: boolean | null; linked: boolean }>;
  return rows[0]?.closed === true && rows[0]?.linked === true;
}

/** Origine des candidats (source → nombre de biens) depuis le monitoring DOCUMENT_ASSET. Pure. */
export function candidateOriginsOf(ev: { candidateSources?: Record<string, string[]>; semanticSearch?: { origins: Record<string, number>; presented: number } | null } | undefined): Record<string, number> | null {
  if (!ev) return null;
  const out: Record<string, number> = {};
  for (const srcs of Object.values(ev.candidateSources ?? {})) for (const s of srcs) out[s] = (out[s] ?? 0) + 1;
  if (ev.semanticSearch && ev.semanticSearch.presented > 0) {
    out.SEMANTIC_SEARCH = ev.semanticSearch.presented;
    for (const [k, v] of Object.entries(ev.semanticSearch.origins)) out[`SEMANTIC_${k}`] = v;
  }
  return out;
}

/** LINK-ASSET : réexamen complet du document (voie canonique). */
async function reexamineDocument(accountId: number, row: ActionRow, base: Base, o: {
  guard?: ExecutionGuard; triggerCode?: string | null; indexes?: MatchingIndexCache; d: OpenActionsDeps; trace?: Trace; out?: OpenActionsResult;
}): Promise<OpenActionEntry> {
  const fileId = Number(row.target_id);
  const cle = { actionId: base.actionId, ruleCode: base.ruleCode, targetType: base.targetType, targetId: base.targetId };
  etape(o.trace, 'DELEGATION');
  const job = await delegatedJob('document', fileId);
  let reprise: DelegatedJob | null = null;
  if (job) {
    // Lot 57B (défaut C) : job vivant → il réexamine (jamais deux évaluations) ;
    // job BLOQUÉ → repris atomiquement puis traité ici (jamais d'attente indéfinie).
    if (job.stalled && await takeOverStalledJob(job.id)) {
      reprise = job;
      if (o.out) o.out.stalledRecovered += 1;
      console.warn(`[t3-open-actions] compte ${accountId} : job T3 document #${job.id} (${job.status}) bloqué depuis ${job.lastActivityAt ?? '?'} — repris par le passage.`);
    } else {
      return {
        ...cle, previousResolution: null, resolver: 'T3_DOCUMENT_ASSET', candidateCount: null, deterministicAttempted: false,
        aiCalled: false, newResolution: null, actionEffect: 'STILL_OPEN', note: 'job_pending', fingerprint: null, fingerprintChanged: null,
        // Bloqué mais non repris (il a repris vie entre-temps) : signalé, retenté au passage suivant.
        evaluationMode: 'SUPERSEDED', resolutionAttempted: false, reasonCode: job.stalled ? 'DEPENDENCY_STALLED' : 'JOB_PENDING',
        delegatedJobId: job.id, delegatedJobStatus: job.status, lastStep: 'DELEGATION', aiReason: 'DELEGATED',
      };
    }
  }
  etape(o.trace, 'KNOWLEDGE');
  const index = o.indexes ? await o.indexes.get(accountId) : undefined;
  const avant = await cardSnapshot(Number(row.id));
  etape(o.trace, 'RESOLVER');
  const r = await o.d.resolveDocumentAsset({
    accountId, fileId, guard: o.guard, triggerCode: o.triggerCode ?? 'schedule_hourly', reprocessReason: 'OPEN_ACTION',
    openActionId: Number(row.id), rearbitration: 'allow', ...(index ? { index } : {}),
  });
  etape(o.trace, 'DECISION');
  const ev = r.evaluation;
  const tente = r.status !== 'USER_DECIDED' && r.status !== 'TARGET_GONE' && r.status !== 'ALREADY_LINKED';
  const ai = ev?.ai ?? null;
  const commun = {
    ...cle, resolver: 'T3_DOCUMENT_ASSET', previousResolution: ev?.previousResolution ?? null,
    candidateCount: ev?.candidateCount ?? null, deterministicAttempted: r.status !== 'USER_DECIDED' && r.status !== 'TARGET_GONE',
    aiCalled: r.aiCalled, newResolution: r.status, fingerprint: ev?.currentFingerprint ?? null,
    fingerprintChanged: ev?.fingerprintChanged ?? null,
    // Lot 54A : Candidate Builder + déterministe (+ IA) réellement rejoués.
    evaluationMode: (r.aiCalled ? 'AI_REEVALUATION' : tente ? 'FULL_REEVALUATION' : r.status === 'USER_DECIDED' ? 'SUPERSEDED' : 'OBSOLESCENCE_ONLY') as EvaluationMode,
    resolutionAttempted: tente,
    // Lot 57B : parcours de la carte.
    knowledgeSources: ev?.knowledgeCounts ?? null, missingSources: ev?.missingSources ?? null, candidateOrigins: candidateOriginsOf(ev),
    aiOperation: r.aiCalled ? ai?.operation ?? 't3_link_ambiguity' : null, aiTraceId: ai?.traceIds[0] ?? null, aiStatus: ai?.status ?? (r.aiCalled ? 'OK' as const : 'NOT_CALLED' as const),
    aiError: ai?.error ?? null, aiReason: ai?.reason ?? (r.status === 'USER_DECIDED' ? 'USER_DECISION_PROTECTED' : null),
    decision: ev?.decision ?? (r.decision ? (r.decision.kind === 'ABSTAIN' ? `ABSTAIN:${r.decision.reasonCode}` : `${r.decision.kind}:${r.decision.method}`) : null),
    confidence: r.decision?.kind === 'APPLY' ? r.decision.score : null,
    ...(reprise ? { delegatedJobId: reprise.id, delegatedJobStatus: `${reprise.status}:STALLED_RECOVERED` } : {}),
  };
  let actionEffect: OpenActionEffect;
  let note: string | undefined;
  let reasonCode: ReasonCode | undefined;
  let writeAttempted = false;
  let writeVerified: boolean | null = null;
  if (r.outcome === 'APPLIED') {
    writeAttempted = true;
    etape(o.trace, 'VERIFY');
    // Lot 57B : la fermeture annoncée est VÉRIFIÉE en base (carte close, lien posé).
    writeVerified = await linkVerified(Number(row.id), fileId);
    actionEffect = writeVerified ? 'CLOSED' : 'ERROR';
    reasonCode = writeVerified ? 'RESOLVED' : 'PERSISTENCE_FAILED';
    if (!writeVerified) note = 'write_not_verified';
  } else if (r.outcome === 'ABSTAIN') {
    // Carte rafraîchie à l'identique : maintenue ; propositions ou nature modifiées : actualisée ;
    // ancienne carte close au profit d'une autre (nature du problème modifiée) : remplacée.
    const apres = await cardSnapshot(Number(row.id));
    actionEffect = apres === null ? 'SUPERSEDED' : apres !== avant ? 'UPDATED' : 'STILL_OPEN';
    if (apres === null) note = 'card_replaced';
    const rc = (ev?.reasonCode ?? (r.decision?.kind === 'ABSTAIN' ? r.decision.reasonCode : null)) as string | null;
    reasonCode = rc && (REASON_CODES as readonly string[]).includes(rc) ? rc as ReasonCode
      : rc === 'CLOSED_WORLD_VIOLATION' ? 'INSUFFICIENT_EVIDENCE' : 'AWAITING_USER';
    if (reasonCode === 'NO_CANDIDATE' && ev?.missingSources?.includes('EXTRACTION')) reasonCode = 'NO_T1_KNOWLEDGE';
  } else if (r.outcome === 'TARGET_GONE') {
    await closeAction(Number(row.id), 'TARGET_DELETED');
    actionEffect = 'SUPERSEDED';
    note = 'document_gone';
  } else {
    // NO_CHANGE (déjà rattaché) ou SUPERSEDED (décision utilisateur, protégée).
    const etat = await isOpen(Number(row.id));
    if (!etat.open) actionEffect = 'SUPERSEDED';
    else if (r.status === 'ALREADY_LINKED') {
      await closeAction(Number(row.id), 'OBSOLETE');
      actionEffect = 'SUPERSEDED';
      note = 'already_linked';
    } else {
      actionEffect = 'STILL_OPEN';
      if (r.status === 'USER_DECIDED') note = 'user_decision_protected';
    }
    if (r.status === 'USER_DECIDED') reasonCode = 'USER_DECISION_PROTECTED';
  }
  etape(o.trace, 'CLOSE');
  return {
    ...commun, actionEffect, ...(note ? { note } : {}), ...(reasonCode ? { reasonCode } : {}),
    writeAttempted, writeVerified, lastStep: actionEffect === 'ERROR' ? 'WRITE' : 'CLOSE', failedStep: actionEffect === 'ERROR' ? 'VERIFY' : null,
  };
}

interface OtherCtx {
  reconciledAssetIds?: ReadonlySet<number>;
  d: OpenActionsDeps;
  /** ENTITY : 1 réconciliation max par entité et par passage. */
  entites: Set<string>;
  guard?: ExecutionGuard;
  /** T3_OPERATIONS : consolidation du passage (une seule) et effet par carte. */
  /** Borne du cycle : cartes ouvertes au début du passage. */
  borne: number;
  operations: null | { effets: Map<number, { effect: OpenActionEffect; reason: string | null }>; note: string; attempted: boolean; error: string | null; job?: DelegatedJob | null; aiCalls?: number };
  out: OpenActionsResult;
}

/**
 * Lot 54A (écart 3) : relance UNE consolidation Opérations du compte pour le
 * passage (données actuelles), puis relit chaque carte T3_OPERATIONS ouverte
 * au début du passage. Un travail BUSINESS_OPERATIONS vivant du compte la
 * porte déjà : aucune seconde consolidation (jamais de double traitement).
 */
async function consolidationOperations(accountId: number, borne: number, o: OtherCtx): Promise<NonNullable<OtherCtx['operations']>> {
  const db = await sql();
  const cartes = (await db.unsafe(
    `SELECT id, rule_code, target_type, target_id, trigger_context,
            action_kind || '|' || coalesce(proposals_json::text, '') AS snap
       FROM to_process_actions
      WHERE account_id = $1 AND resolved_at IS NULL AND id <= $2 AND rule_code = ANY($3::text[])`,
    [accountId, borne, operationRuleCodes()] as never[],
  )) as unknown as Array<ActionRow & { snap: string }>;
  const avant = new Map(cartes.map((c) => [Number(c.id), c.snap]));
  // Lot 57B (défaut C) : job Opérations vivant → il porte la consolidation ;
  // BLOQUÉ → repris atomiquement, la consolidation est relancée ici.
  const vivant = await delegatedJob('business_operations', accountId);
  if (vivant && !(vivant.stalled && await takeOverStalledJob(vivant.id))) {
    return { effets: new Map(), note: `operations_job_pending:${vivant.id}`, attempted: false, error: null, job: vivant };
  }
  if (vivant) o.out.stalledRecovered += 1;
  const fileIds = [...new Set(cartes.filter((c) => c.target_type === 'DOCUMENT').map((c) => Number(c.target_id)))];
  const operationIds = [...new Set(cartes.map((c) => Number(parseCtx(c.trigger_context).operationId)).filter((n) => Number.isInteger(n) && n > 0))];
  let error: string | null = null;
  try {
    await o.guard?.assertActive('T3 À traiter ouverts — consolidation Opérations');
    const r = await o.d.consolidateOperations!(accountId, { fileIds, operationIds, beforeWrite: o.guard ? (w) => o.guard!.assertActive(w) : undefined });
    o.out.operationsConsolidations += 1;
    o.out.aiCalls += r.aiCalls;
  } catch (e) {
    if (isExecutionCancelled(e)) throw e;
    error = (e as Error).message.slice(0, 200);
    console.error(`[t3-open-actions] compte ${accountId} : consolidation Opérations en échec — ${error}`);
  }
  const effets = new Map<number, { effect: OpenActionEffect; reason: string | null }>();
  if (cartes.length) {
    const apres = (await db.unsafe(
      `SELECT id, resolved_at IS NULL AS open, resolution_reason, action_kind || '|' || coalesce(proposals_json::text, '') AS snap
         FROM to_process_actions WHERE id = ANY($1::int[])`,
      [[...avant.keys()]] as never[],
    )) as unknown as Array<{ id: number; open: boolean; resolution_reason: string | null; snap: string }>;
    for (const a of apres) {
      effets.set(Number(a.id), {
        effect: !a.open ? 'CLOSED' : a.snap !== avant.get(Number(a.id)) ? 'UPDATED' : 'STILL_OPEN',
        reason: a.resolution_reason,
      });
    }
  }
  return { effets, note: vivant ? `operations_consolidated:stalled_job_recovered:${vivant.id}` : 'operations_consolidated', attempted: error === null, error, job: vivant };
}

let reglesOperations: string[] | null = null;
function operationRuleCodes(): string[] {
  if (!reglesOperations) {
    // Registre unique (`PROCESSING_RULES`) : toutes les règles produites par T3_OPERATIONS.
    reglesOperations = ['OPERATION-MATCH', 'OPERATION-CLAIM-PARENT', 'OPERATION-AMOUNT', 'OPERATION-CLAIM-DETACH', 'OPERATION-CLAIM-ASSET']
      .filter((c) => resolverOf(c).resolver === 'T3_OPERATIONS');
  }
  return reglesOperations;
}

/** Autres règles : résolveur T3 dédié, ou SKIPPED_NOT_T3 après contrôle d'obsolescence. */
async function reexamineOther(accountId: number, row: ActionRow, base: Base, resolver: string, t3: boolean, o: OtherCtx, trace?: Trace): Promise<OpenActionEntry> {
  const entry = (p: Partial<OpenActionEntry> & Pick<OpenActionEntry, 'actionEffect'>): OpenActionEntry => ({
    ...base, previousResolution: null, resolver, candidateCount: null, deterministicAttempted: false, aiCalled: false,
    newResolution: null, ...p,
  });
  // Cible supprimée : la carte est sans objet, quel que soit son producteur.
  if (!(await targetExists(accountId, row.target_type, Number(row.target_id)))) {
    await closeAction(Number(row.id), 'TARGET_DELETED');
    return entry({ actionEffect: 'SUPERSEDED', newResolution: 'TARGET_DELETED', note: 'target_gone', evaluationMode: 'OBSOLESCENCE_ONLY', resolutionAttempted: false });
  }
  // T4 et hors T3 : jamais le prompt T3, jamais une « résolution ».
  if (!t3) return entry({ actionEffect: 'SKIPPED_NOT_T3', note: resolver === 'UNKNOWN_RULE' ? 'unknown_rule' : 'outside_t3', evaluationMode: 'NOT_T3', resolutionAttempted: false, reasonCode: 'NOT_T3', aiReason: 'NOT_T3' });
  etape(trace, 'RESOLVER');

  switch (resolver) {
    case 'T3_DOCUMENT_FIELD': {
      // Lot 57B (défaut E) : reprise ciblée depuis la connaissance T1 persistée
      // par le résolveur du pont (déterministe : aucun appel IA).
      if (row.target_type !== 'DOCUMENT' || !o.d.resolveDocumentField) {
        return entry({ actionEffect: 'STILL_OPEN', evaluationMode: 'OBSOLESCENCE_ONLY', resolutionAttempted: false, note: 'unsupported_target' });
      }
      const avant = await cardSnapshot(Number(row.id));
      const r = await o.d.resolveDocumentField(accountId, Number(row.target_id), row.rule_code);
      etape(trace, 'VERIFY');
      const apres = await cardSnapshot(Number(row.id));
      const commun = {
        deterministicAttempted: true, newResolution: r.status, knowledgeSources: r.sources, missingSources: r.missingSources,
        candidateCount: r.proposals, decision: `FIELD:${r.status}`, confidence: r.confidence, writeAttempted: r.writeAttempted,
        writeVerified: r.writeAttempted || r.status === 'RESOLVED' ? r.verified : null, aiReason: 'DETERMINISTIC_PROOF',
        candidateOrigins: Object.keys(r.sources).length ? r.sources : null,
      };
      if (r.status === 'TARGET_GONE') return entry({ ...commun, actionEffect: 'SUPERSEDED', note: 'document_gone', evaluationMode: 'OBSOLESCENCE_ONLY', resolutionAttempted: false, reasonCode: 'TARGET_GONE' });
      if ((r.status === 'WRITTEN' || r.status === 'RESOLVED') && r.verified) {
        return entry({ ...commun, actionEffect: 'CLOSED', evaluationMode: 'DETERMINISTIC_REEVALUATION', resolutionAttempted: true, reasonCode: 'RESOLVED', lastStep: 'CLOSE' });
      }
      if (r.status === 'WRITTEN') {
        return entry({ ...commun, actionEffect: 'ERROR', evaluationMode: 'ERROR', resolutionAttempted: true, reasonCode: 'PERSISTENCE_FAILED', lastStep: 'WRITE', failedStep: 'VERIFY', note: 'write_not_verified' });
      }
      const rc: ReasonCode = r.reasonCode === 'USER_DECISION_PROTECTED' ? 'USER_DECISION_PROTECTED'
        : r.status === 'NO_T1_KNOWLEDGE' ? 'NO_T1_KNOWLEDGE' : r.status === 'NO_EVIDENCE' ? 'FIELD_NOT_IN_T1'
          : r.reasonCode === 'AMBIGUOUS' ? 'AMBIGUOUS' : r.status === 'NOT_A_FIELD' ? 'NOT_T3' : 'INSUFFICIENT_EVIDENCE';
      return entry({
        ...commun, actionEffect: apres === null ? 'SUPERSEDED' : apres !== avant ? 'UPDATED' : 'STILL_OPEN',
        evaluationMode: 'DETERMINISTIC_REEVALUATION', resolutionAttempted: r.status !== 'NOT_A_FIELD', reasonCode: rc,
        ...(rc === 'USER_DECISION_PROTECTED' ? { note: 'user_decision_protected' } : apres === null ? { note: 'card_replaced' } : {}),
      });
    }
    case 'T3_ASSET_CONFLICT': {
      // Obsolescence évaluée en tête de phase (une requête par compte) : constat seulement.
      return entry({ actionEffect: 'STILL_OPEN', deterministicAttempted: true, evaluationMode: 'OBSOLESCENCE_ONLY', resolutionAttempted: false, reasonCode: 'CONFLICT_STILL_VALID' });
    }
    case 'T3_EQUIPMENT_LINK': {
      // Lot 54A (écart 2) : candidats RECONSTRUITS depuis l'état courant.
      if (row.target_type !== 'DOCUMENT' || !o.d.resolveElementLink) {
        return entry({ actionEffect: 'STILL_OPEN', evaluationMode: 'OBSOLESCENCE_ONLY', resolutionAttempted: false, note: 'unsupported_target' });
      }
      const avant = await cardSnapshot(Number(row.id));
      const r = await o.d.resolveElementLink({ accountId, fileId: Number(row.target_id), actionId: Number(row.id), guard: o.guard });
      const commun = {
        candidateCount: r.candidateCount, deterministicAttempted: r.deterministicAttempted, aiCalled: r.aiCalled, newResolution: r.status,
        aiReason: r.aiCalled ? 'STRUCTURED_CANDIDATES_NEED_ARBITRATION' : r.deterministicAttempted ? 'DETERMINISTIC_PROOF' : null,
      };
      if (r.status === 'APPLIED') {
        return entry({ ...commun, actionEffect: 'CLOSED', evaluationMode: r.aiCalled ? 'AI_REEVALUATION' : 'FULL_REEVALUATION', resolutionAttempted: true, note: `equipment:${r.equipmentId}` });
      }
      if (r.status === 'ALREADY_LINKED' || r.status === 'TARGET_GONE') {
        await closeAction(Number(row.id), r.status === 'TARGET_GONE' ? 'TARGET_DELETED' : 'OBSOLETE');
        return entry({ ...commun, actionEffect: 'SUPERSEDED', evaluationMode: 'OBSOLESCENCE_ONLY', resolutionAttempted: false, note: r.status === 'TARGET_GONE' ? 'document_gone' : 'equipment_link_obsolete' });
      }
      if (r.status === 'NO_ASSET') {
        return entry({ ...commun, actionEffect: 'STILL_OPEN', evaluationMode: 'OBSOLESCENCE_ONLY', resolutionAttempted: false, note: 'document_without_asset' });
      }
      const apres = await cardSnapshot(Number(row.id));
      return entry({
        ...commun, actionEffect: apres !== null && apres !== avant ? 'UPDATED' : 'STILL_OPEN',
        evaluationMode: r.aiCalled ? 'AI_REEVALUATION' : 'FULL_REEVALUATION', resolutionAttempted: true,
        reasonCode: (r.candidateCount ?? 0) === 0 ? 'NO_CANDIDATE' : (r.candidateCount ?? 0) > 1 ? 'AMBIGUOUS' : 'INSUFFICIENT_EVIDENCE',
      });
    }
    case 'T3_ASSET': {
      // Le bien de la carte DATA-* est ajouté au périmètre du passage (reconcileAccount) : réconciliation réelle.
      const fait = o.reconciledAssetIds?.has(Number(row.target_id)) === true;
      return entry({
        actionEffect: 'STILL_OPEN', deterministicAttempted: fait, ...(fait ? {} : { note: 'asset_not_eligible' }),
        evaluationMode: fait ? 'DETERMINISTIC_REEVALUATION' : 'OBSOLESCENCE_ONLY', resolutionAttempted: fait,
      });
    }
    case 'T3_ENTITY': {
      const type = row.target_type === 'ROOM' ? 'ROOM' as const : 'EQUIPMENT' as const;
      const cle = `${type}:${row.target_id}`;
      if (!o.entites.has(cle)) {
        o.entites.add(cle);
        const r = await o.d.reconcileEntity({ accountId, target: { type, id: Number(row.target_id) } });
        if (r.skipped) {
          await closeAction(Number(row.id), 'TARGET_DELETED');
          return entry({ actionEffect: 'SUPERSEDED', deterministicAttempted: true, newResolution: 'TARGET_DELETED', note: 'entity_gone', evaluationMode: 'OBSOLESCENCE_ONLY', resolutionAttempted: false });
        }
      }
      const etat = await isOpen(Number(row.id));
      return entry({
        actionEffect: etat.open ? 'STILL_OPEN' : 'CLOSED', deterministicAttempted: true, newResolution: etat.reason,
        evaluationMode: 'DETERMINISTIC_REEVALUATION', resolutionAttempted: true,
      });
    }
    case 'T3_OPERATIONS': {
      // Lot 54A (écart 3) : consolidation RÉELLEMENT relancée, une fois par passage.
      if (!o.d.consolidateOperations) {
        return entry({ actionEffect: 'STILL_OPEN', note: 'operations_consolidation_unavailable', evaluationMode: 'OBSOLESCENCE_ONLY', resolutionAttempted: false });
      }
      if (!o.operations) o.operations = await consolidationOperations(accountId, o.borne, o);
      const ops = o.operations;
      const deleg = ops.job ? { delegatedJobId: ops.job.id, delegatedJobStatus: ops.attempted ? `${ops.job.status}:STALLED_RECOVERED` : ops.job.status } : {};
      if (!ops.attempted) {
        return entry({
          actionEffect: ops.error ? 'ERROR' : 'STILL_OPEN', note: ops.error ?? ops.note,
          evaluationMode: ops.error ? 'ERROR' : 'SUPERSEDED', resolutionAttempted: ops.error !== null,
          reasonCode: ops.error ? 'RESOLVER_FAILED' : 'JOB_PENDING', ...deleg, ...(ops.error ? { failedStep: 'RESOLVER' } : {}),
        });
      }
      const eff = ops.effets.get(Number(row.id)) ?? { effect: 'STILL_OPEN' as OpenActionEffect, reason: null };
      return entry({
        actionEffect: eff.effect, deterministicAttempted: true, newResolution: eff.reason, note: ops.note,
        evaluationMode: 'DETERMINISTIC_REEVALUATION', resolutionAttempted: true, ...deleg,
        writeVerified: eff.effect === 'CLOSED' ? true : null, aiReason: 'OPERATIONS_CONSOLIDATION',
      });
    }
    default:
      return entry({ actionEffect: 'SKIPPED_NOT_T3', evaluationMode: 'NOT_T3', resolutionAttempted: false });
  }
}
