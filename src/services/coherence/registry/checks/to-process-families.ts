/**
 * Familles « À traiter » restantes du registre de cohérence — lot 85B (CDC
 * cohérence §4.6, complément PO du 23/10 ; arbitrages C-Q1, C-Q2, C-Q9,
 * C-Q11 ; lacunes déclarées par 83E dans `coverage.ts`).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE FAMILLE = SON PRODUCTEUR EXISTANT UTILISÉ EN RÉPARATION
 *
 * Même modèle que COH-TODO-RELEVANCE-CARDS (lot 83E) : le contrôle repère, en
 * LECTURE SEULE, une carte ouverte que la décision COURANTE de sa famille ne
 * justifie plus ; la réparation rappelle le producteur (ou le service de
 * fermeture) de la famille, restreint à la cible — c'est lui qui ferme, met à
 * jour ou rouvre, et qui trace. Aucun nouveau moteur, aucune règle recopiée,
 * aucune écriture directe ici, aucun appel IA, jamais T1.
 *
 *   COH-TODO-T3-FIELD-CARDS     arbitrages T3 de champ de BIEN (pont de
 *     réconciliation : règles du producteur RECONCILIATION_BRIDGE) et champs
 *     d'ENTITÉ (équipement, Pièce : ENTITY-FIELD, ENTITY-FIELD-ROOM).
 *     Évaluation : `evaluateAssetField` / `evaluateEntityField` (mêmes étapes
 *     que la réconciliation, sans écriture, sans revue IA), traduite par la
 *     table du producteur (`mapReconciliationDecision`, règles de
 *     `syncEntityFieldCards`). Carte périmée (donnée désormais tranchée : la
 *     décision du producteur est une FERMETURE, ou un changement de nature) →
 *     le producteur lui-même (`syncReconciliationToProcess`,
 *     `syncEntityFieldCards`) avec ces décisions. Faux arbitrage (valeurs
 *     équivalentes, lot 81A) → le réexamen 81A (`reexamineCard`) : carte
 *     CORRIGÉE ou close, tracée — la campagne automatique 81A est retirée
 *     (C-Q9 : une seule chaîne, le rattrapage BO garde le même code).
 *   COH-TODO-OPERATION-CARDS    ambiguïtés de consolidation des Opérations
 *     (OPERATION-MATCH / -AMOUNT / -CURRENCY / -CLAIM-ASSET). Carte périmée :
 *     candidat disparu, dernière décision T3 du candidat qui ne demande plus
 *     d'arbitrage, réalité proposée disparue ; Opération fusionnée, invalidée,
 *     document retiré de l'Opération, ou Opération recalculée APRÈS la
 *     dernière reconduction de la carte sans la reconduire (fermeture perdue,
 *     lot 54D E05). Producteur : consolidation T3 du document
 *     (`consolidateDocument`) ou reconsolidation de l'Opération
 *     (`reconsolidateOperations`) — déterministes, la phase M3 (IA) reste au
 *     passage T3 ; les cartes non reconduites sont closes par
 *     `syncOperationCards` (OBSOLETE, trace T3).
 *   COH-TODO-MIGRATION-REVIEW-CARDS  revues de migration CDC 15 (MIG-REVIEW) :
 *     la valeur en place a changé depuis l'ouverture de la carte (contrôle
 *     optimiste de la famille) → carte PÉRIMÉE par le service de la famille
 *     (`perimer`, événement OBSOLETE « CURRENT_VALUE_CHANGED ») — exactement
 *     ce que ferait sa résolution ; jamais aucune valeur écrite.
 *   COH-TODO-AGENDA-PROPOSAL-CARDS   propositions d'agenda (AGENDA-PROPOSAL) :
 *     un événement de même clé fonctionnelle existe déjà (règle R5 de la
 *     famille, appliquée jusqu'ici à la seule écriture) → fermeture par le
 *     service de la famille (`closeObsoleteAgendaProposals`, tracée).
 *
 * Une même anomalie n'est corrigée que par UNE chaîne (C-Q9) : une carte dont
 * la cible a disparu relève du seul COH-TODO-ORPHAN-CARDS ; un champ sans
 * objet pour le bien (immatriculation d'un vélo), du balayage horaire
 * (`closeInapplicableAssetFieldActions`) ; une contradiction d'Opération
 * disparue sur une Opération inchangée et non recalculée, du passage T3
 * suivant (documents « sales », `listDirtyDocuments`).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { CheckContext, CoherenceCheck, Inspection, RepairResult } from '../types';
import { hashOf, idsOf, intArray, rows, type Row } from '../util';

type Proposal = { value: unknown; label?: string; isCurrentValue?: boolean; evidenceIds?: string[]; confidence?: number };

const asJson = <T>(v: unknown, def: T): T => {
  if (v == null) return def;
  if (typeof v === 'string') { try { return JSON.parse(v) as T; } catch { return def; } }
  return v as T;
};

/** Cartes ouvertes d'une liste de règles, par identifiant croissant (pagination du registre). */
async function openCards(ctx: CheckContext, accountId: number, rules: readonly string[], afterId: number, limit: number): Promise<number[]> {
  return idsOf(await rows(ctx.sql, `
    SELECT a.id FROM to_process_actions a
     WHERE a.account_id = $1 AND a.resolved_at IS NULL AND a.rule_code = ANY($2::text[]) AND a.id > $3
     ORDER BY a.id LIMIT $4`, [accountId, [...rules], afterId, limit]));
}

/** Résumé borné de décisions de réconciliation (constat, empreinte). */
const resume = (ds: ReadonlyArray<{ action: string; reasonCode: string; proposedValue?: unknown }>) =>
  ds.map((d) => ({ action: d.action, reasonCode: d.reasonCode, proposedValue: d.proposedValue ?? null }));

