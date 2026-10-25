/**
 * OperationAgendaProjectionService — T4 / Agenda : projection des Opérations
 * (lot 46, O7 ; CDC Opérations V1 ch. 17.1, B16, C16, C16.1, C16.2, C21.1,
 * C22, C24 NFR-OP-006, F-138 à F-147).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LIRE, DÉCIDER (règles pures de `model.ts`), ÉCRIRE PAR LA PRIMITIVE AGENDA
 *
 *   projectAccountOperations(compte, { operationIds | all })
 *     relit les Opérations visées, leurs éléments d'agenda liés, les
 *     suppressions mémorisées et le pool de rapprochement, puis applique le
 *     plan de chaque Opération. IDEMPOTENT : un agenda à jour ne produit
 *     aucune écriture (no-op) ; rejouable après un échec (NFR-OP-006 : une
 *     erreur de projection n'annule jamais l'Opération déjà validée).
 *
 * Écritures : `writeAgendaItem` (primitive unique de l'agenda, CDC 15 T4-09)
 * — mêmes colonnes 0223 (clé fonctionnelle, nature, type métier), mêmes
 * liens ; sans recopie « achat » (D-13), sans proposition de statut du bien
 * (D-15 : la donnée vient déjà de la fiche ou des documents), notification
 * seulement pour une échéance à venir (D-14 : un HISTORICAL n'est jamais
 * notifié). Retraits : `removeAgendaItemsTraced` (motif
 * OPERATION_PROJECTION, rattrapable), jamais un élément touché par
 * l'utilisateur.
 *
 * ANTI-BOUCLE (C16.2) : une écriture de projection porte
 * `projection_origin = 'OPERATION'` et la corrélation de la chaîne T3 → T4
 * (`projection_correlation_id`) ; elle n'émet AUCUN déclencheur T3 (seuls
 * les gestes utilisateur de `AgendaWriteService` le font, voir
 * `queue.ts / notifyAgendaChangedForOperations`).
 *
 * SUPPRESSION UTILISATEUR (C16.1, F-146) : `recordAgendaProjectionSuppression`
 * écrit `business_operation_projection_suppressions` dans la transaction de
 * suppression de l'élément ; la projection la consulte avant toute création
 * ou tout rapprochement. Changement significatif qui rouvre la projection :
 * une NOUVELLE clé de projection (type requalifié, nouvelle échéance de
 * contrat) — jamais une simple reconsolidation ni le balayage horaire.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { sql, type SQL } from 'drizzle-orm';
import { db, pgClient } from '@/db';
import { agendaFunctionalColumnsReady } from '@/services/agenda/agenda-columns';
import { writeAgendaItem, type AgendaItemValues } from '@/services/agenda/write-agenda-item';
import {
  PROJECTION_KIND_AGENDA, PROJECTION_ORIGIN, PROJECTION_ORIGIN_REF_TYPE, PROJECTION_ORIGIN_TYPE,
  decideProjection, isTouched, parseProjectionFunctionalKey, planOperationProjection, projectionKeyOf,
  type AgendaItemSnapshot, type ItemSync, type OperationSnapshot, type ProjectionAction,
} from './model';
import type { AgendaEventNature } from '@/services/agenda/agenda-functional-key';
import type { BusinessOperationStatus, BusinessOperationTypeCode } from '../model';
import { projectionRoleOf } from '../grouping/model';

type Row = Record<string, unknown>;
interface Executor { execute: (q: SQL) => Promise<unknown> }
const rows = async <T = Row>(x: Executor, q: SQL): Promise<T[]> => (await x.execute(q)) as unknown as T[];
const intArray = (v: readonly number[]): string => `{${[...new Set(v)].filter((x) => Number.isSafeInteger(x)).join(',')}}`;
const nums = (v: unknown): number[] => (Array.isArray(v) ? v.map(Number).filter((x) => Number.isSafeInteger(x)) : []);
const txt = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const todayUtc = () => new Date().toISOString().slice(0, 10);

/**
 * Lot 76H — documents dont T3 a consolidé TOUTE la preuve d'intervention dans
 * l'Opération `o` (alias SQL `o`) : source DOCUMENT active, document non
 * supprimé, aucune AUTRE Opération active d'intervention (ou non qualifiée)
 * prouvée par ce document, et chaque candidat T1 établi d'intervention (ou
 * sans type) ACTIF du document traité par T3 (MATCH / CREATE) vers `o` — la
 * chaîne de fusion suivie — ou réanalyse d'un candidat déjà porté par `o`
 * (même clé). Un candidat en attente, en arbitrage, en attente M3 ou
 * rattaché ailleurs : le document n'est PAS exclusif (abstention).
 */
export const EXCLUSIVE_FILES_RAW = `
  CASE WHEN o.type_code = 'INTERVENTION' AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL THEN
  COALESCE((SELECT array_agg(DISTINCT xf.id ORDER BY xf.id) FROM business_operation_sources xs
              JOIN asset_files xf ON xf.id::text = xs.source_entity_key AND xf.account_id = o.account_id AND xf.deleted_at IS NULL
             WHERE xs.operation_id = o.id AND xs.active AND xs.source_kind = 'DOCUMENT'
               AND NOT EXISTS (SELECT 1 FROM business_operation_sources ys JOIN business_operations yo ON yo.id = ys.operation_id
                                WHERE ys.account_id = o.account_id AND ys.active AND ys.source_kind = 'DOCUMENT'
                                  AND ys.source_entity_key = xs.source_entity_key AND yo.id <> o.id
                                  AND yo.invalidated_at IS NULL AND yo.merged_into_operation_id IS NULL
                                  AND (yo.type_code IS NULL OR yo.type_code IN ('INTERVENTION', 'OTHER')))
               AND NOT EXISTS (
                 SELECT 1 FROM document_operation_candidates dc
                  WHERE dc.account_id = o.account_id AND dc.file_id = xf.id AND dc.status = 'ACTIVE' AND dc.established
                    AND (dc.type_hint IS NULL OR dc.type_hint IN ('INTERVENTION', 'OTHER'))
                    AND NOT (
                      -- résolu par T3 vers cette Opération (fusions suivies)…
                      (NOT dc.t3_pending AND dc.t3_outcome IN ('MATCH_AND_ENRICH', 'CREATE_NEW')
                       AND (WITH RECURSIVE ch(id, m, n) AS (
                              SELECT x.id, x.merged_into_operation_id, 0 FROM business_operations x WHERE x.id = dc.t3_operation_id
                              UNION ALL
                              SELECT y.id, y.merged_into_operation_id, ch.n + 1 FROM business_operations y JOIN ch ON y.id = ch.m WHERE ch.n < 20)
                            SELECT ch.id FROM ch WHERE ch.m IS NULL LIMIT 1) = o.id)
                      -- … ou réanalyse d'un candidat que cette Opération porte déjà
                      -- (même document, même clé : M2 « même source » de T3).
                      OR (dc.t3_pending AND EXISTS (
                            SELECT 1 FROM business_operation_sources zs
                             WHERE zs.operation_id = o.id AND zs.active AND zs.source_kind = 'DOCUMENT'
                               AND zs.source_entity_key = xs.source_entity_key AND zs.locator->>'candidateKey' = dc.candidate_key))))), '{}')
  ELSE '{}' END`;
