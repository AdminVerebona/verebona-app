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
 *                          qu'un historique. Plafond de coût des réarbitrages
 *                          à contexte inchangé (`rearbitration-budget.ts`) ;
 *   LINK-ASSET-CONFLICT  → T3 conflit document / bien (obsolescence) ;
 *   LINK-ELT             → rattachement équipement : obsolescence déterministe ;
 *   DATA-* (RECONCILIATION_BRIDGE) → réconciliation T3 du bien (périmètre du
 *                          passage élargi à ces biens) ;
 *   ENTITY-FIELD(-ROOM)  → réconciliation T3 de l'entité ;
 *   OPERATION-*          → consolidation T3 des Opérations (balayage dédié) ;
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
  /** Précision (travail vivant, réarbitrage reporté, cible supprimée…). */
  note?: string;
}

export interface OpenActionsResult {
  examined: number;
  pages: number;
  byEffect: Record<OpenActionEffect, number>;
  byResolver: Record<string, number>;
  aiCalls: number;
  aiDeferred: number;
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
  /** Appels `t3_link_ambiguity` du compte sur 24 h. */
  callsLastDay: (accountId: number) => Promise<number>;
  maxPerPass: number;
  maxPerDay: number;
}

async function defaultDeps(): Promise<OpenActionsDeps> {
  const [r, e, c, b] = await Promise.all([
    import('../document-asset/resolve-document-asset.service'),
    import('../entity-reconciliation'),
    import('@/services/to-process/document-asset-conflict'),
    import('../document-asset/rearbitration-budget'),
  ]);
  return {
    resolveDocumentAsset: r.resolveDocumentAsset,
    reconcileEntity: async (p) => e.reconcileEntity({ accountId: p.accountId, target: p.target, triggeredBy: 'manual' }),
    closeObsoleteAssetConflicts: c.closeObsoleteAssetConflicts,
    callsLastDay: b.linkAmbiguityCallsLastDay,
    maxPerPass: b.rearbitrationsPerPass(),
    maxPerDay: b.rearbitrationsPerDay(),
  };
}

const vide = (): OpenActionsResult => ({
  examined: 0, pages: 0,
  byEffect: Object.fromEntries(OPEN_ACTION_EFFECTS.map((k) => [k, 0])) as Record<OpenActionEffect, number>,
  byResolver: {}, aiCalls: 0, aiDeferred: 0, entries: [], omittedEntries: 0,
});

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

/**
 * LINK-ELT encore pertinent ? Le document existe, n'a pas d'équipement, et au
 * moins un équipement proposé appartient encore à son bien.
 */