// ══ COH-TODO-T3-FIELD-CARDS ═════════════════════════════════════════════════

/** Règles des cartes de champ produites par T3 (pont de réconciliation des biens, champs d'entité) — lues du catalogue. */
export async function t3FieldCardRuleCodes(): Promise<string[]> {
  const { PROCESSING_RULES } = await import('@/services/to-process/rules-catalog');
  return PROCESSING_RULES.filter((r) => r.producer === 'RECONCILIATION_BRIDGE' || r.producer === 'T3_ENTITY_FIELDS').map((r) => r.code);
}

type ReconDecision = import('@/services/ai/reconciliation/types').ReconciliationDecision;

/** Intention du producteur pour la carte (pure) : maintien, fermeture, changement de nature. */
type FieldCardVerdict = 'JUSTIFIED' | 'STALE' | 'KIND_CHANGED' | 'NO_DECISION';

/**
 * Lot 85B — verdict d'une carte de champ de BIEN (pure) à partir des
 * intentions du pont (`mapReconciliationDecision`) pour SA donnée : une
 * intention de maintien de même nature la justifie ; une fermeture sans
 * maintien la périme (comme le pont : une fermeture d'alias ne ferme jamais
 * une carte reconduite dans le même passage) ; un maintien d'une autre nature
 * la remplace.
 */
export function assetFieldCardVerdict(cardKind: string, intents: ReadonlyArray<{ kind: 'UPSERT' | 'RESOLVE'; actionKind?: string } | null>): FieldCardVerdict {
  const vus = intents.filter((i): i is { kind: 'UPSERT' | 'RESOLVE'; actionKind?: string } => !!i);
  if (vus.some((i) => i.kind === 'UPSERT' && i.actionKind === cardKind)) return 'JUSTIFIED';
  if (vus.some((i) => i.kind === 'UPSERT')) return 'KIND_CHANGED';
  if (vus.some((i) => i.kind === 'RESOLVE')) return 'STALE';
  return 'NO_DECISION';
}

/**
 * Lot 85B — verdict d'une carte de champ d'ENTITÉ (pure), mêmes règles que
 * `syncEntityFieldCards` : un conflit avec une véritable alternative la
 * maintient ; un conflit sans alternative ne ferme rien ; une décision
 * tranchée (apply / update / keep) la ferme.
 */
export function entityFieldCardVerdict(decisions: ReadonlyArray<{ action: string; proposals: number }>): FieldCardVerdict {
  if (decisions.some((d) => d.action === 'create_conflict' && d.proposals > 0)) return 'JUSTIFIED';
  if (decisions.some((d) => d.action === 'create_conflict')) return 'NO_DECISION';
  if (decisions.some((d) => d.action === 'apply' || d.action === 'update' || d.action === 'keep')) return 'STALE';
  return 'NO_DECISION';
}

interface FieldCard { id: number; accountId: number; targetType: string; targetId: number; fieldKey: string; ruleCode: string; actionKind: string; proposals: Proposal[]; open: boolean }

async function fieldCards(ctx: CheckContext, accountId: number, ids: readonly number[]): Promise<Map<number, FieldCard>> {
  const r = await rows(ctx.sql, `
    SELECT id, account_id, target_type, target_id, field_key, rule_code, action_kind, proposals_json, resolved_at IS NULL AS open
      FROM to_process_actions WHERE account_id = $1 AND id = ANY($2::int[])`, [accountId, intArray(ids)]);
  return new Map(r.map((x: Row) => [Number(x.id), {
    id: Number(x.id), accountId: Number(x.account_id), targetType: String(x.target_type), targetId: Number(x.target_id),
    fieldKey: String(x.field_key ?? ''), ruleCode: String(x.rule_code), actionKind: String(x.action_kind),
    proposals: asJson<Proposal[]>(x.proposals_json, []), open: x.open === true,
  }]));
}

/** Évaluation en lecture seule de la donnée d'une carte, et décisions du producteur qui la concernent. */
async function evaluateFieldCard(c: FieldCard): Promise<{ missing: boolean; verdict: FieldCardVerdict; decisions: ReconDecision[] }> {
  if (c.targetType === 'ASSET') {
    const [{ evaluateAssetField }, { mapReconciliationDecision }, { canonicalAssetKey }] = await Promise.all([
      import('@/services/ai/reconciliation/reconciliation-engine'), import('@/services/to-process/reconciliation-bridge'),
      import('@/services/to-process/rules-catalog'),
    ]);
    const ev = await evaluateAssetField(c.accountId, c.targetId, canonicalAssetKey(c.fieldKey));
    if (ev.missing) return { missing: true, verdict: 'NO_DECISION', decisions: [] };
    const miennes = ev.decisions.filter((d) => mapReconciliationDecision(d)?.fieldKey === c.fieldKey);
    return { missing: false, verdict: assetFieldCardVerdict(c.actionKind, miennes.map((d) => mapReconciliationDecision(d))), decisions: miennes };
  }
  const [{ evaluateEntityField }, { entityConflictProposals }] = await Promise.all([
    import('@/services/ai/reconciliation/entity-reconciliation'), import('@/services/to-process/entity-field-cards'),
  ]);
  const ev = await evaluateEntityField(c.accountId, { type: c.targetType as 'EQUIPMENT' | 'ROOM', id: c.targetId }, c.fieldKey);
  if (ev.missing) return { missing: true, verdict: 'NO_DECISION', decisions: [] };
  const miennes = ev.decisions.filter((d) => d.fieldKey === c.fieldKey);
  return { missing: false, verdict: entityFieldCardVerdict(miennes.map((d) => ({ action: d.action, proposals: entityConflictProposals(d).length }))), decisions: miennes };
}