export const EXCLUSIVE_FILES_SQL = sql.raw(EXCLUSIVE_FILES_RAW);

/** Pool de rapprochement borné par passage (charge). */
const CANDIDATE_LIMIT = 2000;
/**
 * Lot 54D (E07) : taille des PAGES d'un passage complet (curseur stable sur
 * l'identifiant) — le passage va jusqu'à épuisement du périmètre, plus de
 * plafond à 1 000 Opérations.
 */
export const PROJECTION_PAGE_SIZE = 500;

export interface ProjectionRunOptions {
  /** Opérations à projeter (identifiants, fusionnées comprises : la canonique est traitée). */
  operationIds?: readonly number[];
  /** Toutes les Opérations du compte, plus le nettoyage des projections orphelines. */
  all?: boolean;
  /** Corrélation de la chaîne T3 → T4 (C16.2). */
  correlationId?: string | null;
  today?: string;
  /** Garde du travail de file, appelée avant chaque écriture. */
  beforeWrite?: (what: string) => Promise<void> | void;
  /**
   * Lot 53 (D14) : réalités pour lesquelles l'utilisateur a choisi « ajouter
   * un nouvel événement » (carte de rapprochement) — création sans nouveau
   * rapprochement.
   */
  forceCreateOperationIds?: readonly number[];
  /** Tests : taille de page d'un passage complet (E07). */
  pageSize?: number;
  /** Lot 76H : exécution du rattrapage qui porte les écritures (journal 0591, restauration). */
  runId?: string | null;
  /**
   * Lot 76H : SIMULATION — plans calculés et rendus (`plans`), aucune
   * écriture (ni élément, ni lien, ni carte, ni journal).
   */
  dryRun?: boolean;
}

/** Lot 76H : plan d'une Opération rendu par une simulation. */
export interface PlannedOperation {
  operationId: number;
  typeCode: string | null;
  decision: string;
  actions: ProjectionAction[];
}

export interface ProjectionRunResult {
  operations: number;
  created: number;
  updated: number;
  linked: number;
  removed: number;
  detached: number;
  markedDone: number;
  proposed: number;
  abstained: number;
  suppressed: number;
  /** Lot 53 (D14) : cartes « À traiter » de rapprochement incertain posées / mises à jour. */
  matchCards?: number;
  /** Lot 76H : intitulés précisés. (Lot 87B : la projection n'absorbe plus aucune représentation.) */
  retitled?: number;
  /**
   * Lot 87B (CODE-02, CODE-03) : Opérations dont la représentation Agenda
   * demande une décision T4 (plusieurs représentations possibles) — aucune
   * écriture ici ; l'exécutant de la file durable sollicite l'orchestration.
   */
  representationRequired?: Array<{ operationId: number; itemIds: number[]; reason: string }>;
  /** Lot 76H : plans calculés d'une simulation (`dryRun`), Opérations avec au moins une action. */
  plans?: PlannedOperation[];
  /** Lot 82D : rôles d'éléments posés ; liens propagés vers le principal (ajoutés + retirés). */
  roles?: number;
  principalLinks?: number;
  /** Lot 54D (E07) : pages traitées (passage complet), dernier identifiant atteint. */
  pages?: number;
  lastOperationId?: number | null;
  /** Lot 83A : éléments dont la carte de date (DATA-AGENDA-DATE) a été réévaluée (créés sans date, date posée ou retirée). */
  dateCards?: number;
  /** Écritures effectives (0 = no-op). */
  changes: number;
  /** Lot 83A (C-Q10) : compte non éligible aux traitements métier — aucune projection. */
  skipped?: 'COLUMNS_MISSING' | 'ACCOUNT_INELIGIBLE';
}

const vide = (): ProjectionRunResult => ({
  operations: 0, created: 0, updated: 0, linked: 0, removed: 0, detached: 0, markedDone: 0, proposed: 0, abstained: 0, suppressed: 0, changes: 0,
});

// ── Lectures ────────────────────────────────────────────────────────────────

async function canonicalIds(accountId: number, ids: readonly number[]): Promise<number[]> {
  if (!ids.length) return [];
  const r = await rows<{ id: string }>(db, sql`
    WITH RECURSIVE chaine(id, merged) AS (
      SELECT o.id, o.merged_into_operation_id FROM business_operations o
       WHERE o.account_id = ${accountId} AND o.id = ANY(${intArray(ids)}::bigint[])
      UNION
      SELECT o.id, o.merged_into_operation_id FROM business_operations o JOIN chaine c ON o.id = c.merged
       WHERE o.account_id = ${accountId}
    )
    SELECT DISTINCT id FROM chaine`);
  return r.map((x) => Number(x.id));
}

async function projectableIdsPage(accountId: number, afterId: number, size: number): Promise<number[]> {
  const r = await rows<{ id: string }>(db, sql`
    SELECT o.id FROM business_operations o
     WHERE o.account_id = ${accountId} AND o.id > ${afterId}
       AND ((o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
             AND o.type_code IN ('INTERVENTION', 'CLAIM', 'ACQUISITION', 'DISPOSAL', 'CONTRACT'))
            OR EXISTS (SELECT 1 FROM agenda_items ai WHERE ai.business_operation_id = o.id AND ai.account_id = o.account_id))
     ORDER BY o.id
     LIMIT ${size}`);
  return r.map((x) => Number(x.id));
}

