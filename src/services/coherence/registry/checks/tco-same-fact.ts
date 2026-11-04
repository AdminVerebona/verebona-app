/**
 * COH-TCO-SAME-FACT — un même fait économique (achat) représenté par
 * plusieurs sources ne contribue qu'UNE fois au TCO (lot 108A, ticket P1
 * « TCO — correctifs globaux » §A ; mécanismes des lots 82B / 86F : registre,
 * campagne quotidienne des comptes actifs, contrôles ciblés).
 *
 * Le TCO n'a AUCUN total persisté : il est recalculé à chaque lecture par
 * `readAssetTco` (même code que la fiche, le BO et T2). La correction du
 * rapprochement (`tco/fact-matching.ts`, faisceau de preuves) répare donc
 * l'HISTORIQUE de tous les comptes dès la lecture — sans écrire, sans créer
 * ni fusionner d'événement de référence, sans toucher aux décisions
 * « Ajouter / Retirer du TCO » de l'utilisateur (elles priment, appliquées
 * par le moteur). Ce contrôle :
 *   · CONSTATE et TRACE, bien par bien, les faits rapprochés (sources
 *     réunies, codes du faisceau) — preuve de la reprise du stock ;
 *   · vérifie l'invariant (aucun achat du bien compté deux fois : au plus une
 *     ligne retenue d'acquisition par source de référence rapprochée) ;
 *   · route vers l'ARBITRAGE existant (verdict AMBIGUOUS) les seuls
 *     rapprochements réellement incertains, encore sans décision de
 *     l'utilisateur : la dépense reste comptée et signalée sur la fiche, avec
 *     les gestes « Retirer du TCO » / « Ajouter au TCO » ; jamais de carte
 *     « À traiter » pour un simple constat.
 * Aucune IA, aucune écriture, idempotent (lecture pure).
 */
import type { CoherenceCheck, Inspection } from '../types';
import { hashOf, idsOf, intArray, rows } from '../util';

const OPERATION_CHANGED = 'BUSINESS_OPERATION_CHANGED';

