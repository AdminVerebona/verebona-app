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
 * reste seul juge).
 *
 * Lot 98B (P0-C, version 2) : une décision ACTUELLE (même moteur, même
 * connaissance) n'est plus assimilée à une carte justifiée. D'après son motif
 * (`to-process/publishability#cardStanding`, même règle que la publication) :
 *   · carte JUSTIFIÉE (donnée utile, intervention, arbitrage d'une réelle
 *     ambiguïté) → CONSISTENT ;
 *   · maintien TECHNIQUE (T4 incompatible, interprétation T3 en attente ou
 *     incomplète, panne IA / configuration) → DECISION_NOT_DEMONSTRATED :
 *     RÉPARABLE dès que la cause est levée (contrat T4 compatible actif,
 *     capacité T3 livrée, panne : nouvelle tentative au plus une fois par
 *     jour) — réévaluation par la décision centrale ; sinon CONSTAT
 *     (« décision non démontrée », cause et demande IA) : jamais CONSISTENT.
 * La carte retenue n'est pas publiée (« À traiter », compteur, mascotte) :
 * elle relève de la Supervision. Lot 100E (A7) : la même règle vaut pour les
 * autres familles (agenda, équipements, fournisseurs, biens, événements de
 * référence) — contrat commun `publishability.ts`, nettoyage rétroactif des
 * cartes devenues inutiles par COH-TODO-PUBLISHABILITY.
 */
import type { CoherenceCheck, Inspection, RepairResult } from '../types';
import { hashOf, idsOf, intArray, rows, type Row } from '../util';
import { cardStanding, HOLD_CAUSE_LABELS, type TechnicalHoldCause } from '@/services/to-process/publishability';

/** Règles « donnée documentaire » du pont (même source que la production). */
async function fieldRuleCodes(): Promise<string[]> {
  const { documentBridgeRules } = await import('@/services/to-process/rules-catalog');
  return documentBridgeRules().filter((r) => !!r.fieldKey).map((r) => r.code);
}

const REPAIR_BY_STATE = new Set(['TARGET_GONE', 'RESOLVABLE_FROM_STATE', 'ALREADY_SATISFIED']);

/**
 * Lot 98B (P0-C) — la cause d'un maintien TECHNIQUE est-elle levée ? (lecture
 * seule, sans appel IA) : contrat T4 compatible désormais actif, capacité T3
 * KNOWLEDGE_QUERY désormais disponible, panne (toujours retentée, une fois par
 * jour). Une interprétation incomplète (connaissance au-delà des bornes)
 * n'est pas levée par une simple nouvelle tentative.
 */
async function causeLevee(cause: TechnicalHoldCause, configRef: string | null): Promise<{ lifted: boolean; why: string; pendingContract?: string }> {
  if (cause === 'T4_INCOMPATIBLE') {
    const { t4AssessmentConfig } = await import('@/services/to-process/document-field-evidence');
    const cfg = await t4AssessmentConfig();
    return cfg.interventionCapable
      ? { lifted: true, why: `t4_compatible:${cfg.ref}` }
      : { lifted: false, why: `t4_incompatible:${cfg.ref}`, pendingContract: 't4_output_v3' };
  }
  if (cause === 'INTERPRETATION_PENDING') {
    const { knowledgeQueryCapability } = await import('@/services/ai/reconciliation/knowledge-query/model');
    const { KNOWLEDGE_QUERY_PENDING_CONTRACT } = await import('@/services/ai/reconciliation/knowledge-query/contract');
    const cap = await knowledgeQueryCapability();
    return cap.available ? { lifted: true, why: `t3_available:${cap.version ?? '?'}` } : { lifted: false, why: `t3_${cap.reason.toLowerCase()}`, pendingContract: KNOWLEDGE_QUERY_PENDING_CONTRACT };
  }
  if (cause === 'INTERPRETATION_INCOMPLETE') return { lifted: false, why: 'context_beyond_bounds' };
  return { lifted: true, why: `retry:${configRef ?? 'unknown'}` };
}

async function cartes(sql: Parameters<typeof rows>[0], accountId: number, ids: readonly number[]): Promise<Map<number, Row>> {
  const r = await rows(sql, `
    SELECT id, target_id, rule_code, resolved_at IS NULL AS open FROM to_process_actions
     WHERE account_id = $1 AND target_type = 'DOCUMENT' AND id = ANY($2::int[])`, [accountId, intArray(ids)]);
  return new Map(r.map((x) => [Number(x.id), x]));
}