export async function loadOperationSnapshots(accountId: number, ids: readonly number[]): Promise<OperationSnapshot[]> {
  if (!ids.length) return [];
  const r = await rows(db, sql`
    SELECT o.id, o.account_id, o.type_code, o.status, o.technical_label, o.provider,
           o.planned_date::text AS planned_date, o.realized_date::text AS realized_date, o.end_date::text AS end_date,
           (o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL) AS active,
           COALESCE((SELECT array_agg(l.asset_id ORDER BY l.asset_id) FROM business_operation_asset_links l
                       JOIN assets a ON a.id = l.asset_id AND a.account_id = o.account_id AND a.deleted_at IS NULL
                      WHERE l.operation_id = o.id AND l.active), '{}') AS asset_ids,
           COALESCE((SELECT array_agg(DISTINCT l.equipment_id) FROM business_operation_equipment_links l
                      WHERE l.operation_id = o.id AND l.active), '{}') AS equipment_ids,
           COALESCE((SELECT array_agg(DISTINCT f.id) FROM business_operation_sources s
                       JOIN asset_files f ON f.id::text = s.source_entity_key AND f.account_id = o.account_id AND f.deleted_at IS NULL
                      WHERE s.operation_id = o.id AND s.active AND s.source_kind = 'DOCUMENT'), '{}') AS file_ids,
           ${EXCLUSIVE_FILES_SQL} AS exclusive_file_ids,
           cd.effective_to::text AS contract_effective_to,
           -- Lot 83A (§11.8) : dates de réalisation contradictoires tracées par T3 (provenance 78A, contradictions ouvertes).
           COALESCE((SELECT array_agg(DISTINCT v->>'value') FROM jsonb_array_elements(
                       CASE WHEN jsonb_typeof(to_jsonb(o)->'attribute_provenance'->'conflicts') = 'array' THEN to_jsonb(o)->'attribute_provenance'->'conflicts' ELSE '[]'::jsonb END) c,
                     jsonb_array_elements(CASE WHEN jsonb_typeof(c->'values') = 'array' THEN c->'values' ELSE '[]'::jsonb END) v
                     WHERE c->>'field' = 'realizedDate' AND v->>'value' IS NOT NULL), '{}') AS realized_conflict,
           kd.history_event_id AS claim_history_event_id,
           (SELECT a.status FROM business_operation_asset_links l JOIN assets a ON a.id = l.asset_id
             WHERE l.operation_id = o.id AND l.active ORDER BY (l.link_role = 'PRIMARY') DESC, l.asset_id LIMIT 1) AS primary_asset_status
      FROM business_operations o
      LEFT JOIN business_operation_contract_details cd ON cd.operation_id = o.id
      LEFT JOIN business_operation_claim_details kd ON kd.operation_id = o.id
     WHERE o.account_id = ${accountId} AND o.id = ANY(${intArray(ids)}::bigint[])
     ORDER BY o.id`);
  return r.map((x): OperationSnapshot => ({
    id: Number(x.id),
    accountId: Number(x.account_id),
    typeCode: (txt(x.type_code) as BusinessOperationTypeCode | null),
    status: String(x.status) as BusinessOperationStatus,
    technicalLabel: txt(x.technical_label),
    provider: txt(x.provider),
    plannedDate: txt(x.planned_date),
    realizedDate: txt(x.realized_date),
    endDate: txt(x.end_date),
    active: x.active === true,
    assetIds: nums(x.asset_ids),
    equipmentIds: nums(x.equipment_ids),
    documentFileIds: nums(x.file_ids).sort((a, b) => a - b),
    contractEffectiveTo: txt(x.contract_effective_to),
    claimHistoryEventId: x.claim_history_event_id === null || x.claim_history_event_id === undefined ? null : Number(x.claim_history_event_id),
    disposalKind: x.primary_asset_status === 'TRANSMIS' ? 'TRANSMISSION' : 'SALE',
    exclusiveFileIds: nums(x.exclusive_file_ids).sort((a, b) => a - b),
    realizedDateConflict: Array.isArray(x.realized_conflict) ? (x.realized_conflict as unknown[]).map(String).sort() : [],
  }));
}

const itemColumnsSql = (journal: boolean) => sql.raw(`
  i.id, i.title, i.start_date::text AS date, i.manual_status, i.is_automatic, i.is_automatic_modified,
  (i.projection_origin IS NOT DISTINCT FROM '${PROJECTION_ORIGIN}') AS projected, i.business_operation_id,
  (lo.id IS NOT NULL AND lo.invalidated_at IS NULL AND lo.merged_into_operation_id IS NULL) AS linked_active,
  i.event_nature, i.business_type, i.home_category, i.functional_key, i.origin_ref_type, i.origin_ref_id,
  COALESCE((SELECT array_agg(l.asset_id) FROM agenda_asset_links l WHERE l.agenda_item_id = i.id), '{}') AS asset_ids,
  COALESCE((SELECT array_agg(l.equipment_id) FROM agenda_equipment_links l WHERE l.agenda_item_id = i.id), '{}') AS equipment_ids,
  COALESCE((SELECT array_agg(l.asset_file_id) FROM agenda_file_links l WHERE l.agenda_item_id = i.id), '{}') AS file_ids,
  (COALESCE(i.requires_qualification, false) OR i.occurrence_nature IS NOT DISTINCT FROM 'FORECAST'
   OR i.confirmation_mode IS NOT DISTINCT FROM 'USER'
   ${journal ? `OR EXISTS (SELECT 1 FROM agenda_intervention_consolidations k
                 WHERE k.account_id = i.account_id AND k.restored_at IS NOT NULL
                   AND (k.absorbed_item_id = i.id OR (k.kind <> 'ABSORB' AND k.principal_item_id = i.id)))` : ''}) AS pending_status,
  i.origin_field_key, i.operation_role, i.operation_role_origin,
  (SELECT count(*)::int FROM agenda_item_sources s WHERE s.agenda_item_id = i.id) AS source_count,
  -- Lot 87B : décision de l'utilisateur sur un lien Document ↔ cet élément (une projection qui la porte ne cède pas sa place).
  EXISTS (SELECT 1 FROM business_operation_match_decisions md WHERE md.account_id = i.account_id AND md.source_kind = 'AGENDA_FILE_LINK'
           AND md.active AND split_part(md.source_entity_key, ':', 1) = i.id::text) AS user_link_decision,
  -- Lot 87B : document d'origine détaché par l'utilisateur (l'origine n'est plus une provenance).
  (i.origin_ref_type = 'asset_file' AND EXISTS (SELECT 1 FROM business_operation_match_decisions md
           WHERE md.account_id = i.account_id AND md.source_kind = 'AGENDA_FILE_LINK' AND md.decision = 'REJECTED' AND md.active
             AND md.source_entity_key = i.id::text || ':' || i.origin_ref_id::text)) AS origin_link_rejected,
  -- Lot 87B : Opérations dont cet élément est la SOURCE exacte — source AGENDA établie par T3 (47B), ou date
  -- d'acquisition de la fiche recopiée de cet élément (D-13, journal canonical_field_writes) puis consolidée par T3.
  COALESCE((SELECT array_agg(DISTINCT x.op) FROM (
             SELECT s.operation_id AS op FROM business_operation_sources s
              WHERE s.account_id = i.account_id AND s.active AND s.source_kind = 'AGENDA' AND s.source_entity_key = i.id::text
             UNION
             SELECT s.operation_id FROM business_operation_sources s
              WHERE s.account_id = i.account_id AND s.active AND s.source_kind = 'ASSET_DATA' AND s.locator->>'nature' = 'ACQUISITION'
                AND (SELECT w.source_type = 'agenda_item' AND w.source_id = i.id::text FROM canonical_field_writes w
                      WHERE w.account_id = i.account_id AND w.asset_id::text = s.source_entity_key AND w.canonical_key = 'acquisitionDate'
                        AND w.outcome = 'written' AND NOT w.dry_run ORDER BY w.id DESC LIMIT 1)) x), '{}') AS agenda_source_ops,
  -- Lot 87B : unique Opération active dont le document d'origine de l'élément est une source (provenance exacte).
  (SELECT CASE WHEN count(DISTINCT s.operation_id) = 1 THEN min(s.operation_id) END FROM business_operation_sources s
     JOIN business_operations so ON so.id = s.operation_id AND so.invalidated_at IS NULL AND so.merged_into_operation_id IS NULL
    WHERE i.origin_ref_type = 'asset_file' AND s.account_id = i.account_id AND s.active AND s.source_kind = 'DOCUMENT'
      AND s.source_entity_key = i.origin_ref_id::text) AS origin_sole_op`);

