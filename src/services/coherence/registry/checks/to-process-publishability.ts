/**
 * COH-TODO-PUBLISHABILITY — lot 100E (décision PO A7 du 27/10/2026 ; A6 ;
 * point D « le moteur de cohérence doit pouvoir supprimer des cartes
 * inutiles, sans masquer les problèmes purement techniques ni écraser les
 * modifications manuelles »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * NETTOYAGE RÉTROACTIF DES CARTES DEVENUES INUTILES — TOUTES FAMILLES
 *
 * Objets : TOUTES les cartes ouvertes du compte (documents, agenda,
 * équipements, fournisseurs, biens et pièces, événements de référence, et
 * toute famille future). Lecture : le statut de publication UNIQUE
 * (`to-process/publishability#publicationStandingSql`, même SQL que la page,
 * le compteur, la mascotte et les notifications) :
 *
 *   · PUBLISHABLE        → CONSISTENT ;
 *   · TARGET_GONE        → CONSISTENT, délégué à COH-TODO-ORPHAN-CARDS ;
 *   · NO_LONGER_USEFUL   → la prémisse du contrat de la famille ne tient plus
 *     (réponse déjà connue, intérêt disparu) :
 *       - fermeture confiée à CE contrôle par le contrat → REPAIRABLE
 *         `CARD_NO_LONGER_USEFUL`, réparé par le service de la famille
 *         (producteur « état » restreint à la cible, fermeture des cartes de
 *         statut d'agenda, ou fermeture générique tracée qui relit la
 *         prémisse dans la même instruction) ;
 *       - fermeture confiée à un autre contrôle (C-Q9, une anomalie = une
 *         chaîne : COH-TODO-OPERATION-CARDS, COH-TODO-AGENDA-PROPOSAL-CARDS…)
 *         → CONSISTENT, délégué ;
 *   · HELD:<cause>       → blocage TECHNIQUE : jamais fermé, jamais masqué —
 *     il reste en Supervision (alerte « cartes retenues ») et sa nouvelle
 *     tentative appartient au contrôle de sa famille (COH-TODO-DOCUMENT-FIELDS,
 *     COH-TODO-RELEVANCE-CARDS) → CONSISTENT, délégué ; une règle sans contrat
 *     déclaré (RULE_NOT_DECLARED) → CONSTAT `CARD_RULE_NOT_DECLARED`.
 *
 * Jamais : écrire une valeur de l'objet (la saisie de l'utilisateur, souvent
 * à l'origine de l'inutilité, est intacte), rouvrir une carte que
 * l'utilisateur a fermée, fermer une carte retenue pour cause technique,
 * appeler l'IA. Idempotent : une carte fermée n'est plus un objet du
 * contrôle ; un second passage ne trouve rien.
 *
 * Mode (A6) : version nouvelle → premier passage À BLANC (qualification par
 * contrôle, `orchestrator.ts#qualifiedChecks`), puis correctif.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { CoherenceCheck, Inspection, RepairResult } from '../types';
import { hashOf, idsOf, intArray, rows } from '../util';
import {
  CARD_FAMILY_LABELS, contractOf, familyOf, HOLD_CAUSE_LABELS, PUBLISHABILITY_CHECK_ID, publicationStandingSql, type TechnicalHoldCause,
} from '@/services/to-process/publishability';
import { documentFieldRuleCodes, relevanceCardRuleCodes } from './to-process-relevance';

/** Contrôle qui retente une carte retenue de cette règle (`null` : aucun — constat). */
async function retryOwner(targetType: string, ruleCode: string): Promise<string | null> {
  if (targetType === 'DOCUMENT' && (await documentFieldRuleCodes()).includes(ruleCode)) return 'COH-TODO-DOCUMENT-FIELDS';
  if ((await relevanceCardRuleCodes()).includes(ruleCode)) return 'COH-TODO-RELEVANCE-CARDS';
  return null;
}

/**
 * Verdict d'une carte ouverte d'après son statut de publication (pure) —
 * L100E-U-COH. `owner` : contrôle qui retente une carte retenue.
 */