async function equipmentLinkStillRelevant(accountId: number, fileId: number, proposals: number[]): Promise<boolean> {
  const rows = (await (await sql()).unsafe(
    `SELECT f.equipment_id, coalesce(f.asset_id, f.linked_asset_id) AS asset_id,
            (SELECT count(*)::int FROM equipments e JOIN assets a ON a.id = e.asset_id AND a.account_id = $2 AND a.deleted_at IS NULL
              WHERE e.id = ANY($3::int[]) AND e.asset_id = coalesce(f.asset_id, f.linked_asset_id) AND e.archived_at IS NULL) AS candidats
       FROM asset_files f WHERE f.id = $1 AND f.account_id = $2 AND f.deleted_at IS NULL`,
    [fileId, accountId, proposals] as never[],
  )) as unknown as Array<{ equipment_id: number | null; asset_id: number | null; candidats: number }>;
  const r = rows[0];
  return !!r && r.equipment_id === null && r.asset_id !== null && Number(r.candidats) > 0;
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
  const enregistrer = (e: OpenActionEntry) => {
    out.examined += 1;
    out.byEffect[e.actionEffect] += 1;
    out.byResolver[e.resolver] = (out.byResolver[e.resolver] ?? 0) + 1;
    if (e.aiCalled) out.aiCalls += 1;
    if (out.entries.length < OPEN_ACTIONS_REPORT_MAX) out.entries.push(e);
    else out.omittedEntries += 1;
    if (e.actionEffect !== 'STILL_OPEN' && e.actionEffect !== 'SKIPPED_NOT_T3') {
      console.info(`[t3-open-actions] ${JSON.stringify({ accountId, ...e })}`);
    }
  };

  const entites = new Set<string>();
  // Plafond des réarbitrages à contexte INCHANGÉ (rearbitration-budget.ts).
  const restantJour = Math.max(0, d.maxPerDay - await d.callsLastDay(accountId));
  const motifReport: 'PASS_CAP' | 'DAY_CAP' = restantJour > 0 ? 'PASS_CAP' : 'DAY_CAP';
  const reportes: Array<{ row: ActionRow; entry: OpenActionEntry; lastAiAt: string | null }> = [];
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
          enregistrer({
            ...base, previousResolution: null, resolver, candidateCount: null, deterministicAttempted: t3, aiCalled: false,
            newResolution: row.resolution_reason, actionEffect: effectOfClosedDuringRun(resolver, row.resolution_reason), note: 'closed_during_run',
          });
          continue;
        }
        if (resolver === 'T3_DOCUMENT_ASSET') {
          // 1er temps : réexamen complet ; un réarbitrage IA à contexte inchangé
          // est mis de côté (budget réparti ensuite, plus anciens d'abord).
          const e = await reexamineDocument(accountId, row, base, { ...opts, d, rearbitration: { defer: motifReport } });
          if (e.deferred) reportes.push({ row, entry: e.entry, lastAiAt: e.lastAiAt });
          else enregistrer(e.entry);
          continue;
        }
        enregistrer(await reexamineOther(accountId, row, base, resolver, t3, { reconciledAssetIds: opts.reconciledAssetIds, d, entites }));
      } catch (err) {
        if (isExecutionCancelled(err)) throw err;
        enregistrer({
          ...base, previousResolution: null, resolver, candidateCount: null, deterministicAttempted: false, aiCalled: false,
          newResolution: null, actionEffect: 'ERROR', note: (err as Error).message.slice(0, 200),
        });
      }
    }
    if (rows.length < OPEN_ACTIONS_PAGE_SIZE) break;
  }

  // 2e temps : réarbitrages à contexte INCHANGÉ dans la limite du passage et
  // du jour, les plus anciennement arbitrés d'abord ; les autres restent
  // reportés (carte maintenue, évaluation AI_DEFERRED) au passage suivant.
  let budget = Math.min(d.maxPerPass, restantJour);
  reportes.sort((a, b) => (a.lastAiAt ?? '').localeCompare(b.lastAiAt ?? '') || Number(a.row.id) - Number(b.row.id));
  for (const { row, entry } of reportes) {
    if (budget <= 0) {
      out.aiDeferred += 1;
      enregistrer(entry);
      continue;
    }
    try {
      const e = await reexamineDocument(accountId, row, entry, { ...opts, d, rearbitration: 'allow' });
      if (e.entry.aiCalled) budget -= 1;
      enregistrer(e.entry);
    } catch (err) {
      if (isExecutionCancelled(err)) throw err;
      enregistrer({ ...entry, aiCalled: false, actionEffect: 'ERROR', note: (err as Error).message.slice(0, 200) });
    }
  }
  if (out.examined > 0) {
    console.info(`[t3-open-actions] compte ${accountId} : ${out.examined} ligne(s) ouverte(s) examinée(s) en ${out.pages} page(s) — `
      + `${OPEN_ACTION_EFFECTS.filter((k) => out.byEffect[k] > 0).map((k) => `${k} ${out.byEffect[k]}`).join(', ')}`
      + ` · IA ${out.aiCalls}${out.aiDeferred ? ` (reportée ${out.aiDeferred})` : ''}`);
  }
  return out;
}

type Base = Pick<OpenActionEntry, 'actionId' | 'ruleCode' | 'targetType' | 'targetId'>;

/** LINK-ASSET : réexamen complet du document (voie canonique). */
async function reexamineDocument(accountId: number, row: ActionRow, base: Base, o: {
  guard?: ExecutionGuard; triggerCode?: string | null; indexes?: MatchingIndexCache; d: OpenActionsDeps;
  rearbitration: 'allow' | { defer: 'PASS_CAP' | 'DAY_CAP' };
}): Promise<{ entry: OpenActionEntry; deferred: boolean; lastAiAt: string | null }> {
  const fileId = Number(row.target_id);
  const cle = { actionId: base.actionId, ruleCode: base.ruleCode, targetType: base.targetType, targetId: base.targetId };
  if (await liveDocumentJob(fileId)) {
    // Un travail DOCUMENT_ASSET vivant réexamine déjà ce document : jamais deux évaluations.
    return {
      entry: {
        ...cle, previousResolution: null, resolver: 'T3_DOCUMENT_ASSET', candidateCount: null, deterministicAttempted: false,
        aiCalled: false, newResolution: null, actionEffect: 'STILL_OPEN', note: 'job_pending', fingerprint: null, fingerprintChanged: null,
      },
      deferred: false, lastAiAt: null,
    };
  }
  const index = o.indexes ? await o.indexes.get(accountId) : undefined;
  const avant = await cardSnapshot(Number(row.id));
  const r = await o.d.resolveDocumentAsset({
    accountId, fileId, guard: o.guard, triggerCode: o.triggerCode ?? 'schedule_hourly', reprocessReason: 'OPEN_ACTION',
    openActionId: Number(row.id), rearbitration: o.rearbitration, ...(index ? { index } : {}),
  });
  const ev = r.evaluation;
  const commun = {
    ...cle, resolver: 'T3_DOCUMENT_ASSET', previousResolution: ev?.previousResolution ?? null,
    candidateCount: ev?.candidateCount ?? null, deterministicAttempted: r.status !== 'USER_DECIDED' && r.status !== 'TARGET_GONE',
    aiCalled: r.aiCalled, newResolution: r.status, fingerprint: ev?.currentFingerprint ?? null,
    fingerprintChanged: ev?.fingerprintChanged ?? null,
  };
  if (r.aiDeferred) {
    return { entry: { ...commun, actionEffect: 'STILL_OPEN', note: `ai_deferred:${r.aiDeferred}` }, deferred: true, lastAiAt: ev?.lastAiAt ?? null };
  }
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
  return { entry: { ...commun, actionEffect, ...(note ? { note } : {}) }, deferred: false, lastAiAt: null };
}