/**
 * Colonnes d'un élément lu par la projection. Lot 76H : un élément dont la
 * consolidation a été RESTAURÉE est un statut ouvert (jamais réabsorbé, ni
 * relié, ni renommé automatiquement) — lu seulement si le journal 0591 existe.
 */
async function itemColumns(): Promise<SQL> {
  const { consolidationJournalReady } = await import('./consolidation');
  return itemColumnsSql(await consolidationJournalReady());
}

function toItem(x: Row): AgendaItemSnapshot {
  return {
    id: Number(x.id),
    title: String(x.title ?? ''),
    date: txt(x.date),
    manualStatus: txt(x.manual_status) || null,
    isAutomatic: x.is_automatic === true,
    isAutomaticModified: x.is_automatic_modified === true,
    projected: x.projected === true,
    businessOperationId: x.business_operation_id === null || x.business_operation_id === undefined ? null : Number(x.business_operation_id),
    linkedOperationActive: x.linked_active === true,
    nature: (txt(x.event_nature) as AgendaEventNature | null),
    businessType: txt(x.business_type),
    homeCategory: txt(x.home_category),
    functionalKey: txt(x.functional_key),
    originRefType: txt(x.origin_ref_type),
    originRefId: x.origin_ref_id === null || x.origin_ref_id === undefined ? null : Number(x.origin_ref_id),
    assetIds: nums(x.asset_ids),
    equipmentIds: nums(x.equipment_ids),
    fileIds: nums(x.file_ids),
    pendingStatus: x.pending_status === true,
    originFieldKey: txt(x.origin_field_key),
    sourceCount: Number(x.source_count ?? 0),
    operationRole: (txt(x.operation_role) as 'PRINCIPAL' | 'RELATED' | null),
    operationRoleOrigin: txt(x.operation_role_origin),
    userLinkDecision: x.user_link_decision === true,
    originLinkRejected: x.origin_link_rejected === true,
    agendaSourceOperationIds: nums(x.agenda_source_ops),
    originSoleOperationId: x.origin_sole_op === null || x.origin_sole_op === undefined ? null : Number(x.origin_sole_op),
  };
}

async function loadLinkedItems(accountId: number, opIds: readonly number[]): Promise<AgendaItemSnapshot[]> {
  if (!opIds.length) return [];
  return (await rows(db, sql`
    SELECT ${await itemColumns()} FROM agenda_items i LEFT JOIN business_operations lo ON lo.id = i.business_operation_id
     WHERE i.account_id = ${accountId} AND i.business_operation_id = ANY(${intArray(opIds)}::bigint[])
     ORDER BY i.id`)).map(toItem);
}

async function loadCandidates(accountId: number, assetIds: readonly number[], fileIds: readonly number[]): Promise<AgendaItemSnapshot[]> {
  if (!assetIds.length && !fileIds.length) return [];
  return (await rows(db, sql`
    SELECT ${await itemColumns()} FROM agenda_items i LEFT JOIN business_operations lo ON lo.id = i.business_operation_id
     WHERE i.account_id = ${accountId} AND i.start_date IS NOT NULL
       AND (i.manual_status IS NULL OR i.manual_status <> 'annule')
       AND (EXISTS (SELECT 1 FROM agenda_asset_links l WHERE l.agenda_item_id = i.id AND l.asset_id = ANY(${intArray(assetIds)}::int[]))
            OR EXISTS (SELECT 1 FROM agenda_file_links l WHERE l.agenda_item_id = i.id AND l.asset_file_id = ANY(${intArray(fileIds)}::int[]))
            OR (i.origin_ref_type = 'asset_file' AND i.origin_ref_id = ANY(${intArray(fileIds)}::int[])))
     ORDER BY i.id DESC
     LIMIT ${CANDIDATE_LIMIT}`)).map(toItem);
}

async function loadSuppressions(opIds: readonly number[]): Promise<Map<number, Set<string>>> {
  const out = new Map<number, Set<string>>();
  if (!opIds.length) return out;
  const r = await rows<{ operation_id: string; projection_key: string }>(db, sql`
    SELECT operation_id, projection_key FROM business_operation_projection_suppressions
     WHERE operation_id = ANY(${intArray(opIds)}::bigint[]) AND projection_kind = ${PROJECTION_KIND_AGENDA}`);
  for (const x of r) {
    const id = Number(x.operation_id);
    if (!out.has(id)) out.set(id, new Set());
    out.get(id)!.add(x.projection_key);
  }
  return out;
}

/**
 * Lot 84B (CDC v5 §10, §11.9) : Opérations dont l'utilisateur a RETIRÉ le
 * rôle principal (mémoire unifiée, décision PRINCIPAL REJECTED active) — la
 * projection n'y reconnaît ni n'y crée de principal.
 */
async function loadPrincipalWithdrawals(accountId: number, opIds: readonly number[]): Promise<Set<number>> {
  if (!opIds.length) return new Set();
  const r = await rows<{ op: string }>(db, sql`
    SELECT DISTINCT candidate_operation_id AS op FROM business_operation_match_decisions
     WHERE account_id = ${accountId} AND candidate_operation_id = ANY(${intArray(opIds)}::bigint[])
       AND source_kind = 'PRINCIPAL' AND decision = 'REJECTED' AND active`);
  return new Set(r.map((x) => Number(x.op)));
}

async function loadStatusCardItems(accountId: number, itemIds: readonly number[]): Promise<Set<number>> {
  if (!itemIds.length) return new Set();
  const r = await rows<{ target_id: number }>(db, sql`
    SELECT DISTINCT target_id FROM to_process_actions
     WHERE account_id = ${accountId} AND target_type = 'AGENDA_ITEM' AND field_key = 'manualStatus'
       AND target_id = ANY(${intArray(itemIds)}::int[])`);
  return new Set(r.map((x) => Number(x.target_id)));
}

/**
 * Lot 76H : Opération d'intervention active dont T3 a fait, de façon
 * exclusive, le document source de chaque élément (`coveredByOperationId`).
 * Une lecture par passage (documents des éléments du pool).
 */
