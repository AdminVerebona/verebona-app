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
 *
 * Version 2 — lot 107C (ticket P1 « TCO — date d'achat du bien prioritaire »)
 * : les acquisitions réalisées DÉJÀ DATÉES sont aussi contrôlées, contre la
 * résolution de la date d'achat du bien par le moteur TCO
 * (`tco/acquisition-start`, via `readAssetTco` : mêmes règles que la fiche,
 * l'API, les exports et T2) :
 *   · achat du bien identifié sans ambiguïté, date canonique ABSENTE →
 *     REPAIRABLE `ACQUISITION_DATE_CANONICAL_NOT_ENRICHED` : la date d'achat
 *     de la fiche est renseignée par la primitive canonique
 *     (`writeCanonicalAssetField`, origine RECONCILIATION, valeur attendue
 *     vide — provenance : l'Opération ; avant / après au journal 0216) ;
 *   · date canonique AUTOMATIQUE contredite par l'achat PROUVÉ (justificatif
 *     du prix du bien, rattachement par l'utilisateur) → REPAIRABLE
 *     `ACQUISITION_DATE_CANONICAL_CONTRADICTED` : correction de la valeur
 *     automatique (valeur attendue = valeur en place ; une valeur humaine est
 *     protégée par la primitive, jamais remplacée) ;
 *   · achat daté autrement que la date SAISIE par l'utilisateur → AMBIGUOUS
 *     `ACQUISITION_DATE_CONTRADICTS_ASSET` (écart tracé, rien n'est écrasé :
 *     la saisie fait autorité pour le TCO) ;
 *   · dates incompatibles sans autorité → AMBIGUOUS
 *     `ACQUISITION_DATE_UNDETERMINED` (moyenne annuelle non calculée, alerte
 *     ciblée sur la fiche ; aucune carte « À traiter » créée : la fiche porte
 *     déjà la question, « Confirmez la date d'achat ») ;
 *   · acquisition qui n'est PAS l'achat du bien (équipement, accessoire, objet
 *     distinct, multibiens) mais que l'ancienne règle (plus ancienne
 *     ACQUISITION) aurait retenue → AMBIGUOUS `ACQUISITION_MISATTRIBUTED`
 *     (constat du stock : le TCO ne l'emploie plus ; à revoir en supervision).
 * Campagne exhaustive quotidienne idempotente : après réparation, la date de
 * la fiche concorde avec l'achat → CONSISTENT, aucune seconde écriture.
 */
import type { CoherenceCheck, Inspection, RepairResult } from '../types';
import { hashOf, idsOf, intArray, rows, type Row } from '../util';

const OPERATION_CHANGED = 'BUSINESS_OPERATION_CHANGED';
const ASSET_UPDATED = 'ASSET_UPDATED';

/** Lot 107C : acquisitions réalisées DATÉES liées à un bien (contrôle contre la date d'achat du bien). */
const DATEE_SQL = `
  o.type_code = 'ACQUISITION' AND o.status = 'REALIZED' AND o.realized_date IS NOT NULL
  AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
  AND EXISTS (SELECT 1 FROM business_operation_asset_links l JOIN assets a ON a.id = l.asset_id AND a.account_id = o.account_id AND a.deleted_at IS NULL
               WHERE l.operation_id = o.id AND l.active)`;

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

/** Lot 107C : acquisitions réalisées liées à un bien, datées ou non (objets du contrôle v2). */
async function acquisitionsControlees(sql: Parameters<typeof rows>[0], accountId: number, extra: string, params: unknown[]): Promise<number[]> {
  return idsOf(await rows(sql, `
    SELECT o.id FROM business_operations o
     WHERE o.account_id = $1 AND ((${SANS_DATE_SQL}) OR (${DATEE_SQL})) ${extra}
     ORDER BY o.id`, [accountId, ...params]));
}

/** Lot 107C : anomalies réparables par la primitive canonique (date d'achat de la fiche). */
const CANONIQUE = new Set(['ACQUISITION_DATE_CANONICAL_NOT_ENRICHED', 'ACQUISITION_DATE_CANONICAL_CONTRADICTED']);

type TcoDepart = NonNullable<import('@/services/business-operations/tco/model').TcoResult['acquisitionStart']>;

/**
 * Lot 107C — verdict d'une acquisition DATÉE pour un bien lié, d'après la
 * résolution de la date d'achat par le moteur TCO (pure).
 */
export function inspectDatedAcquisition(opId: number, assetId: number, r: TcoDepart | null): Inspection {
  if (!r) return { verdict: 'CONSISTENT' };
  const cand = r.candidates.find((x) => x.kind === 'OPERATION' && x.operationId === opId);
  if (!cand) return { verdict: 'CONSISTENT' };
  const c = r.canonical;
  const fiche = c ? { acquisitionDate: c.raw, origin: c.origin } : { acquisitionDate: null };
  if (r.repair && r.repair.operationId === opId) {
    const anomaly = r.repair.kind === 'ENRICH_CANONICAL' ? 'ACQUISITION_DATE_CANONICAL_NOT_ENRICHED' : 'ACQUISITION_DATE_CANONICAL_CONTRADICTED';
    return {
      verdict: 'REPAIRABLE', anomaly, faultyLink: 'T3',
      expected: { acquisitionDate: r.repair.value, origin: 'RECONCILIATION' }, observed: fiche,
      detail: {
        assetId, operationId: opId, repairKind: r.repair.kind, value: r.repair.value, expectedCurrent: r.repair.expectedCurrent,
        repairChain: 'date d’achat de la fiche par la primitive canonique (origine RECONCILIATION, valeur attendue), provenance : l’achat du bien',
      },
      inputHash: hashOf({ opId, assetId, repair: r.repair }),
    };
  }
  const base = { faultyLink: 'T3' as const, observed: { operationDate: cand.date ?? cand.rawDate, ...fiche } };
  const detail = { assetId, operationId: opId, tcoStart: r.date, tcoStatus: r.status, basis: r.basis, reason: cand.reason, legacyDate: r.legacyDate };
  if (cand.reason === 'CANONICAL_USER_PRIORITY') {
    return { verdict: 'AMBIGUOUS', anomaly: 'ACQUISITION_DATE_CONTRADICTS_ASSET', ...base, expected: { acquisitionDate: r.date }, detail: { ...detail, resolvedBy: 'USER_AUTHORITY' }, inputHash: hashOf({ opId, assetId, d: cand.date, f: fiche }) };
  }
  if (cand.reason === 'CONFLICTING_CANDIDATES') {
    return { verdict: 'AMBIGUOUS', anomaly: 'ACQUISITION_DATE_UNDETERMINED', ...base, detail: { ...detail, contradictions: r.contradictions }, inputHash: hashOf({ opId, assetId, c: r.contradictions }) };
  }
  const datee = cand.dateField === 'realizedDate' ? cand.rawDate?.slice(0, 10) ?? null : null;
  if (['NOT_ASSET_PURCHASE', 'MULTI_ASSET', 'EQUIPMENT_PURCHASE'].includes(cand.reason) && datee && r.legacyDate === datee && r.date !== datee) {
    return { verdict: 'AMBIGUOUS', anomaly: 'ACQUISITION_MISATTRIBUTED', ...base, detail: { ...detail, role: cand.role ?? null }, inputHash: hashOf({ opId, assetId, datee, s: r.date }) };
  }
  return { verdict: 'CONSISTENT' };
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
  // Lot 107C : v2 — acquisitions déjà datées contrôlées contre la date d'achat du bien (TCO), enrichissement canonique.
  version: 2,
  status: 'ACTIVE',
  title: 'Opérations : achat réalisé daté par la date d’acquisition connue du bien',
  domain: 'operations',
  level: 'N2',
  objectType: 'operation',
  scope: 'Opérations ACQUISITION actives, réalisées, liées à un bien : sans date de réalisation (lot 85E) ou datées (lot 107C, contre la date d’achat du bien)',
  sources: ['business_operations', 'business_operation_sources', 'business_operation_asset_links', 'assets', 'agenda_items', 'to_process_actions'],
  applicability: 'compte éligible (actif et modifiable) ; bien lié portant une date d’acquisition canonique valide (toute origine)',
  invariant: 'une acquisition réalisée dont le bien porte une date d’acquisition exploitable a cette date (provenance conservée) et son événement de référence aussi ; une date automatique seule ne crée jamais d’Opération ; lot 107C : la date d’achat du bien (TCO) n’est jamais celle d’une acquisition qui n’est pas l’achat du bien, la saisie de l’utilisateur prime, une contradiction sans autorité est tracée',
  anomalies: ['ACQUISITION_DATE_NOT_ENRICHED', 'ACQUISITION_DATE_AMBIGUOUS',
    'ACQUISITION_DATE_CANONICAL_NOT_ENRICHED', 'ACQUISITION_DATE_CANONICAL_CONTRADICTED', 'ACQUISITION_DATE_CONTRADICTS_ASSET', 'ACQUISITION_DATE_UNDETERMINED', 'ACQUISITION_MISATTRIBUTED'],
  autoRepairWhen: 'la réconciliation T3 du bien recalculée (simulation, sans IA) date l’Opération existante avec la date canonique du bien ; lot 107C : l’achat du bien est identifié sans ambiguïté et la date d’achat de la fiche est absente, ou automatique et contredite par la preuve de l’achat',
  forbiddenRepairs: ['créer une Opération depuis une date automatique', 'écraser une date existante', 'choisir entre plusieurs acquisitions du bien',
    'réécrire un événement d’agenda modifié par l’utilisateur', 'créer un second événement Achat', 'appeler l’IA depuis le contrôle',
    'écrire hors de la réconciliation T3 et de la projection T4',
    // Lot 107C.
    'remplacer une date d’achat saisie ou corrigée par l’utilisateur', 'choisir la plus ancienne acquisition', 'dater l’achat par une date de début ou une date planifiée',
    'écrire la date d’achat de la fiche hors de la primitive canonique'],
  services: ['business-operations/consolidation/asset-data-consolidator#previewAssetDataReconciliation',
    'business-operations/consolidation/asset-data-consolidator#consolidateAssetData', 'business-operations/agenda-projection/service#projectAccountOperations',
    'business-operations/tco/service#readAssetTco', 'canonical/asset-state#writeCanonicalAssetField'],
  chain: ['T3', 'PERSISTENCE', 'PROJECTION', 'TO_PROCESS'],
  triggers: [OPERATION_CHANGED, ASSET_UPDATED],
  frequency: 'campagne exhaustive quotidienne + contrôle ciblé à chaque écriture d’Opération ou modification du bien',
  criticality: 'MEDIUM',
  tests: ['L85E-U-01', 'L85E-U-08', 'L85E-E2E-08', 'L85E-E2E-09', 'L107C-U-20', 'L107C-E2E-07', 'L107C-E2E-08'],

  async listObjects(ctx, accountId, afterId, limit) {
    return (await acquisitionsControlees(ctx.sql, accountId, `AND o.id > $2`, [afterId])).slice(0, limit);
  },

  async objectsForEvent(ctx, accountId, e) {
    if (e.entityId == null) return [];
    if (e.type === OPERATION_CHANGED) return acquisitionsControlees(ctx.sql, accountId, `AND o.id = $2`, [e.entityId]);
    if (e.type === ASSET_UPDATED) {
      return acquisitionsControlees(ctx.sql, accountId,
        `AND EXISTS (SELECT 1 FROM business_operation_asset_links l2 WHERE l2.operation_id = o.id AND l2.active AND l2.asset_id = $2)`, [e.entityId]);
    }
    return [];
  },

  async inspect(ctx, accountId, ids) {
    const out = new Map<number, Inspection>();
    const vivants = new Set(await acquisitionsSansDate(ctx.sql, accountId, `AND o.id = ANY($2::bigint[])`, [intArray(ids)]));
    // Lot 107C : acquisitions datées — contrôlées contre la date d'achat du bien résolue par le moteur TCO.
    const datees = new Set(await rows(ctx.sql, `SELECT o.id FROM business_operations o WHERE o.account_id = $1 AND ${DATEE_SQL} AND o.id = ANY($2::bigint[])`,
      [accountId, intArray(ids)]).then(idsOf));
    const liensDatees = datees.size ? await rows(ctx.sql, `
      SELECT l.operation_id, a.id AS asset_id FROM business_operation_asset_links l JOIN assets a ON a.id = l.asset_id AND a.account_id = $1 AND a.deleted_at IS NULL
       WHERE l.active AND l.operation_id = ANY($2::bigint[]) ORDER BY l.operation_id, (l.link_role = 'PRIMARY') DESC, a.id`, [accountId, intArray([...datees])]) : [];
    const departs = new Map<number, TcoDepart | null>();
    const departDe = async (assetId: number): Promise<TcoDepart | null> => {
      if (!departs.has(assetId)) {
        const { readAssetTco, AssetNotFoundForTcoError } = await import('@/services/business-operations/tco/service');
        try { departs.set(assetId, (await readAssetTco(accountId, assetId, { today: ctx.today })).acquisitionStart ?? null); } catch (e) {
          if (!(e instanceof AssetNotFoundForTcoError)) throw e;
          departs.set(assetId, null);
        }
      }
      return departs.get(assetId)!;
    };
    const existants = new Set(idsOf(await rows(ctx.sql, `
      SELECT id FROM business_operations WHERE account_id = $1 AND id = ANY($2::bigint[]) AND invalidated_at IS NULL AND merged_into_operation_id IS NULL`,
    [accountId, intArray(ids)])));
    const liens = await rows(ctx.sql, `
      SELECT l.operation_id, a.id AS asset_id, row_to_json(a.*) AS r
        FROM business_operation_asset_links l JOIN assets a ON a.id = l.asset_id AND a.account_id = $1 AND a.deleted_at IS NULL
       WHERE l.active AND l.operation_id = ANY($2::bigint[])
       ORDER BY l.operation_id, (l.link_role = 'PRIMARY') DESC, a.id`, [accountId, intArray([...vivants])]);
    const { previewAssetDataReconciliation } = await import('@/services/business-operations/consolidation/asset-data-consolidator');
    const RANG: Record<string, number> = { REPAIRABLE: 0, AMBIGUOUS: 1, FINDING: 2, CONSISTENT: 3, GONE: 4 };
    for (const id of ids) {
      if (datees.has(id)) {
        // Un constat par bien lié ; le plus actionnable l'emporte (réparation, puis écart tracé).
        let pire: Inspection = { verdict: 'CONSISTENT' };
        for (const l of liensDatees.filter((x) => Number(x.operation_id) === id)) {
          const i = inspectDatedAcquisition(id, Number(l.asset_id), await departDe(Number(l.asset_id)));
          if (RANG[i.verdict] < RANG[pire.verdict]) pire = i;
        }
        out.set(id, pire);
        continue;
      }
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
      if (inspection.anomaly && CANONIQUE.has(inspection.anomaly)) {
        // Lot 107C : date d'achat de la fiche par la primitive canonique — origine automatique (RECONCILIATION), valeur
        // attendue (conflit optimiste), provenance l'Opération ; une valeur humaine est protégée (jamais remplacée).
        const d = inspection.detail as { value: string; expectedCurrent: string | null };
        const { writeCanonicalAssetField } = await import('@/services/canonical/asset-state');
        const w = await writeCanonicalAssetField({
          assetId, accountId, key: 'acquisitionDate', value: d.value, origin: 'RECONCILIATION', expectedCurrent: d.expectedCurrent,
          actorUserId: null, source: { type: 'coherence_acquisition_date', id: String(id) }, traceId: ctx.correlationId,
        });
        out.set(id, {
          called: true, service: 'writeCanonicalAssetField', aiCalls: 0,
          result: { assetId, anomaly: inspection.anomaly, outcome: w.field?.outcome ?? (w.notFound ? 'not_found' : null), previous: (w.field?.previousValue as string | null) ?? null, next: d.value },
          rollbackRef: `canonical_field_writes:trace_id=${ctx.correlationId}`,
        });
        continue;
      }
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
