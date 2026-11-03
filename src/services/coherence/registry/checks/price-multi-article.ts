/**
 * COH-PRICE-MULTI-ARTICLE — prix de biens / équipements alimentés par le TOTAL
 * d'un justificatif à plusieurs articles, et arbitrages « À traiter » déjà
 * tranchés par l'utilisateur puis rouverts sans preuve nouvelle (lot 107D,
 * ticket P1 « Draisienne »). Ajouté EN FIN de registre.
 *
 * Objet : le BIEN (son prix et celui de ses équipements, ses cartes et celles
 * de ses équipements). Inspection en lecture seule
 * (`multi-article-repair#diagnoseAssetPrices`) ; réparation déterministe
 * (`repairAssetPrices`) : preuve « panier » retirée (jamais supprimée), ligne
 * de l'objet attribuée si démontrable, carte rouverte à tort close, T3 du
 * bien sans IA (valeur automatique erronée corrigée ou retirée ; USER / ADMIN
 * jamais modifiés). Rejoué : plus rien à faire (idempotent).
 */
import type { CoherenceCheck, Inspection, RepairResult } from '../types';
import { idsOf, intArray, rows } from '../util';

export const PRICE_MULTI_ARTICLE_CHECK_ID = 'COH-PRICE-MULTI-ARTICLE';

/** Biens candidats : preuve de prix documentaire active, ou carte « À arbitrer » ouverte après une décision de l'utilisateur. */
const CANDIDATS = (extra: string) => `
  SELECT a.id FROM assets a
   WHERE a.account_id = $1 AND a.deleted_at IS NULL ${extra}
     AND (EXISTS (SELECT 1 FROM field_evidence fe
                   WHERE fe.account_id = a.account_id AND fe.asset_id = a.id AND fe.status = 'active' AND fe.source_type = 'document'
                     AND COALESCE(to_jsonb(fe) ->> 'lifecycle_status', 'ACTIVE') = 'ACTIVE'
                     AND COALESCE(to_jsonb(fe) ->> 'canonical_key', fe.field_key) = 'acquisitionPrice')
       OR EXISTS (SELECT 1 FROM to_process_actions t
                   WHERE t.account_id = a.account_id AND t.resolved_at IS NULL AND t.action_kind = 'ARBITRATE' AND t.field_key IS NOT NULL
                     AND ((t.target_type = 'ASSET' AND t.target_id = a.id)
                       OR (t.target_type = 'EQUIPMENT' AND t.target_id IN (SELECT e.id FROM equipments e WHERE e.asset_id = a.id)))
                     AND EXISTS (SELECT 1 FROM to_process_actions p WHERE p.account_id = t.account_id AND p.target_type = t.target_type
                                  AND p.target_id = t.target_id AND p.field_key = t.field_key AND p.action_kind = 'ARBITRATE'
                                  AND p.resolution_reason IN ('USER_ARBITRATED', 'USER_COMPLETED'))))`;