async function markCoveringOperations(accountId: number, items: AgendaItemSnapshot[]): Promise<void> {
  const fichiers = [...new Set(items.filter((i) => i.originRefType === 'asset_file' && i.originRefId !== null).map((i) => i.originRefId as number))];
  if (!fichiers.length) return;
  const r = await rows<{ file_id: number; op: string }>(db, sql`
    SELECT x.file_id, x.op FROM (
      SELECT DISTINCT f.fid AS file_id, o.id::text AS op, ${EXCLUSIVE_FILES_SQL} AS excl
        FROM unnest(${intArray(fichiers)}::int[]) AS f(fid)
        JOIN business_operation_sources s ON s.account_id = ${accountId} AND s.active AND s.source_kind = 'DOCUMENT' AND s.source_entity_key = f.fid::text
        JOIN business_operations o ON o.id = s.operation_id AND o.account_id = ${accountId}
       WHERE o.type_code = 'INTERVENTION' AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL) x
     WHERE x.file_id = ANY(x.excl)`);
  const par = new Map(r.map((x) => [Number(x.file_id), Number(x.op)]));
  for (const i of items) i.coveredByOperationId = i.originRefType === 'asset_file' && i.originRefId !== null ? par.get(i.originRefId) ?? null : null;
}

// ── Écritures ───────────────────────────────────────────────────────────────

async function itemIdByKey(accountId: number, key: string): Promise<number | null> {
  const [r] = await rows<{ id: number }>(db, sql`
    SELECT id FROM agenda_items WHERE account_id = ${accountId} AND functional_key = ${key} AND is_automatic LIMIT 1`);
  return r ? Number(r.id) : null;
}

function syncValues(changes: ItemSync, correlationId: string | null): Partial<AgendaItemValues> {
  return {
    ...(changes.title !== undefined ? { title: changes.title } : {}),
    ...(changes.date !== undefined ? { startDate: changes.date } : {}),
    ...(changes.homeCategory !== undefined ? { homeCategory: changes.homeCategory } : {}),
    ...(changes.manualStatus !== undefined ? { manualStatus: changes.manualStatus } : {}),
    // Lot 82D : l'appartenance (`business_operation_id`, rôle) est écrite par le service de regroupement.
    ...(changes.businessOperationId !== undefined ? { originRefId: changes.businessOperationId } : {}),
    projectionOrigin: PROJECTION_ORIGIN,
    projectionCorrelationId: correlationId,
    updatedAt: new Date(),
  };
}

/**
 * Lot 82D (CDC v5 O-1) : écriture d'appartenance par le service UNIQUE de
 * regroupement, dans sa transaction (verrou du compte), décision T4.
 */
async function grouping<T>(accountId: number, correlationId: string | null, fn: (ctx: import('../grouping/service').GroupingContext) => Promise<T>): Promise<T> {
  const { runnerContext } = await import('../grouping/service');
  const { drizzleRunner } = await import('../grouping/runner');
  return db.transaction((tx) => fn(runnerContext(drizzleRunner(tx), accountId, { correlationId })));
}

async function attachProjected(op: OperationSnapshot, itemId: number, role: 'PRINCIPAL' | 'RELATED', correlationId: string | null, reasonCode: string): Promise<boolean> {
  const { attachAgendaItem } = await import('../grouping/service');
  const r = await grouping(op.accountId, correlationId, (ctx) => attachAgendaItem(ctx, { operationId: op.id, itemId, role, origin: 'T4', reasonCode }));
  return r.changed;
}

