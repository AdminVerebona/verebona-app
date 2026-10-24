/**
 * COH-OPS-ACQUISITION-DATE — acquisition réalisée sans date alors que la date
 * d'acquisition du bien est connue (lot 85E, ticket PO P1 du 23/10/2026 ;
 * CDC cohérence §4.3 ; arbitrages C-Q2, C-Q10, C-Q11). Reprise du STOCK et
 * filet récurrent : aucune migration de données.
 *
 * Objet : Opération ACQUISITION active, RÉALISÉE, `realized_date` vide, liée
 * à un bien (non supprimé).
 *   · inspection (lecture seule, sans IA) : date d'acquisition canonique du
 *     bien lue quelle que soit son origine (saisie, T1, T3, document) ;
 *     absente ou inexploitable → CONSISTENT (la carte « À quelle date… » de
 *     l'événement de référence est alors la bonne question) ; sinon la
 *     réconciliation du bien est RECALCULÉE en simulation
 *     (`previewAssetDataReconciliation`, transaction annulée — mêmes règles
 *     que T3 : enrichissement seul, jamais de création, contradiction tracée)
 *     → l'Opération recevrait cette date : REPAIRABLE
 *     `ACQUISITION_DATE_NOT_ENRICHED` ; sinon AMBIGUOUS (plusieurs
 *     acquisitions du bien, plusieurs biens aux dates différentes, date
 *     future) : aucune écriture, l'arbitrage existant reste juge ;
 *   · réparation : `consolidateAssetData` (réconciliation T3 du bien, qui
 *     enrichit l'Opération existante — provenance 78A conservée) PUIS
 *     `projectAccountOperations` de l'Opération (T4 : date posée sur
 *     l'événement Achat existant s'il est intact, jamais un second ; carte
 *     DATA-AGENDA-DATE réévaluée et fermée comme obsolète) — aucune écriture
 *     du contrôle, aucune IA ; recontrôle par le moteur.
 */
import type { CoherenceCheck, Inspection, RepairResult } from '../types';
import { hashOf, idsOf, intArray, rows, type Row } from '../util';

const OPERATION_CHANGED = 'BUSINESS_OPERATION_CHANGED';
const ASSET_UPDATED = 'ASSET_UPDATED';

const SANS_DATE_SQL = `
  o.type_code = 'ACQUISITION' AND o.status = 'REALIZED' AND o.realized_date IS NULL
  AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
  AND EXISTS (SELECT 1 FROM business_operation_asset_links l JOIN assets a ON a.id = l.asset_id AND a.account_id = o.account_id AND a.deleted_at IS NULL
               WHERE l.operation_id = o.id AND l.active)`;

async function acquisitionsSansDate(sql: Parameters<typeof rows>[0], accountId: number, extra: string, params: unknown[]): Promise<number[]> {
  return idsOf(await rows(sql, `
    SELECT o.id FROM business_operations o
     WHERE o.account_id = $1 AND ${SANS_DATE_SQL} ${extra}
     ORDER BY o.id`, [accountId, ...params]));
}

/** Date d'acquisition du bien, quelle que soit son origine (saisie : date du fait ; sinon canonique automatique). */
async function dateDuBien(row: Row): Promise<{ date: string; origin: string } | null> {
  const { assetDataFacts, canonicalAcquisitionDate } = await import('@/services/business-operations/consolidation/asset-data');
  const r = row as never;
  const saisie = assetDataFacts(r).ACQUISITION?.date ?? null;
  return saisie ? { date: saisie, origin: 'USER' } : canonicalAcquisitionDate(r);
}