/** Autres règles : résolveur T3 dédié, ou SKIPPED_NOT_T3 après contrôle d'obsolescence. */
async function reexamineOther(accountId: number, row: ActionRow, base: Base, resolver: string, t3: boolean, o: {
  reconciledAssetIds?: ReadonlySet<number>; d: OpenActionsDeps; entites: Set<string>;
}): Promise<OpenActionEntry> {
  const entry = (p: Partial<OpenActionEntry> & Pick<OpenActionEntry, 'actionEffect'>): OpenActionEntry => ({
    ...base, previousResolution: null, resolver, candidateCount: null, deterministicAttempted: false, aiCalled: false,
    newResolution: null, ...p,
  });
  // Cible supprimée : la carte est sans objet, quel que soit son producteur.
  if (!(await targetExists(accountId, row.target_type, Number(row.target_id)))) {
    await closeAction(Number(row.id), 'TARGET_DELETED');
    return entry({ actionEffect: 'SUPERSEDED', newResolution: 'TARGET_DELETED', note: 'target_gone' });
  }
  if (!t3) return entry({ actionEffect: 'SKIPPED_NOT_T3', note: resolver === 'UNKNOWN_RULE' ? 'unknown_rule' : 'outside_t3' });

  switch (resolver) {
    case 'T3_ASSET_CONFLICT': {
      // Obsolescence évaluée en tête de phase (une requête par compte).
      return entry({ actionEffect: 'STILL_OPEN', deterministicAttempted: true });
    }
    case 'T3_EQUIPMENT_LINK': {
      const proposals = (() => {
        const ctx = parseCtx(row.trigger_context);
        const ids = Array.isArray(ctx.candidates) ? ctx.candidates : [];
        return ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
      })();
      if (row.target_type === 'DOCUMENT' && proposals.length > 0
        && !(await equipmentLinkStillRelevant(accountId, Number(row.target_id), proposals))) {
        await closeAction(Number(row.id), 'OBSOLETE');
        return entry({ actionEffect: 'SUPERSEDED', deterministicAttempted: true, newResolution: 'OBSOLETE', note: 'equipment_link_obsolete' });
      }
      return entry({ actionEffect: 'STILL_OPEN', deterministicAttempted: true });
    }
    case 'T3_ASSET': {
      const fait = o.reconciledAssetIds?.has(Number(row.target_id)) === true;
      return entry({ actionEffect: 'STILL_OPEN', deterministicAttempted: fait, ...(fait ? {} : { note: 'asset_not_eligible' }) });
    }
    case 'T3_ENTITY': {
      const type = row.target_type === 'ROOM' ? 'ROOM' as const : 'EQUIPMENT' as const;
      const cle = `${type}:${row.target_id}`;
      if (!o.entites.has(cle)) {
        o.entites.add(cle);
        const r = await o.d.reconcileEntity({ accountId, target: { type, id: Number(row.target_id) } });
        if (r.skipped) {
          await closeAction(Number(row.id), 'TARGET_DELETED');
          return entry({ actionEffect: 'SUPERSEDED', deterministicAttempted: true, newResolution: 'TARGET_DELETED', note: 'entity_gone' });
        }
      }
      const etat = await isOpen(Number(row.id));
      return entry({ actionEffect: etat.open ? 'STILL_OPEN' : 'CLOSED', deterministicAttempted: true, newResolution: etat.reason });
    }
    case 'T3_OPERATIONS':
      return entry({ actionEffect: 'STILL_OPEN', note: 'operations_consolidation' });
    default:
      return entry({ actionEffect: 'SKIPPED_NOT_T3' });
  }
}