async function applyAction(
  op: OperationSnapshot, a: ProjectionAction, res: ProjectionRunResult,
  opts: Required<Pick<ProjectionRunOptions, 'beforeWrite'>> & {
    correlationId: string | null; runId?: string | null; role: 'PRINCIPAL' | 'RELATED';
    /** Lot 83A : éléments dont la date a changé ou manque (carte de date à réévaluer). */
    dateCards: Set<number>;
  },
): Promise<number | null> {
  const accountId = op.accountId;
  const garde = (what: string) => opts.beforeWrite(`T4 projection — ${what}`);
  switch (a.kind) {
    case 'CREATE': {
      const d = a.desired;
      await garde('création');
      const values: Partial<AgendaItemValues> = {
        title: d.title, description: null, startDate: d.date, homeCategory: d.category,
        isAutomatic: true, isAutomaticModified: false, requiresQualification: false,
        originType: PROJECTION_ORIGIN_TYPE, originRefType: PROJECTION_ORIGIN_REF_TYPE, originRefId: op.id, originFieldKey: null,
        // Lot 83A (§11.4, §11.5) : sans date établie, ni date ni « Sans échéance » (no_deadline reste faux).
        occurrenceNature: 'CONFIRMED', dateSource: d.date ? 'EXPLICIT_DATE' : null,
        projectionOrigin: PROJECTION_ORIGIN, projectionCorrelationId: opts.correlationId,
      };
      // Lot 82D : documents d'un principal propagés par le service de regroupement (OPERATION_PRINCIPAL).
      const links = opts.role === 'PRINCIPAL'
        ? { assetIds: op.assetIds, equipmentIds: op.equipmentIds, substructureIds: [] }
        : { assetIds: op.assetIds, equipmentIds: op.equipmentIds, fileIds: op.documentFileIds, substructureIds: [] };
      const write = (itemId?: number) => writeAgendaItem({
        ...(itemId !== undefined ? { itemId } : {}),
        values: itemId !== undefined ? { ...values, updatedAt: new Date() } : values,
        links, semantics: { businessType: d.businessType, nature: d.nature }, functionalKey: a.functionalKey,
      }, {
        accountId, channel: 'T4', linkMode: 'replace', notify: itemId === undefined, statusProposal: false,
        ...(itemId !== undefined ? { onlyIfUntouched: true } : {}),
      });
      // Élément de même clé déjà présent (reprise après échec) : adopté.
      const existant = await itemIdByKey(accountId, a.functionalKey);
      let w: Awaited<ReturnType<typeof write>>;
      try {
        w = await write(existant ?? undefined);
        if (w.protected) return null;
        if (w.created) res.created++; else res.updated++;
        res.changes++;
      } catch (e) {
        if (existant === null && /agenda_items_functional_key_uidx/.test(`${(e as Error).message} ${String((e as { cause?: Error }).cause?.message ?? '')}`)) {
          const id = await itemIdByKey(accountId, a.functionalKey);
          if (id === null) throw e;
          w = await write(id);
          if (w.protected) return w.id;
          res.updated++; res.changes++;
        } else {
          throw e;
        }
      }
      await attachProjected(op, w.id, opts.role, opts.correlationId, 'T4_PROJECTION_CREATED');
      if (!d.date) opts.dateCards.add(w.id);
      return w.id;
    }
    case 'SYNC': {
      await garde('mise à jour');
      const c = a.changes;
      const w = await writeAgendaItem({
        itemId: a.itemId,
        values: syncValues(c, opts.correlationId),
        ...(c.links ? { links: { ...c.links, substructureIds: [] } } : {}),
        semantics: { businessType: c.businessType ?? null, nature: c.nature ?? null },
        functionalKey: c.functionalKey ?? null,
      }, { accountId, channel: 'T4', linkMode: 'replace', onlyIfUntouched: true, notify: false, statusProposal: false });
      if (!w.protected) {
        res.updated++; res.changes++;
        if (c.businessOperationId !== undefined) await attachProjected(op, a.itemId, opts.role, opts.correlationId, 'T4_PROJECTION_SYNC');
        if (c.date !== undefined) opts.dateCards.add(a.itemId);
      }
      return null;
    }
    case 'DATE': {
      // Lot 83A (§11.7, AC19) : date établie posée sur un élément automatique intact resté sans date
      // (garde d'écriture : jamais un élément modifié ou confirmé par l'utilisateur).
      await garde('date établie');
      const w = await writeAgendaItem({
        itemId: a.itemId, values: { startDate: a.date, dateSource: 'EXPLICIT_DATE', updatedAt: new Date() },
      }, { accountId, channel: 'T4', onlyIfUntouched: true, notify: false, statusProposal: false });
      if (!w.protected) {
        res.updated++; res.changes++;
        opts.dateCards.add(a.itemId);
      }
      return null;
    }
    case 'LINK': {
      await garde('rapprochement');
      // Lot 82D : service unique de regroupement — jamais un élément d'une autre Opération active, refus utilisateur respecté.
      const applied = await attachProjected(op, a.itemId, opts.role, opts.correlationId, 'T4_PROJECTION_LINK');
      if (applied) { res.linked++; res.changes++; }
      console.info(JSON.stringify({ event: 't4.operation_projection_link', accountId, operationId: op.id, itemId: a.itemId, reason: a.reason, applied }));
      return null;
    }
    case 'ROLE': {
      await garde('rôle de l’élément');
      if (await attachProjected(op, a.itemId, a.role, opts.correlationId, 'T4_PROJECTION_ROLE')) { res.roles = (res.roles ?? 0) + 1; res.changes++; }
      return null;
    }
    case 'REPRESENTATION_REQUIRED':
      // Lot 87B : aucune écriture — la demande de décision T4 est rendue à l'appelant (file durable : `queue.ts`).
      (res.representationRequired ??= []).push({ operationId: op.id, itemIds: a.itemIds, reason: a.reason });
      return null;
    case 'RETITLE': {
      await garde('intitulé précis');
      const { retitleAgendaItem } = await import('./consolidation');
      if (await retitleAgendaItem({
        accountId, operationId: op.id, itemId: a.itemId, title: a.title, from: a.from,
        origin: opts.runId ? 'REPRISE' : 'PROJECTION', runId: opts.runId ?? null, correlationId: opts.correlationId,
      })) { res.retitled = (res.retitled ?? 0) + 1; res.changes++; }
      return null;
    }
    case 'REMOVE': {
      await garde('retrait');
      const { removeAgendaItemsTraced } = await import('@/services/agenda/agenda-removal-trace');
      const gone = await removeAgendaItemsTraced(pgClient, { accountId, ids: [a.itemId], reason: 'OPERATION_PROJECTION' });
      if (gone.length) { res.removed++; res.changes++; }
      return null;
    }
    case 'DETACH': {
      await garde('détachement');
      await detachItem(accountId, a.itemId, op.id);
      res.detached++;
      res.changes++;
      return null;
    }
    case 'MARK_DONE': {
      await garde('statut réalisé');
      const [cur] = await rows<{ s: string | null }>(db, sql`SELECT manual_status AS s FROM agenda_items WHERE id = ${a.itemId} AND account_id = ${accountId}`);
      if (!cur || (cur.s && cur.s !== '')) return null;
      const { upsertAgendaItem } = await import('@/services/agenda/agenda-write-primitive');
      await upsertAgendaItem({ itemId: a.itemId, accountId, assetId: null, origin: 'AUTOMATIC', details: { manualStatus: 'realise' } });
      const { recordOccurrenceEvent } = await import('@/services/agenda/agenda-persistence');
      await recordOccurrenceEvent(a.itemId, accountId, 'STATUS_AUTO_COMPLETED', {
        manualStatus: 'realise', origin: 'CONSOLIDATED_REALIZATION', reasonCode: 'COMPLETION_PROVEN', correlationId: opts.correlationId,
      });
      const { closeAgendaStatusCards } = await import('@/services/to-process/agenda-status-cards');
      await closeAgendaStatusCards(accountId, a.itemId, 'OBSOLETE');
      res.markedDone++;
      res.changes++;
      return null;
    }
    case 'PROPOSE_DONE': {
      await garde('proposition de réalisation');
      const { proposeAgendaStatus } = await import('@/services/to-process/agenda-status-cards');
      const r = await proposeAgendaStatus({ accountId, itemId: a.itemId, kind: 'propose_done', sourceFileId: op.documentFileIds[0] ?? null });
      if (r.status !== 'SKIPPED') { res.proposed++; res.changes++; }
      return null;
    }
    case 'ABSTAIN':
      res.abstained++;
      if (a.itemId !== undefined) {
        console.info(JSON.stringify({ event: 't4.operation_projection_abstain', accountId, operationId: op.id, itemId: a.itemId, reason: a.reason }));
      }
      return null;
    case 'SUPPRESSED':
      res.suppressed++;
      return null;
  }
}

/**
 * Retire le lien (et le marquage de projection) d'un élément — l'élément reste.
 * Lot 76H : seulement s'il est ENCORE lié à `operationId` (un élément repris
 * par la canonique d'une fusion dans le même passage n'est jamais détaché).
 */
async function detachItem(accountId: number, itemId: number, operationId: number | null = null): Promise<void> {
  // Lot 82D : service unique de regroupement (rôle et propagation retirés), marques de projection effacées.
  const { detachAgendaItem } = await import('../grouping/service');
  await grouping(accountId, null, (ctx) => detachAgendaItem(ctx, { itemId, operationId, origin: 'T4', reasonCode: 'T4_PROJECTION_DETACH', clearProjectionMarks: true }));
}

/** Projections orphelines (Opération disparue, lien coupé par un transfert) : retirées, ou détachées si touchées. */
async function cleanupOrphans(accountId: number, res: ProjectionRunResult, beforeWrite: (w: string) => Promise<void> | void): Promise<void> {
  const orphelins = (await rows(db, sql`
    SELECT ${await itemColumns()} FROM agenda_items i LEFT JOIN business_operations lo ON lo.id = i.business_operation_id
     WHERE i.account_id = ${accountId} AND i.projection_origin = ${PROJECTION_ORIGIN}
       AND (i.business_operation_id IS NULL OR lo.id IS NULL OR lo.account_id <> i.account_id)`)).map(toItem);
  if (!orphelins.length) return;
  await beforeWrite('T4 projection — orphelines');
  const intacts = orphelins.filter((o) => !isTouched(o)).map((o) => o.id);
  if (intacts.length) {
    const { removeAgendaItemsTraced } = await import('@/services/agenda/agenda-removal-trace');
    const gone = await removeAgendaItemsTraced(pgClient, { accountId, ids: intacts, reason: 'OPERATION_PROJECTION' });
    res.removed += gone.length;
    res.changes += gone.length;
  }
  for (const o of orphelins.filter((x) => isTouched(x))) {
    await detachItem(accountId, o.id);
    res.detached++;
    res.changes++;
  }
}

// ── Point d'entrée ─────────────────────────────────────────────────────────

let signale = false;