const toProcessT3FieldCardsCheck: CoherenceCheck = {
  id: 'COH-TODO-T3-FIELD-CARDS',
  version: 1,
  status: 'ACTIVE',
  title: '« À traiter » : arbitrages T3 de champ (bien, équipement, Pièce) que la décision courante ne justifie plus',
  domain: 'a-traiter',
  level: 'N2',
  objectType: 'to_process_action',
  scope: 'cartes ouvertes des règles du pont de réconciliation (champs de bien) et des champs d’entité (ENTITY-FIELD, ENTITY-FIELD-ROOM)',
  sources: ['to_process_actions', 'field_evidence', 'assets', 'equipments', 'substructures', 'inconsistency_registry', 'reconciliation_decisions'],
  applicability: 'compte éligible ; cible vivante (sinon : COH-TODO-ORPHAN-CARDS) ; champ applicable au bien (sinon : balayage horaire)',
  invariant: 'une carte de champ ouverte correspond à la décision COURANTE du producteur pour sa donnée (contradiction réelle ou donnée attendue), sans proposition équivalente à la valeur en place',
  anomalies: ['FIELD_CARD_STALE', 'FIELD_CARD_KIND_CHANGED', 'FALSE_ARBITRATION'],
  autoRepairWhen: 'toujours (producteur de la famille restreint à la donnée de la carte ; réexamen 81A pour un faux arbitrage) — aucune valeur de fiche écrite',
  forbiddenRepairs: ['écrire une valeur de fiche', 'fermer une carte sans décision du producteur', 'supprimer une carte', 'appeler l’IA (revue T3)', 'relancer T1'],
  services: [
    'ai/reconciliation/reconciliation-engine#evaluateAssetField', 'ai/reconciliation/entity-reconciliation#evaluateEntityField',
    'to-process/reconciliation-bridge#syncReconciliationToProcess', 'to-process/entity-field-cards#syncEntityFieldCards',
    'to-process/arbitration-equivalence-reprise#reexamineCard',
  ],
  chain: ['T3', 'TO_PROCESS'],
  triggers: ['ASSET_UPDATED', 'SOURCE_ANALYZED'],
  frequency: 'campagne exhaustive quotidienne + contrôle ciblé au changement du bien',
  criticality: 'MEDIUM',
  tests: ['L85B-E2E-01', 'L85B-U-FAMILIES'],

  async listObjects(ctx, accountId, afterId, limit) {
    return openCards(ctx, accountId, await t3FieldCardRuleCodes(), afterId, limit);
  },

  async objectsForEvent(ctx, accountId, e) {
    const assetId = e.type === 'ASSET_UPDATED' ? e.entityId : e.assetId ?? null;
    if (assetId == null) return [];
    return idsOf(await rows(ctx.sql, `
      SELECT a.id FROM to_process_actions a
       WHERE a.account_id = $1 AND a.resolved_at IS NULL AND a.target_type = 'ASSET' AND a.target_id = $2 AND a.rule_code = ANY($3::text[])
       ORDER BY a.id`, [accountId, assetId, await t3FieldCardRuleCodes()]));
  },

  async inspect(ctx, accountId, ids) {
    const out = new Map<number, Inspection>();
    const cartes = await fieldCards(ctx, accountId, ids);
    const { suspectArbitration, reexamineCard } = await import('@/services/to-process/arbitration-equivalence-reprise');
    for (const id of ids) {
      const c = cartes.get(id);
      if (!c || !c.open || !c.fieldKey) { out.set(id, { verdict: 'GONE' }); continue; }
      const detail = { targetType: c.targetType, targetId: c.targetId, fieldKey: c.fieldKey, rule: c.ruleCode };
      // Faux arbitrage (valeurs équivalentes) : réexamen 81A en LECTURE SEULE (même code que le rattrapage BO).
      const suspect = c.actionKind === 'ARBITRATE' ? suspectArbitration(c.fieldKey, c.proposals as never) : null;
      if (suspect) {
        const it = await reexamineCard({ ...c, proposals: c.proposals as never }, suspect, { apply: false, campaign: ctx.correlationId, origin: 'SCHEDULED' });
        if (it.outcome === 'ERROR') throw new Error(`réexamen du faux arbitrage ${id} impossible : ${it.error ?? 'erreur'}`);
        if (it.outcome === 'TARGET_MISSING') { out.set(id, { verdict: 'CONSISTENT', detail: { ...detail, delegatedTo: 'COH-TODO-ORPHAN-CARDS' } }); continue; }
        if (it.outcome === 'CORRECTED' || it.outcome === 'OBSOLETE') {
          out.set(id, {
            verdict: 'REPAIRABLE', anomaly: 'FALSE_ARBITRATION', faultyLink: 'TO_PROCESS',
            expected: it.outcome === 'CORRECTED' ? { proposals: (it.after ?? []).map((p) => p.value) } : 'carte close (aucune contradiction réelle)',
            observed: { proposals: c.proposals.map((p) => p.value), suspect },
            detail: { ...detail, suspect, outcome: it.outcome, corrective: it.corrective ?? [] },
            inputHash: hashOf({ id, suspect, outcome: it.outcome, after: (it.after ?? []).map((p) => p.value), corrective: it.corrective ?? [] }),
          });
          continue;
        }
      }
      const ev = await evaluateFieldCard(c);
      if (ev.missing) { out.set(id, { verdict: 'CONSISTENT', detail: { ...detail, delegatedTo: 'COH-TODO-ORPHAN-CARDS' } }); continue; }
      if (c.targetType === 'ASSET') {
        const { isFieldApplicableToAsset } = await import('@/services/canonical/registry');
        const [b] = await rows(ctx.sql, `SELECT category, subtype FROM assets WHERE id = $1 AND account_id = $2`, [c.targetId, accountId]);
        if (b && !isFieldApplicableToAsset(c.fieldKey, { category: b.category as string, subtype: (b.subtype as string | null) ?? null } as never)) {
          out.set(id, { verdict: 'CONSISTENT', detail: { ...detail, delegatedTo: 'to-process-scan#closeInapplicableAssetFieldActions' } });
          continue;
        }
      }
      if (ev.verdict === 'JUSTIFIED' || ev.verdict === 'NO_DECISION') {
        out.set(id, { verdict: 'CONSISTENT', detail: { ...detail, producer: ev.verdict, decisions: resume(ev.decisions) } });
        continue;
      }
      out.set(id, {
        verdict: 'REPAIRABLE', anomaly: ev.verdict === 'STALE' ? 'FIELD_CARD_STALE' : 'FIELD_CARD_KIND_CHANGED', faultyLink: 'TO_PROCESS',
        expected: ev.verdict === 'STALE' ? 'carte close : donnée tranchée par la décision courante' : 'carte de l’autre nature (décision courante)',
        observed: { actionKind: c.actionKind, decisions: resume(ev.decisions) },
        detail: { ...detail, decisions: resume(ev.decisions) },
        inputHash: hashOf({ id, verdict: ev.verdict, decisions: resume(ev.decisions) }),
      });
    }
    return out;
  },

  async repair(ctx, accountId, items) {
    const out = new Map<number, RepairResult>();
    const cartes = await fieldCards(ctx, accountId, items.map((x) => x.id));
    for (const { id, inspection } of items) {
      const c = cartes.get(id);
      if (!c || !c.open) { out.set(id, { called: false, service: 'none', result: { gone: true } }); continue; }
      const rollbackRef = `to_process_action_events:action_id=${id}`;
      if (inspection.anomaly === 'FALSE_ARBITRATION') {
        const { suspectArbitration, reexamineCard } = await import('@/services/to-process/arbitration-equivalence-reprise');
        const suspect = suspectArbitration(c.fieldKey, c.proposals as never);
        if (!suspect) { out.set(id, { called: false, service: 'reexamineCard', result: { noLongerSuspect: true } }); continue; }
        const it = await reexamineCard({ ...c, proposals: c.proposals as never }, suspect, { apply: true, campaign: ctx.correlationId, origin: 'SCHEDULED' });
        if (it.outcome === 'ERROR') throw new Error(`réexamen du faux arbitrage ${id} en erreur : ${it.error ?? 'erreur'}`);
        out.set(id, { called: true, service: 'reexamineCard', aiCalls: 0, result: { outcome: it.outcome, suspect }, rollbackRef });
        continue;
      }
      // Décisions COURANTES (réévaluées au moment de réparer), transmises au producteur de la famille.
      const ev = await evaluateFieldCard(c);
      if (ev.missing) { out.set(id, { called: false, service: 'none', result: { targetMissing: true } }); continue; }
      if (c.targetType === 'ASSET') {
        const { syncReconciliationToProcess } = await import('@/services/to-process/reconciliation-bridge');
        const r = await syncReconciliationToProcess({ accountId, assetId: c.targetId, decisions: ev.decisions });
        out.set(id, { called: true, service: 'syncReconciliationToProcess', aiCalls: 0, result: { ...r, verdict: ev.verdict }, rollbackRef });
      } else {
        const { syncEntityFieldCards } = await import('@/services/to-process/entity-field-cards');
        const r = await syncEntityFieldCards({ accountId, target: { type: c.targetType as 'EQUIPMENT' | 'ROOM', id: c.targetId }, entityName: null, decisions: ev.decisions });
        out.set(id, { called: true, service: 'syncEntityFieldCards', aiCalls: 0, result: { ...r, verdict: ev.verdict }, rollbackRef });
      }
    }
    return out;
  },
};