export const priceMultiArticleCheck: CoherenceCheck = {
  id: PRICE_MULTI_ARTICLE_CHECK_ID,
  version: 1,
  status: 'ACTIVE',
  title: 'Prix d’achat : jamais le total d’un justificatif à plusieurs articles ; un arbitrage tranché par l’utilisateur n’est pas rouvert sans preuve nouvelle',
  domain: 'biens',
  level: 'N2',
  objectType: 'asset',
  scope: 'biens du compte portant une preuve documentaire active du prix d’achat (bien ou équipement), ou une carte « À arbitrer » ouverte après une décision de l’utilisateur',
  sources: ['field_evidence', 'document_source_units', 'document_extractions', 'assets', 'equipments', 'to_process_actions', 'to_process_action_events'],
  applicability: 'compte éligible ; couche A (0300) ou transcription conservée pour lire les lignes du justificatif (sinon aucune exclusion : prudence)',
  invariant: 'le prix d’achat d’un bien ou d’un équipement repose sur une ligne explicitement attribuable, jamais sur le total, le sous-total ou le paiement d’un ticket à plusieurs articles ; une décision de l’utilisateur n’est reproposée que sur une preuve nouvelle, indépendante et fiable, avec un motif expliqué',
  anomalies: ['BASKET_TOTAL_PRICE_EVIDENCE', 'LINE_PRICE_ATTRIBUTABLE', 'ARBITRATION_REOPENED_SAME_EVIDENCE', 'ARBITRATION_REOPEN_REASON_MISSING', 'BASKET_PRICE_NOT_ATTRIBUTABLE'],
  autoRepairWhen: 'preuve du prix égale à un montant de transaction d’un justificatif à plusieurs articles (et à aucune ligne) ; ligne de l’objet unique et démontrable (désignation / référence, quantité 1 ou prix unitaire écrit, remise de ligne explicite, aucune remise globale ni coupon) ; carte rouverte sans preuve indépendante et certaine',
  forbiddenRepairs: ['modifier une valeur saisie ou validée par l’utilisateur ou un administrateur', 'supprimer une preuve', 'inventer un prix net (quote-part de remise globale, coupon, frais, lot)',
    'attribuer une ligne ambiguë (articles identiques)', 'reporter le prix d’un équipement sur le bien parent', 'rouvrir une carte fermée par l’utilisateur'],
  services: ['ai/reconciliation/multi-article-repair#diagnoseAssetPrices', 'ai/reconciliation/multi-article-repair#repairAssetPrices',
    'ai/evidence/field-evidence.service#recordEvidence', 'ai/reconciliation/reconciliation-engine#reconcileAsset', 'to-process/arbitration-memory#judgeAgainstUserDecision'],
  chain: ['T1', 'T3', 'PERSISTENCE', 'TO_PROCESS'],
  triggers: ['SOURCE_ANALYZED', 'DOCUMENT_UPDATED', 'ASSET_UPDATED'],
  frequency: 'campagne exhaustive quotidienne + contrôle ciblé à chaque analyse / modification de document ou de bien',
  criticality: 'HIGH',
  tests: ['L107D-U-AMOUNTS', 'L107D-U-MEMORY', 'L107D-E2E-01', 'L107D-E2E-02', 'L107D-E2E-03', 'L107D-E2E-04', 'L107D-E2E-07'],

  async listObjects(ctx, accountId, afterId, limit) {
    return idsOf(await rows(ctx.sql, `${CANDIDATS('AND a.id > $2')} ORDER BY a.id LIMIT $3`, [accountId, afterId, limit]));
  },

  async objectsForEvent(ctx, accountId, e) {
    if (e.type === 'ASSET_UPDATED' && e.entityId != null) return idsOf(await rows(ctx.sql, `${CANDIDATS('AND a.id = $2')}`, [accountId, e.entityId]));
    const parDoc = e.entityId == null ? [] : idsOf(await rows(ctx.sql, `${CANDIDATS(`AND a.id IN (SELECT fe.asset_id FROM field_evidence fe WHERE fe.account_id = $1 AND fe.source_type = 'document' AND fe.source_id = $2)`)}`, [accountId, e.entityId]));
    const parBien = e.assetId ? idsOf(await rows(ctx.sql, `${CANDIDATS('AND a.id = $2')}`, [accountId, e.assetId])) : [];
    return [...new Set([...parDoc, ...parBien])].sort((a, b) => a - b);
  },

  async inspect(ctx, accountId, ids) {
    const out = new Map<number, Inspection>();
    const { diagnoseAssetPrices, hasRepair, diagnosisFingerprint } = await import('@/services/ai/reconciliation/multi-article-repair');
    const vivants = new Set(idsOf(await rows(ctx.sql, `SELECT id FROM assets WHERE account_id = $1 AND id = ANY($2::int[]) AND deleted_at IS NULL`, [accountId, intArray(ids)])));
    const cache = new Map();
    for (const id of ids) {
      if (!vivants.has(id)) { out.set(id, { verdict: 'GONE' }); continue; }
      const d = await diagnoseAssetPrices(ctx.sql, accountId, id, cache);
      // Diagnostic borné : identifiants, montants, rôles, motifs — jamais de contenu de document au-delà de la ligne citée.
      const detail = {
        basketEvidence: d.basketEvidence.map((x) => ({ evidenceId: x.evidenceId, documentId: x.sourceId, cents: x.cents, roles: x.summaryRoles, rule: x.projectionRule, target: x.target })),
        lineAttributions: d.lineAttributions.map((x) => ({ target: x.target, documentId: x.fileId, unitId: x.unitId, cents: x.cents, basis: x.basis, matchedBy: x.matchedBy, confidence: x.confidence })),
        abstentions: d.abstentions, currentValues: d.currentValues,
        reopenedCards: d.reopenedCards, reopenReasonMissing: d.reopenReasonMissing.map((x) => ({ actionId: x.actionId, code: x.reason.code })),
      };
      if (!hasRepair(d)) {
        // Panier retiré, ligne non démontrable, valeur automatique encore égale au panier : constat (aucune invention).
        const reste = d.currentValues.filter((v) => v.equalsBasket && v.origin !== 'USER' && v.origin !== 'ADMIN');
        out.set(id, reste.length
          ? { verdict: 'FINDING', anomaly: 'BASKET_PRICE_NOT_ATTRIBUTABLE', faultyLink: 'T1', detail, inputHash: diagnosisFingerprint(d) }
          : { verdict: 'CONSISTENT', detail });
        continue;
      }
      const anomaly = d.basketEvidence.length ? 'BASKET_TOTAL_PRICE_EVIDENCE'
        : d.lineAttributions.length ? 'LINE_PRICE_ATTRIBUTABLE'
          : d.reopenedCards.length ? 'ARBITRATION_REOPENED_SAME_EVIDENCE' : 'ARBITRATION_REOPEN_REASON_MISSING';
      out.set(id, {
        verdict: 'REPAIRABLE', anomaly, faultyLink: d.basketEvidence.length ? 'T3' : 'TO_PROCESS',
        expected: 'prix fondé sur la ligne de l’objet ; décision de l’utilisateur respectée',
        observed: { basket: detail.basketEvidence.length, lines: detail.lineAttributions.length, reopened: detail.reopenedCards.length },
        detail, inputHash: diagnosisFingerprint(d),
      });
    }
    return out;
  },

  async repair(ctx, accountId, items) {
    const out = new Map<number, RepairResult>();
    const { diagnoseAssetPrices, repairAssetPrices } = await import('@/services/ai/reconciliation/multi-article-repair');
    for (const { id } of items) {
      // Diagnostic relu au moment de réparer (jamais sur un état périmé).
      const d = await diagnoseAssetPrices(ctx.sql, accountId, id);
      const r = await repairAssetPrices(ctx.sql, accountId, d, { correlationId: ctx.correlationId });
      out.set(id, {
        called: true, service: 'repairAssetPrices', aiCalls: 0, reevaluation: 'TECHNICAL_REBUILD',
        result: {
          before: { basketEvidence: d.basketEvidence.map((x) => ({ id: x.evidenceId, lifecycle: 'ACTIVE' })), currentValues: d.currentValues, openCards: d.reopenedCards.map((c) => c.actionId) },
          after: { evidenceWithdrawn: r.evidenceWithdrawn, factsRequalified: r.factsRequalified, lineEvidenceRecorded: r.lineEvidenceRecorded, cardsClosed: r.cardsClosed, reopenReasonsSet: r.reopenReasonsSet, t3: r.t3 },
        },
        rollbackRef: r.evidenceWithdrawn.length ? `field_evidence:${r.evidenceWithdrawn.join(',')}:WITHDRAWN` : null,
      });
    }
    return out;
  },
};