export const operationsAcquisitionDateCheck: CoherenceCheck = {
  id: 'COH-OPS-ACQUISITION-DATE',
  version: 1,
  status: 'ACTIVE',
  title: 'Opérations : achat réalisé daté par la date d’acquisition connue du bien',
  domain: 'operations',
  level: 'N2',
  objectType: 'operation',
  scope: 'Opérations ACQUISITION actives, réalisées, sans date de réalisation, liées à un bien',
  sources: ['business_operations', 'business_operation_sources', 'business_operation_asset_links', 'assets', 'agenda_items', 'to_process_actions'],
  applicability: 'compte éligible (actif et modifiable) ; bien lié portant une date d’acquisition canonique valide (toute origine)',
  invariant: 'une acquisition réalisée dont le bien porte une date d’acquisition exploitable a cette date (provenance conservée) et son événement de référence aussi ; une date automatique seule ne crée jamais d’Opération',
  anomalies: ['ACQUISITION_DATE_NOT_ENRICHED', 'ACQUISITION_DATE_AMBIGUOUS'],
  autoRepairWhen: 'la réconciliation T3 du bien recalculée (simulation, sans IA) date l’Opération existante avec la date canonique du bien',
  forbiddenRepairs: ['créer une Opération depuis une date automatique', 'écraser une date existante', 'choisir entre plusieurs acquisitions du bien',
    'réécrire un événement d’agenda modifié par l’utilisateur', 'créer un second événement Achat', 'appeler l’IA depuis le contrôle',
    'écrire hors de la réconciliation T3 et de la projection T4'],
  services: ['business-operations/consolidation/asset-data-consolidator#previewAssetDataReconciliation',
    'business-operations/consolidation/asset-data-consolidator#consolidateAssetData', 'business-operations/agenda-projection/service#projectAccountOperations'],
  chain: ['T3', 'PERSISTENCE', 'PROJECTION', 'TO_PROCESS'],
  triggers: [OPERATION_CHANGED, ASSET_UPDATED],
  frequency: 'campagne exhaustive quotidienne + contrôle ciblé à chaque écriture d’Opération ou modification du bien',
  criticality: 'MEDIUM',
  tests: ['L85E-U-01', 'L85E-U-08', 'L85E-E2E-08', 'L85E-E2E-09'],

  async listObjects(ctx, accountId, afterId, limit) {
    return (await acquisitionsSansDate(ctx.sql, accountId, `AND o.id > $2`, [afterId])).slice(0, limit);
  },

  async objectsForEvent(ctx, accountId, e) {
    if (e.entityId == null) return [];
    if (e.type === OPERATION_CHANGED) return acquisitionsSansDate(ctx.sql, accountId, `AND o.id = $2`, [e.entityId]);
    if (e.type === ASSET_UPDATED) {
      return acquisitionsSansDate(ctx.sql, accountId,
        `AND EXISTS (SELECT 1 FROM business_operation_asset_links l2 WHERE l2.operation_id = o.id AND l2.active AND l2.asset_id = $2)`, [e.entityId]);
    }
    return [];
  },

  async inspect(ctx, accountId, ids) {
    const out = new Map<number, Inspection>();
    const vivants = new Set(await acquisitionsSansDate(ctx.sql, accountId, `AND o.id = ANY($2::bigint[])`, [intArray(ids)]));
    const existants = new Set(idsOf(await rows(ctx.sql, `
      SELECT id FROM business_operations WHERE account_id = $1 AND id = ANY($2::bigint[]) AND invalidated_at IS NULL AND merged_into_operation_id IS NULL`,
    [accountId, intArray(ids)])));
    const liens = await rows(ctx.sql, `
      SELECT l.operation_id, a.id AS asset_id, row_to_json(a.*) AS r
        FROM business_operation_asset_links l JOIN assets a ON a.id = l.asset_id AND a.account_id = $1 AND a.deleted_at IS NULL
       WHERE l.active AND l.operation_id = ANY($2::bigint[])
       ORDER BY l.operation_id, (l.link_role = 'PRIMARY') DESC, a.id`, [accountId, intArray([...vivants])]);
    const { previewAssetDataReconciliation } = await import('@/services/business-operations/consolidation/asset-data-consolidator');
    for (const id of ids) {
      if (!vivants.has(id)) { out.set(id, { verdict: existants.has(id) ? 'CONSISTENT' : 'GONE' }); continue; }
      const biens: Array<{ assetId: number; date: string; origin: string }> = [];
      for (const l of liens.filter((x) => Number(x.operation_id) === id)) {
        const r = (typeof l.r === 'string' ? JSON.parse(l.r) : l.r) as Row;
        const d = await dateDuBien(r);
        if (d) biens.push({ assetId: Number(l.asset_id), ...d });
      }
      // Date inconnue sur la fiche : la question « À quelle date… » est la bonne (aucun écart).
      if (!biens.length) { out.set(id, { verdict: 'CONSISTENT' }); continue; }
      const dates = [...new Set(biens.map((b) => b.date))];
      if (dates.length > 1) {
        out.set(id, {
          verdict: 'AMBIGUOUS', anomaly: 'ACQUISITION_DATE_AMBIGUOUS', faultyLink: 'T3', observed: { assets: biens },
          detail: { why: 'BIENS_DATES_DIFFERENTES' }, inputHash: hashOf({ id, biens }),
        });
        continue;
      }
      const cible = biens[0];
      const apercu = await previewAssetDataReconciliation(accountId, cible.assetId, [id], ctx.today);
      const voulue = apercu.realizedDates.get(id) ?? null;
      if (voulue === cible.date) {
        out.set(id, {
          verdict: 'REPAIRABLE', anomaly: 'ACQUISITION_DATE_NOT_ENRICHED', faultyLink: 'T3',
          expected: { realizedDate: cible.date, origin: cible.origin }, observed: { realizedDate: null },
          detail: { assetId: cible.assetId, repairChain: 'réconciliation T3 du bien (enrichissement), puis projection T4 de l’Opération' },
          inputHash: hashOf({ id, cible }),
        });
        continue;
      }
      const issue = apercu.result.natures.find((n) => n.nature === 'ACQUISITION');
      out.set(id, {
        verdict: 'AMBIGUOUS', anomaly: 'ACQUISITION_DATE_AMBIGUOUS', faultyLink: 'T3',
        expected: { realizedDate: cible.date }, observed: { realizedDate: voulue },
        detail: { assetId: cible.assetId, outcome: issue?.outcome ?? null, reason: issue?.reason ?? (cible.date > ctx.today ? 'DATE_IN_FUTURE' : null) },
        inputHash: hashOf({ id, cible, voulue }),
      });
    }
    return out;
  },

  async repair(ctx, accountId, items) {
    const out = new Map<number, RepairResult>();
    const { consolidateAssetData } = await import('@/services/business-operations/consolidation/asset-data-consolidator');
    const { projectAccountOperations } = await import('@/services/business-operations/agenda-projection/service');
    for (const { id, inspection } of items) {
      const assetId = Number((inspection.detail as { assetId?: unknown } | undefined)?.assetId);
      if (!Number.isSafeInteger(assetId)) throw new Error(`bien inconnu pour l’Opération ${id}`);
      const t3 = await consolidateAssetData(accountId, assetId, { today: ctx.today, correlationId: ctx.correlationId });
      if (t3.error) throw new Error(`réconciliation du bien ${assetId} : ${t3.error}`);
      const t4 = await projectAccountOperations(accountId, { operationIds: [id], correlationId: ctx.correlationId, today: ctx.today });
      out.set(id, {
        called: true, service: 'consolidateAssetData+projectAccountOperations', aiCalls: 0,
        result: {
          assetId, t3Changes: t3.changes, outcome: t3.natures.find((n) => n.nature === 'ACQUISITION')?.outcome ?? null,
          t4Changes: t4.changes, t4Updated: t4.updated, t4Created: t4.created, dateCards: t4.dateCards ?? 0,
        },
        rollbackRef: `business_operation_history:correlation_id=${ctx.correlationId}`,
      });
    }
    return out;
  },
};