export function publishabilityVerdict(p: { standing: string; ruleCode: string; owner: string | null }): {
  verdict: Inspection['verdict']; anomaly?: string; delegatedTo?: string; cause?: TechnicalHoldCause;
} {
  if (p.standing === 'PUBLISHABLE') return { verdict: 'CONSISTENT' };
  if (p.standing === 'TARGET_GONE') return { verdict: 'CONSISTENT', delegatedTo: 'COH-TODO-ORPHAN-CARDS' };
  if (p.standing === 'NO_LONGER_USEFUL') {
    const c = contractOf(p.ruleCode);
    if (c && c.cleanup.by === PUBLISHABILITY_CHECK_ID) return { verdict: 'REPAIRABLE', anomaly: 'CARD_NO_LONGER_USEFUL' };
    return { verdict: 'CONSISTENT', delegatedTo: c?.cleanup.by ?? 'COH-TODO-ORPHAN-CARDS' };
  }
  const cause = p.standing.startsWith('HELD:') ? p.standing.slice(5) as TechnicalHoldCause : 'EVALUATION_ERROR';
  if (cause === 'RULE_NOT_DECLARED') return { verdict: 'FINDING', anomaly: 'CARD_RULE_NOT_DECLARED', cause };
  if (p.owner) return { verdict: 'CONSISTENT', delegatedTo: p.owner, cause };
  return { verdict: 'FINDING', anomaly: 'CARD_HELD_WITHOUT_RETRY', cause };
}