export const tcoSameFactCheck: CoherenceCheck = {
  id: 'COH-TCO-SAME-FACT',
  version: 1,
  status: 'ACTIVE',
  title: 'TCO : un même achat représenté par plusieurs sources compté une seule fois',
  domain: 'tco',
  level: 'N2',
  objectType: 'asset',
  scope: 'tous les biens vivants du compte (fiche, équipements, justificatifs, événements de référence, composantes), stock historique compris',
  sources: ['assets', 'equipments', 'asset_files', 'document_operation_candidates', 'business_operations', 'business_operation_financial_components',
    'business_operation_financial_component_sources', 'field_evidence', 'asset_cost_line_decisions'],
  applicability: 'compte éligible (actif) ; lecture TCO complète (une lecture partielle est une erreur de contrôle, jamais un résultat conforme)',
  invariant: 'un achat établi par faisceau de preuves (montant, objet, cible, fournisseur, références, dates proches) contribue une seule fois, toutes ses sources restant consultables ; deux transactions distinctes de même montant restent deux coûts ; un rapprochement incertain reste compté et signalé',
  anomalies: ['SAME_FACT_UNCERTAIN', 'SAME_FACT_COUNTED_TWICE'],
  autoRepairWhen: 'aucune écriture nécessaire : le TCO est recalculé à la lecture par le moteur corrigé (stock repris d’office) ; incertitude → arbitrage de l’utilisateur (gestes du TCO)',
  forbiddenRepairs: ['fusionner sur le seul montant, fournisseur, intitulé ou proximité de dates', 'créer, fusionner ou invalider un événement de référence',
    'écraser une décision « Ajouter / Retirer du TCO »', 'supprimer un justificatif', 'règle propre à un fournisseur, un montant ou un intervalle d’exemple', 'appeler l’IA'],
  services: ['business-operations/tco/service#readAssetTco'],
  chain: ['T1', 'T3', 'PERSISTENCE'],
  triggers: ['SOURCE_ANALYZED', 'DOCUMENT_UPDATED', 'ASSET_UPDATED', OPERATION_CHANGED],
  frequency: 'campagne exhaustive quotidienne + contrôle ciblé à chaque changement de la fiche, d’un justificatif ou d’un événement de référence',
  criticality: 'HIGH',
  tests: ['L108A-U-RC-01', 'L108A-U-RC-02', 'L108A-U-MAT', 'L108A-U-COH', 'L108A-E2E-01', 'L108A-E2E-03'],

  async listObjects(ctx, accountId, afterId, limit) {
    return idsOf(await rows(ctx.sql, `SELECT a.id FROM assets a WHERE a.account_id = $1 AND a.deleted_at IS NULL AND a.id > $2 ORDER BY a.id LIMIT $3`, [accountId, afterId, limit]));
  },

  async objectsForEvent(ctx, accountId, e) {
    if (e.entityId == null) return e.assetId != null ? [e.assetId] : [];
    if (e.type === 'ASSET_UPDATED') {
      return idsOf(await rows(ctx.sql, `SELECT id FROM assets WHERE account_id = $1 AND id = $2 AND deleted_at IS NULL`, [accountId, e.entityId]));
    }
    if (e.type === OPERATION_CHANGED) {
      return idsOf(await rows(ctx.sql, `
        SELECT DISTINCT a.id FROM assets a
         WHERE a.account_id = $1 AND a.deleted_at IS NULL
           AND (a.id IN (SELECT l.asset_id FROM business_operation_asset_links l WHERE l.account_id = $1 AND l.operation_id = $2 AND l.active)
                OR a.id IN (SELECT q.asset_id FROM business_operation_equipment_links q WHERE q.account_id = $1 AND q.operation_id = $2 AND q.active))
         ORDER BY a.id`, [accountId, e.entityId]));
    }
    // Justificatif analysé / modifié : biens qu'il concerne (colonnes et liens actifs), plus le bien de l'analyse.
    const ids = idsOf(await rows(ctx.sql, `
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
    const { inspectSameFacts } = await import('@/services/business-operations/tco/same-fact-audit');
    for (const assetId of ids) {
      let tco;
      try {
        tco = await readAssetTco(accountId, assetId, { today: ctx.today });
      } catch (e) {
        if (e instanceof AssetNotFoundForTcoError) { out.set(assetId, { verdict: 'GONE' }); continue; }
        throw e;
      }
      if (tco.status === 'PARTIAL' || tco.status === 'ERROR') throw new Error(`lecture TCO ${tco.status} du bien ${assetId}`);
      const audit = inspectSameFacts(tco.lines);
      if (audit.countedTwice.length) {
        out.set(assetId, {
          verdict: 'FINDING', anomaly: 'SAME_FACT_COUNTED_TWICE', faultyLink: 'T3',
          expected: 'un seul achat du bien retenu par fait rapproché', observed: audit.countedTwice,
          detail: { merged: audit.merged.length }, inputHash: hashOf({ assetId, c: audit.countedTwice }),
        });
        continue;
      }
      if (audit.uncertain.length) {
        out.set(assetId, {
          verdict: 'AMBIGUOUS', anomaly: 'SAME_FACT_UNCERTAIN', faultyLink: 'T3',
          expected: 'arbitrage de l’utilisateur (« Retirer du TCO » si même achat) — la dépense reste comptée et signalée',
          observed: audit.uncertain, detail: { merged: audit.merged.length, arbitration: 'TCO_LINE_DECISION' },
          inputHash: hashOf({ assetId, u: audit.uncertain.map((x) => [x.lineId, x.against]) }),
        });
        continue;
      }
      out.set(assetId, { verdict: 'CONSISTENT', detail: { lines: tco.lines.length, merged: audit.merged.length, ...(audit.merged.length ? { facts: audit.merged.slice(0, 20) } : {}) } });
    }
    return out;
  },
};
