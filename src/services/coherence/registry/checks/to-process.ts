/**
 * COH-TODO-DOCUMENT-FIELDS — cartes « À traiter » documentaires (lot 82B ;
 * complément PO du 23/10 : « carte alors que la réponse est déjà dans les
 * données du document ou que l'information n'est plus nécessaire → détecter,
 * réévaluer la règle, fermer la carte, sans relancer T1 » ; C-Q1, C-Q2).
 *
 * Objets : cartes OUVERTES sur un document, des règles du pont documentaire
 * portant sur une donnée (fin de contrat, fin de garantie, fournisseur…).
 *
 * Diagnostic : `diagnoseDocumentRuleCard` (lecture seule — mêmes lectures
 * que la production, ni écriture ni appel IA, mode à blanc compris).
 *
 * Réparation : la DÉCISION CENTRALE existante, jamais une fermeture directe :
 *   · état (donnée présente, règle plus pertinente, document supprimé) :
 *     `syncDocumentRulesFromState` (réévaluation d'état, sans création) ;
 *   · connaissance T1 persistée (réponse disponible, décision périmée ou
 *     absente — « information non nécessaire » comprise) :
 *     `resolveDocumentRuleFromKnowledge` — même décision que l'analyse et le
 *     balayage, valeur fiable écrite et RELUE, carte fermée ; incertitude →
 *     carte maintenue ; valeur de l'utilisateur jamais écrasée ; T1 jamais
 *     relancé.
 * Valeurs contradictoires : AMBIGUOUS, aucune écriture (l'arbitrage existant
 * reste seul juge). Les autres familles de cartes (agenda, équipements,
 * fournisseurs, Opérations) sont réévaluées par leurs producteurs horaires :
 * lacune DÉCLARÉE dans l'inventaire de couverture, jamais réputée couverte.
 */
import type { CoherenceCheck, Inspection, RepairResult } from '../types';
import { hashOf, idsOf, intArray, rows, type Row } from '../util';

/** Règles « donnée documentaire » du pont (même source que la production). */
async function fieldRuleCodes(): Promise<string[]> {
  const { documentBridgeRules } = await import('@/services/to-process/rules-catalog');
  return documentBridgeRules().filter((r) => !!r.fieldKey).map((r) => r.code);
}

const REPAIR_BY_STATE = new Set(['TARGET_GONE', 'RESOLVABLE_FROM_STATE', 'ALREADY_SATISFIED']);

async function cartes(sql: Parameters<typeof rows>[0], accountId: number, ids: readonly number[]): Promise<Map<number, Row>> {
  const r = await rows(sql, `
    SELECT id, target_id, rule_code, resolved_at IS NULL AS open FROM to_process_actions
     WHERE account_id = $1 AND target_type = 'DOCUMENT' AND id = ANY($2::int[])`, [accountId, intArray(ids)]);
  return new Map(r.map((x) => [Number(x.id), x]));
}