/** Projette les Opérations d'un compte dans l'Agenda (voir l'en-tête). Lève sur une erreur technique (rejouable). */
export async function projectAccountOperations(accountId: number, opts: ProjectionRunOptions = {}): Promise<ProjectionRunResult> {
  const res = vide();
  if (!Number.isInteger(accountId) || accountId <= 0) return res;
  if (!(await agendaFunctionalColumnsReady())) {
    if (!signale) {
      signale = true;
      console.error('[t4-projection] colonnes 0223 absentes : projection des Opérations dans l\'agenda suspendue.');
    }
    return { ...res, skipped: 'COLUMNS_MISSING' };
  }
  // Lot 83A (C-Q10) : aucun traitement métier pour un compte non éligible (essai échu, lecture
  // seule, suspendu…) — fonction d'éligibilité unique (82A) ; une simulation n'écrit rien.
  if (!opts.dryRun) {
    const { isAccountProcessingEligible } = await import('@/services/account/processing-eligibility');
    if (!(await isAccountProcessingEligible(accountId))) return { ...res, skipped: 'ACCOUNT_INELIGIBLE' };
  }
  const beforeWrite = opts.beforeWrite ?? (() => undefined);
  const today = opts.today ?? todayUtc();
  const correlationId = opts.correlationId ?? null;

  if (opts.all) {
    // Lot 54D (E07) : passage COMPLET par pages sur curseur stable, jusqu'à
    // épuisement. Interrompu (garde), le travail est rejoué : les pages déjà
    // projetées n'écrivent plus rien (idempotence), rien n'est omis.
    if (!opts.dryRun) await cleanupOrphans(accountId, res, beforeWrite);
    res.pages = 0;
    res.lastOperationId = null;
    let curseur = 0;
    for (;;) {
      const page = await projectableIdsPage(accountId, curseur, opts.pageSize ?? PROJECTION_PAGE_SIZE);
      if (!page.length) break;
      await projectIds(accountId, page, res, { ...opts, beforeWrite, today, correlationId });
      res.pages++;
      curseur = page[page.length - 1];
      res.lastOperationId = curseur;
      if (page.length < (opts.pageSize ?? PROJECTION_PAGE_SIZE)) break;
    }
  } else {
    const ids = await canonicalIds(accountId, opts.operationIds ?? []);
    if (!ids.length) return res;
    await projectIds(accountId, ids, res, { ...opts, beforeWrite, today, correlationId });
  }
  if (res.changes > 0) {
    console.info(JSON.stringify({ event: 't4.operation_projection', accountId, correlationId, ...res }));
  }
  return res;
}

/** Projette un lot d'Opérations (identifiants canoniques) — corps commun aux deux modes. */
async function projectIds(
  accountId: number, ids: readonly number[], res: ProjectionRunResult,
  o: ProjectionRunOptions & { beforeWrite: (w: string) => Promise<void> | void; today: string; correlationId: string | null },
): Promise<void> {
  const { beforeWrite, today, correlationId } = o;
  const opts = o;
  const ops = await loadOperationSnapshots(accountId, ids);
  const linked = await loadLinkedItems(accountId, ops.map((o) => o.id));
  const suppressions = await loadSuppressions(ops.map((o) => o.id));
  const retraits = await loadPrincipalWithdrawals(accountId, ops.map((o) => o.id));
  // Lot 87B (CODE-03, CODE-11) : rôles donnés par la dernière décision T4 appliquée (mémoire de convergence).
  const { loadT4Roles } = await import('../semantic/store');
  const rolesT4 = await loadT4Roles(pgClient, accountId, ops.map((o) => o.id));
  const actifs = ops.filter((o) => o.active);
  const candidates = await loadCandidates(accountId, actifs.flatMap((o) => o.assetIds), actifs.flatMap((o) => o.documentFileIds));
  await markCoveringOperations(accountId, [...linked, ...candidates]);
  const cards = await loadStatusCardItems(accountId, [...linked, ...candidates].map((i) => i.id));
  // Lot 76H : un élément lié à une Opération INACTIVE (fusionnée, invalidée)
  // reste disponible pour la canonique dans le même passage (représentation
  // cohérente après fusion) ; son détachement est gardé (`detachItem`).
  const taken = new Set<number>(linked.filter((i) => i.linkedOperationActive).map((i) => i.id));
  const forcer = new Set(opts.forceCreateOperationIds ?? []);
  // Lot 53 (D14) : rapprochements incertains → carte « À traiter » (candidats, provenance).
  const besoins: import('@/services/to-process/agenda-projection-cards').AgendaProjectionCardNeed[] = [];
  // Lot 83A (§11.5 – §11.8) : éléments créés sans date, ou dont la date a été posée / retirée.
  const dateCards = new Set<number>();

  for (const op of ops) {
    res.operations++;
    const decision = decideProjection(op, today);
    const plan = planOperationProjection({
      op,
      decision,
      linked: linked.filter((i) => i.businessOperationId === op.id),
      suppressedKeys: suppressions.get(op.id) ?? new Set(),
      candidates,
      taken,
      statusCardItems: cards,
      forceCreate: forcer.has(op.id),
      principalWithdrawn: retraits.has(op.id),
      t4Roles: rolesT4.get(op.id),
    });
    for (const action of plan) {
      if (action.kind === 'LINK') taken.add(action.itemId);
      // Lot 87B : une demande de décision T4 ne RÉSERVE aucun élément (rien n'est rattaché) : une autre Opération du
      // même document les voit encore comme candidats (et s'abstient de même) — jamais une projection en doublon.
      if (action.kind === 'ABSTAIN' && action.candidates?.length && action.key && decision.kind === 'PROJECT' && op.assetIds.length) {
        besoins.push({
          operationId: op.id, key: action.key, assetId: op.assetIds[0],
          desired: { title: decision.desired.title, date: decision.desired.date, typeCode: op.typeCode },
          candidates: action.candidates, fileIds: op.documentFileIds,
        });
      }
      if (opts.dryRun) {
        if (action.kind === 'REPRESENTATION_REQUIRED') (res.representationRequired ??= []).push({ operationId: op.id, itemIds: action.itemIds, reason: action.reason });
        continue;
      }
      const role = decision.kind === 'PROJECT' ? projectionRoleOf(decision.desired.key) : 'RELATED';
      const created = await applyAction(op, action, res, { beforeWrite, correlationId, runId: opts.runId ?? null, role, dateCards });
      if (created !== null) taken.add(created);
    }
    // Lot 82D (CDC v5 §7.1, P4) : documents de l'Opération propagés vers son principal (idempotent) —
    // seulement pour une Opération qui a (ou vient de recevoir) des éléments d'agenda.
    const representee = linked.some((i) => i.businessOperationId === op.id)
      || plan.some((a) => a.kind === 'CREATE' || a.kind === 'LINK' || a.kind === 'ROLE');
    if (!opts.dryRun && representee) {
      const { recomputePrincipal } = await import('../grouping/service');
      const r = await grouping(accountId, correlationId, (ctx) => recomputePrincipal(ctx, op.id));
      if (r.added + r.removed > 0) {
        res.principalLinks = (res.principalLinks ?? 0) + r.added + r.removed;
        res.changes++;
      }
    }
    if (opts.dryRun && plan.length) {
      (res.plans ??= []).push({ operationId: op.id, typeCode: op.typeCode, decision: decision.kind === 'PROJECT' ? 'PROJECT' : decision.reason, actions: plan });
    }
  }
  if (opts.dryRun) return;
  {
    const { syncAgendaProjectionCards } = await import('@/services/to-process/agenda-projection-cards');
    const r = await syncAgendaProjectionCards(accountId, besoins, ops.map((x) => x.id));
    res.matchCards = (res.matchCards ?? 0) + r.created + r.updated;
  }
  await refreshDateCards(accountId, [...dateCards], res, correlationId);
}

