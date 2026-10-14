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
  const [r, e, c, l] = await Promise.all([
    import('../document-asset/resolve-document-asset.service'),
    import('../entity-reconciliation'),
    import('@/services/to-process/document-asset-conflict'),
    import('./document-element-link'),
  ]);
  return {
    resolveDocumentAsset: r.resolveDocumentAsset,
    reconcileEntity: async (p) => e.reconcileEntity({ accountId: p.accountId, target: p.target, triggeredBy: 'manual' }),
    closeObsoleteAssetConflicts: c.closeObsoleteAssetConflicts,
    resolveElementLink: l.resolveDocumentElementLink,
    consolidateOperations: defaultConsolidateOperations,
  };
}

const vide = (): OpenActionsResult => ({
  examined: 0, pages: 0,
  byEffect: Object.fromEntries(OPEN_ACTION_EFFECTS.map((k) => [k, 0])) as Record<OpenActionEffect, number>,
  byResolver: {}, aiCalls: 0, aiDeferred: 0, resolutionAttempted: 0, byEvaluationMode: {}, operationsConsolidations: 0,
  journaled: 0, entries: [], omittedEntries: 0,
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

/** Lot 54A (écart 6) : journal durable, une ligne par carte. Ne lève jamais ; null si indisponible. */
async function journaliser(
  accountId: number, ctx: { accountRunId?: number | null; queueJobId?: number | null }, lot: OpenActionEntry[],
): Promise<number | null> {
  if (lot.length === 0) return 0;
  try {
    const db = await sql();
    const cols = ['account_id', 'account_run_id', 'queue_job_id', 'action_id', 'rule_code', 'target_type', 'target_id', 'resolver',
      'previous_resolution', 'candidate_count', 'deterministic_attempted', 'ai_called', 'resolution_attempted', 'evaluation_mode',
      'new_resolution', 'action_effect', 'fingerprint', 'fingerprint_changed', 'note'];
    const params: unknown[] = [];
    const lignes = lot.map((e) => {
      const v = [accountId, ctx.accountRunId ?? null, ctx.queueJobId ?? null, e.actionId, e.ruleCode, e.targetType, e.targetId, e.resolver,
        e.previousResolution, e.candidateCount, e.deterministicAttempted, e.aiCalled, e.resolutionAttempted ?? false,
        e.evaluationMode ?? 'OBSOLESCENCE_ONLY', e.newResolution, e.actionEffect, e.fingerprint ?? null, e.fingerprintChanged ?? null,
        e.note ? e.note.slice(0, 300) : null];
      const ph = v.map((x) => { params.push(x); return `$${params.length}`; });
      return `(${ph.join(', ')})`;
    });
    await db.unsafe(`INSERT INTO t3_open_action_evaluations (${cols.join(', ')}) VALUES ${lignes.join(', ')}`, params as never[]);
    return lot.length;
  } catch (e) {
    console.error(`[t3-open-actions] compte ${accountId} : journal des réexamens indisponible (${(e as Error).message}) — rapport du job seul.`);
    return null;
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

async function liveDocumentJob(fileId: number): Promise<boolean> {
  const rows = (await (await sql()).unsafe(
    `SELECT 1 FROM ai_job_queue WHERE treatment = 'T3' AND target_type = 'document' AND target_id = $1 AND status IN ('PENDING', 'RUNNING') LIMIT 1`,
    [String(fileId)] as never[],
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
  const tampon: OpenActionEntry[] = [];
  let journalOk = true;
  const vider = async () => {
    const lot = tampon.splice(0, tampon.length);
    const n = await journaliser(accountId, { accountRunId: opts.accountRunId, queueJobId: opts.queueJobId }, lot);
    if (n === null) journalOk = false;
    else if (out.journaled !== null) out.journaled += n;
  };
  const enregistrer = (brute: OpenActionEntry) => {
    const e: OpenActionEntry = { ...brute, examined: true, ...classifyEvaluation(brute) };
    out.examined += 1;
    out.byEffect[e.actionEffect] += 1;
    out.byResolver[e.resolver] = (out.byResolver[e.resolver] ?? 0) + 1;
    out.byEvaluationMode[e.evaluationMode!] = (out.byEvaluationMode[e.evaluationMode!] ?? 0) + 1;
    if (e.resolutionAttempted) out.resolutionAttempted += 1;
    if (e.aiCalled) out.aiCalls += 1;
    if (out.entries.length < OPEN_ACTIONS_REPORT_MAX) out.entries.push(e);
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
          });
          continue;
        }
        if (resolver === 'T3_DOCUMENT_ASSET') {
          // Réexamen complet, IA si nécessaire — lot 54A : jamais reporté pour quota T3.
          enregistrer(await reexamineDocument(accountId, row, base, { ...opts, d }));
          continue;
        }
        enregistrer(await reexamineOther(accountId, row, base, resolver, t3, ctxAutres));
      } catch (err) {
        if (isExecutionCancelled(err)) throw err;
        enregistrer({
          ...base, previousResolution: null, resolver, candidateCount: null, deterministicAttempted: false, aiCalled: false,
          newResolution: null, actionEffect: 'ERROR', note: (err as Error).message.slice(0, 200),
          evaluationMode: 'ERROR', resolutionAttempted: t3,
        });
      }
    }
    await vider();
    if (rows.length < OPEN_ACTIONS_PAGE_SIZE) break;
  }
  await vider();
  if (!journalOk) out.journaled = null;
  if (out.examined > 0) await purgerJournal(accountId);
  if (out.examined > 0) {
    console.info(`[t3-open-actions] compte ${accountId} : ${out.examined} ligne(s) ouverte(s) examinée(s) en ${out.pages} page(s), `
      + `${out.resolutionAttempted} réellement retentée(s) — `
      + `${OPEN_ACTION_EFFECTS.filter((k) => out.byEffect[k] > 0).map((k) => `${k} ${out.byEffect[k]}`).join(', ')}`
      + ` · IA ${out.aiCalls}${out.operationsConsolidations ? ' · consolidation Opérations relancée' : ''}`
      + ` · journal ${out.journaled ?? 'indisponible'}`);
  }
  return out;
}

type Base = Pick<OpenActionEntry, 'actionId' | 'ruleCode' | 'targetType' | 'targetId'>;

/** LINK-ASSET : réexamen complet du document (voie canonique). */
async function reexamineDocument(accountId: number, row: ActionRow, base: Base, o: {
  guard?: ExecutionGuard; triggerCode?: string | null; indexes?: MatchingIndexCache; d: OpenActionsDeps;
}): Promise<OpenActionEntry> {
  const fileId = Number(row.target_id);
  const cle = { actionId: base.actionId, ruleCode: base.ruleCode, targetType: base.targetType, targetId: base.targetId };
  if (await liveDocumentJob(fileId)) {
    // Un travail DOCUMENT_ASSET vivant réexamine déjà ce document : jamais deux évaluations.
    return {
      ...cle, previousResolution: null, resolver: 'T3_DOCUMENT_ASSET', candidateCount: null, deterministicAttempted: false,
      aiCalled: false, newResolution: null, actionEffect: 'STILL_OPEN', note: 'job_pending', fingerprint: null, fingerprintChanged: null,
      evaluationMode: 'SUPERSEDED', resolutionAttempted: false,
    };
  }
  const index = o.indexes ? await o.indexes.get(accountId) : undefined;
  const avant = await cardSnapshot(Number(row.id));
  const r = await o.d.resolveDocumentAsset({
    accountId, fileId, guard: o.guard, triggerCode: o.triggerCode ?? 'schedule_hourly', reprocessReason: 'OPEN_ACTION',
    openActionId: Number(row.id), rearbitration: 'allow', ...(index ? { index } : {}),
  });
  const ev = r.evaluation;
  const tente = r.status !== 'USER_DECIDED' && r.status !== 'TARGET_GONE' && r.status !== 'ALREADY_LINKED';
  const commun = {
    ...cle, resolver: 'T3_DOCUMENT_ASSET', previousResolution: ev?.previousResolution ?? null,
    candidateCount: ev?.candidateCount ?? null, deterministicAttempted: r.status !== 'USER_DECIDED' && r.status !== 'TARGET_GONE',
    aiCalled: r.aiCalled, newResolution: r.status, fingerprint: ev?.currentFingerprint ?? null,
    fingerprintChanged: ev?.fingerprintChanged ?? null,
    // Lot 54A : Candidate Builder + déterministe (+ IA) réellement rejoués.
    evaluationMode: (r.aiCalled ? 'AI_REEVALUATION' : tente ? 'FULL_REEVALUATION' : r.status === 'USER_DECIDED' ? 'SUPERSEDED' : 'OBSOLESCENCE_ONLY') as EvaluationMode,
    resolutionAttempted: tente,
  };
  let actionEffect: OpenActionEffect;
  let note: string | undefined;
  if (r.outcome === 'APPLIED') {
    actionEffect = 'CLOSED';
  } else if (r.outcome === 'ABSTAIN') {
    // Carte rafraîchie à l'identique : maintenue ; propositions ou nature modifiées : actualisée ;
    // ancienne carte close au profit d'une autre (nature du problème modifiée) : remplacée.
    const apres = await cardSnapshot(Number(row.id));
    actionEffect = apres === null ? 'SUPERSEDED' : apres !== avant ? 'UPDATED' : 'STILL_OPEN';
    if (apres === null) note = 'card_replaced';
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
  }
  return { ...commun, actionEffect, ...(note ? { note } : {}) };
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
  operations: null | { effets: Map<number, { effect: OpenActionEffect; reason: string | null }>; note: string; attempted: boolean; error: string | null };
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
  const [vivant] = (await db.unsafe(
    `SELECT id FROM ai_job_queue WHERE treatment = 'T3' AND target_type = 'business_operations' AND target_id = $1
        AND status IN ('PENDING', 'RUNNING') LIMIT 1`,
    [String(accountId)] as never[],
  )) as unknown as Array<{ id: number }>;
  if (vivant) return { effets: new Map(), note: `operations_job_pending:${vivant.id}`, attempted: false, error: null };
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
  return { effets, note: 'operations_consolidated', attempted: error === null, error };
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
async function reexamineOther(accountId: number, row: ActionRow, base: Base, resolver: string, t3: boolean, o: OtherCtx): Promise<OpenActionEntry> {
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
  if (!t3) return entry({ actionEffect: 'SKIPPED_NOT_T3', note: resolver === 'UNKNOWN_RULE' ? 'unknown_rule' : 'outside_t3', evaluationMode: 'NOT_T3', resolutionAttempted: false });

  switch (resolver) {
    case 'T3_ASSET_CONFLICT': {
      // Obsolescence évaluée en tête de phase (une requête par compte) : constat seulement.
      return entry({ actionEffect: 'STILL_OPEN', deterministicAttempted: true, evaluationMode: 'OBSOLESCENCE_ONLY', resolutionAttempted: false });
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
      if (!ops.attempted) {
        return entry({
          actionEffect: ops.error ? 'ERROR' : 'STILL_OPEN', note: ops.error ?? ops.note,
          evaluationMode: ops.error ? 'ERROR' : 'SUPERSEDED', resolutionAttempted: ops.error !== null,
        });
      }
      const eff = ops.effets.get(Number(row.id)) ?? { effect: 'STILL_OPEN' as OpenActionEffect, reason: null };
      return entry({
        actionEffect: eff.effect, deterministicAttempted: true, newResolution: eff.reason, note: ops.note,
        evaluationMode: 'DETERMINISTIC_REEVALUATION', resolutionAttempted: true,
      });
    }
    default:
      return entry({ actionEffect: 'SKIPPED_NOT_T3', evaluationMode: 'NOT_T3', resolutionAttempted: false });
  }
}