export const toProcessPublishabilityCheck: CoherenceCheck = {
  id: PUBLISHABILITY_CHECK_ID,
  version: 1,
  status: 'ACTIVE',
  title: '« À traiter » : cartes devenues inutiles (réponse connue, intérêt disparu) — toutes familles',
  domain: 'a-traiter',
  level: 'N2',
  objectType: 'to_process_action',
  scope: 'toutes les cartes ouvertes du compte, toutes familles (documents, agenda, équipements, fournisseurs, biens et pièces, événements de référence, familles futures)',
  sources: ['to_process_actions', 'to_process_decisions', 'document_rule_evaluations', 'agenda_items', 'equipments', 'assets', 'asset_files',
    'document_asset_links', 'supplier_review_items', 'business_operations', 'document_operation_candidates'],
  applicability: 'compte éligible ; cible vivante (sinon : COH-TODO-ORPHAN-CARDS)',
  invariant: 'une carte ouverte satisfait les deux conditions A7 : intervention utile ET réponse non déjà connue de Verebona ; un blocage technique relève de la Supervision',
  anomalies: ['CARD_NO_LONGER_USEFUL', 'CARD_RULE_NOT_DECLARED', 'CARD_HELD_WITHOUT_RETRY'],
  autoRepairWhen: 'prémisse du contrat de la famille fausse sur l’état courant, fermeture confiée à ce contrôle : service de la famille (producteur restreint à la cible, ou fermeture tracée qui relit la prémisse)',
  forbiddenRepairs: ['écrire une valeur de l’objet', 'fermer une carte retenue pour cause technique', 'rouvrir une carte fermée par l’utilisateur',
    'fermer une carte dont la prémisse tient', 'supprimer une carte', 'appeler l’IA'],
  services: [
    'to-process/publishability#closeCardsNoLongerUseful', 'to-process/agenda-status-cards#closeAgendaStatusCards',
    'to-process/producers.service#produceAgendaActions', 'to-process/producers.service#produceEquipmentActions', 'to-process/producers.service#produceSupplierActions',
  ],
  chain: ['PERSISTENCE', 'TO_PROCESS'],
  triggers: ['AGENDA_ITEM_UPDATED', 'DOCUMENT_UPDATED', 'ASSET_UPDATED'],
  frequency: 'campagne exhaustive quotidienne + contrôle ciblé au changement de l’objet',
  criticality: 'MEDIUM',
  tests: ['L100E-U-CONTRACT', 'L100E-U-COH', 'L100E-E2E-01', 'L100E-E2E-02', 'L100E-E2E-03'],

  async listObjects(ctx, accountId, afterId, limit) {
    return idsOf(await rows(ctx.sql, `
      SELECT a.id FROM to_process_actions a WHERE a.account_id = $1 AND a.resolved_at IS NULL AND a.id > $2 ORDER BY a.id LIMIT $3`,
    [accountId, afterId, limit]));
  },

  async objectsForEvent(ctx, accountId, e) {
    if (e.entityId == null) return [];
    const type = e.type === 'AGENDA_ITEM_UPDATED' ? 'AGENDA_ITEM' : e.type === 'ASSET_UPDATED' ? 'ASSET' : 'DOCUMENT';
    return idsOf(await rows(ctx.sql, `
      SELECT a.id FROM to_process_actions a
       WHERE a.account_id = $1 AND a.resolved_at IS NULL AND a.target_type = $2 AND a.target_id = $3 ORDER BY a.id`, [accountId, type, e.entityId]));
  },

  async inspect(ctx, accountId, ids) {
    const out = new Map<number, Inspection>();
    const r = await rows(ctx.sql, `
      SELECT a.id, a.target_type, a.target_id, a.rule_code, a.resolved_at IS NULL AS open,
             CASE WHEN a.resolved_at IS NULL THEN ${publicationStandingSql('a')} END AS standing
        FROM to_process_actions a WHERE a.account_id = $1 AND a.id = ANY($2::int[])`, [accountId, intArray(ids)]);
    const parId = new Map(r.map((x) => [Number(x.id), x]));
    for (const id of ids) {
      const x = parId.get(id);
      if (!x || x.open !== true) { out.set(id, { verdict: 'GONE' }); continue; }
      const rule = String(x.rule_code);
      const standing = String(x.standing);
      const family = familyOf(rule);
      const owner = standing.startsWith('HELD:') ? await retryOwner(String(x.target_type), rule) : null;
      const v = publishabilityVerdict({ standing, ruleCode: rule, owner });
      const detail: Record<string, unknown> = {
        targetType: x.target_type, targetId: Number(x.target_id), rule, family: family ? CARD_FAMILY_LABELS[family] : null, standing,
        ...(v.delegatedTo ? { delegatedTo: v.delegatedTo } : {}),
        ...(v.cause ? { cause: v.cause, causeLabel: HOLD_CAUSE_LABELS[v.cause] } : {}),
      };
      if (v.verdict === 'CONSISTENT') { out.set(id, { verdict: 'CONSISTENT', detail }); continue; }
      const contrat = contractOf(rule);
      out.set(id, v.verdict === 'REPAIRABLE'
        ? {
          verdict: 'REPAIRABLE', anomaly: v.anomaly, faultyLink: 'TO_PROCESS',
          expected: 'carte fermée : réponse déjà connue ou question sans intérêt', observed: 'carte ouverte',
          detail: { ...detail, reason: contrat?.reason ?? null, service: contrat && 'service' in contrat.cleanup ? contrat.cleanup.service : null },
          inputHash: hashOf({ id, rule, standing, target: [x.target_type, x.target_id] }),
        }
        : {
          verdict: 'FINDING', anomaly: v.anomaly, faultyLink: 'TO_PROCESS',
          expected: v.anomaly === 'CARD_RULE_NOT_DECLARED' ? 'règle déclarée dans le contrat commun de publication' : 'nouvelle tentative par le contrôle de la famille',
          observed: standing, detail, inputHash: hashOf({ id, rule, standing }),
        });
    }
    return out;
  },

  async repair(ctx, accountId, items) {
    const out = new Map<number, RepairResult>();
    const r = await rows(ctx.sql, `SELECT id, target_type, target_id, rule_code, resolved_at IS NULL AS open FROM to_process_actions WHERE account_id = $1 AND id = ANY($2::int[])`,
      [accountId, intArray(items.map((x) => x.id))]);
    const parId = new Map(r.map((x) => [Number(x.id), x]));
    for (const { id } of items) {
      const x = parId.get(id);
      if (!x || x.open !== true) { out.set(id, { called: false, service: 'none', result: { gone: true } }); continue; }
      const rule = String(x.rule_code);
      const targetId = Number(x.target_id);
      const contrat = contractOf(rule);
      const service = contrat && 'service' in contrat.cleanup ? contrat.cleanup.service : null;
      const rollbackRef = `to_process_action_events:action_id=${id}`;
      if (!service) { out.set(id, { called: false, service: 'none', result: { delegated: contrat?.cleanup.by ?? null } }); continue; }
      if (service === 'closeCardsNoLongerUseful') {
        const { closeCardsNoLongerUseful } = await import('@/services/to-process/publishability');
        const fermees = await closeCardsNoLongerUseful(accountId, [id], { runRef: ctx.correlationId });
        out.set(id, { called: true, service, aiCalls: 0, result: { closed: fermees, reason: contrat?.reason ?? null }, rollbackRef });
        continue;
      }
      if (service === 'closeAgendaStatusCards') {
        // Statut posé par l'utilisateur (réalisé / annulé) : la carte de statut est close « complétée ailleurs ».
        const { closeAgendaStatusCards } = await import('@/services/to-process/agenda-status-cards');
        const fermees = await closeAgendaStatusCards(accountId, targetId, 'USER_COMPLETED');
        out.set(id, { called: true, service, aiCalls: 0, result: { closed: fermees }, rollbackRef });
        continue;
      }
      const producteurs = await import('@/services/to-process/producers.service');
      const rep = await producteurs[service](accountId, { trigger: 'BACKFILL', runRef: ctx.correlationId, only: [targetId] });
      out.set(id, { called: true, service, aiCalls: 0, result: { created: rep.created, updated: rep.updated, closed: rep.closed }, rollbackRef });
      const err = (rep.errorDetails ?? []).filter((e) => e.kind !== 'TRACE_FAILED' && (e.targetId === undefined || e.targetId === targetId));
      if (err.length) throw new Error(`nettoyage ${rule} ${targetId} en erreur : ${err.map((e) => `${e.step} — ${e.cause}`).join(' ; ').slice(0, 300)}`);
    }
    return out;
  },
};