/**
 * Lot 83A (CDC v5 §11.5 – §11.8, AC17, AC19, AC20) — carte « À traiter » de
 * date EXISTANTE (DATA-AGENDA-DATE, producteur unique `produceAgendaActions`)
 * réévaluée immédiatement pour les éléments que la projection vient de créer
 * sans date ou dont elle a posé / retiré la date : question (ou arbitrage des
 * dates contradictoires de T3) pour un principal sans date, fermeture
 * d'elle-même quand la date est posée. Aucun nouveau type de carte. Ne fait
 * jamais échouer la projection : le balayage horaire du producteur reste le filet.
 */
async function refreshDateCards(accountId: number, ids: number[], res: ProjectionRunResult, correlationId: string | null): Promise<void> {
  if (!ids.length) return;
  try {
    const { produceAgendaActions } = await import('@/services/to-process/producers.service');
    await produceAgendaActions(accountId, { trigger: 'ANALYSIS', only: ids, runRef: correlationId });
    res.dateCards = (res.dateCards ?? 0) + ids.length;
  } catch (e) {
    console.error(`[t4-projection] carte de date (compte ${accountId}) :`, (e as Error).message);
  }
}

// ── Suppression utilisateur mémorisée (C16.1, F-146) ───────────────────────

/**
 * À appeler DANS la transaction qui supprime l'élément `itemId` à la demande
 * de l'utilisateur. Un élément qui représente une Opération (projeté, ou lié
 * par rapprochement / formulaire Sinistre) : la clé de projection est
 * mémorisée — la projection ne le recréera ni ne liera un autre élément à sa
 * place. Rend l'Opération concernée (ou null). L'Opération n'est jamais
 * invalidée par ce geste (C16.1).
 */
export async function recordAgendaProjectionSuppression(
  tx: Executor, p: { accountId: number; itemId: number; userId: number | null },
): Promise<{ operationId: number; key: string } | null> {
  const [i] = await rows(tx, sql`
    SELECT i.business_operation_id, i.projection_origin, ${await agendaFunctionalColumnsReady() ? sql`i.functional_key` : sql`NULL::text`} AS functional_key,
           o.account_id AS op_account, o.type_code, o.end_date::text AS end_date, cd.effective_to::text AS effective_to
      FROM agenda_items i
      JOIN business_operations o ON o.id = i.business_operation_id
      LEFT JOIN business_operation_contract_details cd ON cd.operation_id = o.id
     WHERE i.id = ${p.itemId} AND i.account_id = ${p.accountId}`);
  if (!i || Number(i.op_account) !== p.accountId) return null;
  const operationId = Number(i.business_operation_id);
  const parsed = i.projection_origin === PROJECTION_ORIGIN ? parseProjectionFunctionalKey(txt(i.functional_key)) : null;
  const key = parsed && parsed.operationId === operationId
    ? parsed.key
    : projectionKeyOf({ typeCode: txt(i.type_code) as BusinessOperationTypeCode | null, contractEffectiveTo: txt(i.effective_to) });
  if (!key) return null;
  await tx.execute(sql`
    INSERT INTO business_operation_projection_suppressions (account_id, operation_id, projection_kind, projection_key, user_id)
    VALUES (${p.accountId}, ${operationId}, ${PROJECTION_KIND_AGENDA}, ${key}, ${p.userId})
    ON CONFLICT (operation_id, projection_kind, projection_key) DO NOTHING`);
  return { operationId, key };
}

// ── Lot 87B : garde T4 « événement déjà représenté par une Opération » RETIRÉE ─
//
// `findOperationAgendaEquivalent` empêchait T4 de créer l'événement d'un document
// quand un élément lié à une Opération existait sur le même bien à ±3 jours (même
// document source ou même type métier) — une FUSION décidée par le code (CODE-04 :
// même bien + catégorie + date proche). Désormais T4 crée l'événement de son
// document ; la projection rattache l'unique représentation par provenance, cède sa
// propre projection technique, ou demande la décision T4 multi-événements
// (`REPRESENTATION_REQUIRED`) quand plusieurs représentations sont possibles.

/**
 * Lot 76H (§3.3) — un élément automatique vient d'être créé depuis le document
 * `sourceFileId` : si ce document prouve une intervention ACTIVE (lot 87B : ou un
 * sinistre, un achat, une cession), la
 * projection de cette Opération est demandée (file durable existante,
 * dédoublonnée par compte) pour faire converger les représentations créées
 * avant, pendant ou après la consolidation T3 — quel que soit l'ordre
 * T1 / T3 / T4. Ne lève jamais. Rend les Opérations concernées.
 */
export async function requestProjectionForDocument(accountId: number, sourceFileId: number | null, correlationId?: string): Promise<number[]> {
  try {
    if (!sourceFileId || !Number.isInteger(accountId) || accountId <= 0) return [];
    const r = await rows<{ id: string }>(db, sql`
      SELECT DISTINCT o.id FROM business_operation_sources s
        JOIN business_operations o ON o.id = s.operation_id AND o.account_id = s.account_id
       WHERE s.account_id = ${accountId} AND s.active AND s.source_kind = 'DOCUMENT' AND s.source_entity_key = ${String(sourceFileId)}
         AND o.type_code IN ('INTERVENTION', 'CLAIM', 'ACQUISITION', 'DISPOSAL') AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL`);
    const ids = r.map((x) => Number(x.id));
    if (!ids.length) return [];
    const { requestAgendaProjection } = await import('./queue');
    await requestAgendaProjection(accountId, { operationIds: ids, correlationId: correlationId ?? `t4-document:${sourceFileId}` });
    return ids;
  } catch (e) {
    console.error(`[t4-projection] convergence après T4 (document ${sourceFileId}) non demandée :`, (e as Error).message);
    return [];
  }
}

// Lot 83E (C-Q9) : `listAccountsNeedingProjection` (sélection du balayage
// horaire de convergence, retiré) est supprimée — la convergence est
// contrôlée par COH-AGENDA-OPERATION-PROJECTION / -ORPHANS (registre de
// cohérence), qui appellent `projectAccountOperations` (simulation puis
// application).
