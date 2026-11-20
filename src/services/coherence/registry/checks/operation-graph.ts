/**
 * COH-OPERATION-GRAPH — cohérence du GRAPHE des opérations (lot 116C, carte
 * Trello #806 §4 ; CDC « Opérations / Agenda V2.0 » AC73). Raccorde le contrôle
 * de lecture existant `graph/store.ts › auditOperationGraph` au registre des
 * contrôles de cohérence (aucun moteur parallèle) : exécuté par la campagne
 * exhaustive quotidienne et par les contrôles ciblés à chaque écriture d'une
 * opération ou d'un événement de l'Agenda.
 *
 * Objet contrôlé : le COMPTE (le graphe est un tout : relations entre
 * opérations, liens N↔N avec l'Agenda, lien Sinistre → contrat, mémoire des
 * scissions) — seulement s'il porte des opérations.
 *   · inspection (LECTURE SEULE, sans IA) : `auditOperationGraph` — liens
 *     orphelins, liens intercomptes, réactivation d'un refus de l'utilisateur
 *     (dont la refusion automatique d'une paire scindée), anomalies de
 *     provenance, double comptage, écarts de la colonne historique ;
 *   · verdict : CONSISTENT, ou FINDING (constat) — JAMAIS « réparable » :
 *     ce contrôle n'a AUCUNE fonction de réparation. Un écart du graphe touche
 *     l'isolation d'un compte ou une décision de l'utilisateur ; aucune
 *     correction destructive n'est faite automatiquement ;
 *   · la PREUVE de contrôle (`coherence_object_proofs`) est écrite par le
 *     moteur, objet par objet : un compte jamais contrôlé n'a pas de preuve et
 *     n'est jamais présenté comme « vérifié » (lecture du BO :
 *     `graph/audit-read.ts`).
 * Les écarts BLOQUANTS (intercomptes, décision de l'utilisateur contournée)
 * sont signalés IMMÉDIATEMENT à la Supervision.
 */
import {
  GRAPH_FINDING_DESCRIPTIONS, GRAPH_IMMEDIATE_FINDINGS, OPERATION_GRAPH_CHECK_ID, OPERATION_GRAPH_CHECK_VERSION,
} from '@/services/business-operations/graph/audit-model';
import type { GraphFindingCode } from '@/services/business-operations/graph/store';
import type { CheckContext, CoherenceCheck, Inspection } from '../types';
import { hashOf, rows } from '../util';

/** Le compte porte-t-il un graphe à contrôler (opérations, relations, liens d'Agenda) ? */
async function compteConcerne(ctx: CheckContext, accountId: number): Promise<boolean> {
  const [r] = await rows(ctx.sql, `
    SELECT EXISTS (SELECT 1 FROM business_operations o WHERE o.account_id = $1)
        OR EXISTS (SELECT 1 FROM business_operation_relations rel WHERE rel.account_id = $1)
        OR EXISTS (SELECT 1 FROM business_operation_agenda_links g WHERE g.account_id = $1) AS ok`, [accountId]);
  return r?.ok === true;
}

const CODES = Object.keys(GRAPH_FINDING_DESCRIPTIONS) as GraphFindingCode[];

export const operationGraphCheck: CoherenceCheck = {
  id: OPERATION_GRAPH_CHECK_ID,
  version: OPERATION_GRAPH_CHECK_VERSION,
  status: 'ACTIVE',
  title: 'Opérations : graphe cohérent (aucun lien orphelin ni entre comptes, refus et scissions de l’utilisateur respectés, provenance, aucun double comptage)',
  domain: 'operations',
  level: 'N1',
  objectType: 'account',
  scope: 'graphe des opérations du compte : relations entre opérations, liens opération ↔ événement de l’Agenda, lien sinistre → contrat d’assurance, mémoire des scissions',
  sources: ['business_operations', 'business_operation_relations', 'business_operation_agenda_links', 'business_operation_graph_history',
    'business_operation_claim_details', 'business_operation_match_decisions', 'business_operation_sources', 'agenda_items'],
  applicability: 'compte éligible portant des opérations, des relations ou des liens d’Agenda',
  invariant: 'toute relation et tout lien actif relient deux objets ACTIFS du MÊME compte ; aucun traitement ne rétablit ce que l’utilisateur a refusé, retiré ou scindé ; une relation déduite cite sa preuve ; un même fait d’un justificatif ne fonde qu’une opération active ; la colonne historique et le graphe disent la même chose',
  anomalies: CODES,
  autoRepairWhen: 'jamais : constat seul (aucune réparation destructive automatique)',
  forbiddenRepairs: [
    'retirer, réactiver ou réorienter une relation ou un lien',
    'fusionner ou scinder une opération',
    'lever ou recréer une décision de l’utilisateur',
    'déplacer un objet d’un compte à l’autre',
    'appeler l’IA',
  ],
  services: ['business-operations/graph/store#auditOperationGraph'],
  chain: ['T3', 'T4', 'PERSISTENCE', 'LINK'],
  triggers: ['BUSINESS_OPERATION_CHANGED', 'AGENDA_ITEM_CREATED', 'AGENDA_ITEM_UPDATED', 'DOCUMENT_DELETED'],
  frequency: 'campagne exhaustive quotidienne + contrôle ciblé à chaque écriture d’opération ou d’agenda',
  criticality: 'HIGH',
  tests: ['L116C-G-U', 'L116C-G01', 'L116C-G02', 'L116C-G03'],
  immediateSupervision: GRAPH_IMMEDIATE_FINDINGS,

  async listObjects(ctx, accountId, afterId) {
    return afterId < accountId && (await compteConcerne(ctx, accountId)) ? [accountId] : [];
  },

  async objectsForEvent(ctx, accountId) {
    return (await compteConcerne(ctx, accountId)) ? [accountId] : [];
  },

  async inspect(ctx, accountId, ids) {
    const out = new Map<number, Inspection>();
    const [{ auditOperationGraph }, { postgresRunner }] = await Promise.all([
      import('@/services/business-operations/graph/store'), import('@/services/business-operations/grouping/runner'),
    ]);
    for (const id of ids) {
      if (id !== accountId) { out.set(id, { verdict: 'GONE' }); continue; }
      const findings = await auditOperationGraph(postgresRunner(ctx.sql), accountId);
      if (!findings.length) { out.set(id, { verdict: 'CONSISTENT' }); continue; }
      // L'écart le plus grave nomme le constat (signalement immédiat) ; tous sont détaillés.
      const principal = findings.find((f) => GRAPH_FINDING_DESCRIPTIONS[f.code].severity === 'BLOCKING') ?? findings[0];
      out.set(id, {
        verdict: 'FINDING', anomaly: principal.code, faultyLink: 'PERSISTENCE',
        expected: 'graphe des opérations sans écart',
        observed: findings.map((f) => ({ code: f.code, count: f.count, sample: f.sample })),
        detail: {
          findings: findings.length, codes: findings.map((f) => f.code),
          blocking: findings.filter((f) => GRAPH_FINDING_DESCRIPTIONS[f.code].severity === 'BLOCKING').map((f) => f.code),
        },
        inputHash: hashOf({ v: OPERATION_GRAPH_CHECK_VERSION, f: findings.map((f) => [f.code, f.count, f.sample]) }),
      });
    }
    return out;
  },
};