// ══ COH-TODO-OPERATION-CARDS ════════════════════════════════════════════════

/** Marge d'horloge (application ↔ base) avant de conclure qu'un recalcul de l'Opération n'a pas reconduit la carte. */
export const OPERATION_CARD_CLOCK_MARGIN_MS = 60_000;

interface OperationCardState {
  rule: string;
  documentAlive: boolean;
  lastSeenAt: Date | null;
  /** OPERATION-MATCH : candidat du document (le plus récent) et réalités proposées vivantes / disparues. */
  candidate?: { status: string; pending: boolean; outcome: string | null } | null;
  offeredGone?: number[];
  /** Autres règles : Opération citée par la carte. */
  operation?: { exists: boolean; merged: boolean; invalidated: boolean; lastReconciledAt: Date | null; documentIsSource: boolean } | null;
}

/**
 * Lot 85B — verdict d'une carte de consolidation des Opérations (pure).
 * `null` : carte justifiée (ou constat sans réparation : OPERATION_MISSING).
 */
export function operationCardAnomaly(s: OperationCardState): { anomaly: string; verdict: 'REPAIRABLE' | 'FINDING' } | 'DELEGATED' | null {
  if (!s.documentAlive) return 'DELEGATED';
  if (s.rule === 'OPERATION-MATCH') {
    const c = s.candidate;
    if (!c || c.status !== 'ACTIVE') return { anomaly: 'MATCH_CANDIDATE_GONE', verdict: 'REPAIRABLE' };
    if (c.pending) return null;
    if (c.outcome !== 'ARBITRATION_REQUIRED') return { anomaly: 'CARD_NOT_RECONDUCTED', verdict: 'REPAIRABLE' };
    if ((s.offeredGone ?? []).length) return { anomaly: 'OFFERED_OPERATION_GONE', verdict: 'REPAIRABLE' };
    return null;
  }
  const o = s.operation;
  if (!o || !o.exists) return { anomaly: 'OPERATION_MISSING', verdict: 'FINDING' };
  if (o.merged) return { anomaly: 'OPERATION_MERGED', verdict: 'REPAIRABLE' };
  if (o.invalidated) return { anomaly: 'OPERATION_INVALIDATED', verdict: 'REPAIRABLE' };
  if ((s.rule === 'OPERATION-AMOUNT' || s.rule === 'OPERATION-CURRENCY') && !o.documentIsSource) return { anomaly: 'DOCUMENT_NOT_IN_OPERATION', verdict: 'REPAIRABLE' };
  if (o.lastReconciledAt && s.lastSeenAt && o.lastReconciledAt.getTime() > s.lastSeenAt.getTime() + OPERATION_CARD_CLOCK_MARGIN_MS) {
    return { anomaly: 'CARD_NOT_RECONDUCTED', verdict: 'REPAIRABLE' };
  }
  return null;
}