export const toProcessDocumentFieldsCheck: CoherenceCheck = {
  id: 'COH-TODO-DOCUMENT-FIELDS',
  version: 1,
  status: 'ACTIVE',
  title: '« À traiter » : cartes documentaires dont la réponse est disponible ou la question sans objet',
  domain: 'a-traiter',
  level: 'N2',
  objectType: 'to_process_action',
  scope: 'cartes ouvertes sur un document, règles du pont documentaire portant sur une donnée',
  sources: ['to_process_actions', 'document_field_values', 'document_facts', 'document_unresolved_facts', 'document_source_units', 'document_rule_evaluations'],
  applicability: 'compte éligible',
  invariant: 'une carte ouverte correspond à une information réellement manquante, nécessaire et non déjà disponible ou calculable',
  anomalies: ['CARD_TARGET_DELETED', 'CARD_RESOLVABLE_FROM_STATE', 'ANSWER_ALREADY_PRESENT', 'ANSWER_AVAILABLE', 'DECISION_STALE', 'CONFLICTING_VALUES'],
  autoRepairWhen: 'réévaluation par la décision centrale existante (état, ou connaissance T1 persistée), écriture relue avant fermeture',
  forbiddenRepairs: ['fermer une carte sans décision du moteur', 'relancer T1', 'écraser une valeur de l’utilisateur', 'choisir entre valeurs contradictoires'],
  services: ['to-process/document-rule-bridge#syncDocumentRulesFromState', 'to-process/document-rule-bridge#resolveDocumentRuleFromKnowledge'],
  chain: ['T1', 'PERSISTENCE', 'TO_PROCESS'],
  triggers: ['SOURCE_ANALYZED', 'DOCUMENT_UPDATED', 'DOCUMENT_DELETED'],
  frequency: 'campagne exhaustive quotidienne + contrôle ciblé à chaque changement',
  criticality: 'MEDIUM',
  tests: ['L82B-E2E-03', 'L82B-E2E-04'],

  async listObjects(ctx, accountId, afterId, limit) {
    return idsOf(await rows(ctx.sql, `
      SELECT a.id FROM to_process_actions a
       WHERE a.account_id = $1 AND a.target_type = 'DOCUMENT' AND a.resolved_at IS NULL AND a.rule_code = ANY($2::text[]) AND a.id > $3
       ORDER BY a.id LIMIT $4`, [accountId, await fieldRuleCodes(), afterId, limit]));
  },

  async objectsForEvent(ctx, accountId, e) {
    if (e.entityId == null) return [];
    return idsOf(await rows(ctx.sql, `
      SELECT a.id FROM to_process_actions a
       WHERE a.account_id = $1 AND a.target_type = 'DOCUMENT' AND a.target_id = $2 AND a.resolved_at IS NULL AND a.rule_code = ANY($3::text[])
       ORDER BY a.id`, [accountId, e.entityId, await fieldRuleCodes()]));
  },

  async inspect(ctx, accountId, ids) {
    const out = new Map<number, Inspection>();
    const { diagnoseDocumentRuleCard } = await import('@/services/to-process/document-rule-bridge');
    const parId = await cartes(ctx.sql, accountId, ids);
    for (const id of ids) {
      const c = parId.get(id);
      if (!c || c.open !== true) { out.set(id, { verdict: 'GONE' }); continue; }
      const fileId = Number(c.target_id);
      const rule = String(c.rule_code);
      const d = await diagnoseDocumentRuleCard(accountId, fileId, rule, ctx.now);
      const detail = { fileId, rule, diagnosis: d.kind, reason: d.reason, lastDecision: d.lastDecision ?? null };
      const inputHash = hashOf({ id, kind: d.kind, values: d.values ?? [], rev: d.knowledgeRev ?? null });
      switch (d.kind) {
        case 'KNOWLEDGE_UNREADABLE':
          // Une lecture impossible n'est jamais une donnée absente : le contrôle a échoué.
          throw new Error(`carte ${id} : connaissance illisible (${d.reason})`);
        case 'TARGET_GONE':
          out.set(id, { verdict: 'REPAIRABLE', anomaly: 'CARD_TARGET_DELETED', faultyLink: 'TO_PROCESS', detail, inputHash });
          break;
        case 'RESOLVABLE_FROM_STATE':
          out.set(id, { verdict: 'REPAIRABLE', anomaly: 'CARD_RESOLVABLE_FROM_STATE', faultyLink: 'TO_PROCESS', detail, inputHash });
          break;
        case 'ALREADY_SATISFIED':
          out.set(id, { verdict: 'REPAIRABLE', anomaly: 'ANSWER_ALREADY_PRESENT', faultyLink: 'TO_PROCESS', detail, inputHash });
          break;
        case 'ANSWER_AVAILABLE':
          out.set(id, { verdict: 'REPAIRABLE', anomaly: 'ANSWER_AVAILABLE', faultyLink: 'PERSISTENCE', expected: d.values, observed: 'carte ouverte', detail, inputHash });
          break;
        case 'DECISION_STALE':
          out.set(id, { verdict: 'REPAIRABLE', anomaly: 'DECISION_STALE', faultyLink: 'TO_PROCESS', detail, inputHash });
          break;
        case 'CONFLICTING_VALUES':
          out.set(id, { verdict: 'AMBIGUOUS', anomaly: 'CONFLICTING_VALUES', faultyLink: 'T1', observed: d.values, detail, inputHash });
          break;
        default:
          // DECISION_CURRENT, USER_PROTECTED, NO_ACTIVE_CARD, NOT_A_FIELD : carte justifiée ou hors objet.
          out.set(id, { verdict: 'CONSISTENT', detail });
      }
    }
    return out;
  },

  async repair(ctx, accountId, items) {
    const out = new Map<number, RepairResult>();
    const bridge = await import('@/services/to-process/document-rule-bridge');
    const parId = await cartes(ctx.sql, accountId, items.map((x) => x.id));
    for (const { id, inspection } of items) {
      const c = parId.get(id);
      if (!c) continue;
      const fileId = Number(c.target_id);
      const rule = String(c.rule_code);
      const diag = String((inspection.detail as { diagnosis?: string } | undefined)?.diagnosis ?? '');
      if (REPAIR_BY_STATE.has(diag)) {
        const r = await bridge.syncDocumentRulesFromState(accountId, fileId, { reason: 'OBSOLETE', create: false, trigger: 'BACKFILL', runRef: ctx.correlationId });
        out.set(id, {
          called: true, service: 'syncDocumentRulesFromState', aiCalls: 0,
          result: { closed: r.closed, written: r.written, outcome: r.outcomes[rule] ?? null, reason: r.reasons[rule] ?? null, errors: r.errorDetails.length },
          rollbackRef: `to_process_action_events:action_id=${id}`,
        });
        if (r.errorDetails.some((e) => e.ruleCode === rule || e.ruleCode === '*')) {
          throw new Error(`réévaluation de la carte ${id} en erreur : ${r.errorDetails.map((e) => `${e.step} — ${e.cause}`).join(' ; ').slice(0, 300)}`);
        }
        continue;
      }
      const r = await bridge.resolveDocumentRuleFromKnowledge(accountId, fileId, rule, { runRef: ctx.correlationId, today: ctx.today });
      out.set(id, {
        called: true, service: 'resolveDocumentRuleFromKnowledge', aiCalls: r.aiCalled ? 1 : 0,
        result: { status: r.status, reasonCode: r.reasonCode, outcome: r.outcome ?? null, verified: r.verified, writeAttempted: r.writeAttempted },
        rollbackRef: `to_process_action_events:action_id=${id};document_field_values:file=${fileId}`,
      });
    }
    return out;
  },
};