export const toProcessDocumentFieldsCheck: CoherenceCheck = {
  id: 'COH-TODO-DOCUMENT-FIELDS',
  // Lot 98B (P0-C) : version 2 — DECISION_CURRENT n'est plus CONSISTENT par défaut (réexamen du stock).
  version: 2,
  status: 'ACTIVE',
  title: '« À traiter » : cartes documentaires dont la réponse est disponible ou la question sans objet',
  domain: 'a-traiter',
  level: 'N2',
  objectType: 'to_process_action',
  scope: 'cartes ouvertes sur un document, règles du pont documentaire portant sur une donnée',
  sources: ['to_process_actions', 'document_field_values', 'document_facts', 'document_unresolved_facts', 'document_source_units', 'document_rule_evaluations'],
  applicability: 'compte éligible',
  invariant: 'une carte ouverte correspond à une information réellement manquante, nécessaire et non déjà disponible ou calculable',
  anomalies: ['CARD_TARGET_DELETED', 'CARD_RESOLVABLE_FROM_STATE', 'ANSWER_ALREADY_PRESENT', 'ANSWER_AVAILABLE', 'DECISION_STALE', 'CONFLICTING_VALUES', 'DECISION_NOT_DEMONSTRATED'],
  autoRepairWhen: 'réévaluation par la décision centrale existante (état, ou connaissance T1 persistée), écriture relue avant fermeture',
  forbiddenRepairs: ['fermer une carte sans décision du moteur', 'relancer T1', 'écraser une valeur de l’utilisateur', 'choisir entre valeurs contradictoires',
    'tenir un maintien technique (T4 incompatible, interprétation en attente, panne IA) pour une carte justifiée'],
  services: ['to-process/document-rule-bridge#syncDocumentRulesFromState', 'to-process/document-rule-bridge#resolveDocumentRuleFromKnowledge'],
  chain: ['T1', 'PERSISTENCE', 'TO_PROCESS'],
  triggers: ['SOURCE_ANALYZED', 'DOCUMENT_UPDATED', 'DOCUMENT_DELETED'],
  frequency: 'campagne exhaustive quotidienne + contrôle ciblé à chaque changement',
  criticality: 'MEDIUM',
  tests: ['L82B-E2E-03', 'L82B-E2E-04', 'L98B-U-COH', 'L98B-E2E-03', 'L98B-E2E-04'],

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
        case 'DECISION_CURRENT': {
          // Lot 98B (P0-C) : décision à jour ≠ carte justifiée.
          const st = cardStanding(d.lastDecision ? { outcome: d.lastDecision.outcome, reasonCode: d.lastDecision.reasonCode ?? null } : null);
          if (st.kind !== 'TECHNICAL_HOLD') {
            out.set(id, { verdict: 'CONSISTENT', detail: { ...detail, standing: st.kind === 'JUSTIFIED' && st.ambiguity ? 'REAL_AMBIGUITY' : 'JUSTIFIED' } });
            break;
          }
          const levee = await causeLevee(st.cause, d.lastDecision?.configRef ?? null);
          const base = { ...detail, standing: 'NOT_DEMONSTRATED', cause: st.cause, causeLabel: HOLD_CAUSE_LABELS[st.cause], causeLifted: levee.lifted, why: levee.why };
          out.set(id, levee.lifted
            ? { verdict: 'REPAIRABLE', anomaly: 'DECISION_NOT_DEMONSTRATED', faultyLink: st.cause === 'T4_INCOMPATIBLE' || st.cause === 'AI_UNAVAILABLE' ? 'T4' : 'T3',
              expected: 'décision démontrant l’utilité de la carte', observed: `maintien technique (${st.reasonCode ?? st.cause})`, detail: base,
              // Une nouvelle tentative au plus par jour (budget IA, anti-boucle).
              inputHash: hashOf({ id, kind: d.kind, cause: st.cause, why: levee.why, rev: d.knowledgeRev ?? null, jour: ctx.today }) }
            : { verdict: 'FINDING', anomaly: 'DECISION_NOT_DEMONSTRATED', faultyLink: st.cause === 'T4_INCOMPATIBLE' ? 'T4' : 'T3',
              expected: 'décision démontrant l’utilité de la carte', observed: `maintien technique (${st.reasonCode ?? st.cause})`,
              detail: { ...base, qualification: 'UNDETERMINED_DECISION', ...(levee.pendingContract ? { pendingContract: levee.pendingContract } : {}) },
              inputHash: hashOf({ id, kind: d.kind, cause: st.cause, why: levee.why, rev: d.knowledgeRev ?? null }) });
          break;
        }
        default:
          // USER_PROTECTED, NO_ACTIVE_CARD, NOT_A_FIELD : hors objet.
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