async function operationCardRules(): Promise<string[]> {
  const { OPERATION_CARD_RULES } = await import('@/services/to-process/operation-cards');
  return [...OPERATION_CARD_RULES];
}

async function operationCardStates(ctx: CheckContext, accountId: number, ids: readonly number[]): Promise<Map<number, { row: Row; state: OperationCardState }>> {
  const r = await rows(ctx.sql, `
    SELECT a.id, a.rule_code, a.target_id, a.resolved_at IS NULL AS open, a.last_seen_at, a.trigger_context,
           EXISTS (SELECT 1 FROM asset_files f WHERE f.id = a.target_id AND f.account_id = a.account_id AND f.deleted_at IS NULL
                     AND f.grouped_into_file_id IS NULL) AS doc_alive,
           (SELECT json_build_object('status', c.status, 'pending', c.t3_pending, 'outcome', c.t3_outcome)
              FROM document_operation_candidates c
             WHERE c.account_id = a.account_id AND c.file_id = a.target_id AND c.candidate_key = a.trigger_context->>'candidateKey'
             ORDER BY (c.status = 'ACTIVE') DESC, c.id DESC LIMIT 1) AS cand,
           (SELECT array_agg(x::bigint) FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(a.trigger_context->'operationIds') = 'array'
                                                                          THEN a.trigger_context->'operationIds' ELSE '[]'::jsonb END) x
             WHERE NOT EXISTS (SELECT 1 FROM business_operations o WHERE o.id = x::bigint AND o.account_id = a.account_id
                                 AND o.merged_into_operation_id IS NULL AND o.invalidated_at IS NULL)) AS offered_gone,
           o.id AS op_id, o.merged_into_operation_id AS op_merged, o.invalidated_at AS op_invalidated, o.last_reconciled_at AS op_reconciled,
           EXISTS (SELECT 1 FROM business_operation_sources s WHERE s.operation_id = o.id AND s.account_id = a.account_id AND s.active
                     AND s.source_kind = 'DOCUMENT' AND s.source_entity_key = a.target_id::text) AS doc_source
      FROM to_process_actions a
      LEFT JOIN business_operations o ON o.account_id = a.account_id
            AND o.id = CASE WHEN (a.trigger_context->>'operationId') ~ '^[0-9]{1,18}$' THEN (a.trigger_context->>'operationId')::bigint END
     WHERE a.account_id = $1 AND a.id = ANY($2::int[])`, [accountId, intArray(ids)]);
  const out = new Map<number, { row: Row; state: OperationCardState }>();
  for (const x of r) {
    const cand = asJson<{ status: string; pending: boolean; outcome: string | null } | null>(x.cand, null);
    out.set(Number(x.id), {
      row: x,
      state: {
        rule: String(x.rule_code), documentAlive: x.doc_alive === true, lastSeenAt: x.last_seen_at ? new Date(x.last_seen_at as string) : null,
        candidate: cand ? { status: String(cand.status), pending: cand.pending === true, outcome: cand.outcome ?? null } : null,
        offeredGone: ((x.offered_gone as Array<number | string> | null) ?? []).map(Number),
        operation: x.op_id == null ? { exists: false, merged: false, invalidated: false, lastReconciledAt: null, documentIsSource: false } : {
          exists: true, merged: x.op_merged != null, invalidated: x.op_invalidated != null,
          lastReconciledAt: x.op_reconciled ? new Date(x.op_reconciled as string) : null, documentIsSource: x.doc_source === true,
        },
      },
    });
  }
  return out;
}

