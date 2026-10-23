/**
 * COH-TCO-EXTRACTED-EXPENSES — dépense déjà extraite mais absente du TCO sans
 * décision explicable (lot 82B ; arbitrages C-Q1, C-Q6, C-Q7 ; CDC §4.4).
 *
 * Le TCO n'a pas d'état persisté : il est recalculé par `readAssetTco` (même
 * code que le sous-tiroir et T2 — aucun second moteur). Le contrôle relit ce
 * calcul pour CHAQUE bien du compte et retient les lignes économiques dont
 * le MONTANT est connu (extrait par T1 ou porté par le document) mais dont
 * l'inclusion n'a reçu AUCUNE décision : statut `NOT_QUALIFIED`, motif
 * `THEME_UNKNOWN` (« nature non établie : montant non compté »). Une ligne
 * retenue, consolidée ailleurs, doublon, exclue avec motif (dont un retrait
 * par l'utilisateur), prévision ou règlement n'est PAS un écart.
 *
 * Aucune règle par type de document (ni « taxe foncière », ni catégorie
 * « Impôts et taxes ») : C-Q6 confie à T3 la décision SÉMANTIQUE d'inclusion
 * (coût de possession ou d'usage du bien). Le contrat T3 correspondant
 * n'existe pas encore : demande formalisée à l'équipe IA
 * (`demandes-ia/82B-t3-decision-tco.md`). En attendant, le contrôle est un
 * CONSTAT (verdict FINDING, maillon T3) — sans relance de T1, sans appel IA,
 * sans écriture ; un constat persistant remonte UNE fois par contrôle dans
 * la Supervision existante. Dès que le contrat est livré, la réparation
 * (réévaluation T3 ciblée par la file existante, puis recontrôle) se
 * branche ici sans changer l'orchestration.
 */
import type { CoherenceCheck, Inspection } from '../types';
import { hashOf, idsOf, intArray, rows } from '../util';

/** Demande de contrat IA dont dépend la réparation automatique. */
export const TCO_T3_DECISION_CONTRACT = '82B-t3-decision-tco';

export const tcoExtractedExpensesCheck: CoherenceCheck = {
  id: 'COH-TCO-EXTRACTED-EXPENSES',
  version: 1,
  status: 'ACTIVE',
  title: 'TCO : dépense extraite sans décision d’inclusion',
  domain: 'tco',
  level: 'N3',
  objectType: 'asset',
  scope: 'tous les biens vivants du compte (lignes économiques recalculées par le moteur TCO)',
  sources: ['asset_files', 'document_operation_candidates', 'business_operations', 'business_operation_financial_components', 'asset_cost_line_decisions'],
  applicability: 'compte éligible ; lecture TCO complète (une lecture partielle est une erreur de contrôle, jamais un résultat conforme)',
  invariant: 'toute dépense dont le montant est connu est retenue, représentée par une Opération, ou exclue avec un motif explicable',
  anomalies: ['EXTRACTED_EXPENSE_NOT_EVALUATED'],
  autoRepairWhen: 'aucune pour l’instant : la décision d’inclusion relève de T3 (C-Q6) — contrat demandé à l’équipe IA',
  forbiddenRepairs: ['classer une dépense par type de document ou mot-clé', 'relancer T1 (montant déjà extrait)', 'ajouter une décision utilisateur à sa place'],
  services: ['business-operations/tco/service#readAssetTco'],
  chain: ['T1', 'T3', 'PERSISTENCE'],
  triggers: ['SOURCE_ANALYZED', 'DOCUMENT_UPDATED', 'ASSET_UPDATED'],
  frequency: 'campagne exhaustive quotidienne + contrôle ciblé à chaque changement',
  criticality: 'HIGH',
  tests: ['L82B-E2E-07', 'L82B-U-TCO'],

  async listObjects(ctx, accountId, afterId, limit) {
    return idsOf(await rows(ctx.sql, `SELECT a.id FROM assets a WHERE a.account_id = $1 AND a.deleted_at IS NULL AND a.id > $2 ORDER BY a.id LIMIT $3`, [accountId, afterId, limit]));
  },

  async objectsForEvent(ctx, accountId, e) {
    if (e.type === 'ASSET_UPDATED') {
      return e.entityId == null ? [] : idsOf(await rows(ctx.sql, `SELECT id FROM assets WHERE account_id = $1 AND id = $2 AND deleted_at IS NULL`, [accountId, e.entityId]));
    }
    // Document analysé / modifié : biens qu'il concerne (colonnes et liens actifs), plus le bien de l'analyse.
    const ids = e.entityId == null ? [] : idsOf(await rows(ctx.sql, `
      SELECT DISTINCT a.id FROM assets a
       WHERE a.account_id = $1 AND a.deleted_at IS NULL
         AND (a.id IN (SELECT f.asset_id FROM asset_files f WHERE f.id = $2 AND f.account_id = $1)
              OR a.id IN (SELECT f.linked_asset_id FROM asset_files f WHERE f.id = $2 AND f.account_id = $1)
              OR a.id IN (SELECT l.asset_id FROM document_asset_links l WHERE l.file_id = $2 AND l.account_id = $1 AND l.status = 'ACTIVE'))`,
    [accountId, e.entityId]));
    if (e.assetId != null) ids.push(e.assetId);
    return intArray(ids).sort((a, b) => a - b);
  },

  async inspect(ctx, accountId, ids) {
    const out = new Map<number, Inspection>();
    const { readAssetTco, AssetNotFoundForTcoError } = await import('@/services/business-operations/tco/service');
    for (const assetId of ids) {
      let tco;
      try {
        tco = await readAssetTco(accountId, assetId, { today: ctx.today });
      } catch (e) {
        if (e instanceof AssetNotFoundForTcoError) { out.set(assetId, { verdict: 'GONE' }); continue; }
        throw e;
      }
      // Lecture incomplète (pages non lues) : le contrôle n'a pas eu lieu — jamais « conforme ».
      if (tco.status === 'PARTIAL' || tco.status === 'ERROR') throw new Error(`lecture TCO ${tco.status} du bien ${assetId}`);
      const ecarts = tco.lines
        .filter((l) => l.status === 'NOT_QUALIFIED' && l.reason === 'THEME_UNKNOWN' && !l.amountUnknown && l.amountMinor > 0)
        .map((l) => ({ lineId: l.id, fileId: l.fileId, amountMinor: l.amountMinor, currency: l.currency, date: l.date, provenance: l.provenance, label: l.label.slice(0, 120) }));
      if (!ecarts.length) { out.set(assetId, { verdict: 'CONSISTENT', detail: { lines: tco.lines.length } }); continue; }
      out.set(assetId, {
        verdict: 'FINDING', anomaly: 'EXTRACTED_EXPENSE_NOT_EVALUATED', faultyLink: 'T3',
        expected: 'dépense retenue, consolidée ou exclue avec motif (décision sémantique T3, C-Q6)',
        observed: ecarts,
        detail: { pendingContract: TCO_T3_DECISION_CONTRACT, t1Relaunch: false, count: ecarts.length },
        inputHash: hashOf({ assetId, ecarts: ecarts.map((x) => [x.lineId, x.amountMinor, x.currency]) }),
      });
    }
    return out;
  },
};