const toProcessOperationCardsCheck: CoherenceCheck = {
  id: 'COH-TODO-OPERATION-CARDS',
  version: 1,
  status: 'ACTIVE',
  title: '« À traiter » : questions de consolidation (même réalité, montant, devise, bien d’un sinistre) devenues sans objet',
  domain: 'a-traiter',
  level: 'N2',
  objectType: 'to_process_action',
  scope: 'cartes ouvertes OPERATION-MATCH, OPERATION-AMOUNT, OPERATION-CURRENCY, OPERATION-CLAIM-ASSET',
  sources: ['to_process_actions', 'document_operation_candidates', 'business_operations', 'business_operation_sources'],
  applicability: 'compte éligible ; document vivant (sinon : COH-TODO-ORPHAN-CARDS)',
  invariant: 'une question de consolidation ouverte est reconduite par la DERNIÈRE décision de la consolidation T3 de son document ou de son Opération',
  anomalies: ['MATCH_CANDIDATE_GONE', 'CARD_NOT_RECONDUCTED', 'OFFERED_OPERATION_GONE', 'OPERATION_MERGED', 'OPERATION_INVALIDATED', 'DOCUMENT_NOT_IN_OPERATION', 'OPERATION_MISSING'],
  autoRepairWhen: 'carte que la consolidation ne reconduirait pas : consolidation du document ou reconsolidation de l’Opération (déterministes, sans M3) ; Opération introuvable : constat',
  forbiddenRepairs: ['fermer une carte directement', 'écrire une décision de rapprochement à la place de l’utilisateur', 'appeler l’IA (M3)', 'relancer T1'],
  services: ['business-operations/consolidation/consolidator#consolidateDocument', 'business-operations/consolidation/consolidator#reconsolidateOperations', 'to-process/operation-cards#syncOperationCards'],
  chain: ['T3', 'TO_PROCESS'],
  triggers: ['BUSINESS_OPERATION_CHANGED', 'DOCUMENT_UPDATED'],
  frequency: 'campagne exhaustive quotidienne + contrôle ciblé à chaque écriture d’Opération',
  criticality: 'MEDIUM',
  tests: ['L85B-E2E-02', 'L85B-U-FAMILIES'],

  async listObjects(ctx, accountId, afterId, limit) {
    return openCards(ctx, accountId, await operationCardRules(), afterId, limit);
  },

  async objectsForEvent(ctx, accountId, e) {
    if (e.entityId == null) return [];
    const regles = await operationCardRules();
    if (e.type === 'DOCUMENT_UPDATED') {
      return idsOf(await rows(ctx.sql, `
        SELECT a.id FROM to_process_actions a WHERE a.account_id = $1 AND a.resolved_at IS NULL AND a.target_type = 'DOCUMENT'
           AND a.target_id = $2 AND a.rule_code = ANY($3::text[]) ORDER BY a.id`, [accountId, e.entityId, regles]));
    }
    return idsOf(await rows(ctx.sql, `
      SELECT a.id FROM to_process_actions a WHERE a.account_id = $1 AND a.resolved_at IS NULL AND a.rule_code = ANY($3::text[])
         AND (a.trigger_context->>'operationId' = $2::text
              OR (jsonb_typeof(a.trigger_context->'operationIds') = 'array' AND a.trigger_context->'operationIds' @> to_jsonb($2::bigint)))
       ORDER BY a.id`, [accountId, e.entityId, regles]));
  },

  async inspect(ctx, accountId, ids) {
    const out = new Map<number, Inspection>();
    const etats = await operationCardStates(ctx, accountId, ids);
    for (const id of ids) {
      const e = etats.get(id);
      if (!e || e.row.open !== true) { out.set(id, { verdict: 'GONE' }); continue; }
      const tc = asJson<Record<string, unknown>>(e.row.trigger_context, {});
      const detail = { rule: e.state.rule, fileId: Number(e.row.target_id), operationId: tc.operationId ?? null, candidateKey: tc.candidateKey ?? null };
      const a = operationCardAnomaly(e.state);
      if (a === 'DELEGATED') { out.set(id, { verdict: 'CONSISTENT', detail: { ...detail, delegatedTo: 'COH-TODO-ORPHAN-CARDS' } }); continue; }
      if (a === null) { out.set(id, { verdict: 'CONSISTENT', detail: { ...detail, awaitingT3: e.state.candidate?.pending === true || undefined } }); continue; }
      out.set(id, {
        verdict: a.verdict, anomaly: a.anomaly, faultyLink: 'T3',
        expected: 'question reconduite par la dernière consolidation, ou close par elle',
        observed: { candidate: e.state.candidate ?? null, offeredGone: e.state.offeredGone ?? [], operation: e.state.operation ?? null },
        detail: { ...detail, repairWith: e.state.rule === 'OPERATION-MATCH' ? 'consolidateDocument' : 'reconsolidateOperations' },
        inputHash: hashOf({ id, a: a.anomaly, c: e.state.candidate ?? null, g: e.state.offeredGone ?? [], o: e.state.operation
          ? { ...e.state.operation, lastReconciledAt: e.state.operation.lastReconciledAt?.toISOString() ?? null } : null }),
      });
    }
    return out;
  },

  async repair(ctx, accountId, items) {
    const out = new Map<number, RepairResult>();
    const consolidator = await import('@/services/business-operations/consolidation/consolidator');
    for (const { id, inspection } of items) {
      const d = inspection.detail as { rule: string; fileId: number; operationId: unknown };
      const rollbackRef = `to_process_action_events:action_id=${id};business_operation_history:correlation=${ctx.correlationId}`;
      if (d.rule === 'OPERATION-MATCH') {
        const r = await consolidator.consolidateDocument(accountId, d.fileId, { today: ctx.today, correlationId: ctx.correlationId });
        if (r.error) throw new Error(`consolidation du document ${d.fileId} en erreur : ${r.error}`);
        out.set(id, { called: true, service: 'consolidateDocument', aiCalls: 0, result: { outcomes: r.outcomes, changes: r.changes, operations: r.operations.slice(0, 20) }, rollbackRef });
        continue;
      }
      const opId = Number(d.operationId);
      if (!Number.isSafeInteger(opId) || opId <= 0) throw new Error(`carte ${id} : Opération illisible`);
      const n = await consolidator.reconsolidateOperations(accountId, [opId], { today: ctx.today, correlationId: ctx.correlationId });
      out.set(id, { called: true, service: 'reconsolidateOperations', aiCalls: 0, result: { operationId: opId, changes: n }, rollbackRef });
    }
    return out;
  },
};

// ══ COH-TODO-MIGRATION-REVIEW-CARDS ═════════════════════════════════════════

/** Égalité métier d'une valeur scalaire de fiche (pure) : vide ≡ vide, nombres comparés en nombre, dates au jour. */
export function sameFieldValue(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): string | number | null => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    const s = String(v).trim();
    if (s === '') return null;
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    if (/^\d{4}-\d{2}-\d{2}(T|$)/.test(s)) return s.slice(0, 10);
    return s;
  };
  return norm(a) === norm(b);
}

const toProcessMigrationReviewCardsCheck: CoherenceCheck = {
  id: 'COH-TODO-MIGRATION-REVIEW-CARDS',
  version: 1,
  status: 'ACTIVE',
  title: '« À traiter » : revues de migration dont la valeur en place a changé depuis l’ouverture',
  domain: 'a-traiter',
  level: 'N2',
  objectType: 'to_process_action',
  scope: 'cartes ouvertes MIG-REVIEW (rattrapages CDC 15)',
  sources: ['to_process_actions', 'assets'],
  applicability: 'compte éligible ; bien vivant (sinon : COH-TODO-ORPHAN-CARDS)',
  invariant: 'une revue de migration ouverte porte sur la valeur toujours en place à son ouverture (contrôle optimiste de la famille)',
  anomalies: ['MIGRATION_REVIEW_STALE'],
  autoRepairWhen: 'valeur en place différente de celle de l’ouverture : carte PÉRIMÉE par le service de la famille (même effet que sa résolution)',
  forbiddenRepairs: ['écrire une valeur de fiche', 'choisir une proposition à la place de l’utilisateur', 'supprimer une carte'],
  services: ['to-process/migration-review-cards#perimer'],
  chain: ['PERSISTENCE', 'TO_PROCESS'],
  triggers: ['ASSET_UPDATED'],
  frequency: 'campagne exhaustive quotidienne + contrôle ciblé au changement du bien',
  criticality: 'LOW',
  tests: ['L85B-E2E-01', 'L85B-U-FAMILIES'],

  async listObjects(ctx, accountId, afterId, limit) {
    const { MIG_REVIEW_RULE } = await import('@/services/to-process/migration-review-cards');
    return openCards(ctx, accountId, [MIG_REVIEW_RULE], afterId, limit);
  },

  async objectsForEvent(ctx, accountId, e) {
    if (e.entityId == null) return [];
    const { MIG_REVIEW_RULE } = await import('@/services/to-process/migration-review-cards');
    return idsOf(await rows(ctx.sql, `
      SELECT a.id FROM to_process_actions a WHERE a.account_id = $1 AND a.resolved_at IS NULL AND a.rule_code = $2
         AND a.target_type = 'ASSET' AND a.target_id = $3 ORDER BY a.id`, [accountId, MIG_REVIEW_RULE, e.entityId]));
  },

  async inspect(ctx, accountId, ids) {
    const out = new Map<number, Inspection>();
    const [{ loadAssetRow, readCanonicalValue }, { migrationRelationKey }] = await Promise.all([
      import('@/services/canonical/asset-state'), import('@/services/to-process/migration-review-cards'),
    ]);
    const r = await rows(ctx.sql, `
      SELECT id, target_id, relation_key, trigger_context, resolved_at IS NULL AS open FROM to_process_actions
       WHERE account_id = $1 AND id = ANY($2::int[])`, [accountId, intArray(ids)]);
    const parId = new Map(r.map((x) => [Number(x.id), x]));
    const biens = new Map<number, Awaited<ReturnType<typeof loadAssetRow>>>();
    for (const id of ids) {
      const x = parId.get(id);
      if (!x || x.open !== true) { out.set(id, { verdict: 'GONE' }); continue; }
      const tc = asJson<{ key?: string; current?: unknown; step?: string }>(x.trigger_context, {});
      const assetId = Number(x.target_id);
      if (!biens.has(assetId)) biens.set(assetId, await loadAssetRow(ctx.sql as never, assetId, accountId));
      const row = biens.get(assetId);
      const detail = { assetId, key: tc.key ?? migrationRelationKey(x.relation_key as string | null), step: tc.step ?? null };
      if (!row) { out.set(id, { verdict: 'CONSISTENT', detail: { ...detail, delegatedTo: 'COH-TODO-ORPHAN-CARDS' } }); continue; }
      if (!detail.key) { out.set(id, { verdict: 'CONSISTENT', detail: { ...detail, unreadableKey: true } }); continue; }
      const courante = readCanonicalValue(row, detail.key)?.value ?? null;
      if (sameFieldValue(courante, tc.current ?? null)) { out.set(id, { verdict: 'CONSISTENT', detail }); continue; }
      out.set(id, {
        verdict: 'REPAIRABLE', anomaly: 'MIGRATION_REVIEW_STALE', faultyLink: 'TO_PROCESS',
        expected: { current: tc.current ?? null }, observed: { current: courante }, detail,
        inputHash: hashOf({ id, opened: tc.current ?? null, now: courante }),
      });
    }
    return out;
  },

  async repair(_ctx, accountId, items) {
    const out = new Map<number, RepairResult>();
    const [{ db }, { toProcessActions }, { and, eq, isNull }, { perimer }] = await Promise.all([
      import('@/db'), import('@/db/schema'), import('drizzle-orm'), import('@/services/to-process/migration-review-cards'),
    ]);
    for (const { id } of items) {
      const [action] = await db.select().from(toProcessActions)
        .where(and(eq(toProcessActions.id, id), eq(toProcessActions.accountId, accountId), isNull(toProcessActions.resolvedAt))).limit(1);
      if (!action) { out.set(id, { called: false, service: 'perimer', result: { gone: true } }); continue; }
      const r = await perimer(db as never, action, accountId, null);
      out.set(id, { called: true, service: 'perimer', aiCalls: 0, result: { error: r.error ?? null }, rollbackRef: `to_process_action_events:action_id=${id}` });
    }
    return out;
  },
};

// ══ COH-TODO-AGENDA-PROPOSAL-CARDS ══════════════════════════════════════════

const toProcessAgendaProposalCardsCheck: CoherenceCheck = {
  id: 'COH-TODO-AGENDA-PROPOSAL-CARDS',
  version: 1,
  status: 'ACTIVE',
  title: '« À traiter » : propositions d’échéance déjà présentes à l’agenda',
  domain: 'a-traiter',
  level: 'N2',
  objectType: 'to_process_action',
  scope: 'cartes ouvertes AGENDA-PROPOSAL portant une clé fonctionnelle',
  sources: ['to_process_actions', 'agenda_items'],
  applicability: 'compte éligible ; document source vivant (sinon : COH-TODO-ORPHAN-CARDS)',
  invariant: 'une proposition d’échéance ouverte ne double pas un événement d’agenda de même clé fonctionnelle (règle R5 de la famille)',
  anomalies: ['AGENDA_PROPOSAL_ALREADY_SCHEDULED'],
  autoRepairWhen: 'un événement de même clé fonctionnelle existe : fermeture par le service de la famille (tracée)',
  forbiddenRepairs: ['créer ou modifier un événement d’agenda', 'fermer une proposition sans événement de même clé', 'supprimer une carte'],
  services: ['to-process/agenda-proposal-cards#closeObsoleteAgendaProposals'],
  chain: ['T4', 'PROJECTION', 'TO_PROCESS'],
  triggers: ['AGENDA_ITEM_CREATED', 'AGENDA_ITEM_UPDATED'],
  frequency: 'campagne exhaustive quotidienne + contrôle ciblé à l’écriture d’un événement',
  criticality: 'LOW',
  tests: ['L85B-E2E-01', 'L85B-U-FAMILIES'],

  async listObjects(ctx, accountId, afterId, limit) {
    const { AGENDA_PROPOSAL_RULE } = await import('@/services/to-process/agenda-proposal-cards');
    return openCards(ctx, accountId, [AGENDA_PROPOSAL_RULE], afterId, limit);
  },

  async objectsForEvent(ctx, accountId, e) {
    if (e.entityId == null) return [];
    const { AGENDA_PROPOSAL_RULE } = await import('@/services/to-process/agenda-proposal-cards');
    return idsOf(await rows(ctx.sql, `
      SELECT a.id FROM to_process_actions a JOIN agenda_items i ON i.id = $3 AND i.account_id = a.account_id AND i.functional_key IS NOT NULL
       WHERE a.account_id = $1 AND a.resolved_at IS NULL AND a.rule_code = $2 AND a.relation_key = 'agenda:' || i.functional_key
       ORDER BY a.id`, [accountId, AGENDA_PROPOSAL_RULE, e.entityId]));
  },

  async inspect(ctx, accountId, ids) {
    const out = new Map<number, Inspection>();
    const r = await rows(ctx.sql, `
      SELECT a.id, a.resolved_at IS NULL AS open, a.target_id, a.trigger_context->>'functionalKey' AS fk,
             (SELECT min(i.id) FROM agenda_items i WHERE i.account_id = a.account_id AND i.functional_key = a.trigger_context->>'functionalKey') AS item_id
        FROM to_process_actions a WHERE a.account_id = $1 AND a.id = ANY($2::int[])`, [accountId, intArray(ids)]);
    const parId = new Map(r.map((x) => [Number(x.id), x]));
    for (const id of ids) {
      const x = parId.get(id);
      if (!x || x.open !== true) { out.set(id, { verdict: 'GONE' }); continue; }
      const detail = { fileId: Number(x.target_id), functionalKey: (x.fk as string | null) ?? null };
      if (!x.fk || x.item_id == null) { out.set(id, { verdict: 'CONSISTENT', detail }); continue; }
      out.set(id, {
        verdict: 'REPAIRABLE', anomaly: 'AGENDA_PROPOSAL_ALREADY_SCHEDULED', faultyLink: 'TO_PROCESS',
        expected: 'proposition close (échéance déjà à l’agenda)', observed: { agendaItemId: Number(x.item_id) },
        detail: { ...detail, agendaItemId: Number(x.item_id) }, inputHash: hashOf({ id, fk: x.fk, item: Number(x.item_id) }),
      });
    }
    return out;
  },

  async repair(_ctx, accountId, items) {
    const out = new Map<number, RepairResult>();
    const [{ db }, { closeObsoleteAgendaProposals }] = await Promise.all([import('@/db'), import('@/services/to-process/agenda-proposal-cards')]);
    for (const { id, inspection } of items) {
      const fk = (inspection.detail as { functionalKey: string }).functionalKey;
      const n = await closeObsoleteAgendaProposals(db, accountId, fk);
      out.set(id, { called: true, service: 'closeObsoleteAgendaProposals', aiCalls: 0, result: { closed: n, functionalKey: fk }, rollbackRef: `to_process_action_events:action_id=${id}` });
    }
    return out;
  },
};

export const toProcessFamilyChecks: readonly CoherenceCheck[] = [
  toProcessT3FieldCardsCheck, toProcessOperationCardsCheck, toProcessMigrationReviewCardsCheck, toProcessAgendaProposalCardsCheck,
];
