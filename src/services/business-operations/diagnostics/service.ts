/**
 * OperationDiagnosticsService — BO read-only, métriques, anomalies (lot 47A,
 * O9 — CDC Opérations V1 C21, C26.1, C26.2, B23, ch. 21 ; décisions PO Q8, Q9).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * AUCUNE ÉCRITURE POSSIBLE
 *
 * Chaque appel s'exécute dans UNE transaction `READ ONLY` (connexion du pool,
 * `SET LOCAL statement_timeout`) : une requête d'écriture y serait refusée par
 * PostgreSQL lui-même (25006). Le service n'expose que des lectures ; les
 * routes BO qui l'appellent n'exportent que GET.
 *
 * REQUÊTES BORNÉES ET INDEXÉES
 *
 *   · listes paginées (25 par défaut, 100 au plus), tri stable `created_at,
 *     id` (index 0325 `(created_at)` et `(account_id, created_at)`) ;
 *   · détail : listes d'AFFICHAGE bornées à `DETAIL_LIMIT` lignes (écran),
 *     toutes par l'index de l'Opération (`operation_id`) ; une liste tronquée
 *     à l'écran porte son total réel (`listTotals`) — lot 81C : les mêmes
 *     requêtes, SANS borne, alimentent les exports (`OPERATION_DETAIL_LISTS`,
 *     « Données du compte » › Opération : consultation paginée et export
 *     intégral) ;
 *   · indicateurs : période d'au plus 366 jours (index 0325 sur les dates
 *     d'événement), état courant par les index partiels « actifs » ;
 *   · anomalies dures : décompte + échantillon de 20 (fenêtre `count(*) OVER
 *     ()`), parcours hiérarchique borné à 12 niveaux.
 *
 * Isolation : le BO voit tous les comptes (droits administrateur, C25) ; un
 * filtre compte borne chaque requête. Aucun nom de fichier, aucun IBAN, aucun
 * texte libre de sinistre : seulement ce que le BO montre déjà.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { processingEligibleSql } from '@/services/account/processing-eligibility';
import {
  CORRECTION_PROCEDURE, DETAIL_LIMIT, DIAG_ANOMALY_SAMPLE, HARD_ANOMALY_CODES, HARD_ANOMALY_LABELS, INDICATORS,
  aiRunLabel, explainReason, reconciliationView, indicativeNetCents, maskSensitive, pct, principalDate, toM3ProgressView, typeLabel,
  type DiagPeriod, type HardAnomalyCode, type HardAnomalyResult, type HardAnomalySample, type HoldListFilters,
  type IndicatorDefinition, type IndicatorKey, type OperationListFilters,
} from './model';
import type { BusinessOperationStatus, BusinessOperationTypeCode, FinancialComponentKind } from '../model';
import { RESTORE_BLOCK_SQL } from '../consolidation/identity-review';
import { RESTORE_AUDIT_ACTION, RESTORE_AUDIT_TARGET, type RestoreSummary, type RestoreTrace } from '../identity-restore.model';

type Row = Record<string, unknown>;
export type DiagQuery = (sql: string, params?: unknown[]) => Promise<Row[]>;
/** Exécute un calcul dans une session de lecture (injectable : tests). */
export type DiagExecutor = <T>(fn: (q: DiagQuery) => Promise<T>) => Promise<T>;

/** Délai par requête, appliqué par PostgreSQL (annulation 57014). */
export const DIAG_STATEMENT_TIMEOUT_MS = 20_000;

/** Session par défaut : transaction READ ONLY + délai côté base. */
export const readOnlyExecutor: DiagExecutor = async <T>(fn: (q: DiagQuery) => Promise<T>): Promise<T> => {
  const { pgClient } = await import('@/db');
  const out = await pgClient.begin('read only', async (tx) => {
    await tx.unsafe(`SET LOCAL statement_timeout = ${DIAG_STATEMENT_TIMEOUT_MS}`);
    const q: DiagQuery = async (sql, params = []) => (await tx.unsafe(sql, params as never[])) as unknown as Row[];
    return [await fn(q)];
  });
  return (out as unknown as T[])[0];
};

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const int = (v: unknown): number => Number(v ?? 0);
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const ts = (v: unknown): string | null => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v));
const arr = <T = Row>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

/** Bornes SQL d'une période de jours civils Europe/Paris ($a, $b = jours). */
const FROM = (p: string) => `(${p}::date::timestamp AT TIME ZONE 'Europe/Paris')`;
const TO = (p: string) => `((${p}::date + 1)::timestamp AT TIME ZONE 'Europe/Paris')`;

// ── Types de réponse ────────────────────────────────────────────────────────

export interface OperationListItem {
  id: number;
  accountId: number;
  accountName: string | null;
  typeCode: BusinessOperationTypeCode | null;
  typeLabel: string;
  status: BusinessOperationStatus;
  label: string | null;
  assets: Array<{ id: number; name: string | null }>;
  equipments: Array<{ id: number; name: string | null }>;
  principalDate: string | null;
  netCents: number | null;
  netPartial: boolean;
  activeSourceCount: number;
  sourceCount: number;
  componentCount: number;
  lastReconciledAt: string | null;
  createdAt: string | null;
  invalidatedAt: string | null;
  invalidationReason: string | null;
  mergedIntoOperationId: number | null;
}

export interface OperationListResult {
  items: OperationListItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface HoldItem {
  id: number;
  accountId: number;
  accountName: string | null;
  fileId: number;
  candidateKey: string;
  confidence: string;
  established: boolean;
  typeHint: string | null;
  summary: string;
  outcome: string;
  reason: string | null;
  reasonLabel: string;
  operationId: number | null;
  proposedOperationIds: number[];
  processedAt: string | null;
  createdAt: string | null;
  /** Lot 53 (D7) : examen M3 progressif — lot courant, examinées / restantes, report et reprise. */
  m3?: import('./model').M3ProgressView | null;
  /** Lot 54D (E01) : erreur technique T3 — tentatives, prochaine reprise automatique, cause et job. */
  technicalError?: { attempts: number; retryAt: string | null; exhausted: boolean; code: string | null; message: string | null; jobId: number | null; at: string | null } | null;
  /** Lot 54D (E05) : cartes « À traiter » du document en attente de resynchronisation. */
  cardsPending?: boolean;
}

export interface HoldListResult {
  items: HoldItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  /** Motifs présents (filtre), avec leur décompte. */
  reasons: Array<{ outcome: string; reason: string | null; label: string; count: number }>;
  /** Candidats établis encore en file T3 (pas encore consolidés). */
  pendingT3: number;
}

export interface LastT3Pass {
  jobId: number;
  status: string;
  origin: string | null;
  triggerCode: string | null;
  businessResult: string | null;
  createdAt: string | null;
  finishedAt: string | null;
  attempts: number;
  lastError: string | null;
  correlationId: string | null;
}

export interface OperationDetail {
  operation: OperationListItem & {
    provider: string | null;
    plannedDate: string | null;
    startDate: string | null;
    realizedDate: string | null;
    endDate: string | null;
    closedAt: string | null;
    updatedAt: string | null;
    version: number;
    active: boolean;
  };
  /** Opération canonique quand celle-ci a été fusionnée (redirection, F-185). */
  canonicalOperationId: number | null;
  assetLinks: Row[];
  equipmentLinks: Row[];
  sources: Row[];
  components: Row[];
  references: Row[];
  contractDetails: Row | null;
  financingDetails: Row | null;
  claimDetails: Row | null;
  mergedFrom: Row[];
  history: Row[];
  matchDecisions: Row[];
  agendaItems: Row[];
  projectionSuppressions: Row[];
  candidates: Row[];
  /**
   * Lot 81C — listes tronquées À L'ÉCRAN (`displayLimit` lignes) : total réel.
   * Consultation paginée et export intégral : « Données du compte » › Opération.
   */
  listTotals?: Partial<Record<OperationDetailList, number>>;
  displayLimit?: number;
  /** Lot 78A (§5, §6) : contrôles d'identité économique (séparations, doutes, doublons) concernant l'Opération. */
  identityReviews?: Row[];
  /** Lot 78A (§2C, §6) : provenance des valeurs conservées et contradictions d'attributs. */
  attributeProvenance?: Row | null;
  lastT3Pass: LastT3Pass | null;
  procedure: string;
  /** Lot 55B (E) : réconciliation à jour, en attente ou bloquée (jamais « à jour » si un traitement reste dû). */
  reconciliation: import('./model').ReconciliationView;
  /** Lot 55B (B) : branche IA OPERATION_MATCH présente dans la version EFFECTIVE du prompt maître T3. */
  operationMatchBranch?: { available: boolean; version: string | null };
}

export interface IndicatorResult extends IndicatorDefinition {
  value: Record<string, unknown>;
}

export interface IndicatorsReport {
  period: DiagPeriod;
  accountId: number | null;
  computedAt: string;
  indicators: IndicatorResult[];
  anomalies: HardAnomalyResult[];
  hardAnomalyTotal: number;
  procedure: string;
}

// ── Liste ───────────────────────────────────────────────────────────────────

function listWhere(f: OperationListFilters): { where: string; params: unknown[] } {
  const params: unknown[] = [];
  const conds: string[] = [];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  if (f.accountId) conds.push(`o.account_id = ${p(f.accountId)}`);
  if (f.type === 'NULL') conds.push('o.type_code IS NULL');
  else if (f.type) conds.push(`o.type_code = ${p(f.type)}`);
  if (f.status) conds.push(`o.status = ${p(f.status)}`);
  if (f.state === 'active') conds.push('o.invalidated_at IS NULL');
  if (f.state === 'invalidated') conds.push('o.invalidated_at IS NOT NULL AND o.merged_into_operation_id IS NULL');
  if (f.state === 'merged') conds.push('o.merged_into_operation_id IS NOT NULL');
  if (f.withoutAsset) {
    conds.push(`o.invalidated_at IS NULL AND NOT EXISTS (SELECT 1 FROM business_operation_asset_links al
                 WHERE al.operation_id = o.id AND al.active)`);
  }
  if (f.withoutSource) {
    conds.push('NOT EXISTS (SELECT 1 FROM business_operation_sources s WHERE s.operation_id = o.id AND s.active)');
  }
  if (f.from) conds.push(`o.created_at >= ${FROM(p(f.from))}`);
  if (f.to) conds.push(`o.created_at < ${TO(p(f.to))}`);
  // Lot 75N : recherche de la fiche compte (motif « contient », jokers neutralisés).
  if (f.q) {
    const pat = p(`%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    const idCond = /^\d{1,9}$/.test(f.q) ? ` OR o.id = ${p(Number(f.q))}` : '';
    conds.push(`(o.technical_label ILIKE ${pat} OR o.provider ILIKE ${pat} OR o.type_code ILIKE ${pat}${idCond})`);
  }
  return { where: conds.length ? `WHERE ${conds.join(' AND ')}` : '', params };
}

/** Colonnes communes d'une ligne de liste (sous-requêtes par l'index de l'Opération). */
const LIST_COLUMNS = `
  o.id, o.account_id, acc.name AS account_name, o.type_code, o.status, o.technical_label,
  o.planned_date::text AS planned_date, o.start_date::text AS start_date, o.realized_date::text AS realized_date,
  o.end_date::text AS end_date, o.invalidated_at, o.invalidation_reason, o.merged_into_operation_id,
  o.last_reconciled_at, o.created_at,
  (SELECT count(*) FROM business_operation_sources s WHERE s.operation_id = o.id AND s.active)::int AS active_sources,
  (SELECT count(*) FROM business_operation_sources s WHERE s.operation_id = o.id)::int AS all_sources,
  (SELECT count(*) FROM business_operation_financial_components c WHERE c.operation_id = o.id AND c.active)::int AS components,
  (SELECT coalesce(json_agg(json_build_object('id', a.id, 'name', a.name) ORDER BY al.link_role DESC, a.id), '[]'::json)
     FROM business_operation_asset_links al JOIN assets a ON a.id = al.asset_id
    WHERE al.operation_id = o.id AND al.active) AS assets,
  (SELECT coalesce(json_agg(json_build_object('id', e.id, 'name', e.name) ORDER BY e.id), '[]'::json)
     FROM business_operation_equipment_links el JOIN equipments e ON e.id = el.equipment_id
    WHERE el.operation_id = o.id AND el.active) AS equipments,
  (SELECT coalesce(json_agg(json_build_object('kind', c.kind, 'amountMinor', c.amount_minor, 'currency', c.currency,
                                               'amountEurCents', c.amount_eur_cents)), '[]'::json)
     FROM business_operation_financial_components c WHERE c.operation_id = o.id AND c.active) AS money`;

function toListItem(r: Row): OperationListItem {
  const money = arr<{ kind: FinancialComponentKind; amountMinor: number; currency: string; amountEurCents: number | null }>(r.money)
    .map((m) => ({ ...m, amountMinor: Number(m.amountMinor), amountEurCents: num(m.amountEurCents), active: true }));
  const net = indicativeNetCents(money);
  const dates = { realizedDate: str(r.realized_date), startDate: str(r.start_date), plannedDate: str(r.planned_date), endDate: str(r.end_date) };
  return {
    id: Number(r.id),
    accountId: Number(r.account_id),
    accountName: str(r.account_name),
    typeCode: (r.type_code as BusinessOperationTypeCode | null) ?? null,
    typeLabel: typeLabel(str(r.type_code)),
    status: r.status as BusinessOperationStatus,
    label: str(r.technical_label),
    assets: arr<{ id: number; name: string | null }>(r.assets).map((a) => ({ id: Number(a.id), name: a.name ?? null })),
    equipments: arr<{ id: number; name: string | null }>(r.equipments).map((e) => ({ id: Number(e.id), name: e.name ?? null })),
    principalDate: principalDate(dates),
    netCents: net.cents,
    netPartial: net.partial,
    activeSourceCount: int(r.active_sources),
    sourceCount: int(r.all_sources),
    componentCount: int(r.components),
    lastReconciledAt: ts(r.last_reconciled_at),
    createdAt: ts(r.created_at),
    invalidatedAt: ts(r.invalidated_at),
    invalidationReason: str(r.invalidation_reason),
    mergedIntoOperationId: num(r.merged_into_operation_id),
  };
}

// ── Lot 79A : rétablissement d'une séparation (bouton BO) ───────────────────

/** Ligne du journal d'identité → vue BO : `restore` (séparation encore effective) et `restoredBy` (trace). */
export function identityReviewView(x: Row): Row {
  const { restore_block: bloque, restore_summary: resume, restore_current_operation_id: courante, restore_hints: indices,
    restored_by_admin_id: parId, restored_by_admin_email: parEmail, restored_at: le, restore_details: details, ...r } = x;
  let restore: RestoreSummary | null = null;
  if (r.kind === 'SEPARATED' && r.status === 'APPLIED' && bloque == null && r.file_id != null && r.candidate_key != null) {
    restore = {
      reviewId: Number(r.id), fileId: Number(r.file_id), candidateKey: String(r.candidate_key), summary: str(resume),
      originOperationId: Number(r.operation_id), currentOperationId: num(courante),
      amounts: (Array.isArray(indices) ? indices : []).flatMap((h: Row) => (h && Number.isFinite(Number(h.amountMinor))
        ? [{ role: String(h.role ?? ''), amountMinor: Number(h.amountMinor), currency: String(h.currency ?? 'EUR') }] : [])),
    };
  }
  let restoredBy: RestoreTrace | null = null;
  if (r.status === 'REVERTED') {
    let motif: string | null = null;
    try { motif = typeof details === 'string' ? str((JSON.parse(details) as Row).reason) : null; } catch { motif = null; }
    restoredBy = {
      adminId: num(parId) ?? num(r.resolved_by_admin_id), adminEmail: str(parEmail),
      at: ts(le) ?? ts(r.resolved_at), reason: motif,
    };
  }
  return { ...r, restore_block: bloque ?? null, restore, restoredBy };
}

// ── Anomalies dures (C26.2) ─────────────────────────────────────────────────

/** Filtre compte d'une requête d'anomalie : `$1` (nul = tous les comptes). */
const ACC = (col: string) => `($1::int IS NULL OR ${col} = $1::int)`;

/** Clé numérique d'une source (`source_entity_key`), sinon NULL (jamais d'erreur de conversion). */
const KEY = (col: string) => `(CASE WHEN ${col} ~ '^[0-9]{1,9}$' THEN ${col}::int END)`;

/**
 * Lot 81C — listes du détail d'une Opération, SANS borne : `$1` = Opération,
 * `$2` = compte (contrôle d'appartenance). Ordre total (identifiant en
 * départage). Le détail d'écran y ajoute `LIMIT DETAIL_LIMIT` ; les exports
 * (« Données du compte ») les lisent intégralement, par lots.
 */
export const OPERATION_DETAIL_LISTS = {
  assetLinks: { table: 'business_operation_asset_links', sql: `SELECT al.id, al.asset_id, a.name AS asset_name, a.deleted_at IS NOT NULL AS asset_deleted, al.link_role, al.authority,
                al.source_operation_source_id AS source_id, al.active, al.created_at, al.updated_at
           FROM business_operation_asset_links al LEFT JOIN assets a ON a.id = al.asset_id
          WHERE al.operation_id = $1 AND al.account_id = $2 ORDER BY al.active DESC, al.id` },
  equipmentLinks: { table: 'business_operation_equipment_links', sql: `SELECT el.id, el.equipment_id, e.name AS equipment_name, el.asset_id, el.authority,
                el.source_operation_source_id AS source_id, el.active, el.created_at
           FROM business_operation_equipment_links el LEFT JOIN equipments e ON e.id = el.equipment_id
          WHERE el.operation_id = $1 AND el.account_id = $2 ORDER BY el.active DESC, el.id` },
  sources: { table: 'business_operation_sources', sql: `SELECT s.id, s.source_kind, s.source_entity_key, s.source_version, s.source_role, s.locator, s.authority,
                s.confidence, s.match_method, s.match_reason, s.active, s.superseded_at, s.created_at,
                f.id AS file_id, f.document_type AS file_document_type, f.created_at AS file_created_at,
                f.deleted_at AS file_deleted_at, f.asset_id AS file_asset_id
           FROM business_operation_sources s
           LEFT JOIN asset_files f ON s.source_kind = 'DOCUMENT' AND f.id = ${KEY('s.source_entity_key')} AND f.account_id = s.account_id
          WHERE s.operation_id = $1 AND s.account_id = $2 ORDER BY s.active DESC, s.created_at, s.id` },
  components: { table: 'business_operation_financial_components', sql: `SELECT c.id, c.kind, c.amount_minor, c.currency, c.amount_eur_cents, c.economic_date::text AS economic_date,
                c.period_start::text AS period_start, c.period_end::text AS period_end, c.target_asset_id, c.target_equipment_id,
                c.label, c.fingerprint, c.active, c.superseded_at, c.created_at,
                (SELECT coalesce(json_agg(json_build_object('sourceId', cs.operation_source_id, 'evidenceRole', cs.evidence_role,
                                                             'isPrimary', cs.is_primary, 'sourceActive', s.active,
                                                             -- Lot 78A : indices T1 et faits qui justifient le montant (0609).
                                                             'evidence', to_jsonb(cs) -> 'evidence')
                                          ORDER BY cs.is_primary DESC, cs.operation_source_id), '[]'::json)
                   FROM business_operation_financial_component_sources cs
                   LEFT JOIN business_operation_sources s ON s.id = cs.operation_source_id
                  WHERE cs.component_id = c.id) AS sources
           FROM business_operation_financial_components c
          WHERE c.operation_id = $1 AND c.account_id = $2 ORDER BY c.active DESC, c.id` },
  references: { table: 'business_operation_references', sql: `SELECT id, reference_kind, reference_value, normalized_value, source_id, active, superseded_at, created_at
           FROM business_operation_references WHERE operation_id = $1 AND $2::int IS NOT NULL ORDER BY active DESC, id` },
  mergedFrom: { table: 'business_operations', sql: `SELECT id, type_code, status, technical_label, invalidated_at, invalidation_reason FROM business_operations
          WHERE merged_into_operation_id = $1 AND account_id = $2 ORDER BY id` },
  history: { table: 'business_operation_history', sql: `SELECT id, event_type, reason_code, source_id, actor_user_id, before_json, after_json, correlation_id, created_at
           FROM business_operation_history WHERE operation_id = $1 AND $2::int IS NOT NULL ORDER BY created_at DESC, id DESC` },
  matchDecisions: { table: 'business_operation_match_decisions', sql: `SELECT id, source_kind, source_entity_key, source_version, decision, origin, reason_code, active, created_at, updated_at
           FROM business_operation_match_decisions WHERE candidate_operation_id = $1 AND account_id = $2
          ORDER BY active DESC, id DESC` },
  // Lot 86C : provenance de chaque élément (projection d'une fin établie, T4 d'un document, champ métier, saisie).
  agendaItems: { table: 'agenda_items', sql: `SELECT id, title, start_date::text AS start_date, end_date::text AS end_date, projection_origin,
                projection_correlation_id, manual_status, to_jsonb(agenda_items) ->> 'functional_key' AS functional_key,
                to_jsonb(agenda_items) ->> 'business_type' AS business_type, is_automatic, is_automatic_modified, origin_type,
                origin_ref_type, origin_ref_id, origin_field_key, created_at
           FROM agenda_items WHERE business_operation_id = $1 AND account_id = $2 ORDER BY id` },
  projectionSuppressions: { table: 'business_operation_projection_suppressions', sql: `SELECT id, projection_kind, projection_key, user_id, created_at
           FROM business_operation_projection_suppressions WHERE operation_id = $1 AND $2::int IS NOT NULL ORDER BY id` },
  candidates: { table: 'document_operation_candidates', sql: `SELECT c.id, c.file_id, c.candidate_key, c.established, c.confidence, c.type_hint, c.status_hint, c.summary,
                c.status, c.trigger_code, c.t3_pending, c.t3_outcome, c.t3_reason, c.t3_operation_id, c.t3_processed_at,
                c.t3_detail, c.created_at, c.superseded_at
           FROM document_operation_candidates c
          WHERE c.account_id = $2
            AND (c.t3_operation_id = $1
                 OR c.file_id IN (SELECT ${KEY('s.source_entity_key')} FROM business_operation_sources s
                                   WHERE s.operation_id = $1 AND s.source_kind = 'DOCUMENT')
                 -- Lot 55B (E) : documents qui attendent une décision sur CETTE Opération.
                 OR (c.status = 'ACTIVE' AND (COALESCE(c.t3_detail->'plausible', '[]'::jsonb) @> to_jsonb($1::bigint)
                      OR COALESCE(c.t3_detail->'arbitration'->'operationIds', '[]'::jsonb) @> to_jsonb($1::bigint))))
          ORDER BY c.created_at DESC, c.id DESC` },
} as const satisfies Record<string, { table: string; sql: string }>;
export type OperationDetailList = keyof typeof OPERATION_DETAIL_LISTS;

/** Lot 78A : anomalies d'identité dont la table / colonne (0609) peut manquer — sondées avant exécution. */
const IDENTITY_ANOMALY_SQL: Readonly<Record<'IDENTITY_SUSPECT_ATTACHMENT' | 'IDENTITY_ATTRIBUTE_CONFLICT', { probe: string; sql: string }>> = {
  IDENTITY_SUSPECT_ATTACHMENT: {
    probe: `SELECT to_regclass('business_operation_identity_reviews') IS NOT NULL AS ok, $1::int AS compte`,
    sql: `
    SELECT r.account_id, r.operation_id, 'document #' || coalesce(r.file_id::text, '?') || ' (' || coalesce(r.candidate_key, '?') || ') : '
           || coalesce((SELECT string_agg(x, ' ') FROM jsonb_array_elements_text(r.signals) x), '') AS detail
      FROM business_operation_identity_reviews r
     WHERE r.kind = 'SUSPECT' AND r.status = 'OPEN' AND ${ACC('r.account_id')}`,
  },
  IDENTITY_ATTRIBUTE_CONFLICT: {
    probe: `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
                            AND table_name = 'business_operations' AND column_name = 'attribute_provenance') AS ok, $1::int AS compte`,
    sql: `
    SELECT o.account_id, o.id AS operation_id,
           (SELECT string_agg(c->>'field', ', ') FROM jsonb_array_elements(o.attribute_provenance->'conflicts') c) || ' contradictoires' AS detail
      FROM business_operations o
     WHERE o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL AND ${ACC('o.account_id')}
       AND jsonb_typeof(o.attribute_provenance->'conflicts') = 'array' AND jsonb_array_length(o.attribute_provenance->'conflicts') > 0`,
  },
};

const ANOMALY_SQL: Readonly<Record<Exclude<HardAnomalyCode, keyof typeof IDENTITY_ANOMALY_SQL>, string>> = {
  ACTIVE_OPERATION_WITHOUT_SOURCE: `
    SELECT o.account_id, o.id AS operation_id, 'type ' || coalesce(o.type_code, 'non qualifié') AS detail
      FROM business_operations o
     WHERE o.invalidated_at IS NULL AND ${ACC('o.account_id')}
       AND NOT EXISTS (SELECT 1 FROM business_operation_sources s WHERE s.operation_id = o.id AND s.active)`,
  // Composante ACTIVE d'une Opération ACTIVE : une Opération invalidée garde
  // ses composantes en l'état (elles ne sont plus consommées).
  ACTIVE_COMPONENT_WITHOUT_SOURCE: `
    SELECT c.account_id, c.operation_id, 'composante #' || c.id || ' (' || c.kind || ')' AS detail
      FROM business_operation_financial_components c
      JOIN business_operations o ON o.id = c.operation_id AND o.invalidated_at IS NULL
     WHERE c.active AND ${ACC('c.account_id')}
       AND NOT EXISTS (SELECT 1 FROM business_operation_financial_component_sources cs
                         JOIN business_operation_sources s ON s.id = cs.operation_source_id AND s.active
                        WHERE cs.component_id = c.id)`,
  // Toute référence vers une ligne d'un autre compte. Les liens Opération →
  // Opération et Opération → table fille sont déjà impossibles en SQL (clé
  // composée) ; restent les clés simples vers biens, équipements, fichiers,
  // agenda et les références croisées entre Opérations sans account_id.
  CROSS_ACCOUNT_LINK: `
    SELECT al.account_id, al.operation_id, 'bien #' || a.id || ' du compte ' || coalesce(a.account_id::text, '?') AS detail
      FROM business_operation_asset_links al JOIN assets a ON a.id = al.asset_id
     WHERE a.account_id IS DISTINCT FROM al.account_id AND ${ACC('al.account_id')}
    UNION ALL
    SELECT el.account_id, el.operation_id, 'équipement #' || e.id || ' (bien du compte ' || coalesce(ea.account_id::text, '?') || ')'
      FROM business_operation_equipment_links el
      JOIN equipments e ON e.id = el.equipment_id JOIN assets ea ON ea.id = e.asset_id JOIN assets la ON la.id = el.asset_id
     WHERE (ea.account_id IS DISTINCT FROM el.account_id OR la.account_id IS DISTINCT FROM el.account_id) AND ${ACC('el.account_id')}
    UNION ALL
    SELECT c.account_id, c.operation_id, 'composante #' || c.id || ' : bien cible #' || a.id || ' du compte ' || coalesce(a.account_id::text, '?')
      FROM business_operation_financial_components c JOIN assets a ON a.id = c.target_asset_id
     WHERE a.account_id IS DISTINCT FROM c.account_id AND ${ACC('c.account_id')}
    UNION ALL
    SELECT c.account_id, c.operation_id, 'composante #' || c.id || ' : équipement cible #' || e.id
      FROM business_operation_financial_components c JOIN equipments e ON e.id = c.target_equipment_id JOIN assets a ON a.id = e.asset_id
     WHERE a.account_id IS DISTINCT FROM c.account_id AND ${ACC('c.account_id')}
    UNION ALL
    SELECT c.account_id, c.operation_id, 'composante #' || c.id || ' : source #' || s.id || ' du compte ' || s.account_id
      FROM business_operation_financial_components c
      JOIN business_operation_financial_component_sources cs ON cs.component_id = c.id
      JOIN business_operation_sources s ON s.id = cs.operation_source_id
     WHERE s.account_id <> c.account_id AND ${ACC('c.account_id')}
    UNION ALL
    SELECT s.account_id, s.operation_id, 'source #' || s.id || ' : document #' || f.id || ' du compte ' || f.account_id
      FROM business_operation_sources s JOIN asset_files f ON f.id = ${KEY('s.source_entity_key')}
     WHERE s.source_kind = 'DOCUMENT' AND f.account_id <> s.account_id AND ${ACC('s.account_id')}
    UNION ALL
    SELECT s.account_id, s.operation_id, 'source #' || s.id || ' : bien #' || a.id || ' du compte ' || coalesce(a.account_id::text, '?')
      FROM business_operation_sources s JOIN assets a ON a.id = ${KEY('s.source_entity_key')}
     WHERE s.source_kind IN ('ASSET_DATA', 'CLAIM_FORM') AND a.account_id IS DISTINCT FROM s.account_id AND ${ACC('s.account_id')}
    UNION ALL
    SELECT s.account_id, s.operation_id, 'source #' || s.id || ' : événement d’agenda #' || ai.id || ' du compte ' || ai.account_id
      FROM business_operation_sources s JOIN agenda_items ai ON ai.id = ${KEY('s.source_entity_key')}
     WHERE s.source_kind = 'AGENDA' AND ai.account_id <> s.account_id AND ${ACC('s.account_id')}
    UNION ALL
    SELECT o.account_id, o.id, 'événement d’agenda #' || ai.id || ' du compte ' || ai.account_id
      FROM agenda_items ai JOIN business_operations o ON o.id = ai.business_operation_id
     WHERE ai.business_operation_id IS NOT NULL AND ai.account_id <> o.account_id AND ${ACC('o.account_id')}
    UNION ALL
    SELECT o.account_id, o.id, 'contrat d’assurance #' || k.id || ' du compte ' || k.account_id
      FROM business_operation_claim_details cd
      JOIN business_operations o ON o.id = cd.operation_id
      JOIN business_operations k ON k.id = cd.insurance_contract_operation_id
     WHERE k.account_id <> o.account_id AND ${ACC('o.account_id')}
    UNION ALL
    SELECT o.account_id, o.id, 'pièce de dommage : document #' || f.id || ' du compte ' || f.account_id
      FROM business_operation_claim_damage_documents dd
      JOIN business_operation_claim_damages d ON d.id = dd.damage_id
      JOIN business_operations o ON o.id = d.operation_id
      JOIN asset_files f ON f.id = dd.file_id
     WHERE f.account_id <> o.account_id AND ${ACC('o.account_id')}
    UNION ALL
    -- Lot 54 (SEC-06) : photos de dommage, événement historique du sinistre
    -- (lot 84A : actions et échanges de l'ancien modèle retirés avec leurs tables).
    SELECT o.account_id, o.id, 'photo de dommage #' || p.id || ' (bien du compte ' || coalesce(pa.account_id::text, '?') || ', fichier du compte ' || coalesce(pf.account_id::text, '?') || ')'
      FROM business_operation_claim_damage_photos dp
      JOIN business_operation_claim_damages d ON d.id = dp.damage_id
      JOIN business_operations o ON o.id = d.operation_id
      JOIN asset_photos p ON p.id = dp.photo_id JOIN assets pa ON pa.id = p.asset_id JOIN asset_files pf ON pf.id = p.file_id
     WHERE (pa.account_id IS DISTINCT FROM o.account_id OR pf.account_id IS DISTINCT FROM o.account_id) AND ${ACC('o.account_id')}
    UNION ALL
    SELECT o.account_id, o.id, 'sinistre : événement historique #' || ev.id || ' du compte ' || coalesce(ev.account_id::text, '?')
      FROM business_operation_claim_details cd
      JOIN business_operations o ON o.id = cd.operation_id
      JOIN events ev ON ev.id = cd.history_event_id
     WHERE ev.account_id IS DISTINCT FROM o.account_id AND ${ACC('o.account_id')}
    UNION ALL
    SELECT o.account_id, o.id, 'candidat T1 #' || c.id || ' du compte ' || c.account_id
      FROM document_operation_candidates c JOIN business_operations o ON o.id = c.t3_operation_id
     WHERE c.t3_operation_id IS NOT NULL AND c.account_id <> o.account_id AND ${ACC('o.account_id')}`,
  NEGATIVE_COMPONENT: `
    SELECT c.account_id, c.operation_id, 'composante #' || c.id || ' (' || c.kind || ') : ' || c.amount_minor || ' ' || c.currency AS detail
      FROM business_operation_financial_components c
     WHERE c.active AND (c.amount_minor < 0 OR c.amount_eur_cents < 0) AND ${ACC('c.account_id')}`,
  // Lot 54D (§4.5) : même indemnité (montant, devise) portée par deux composantes
  // actives d'un même sinistre (et de ses interventions) — déduction multiple.
  FIN_INDEMNITY_DUPLICATED: `
    SELECT o.account_id, o.id AS operation_id, count(*) || ' indemnités de ' || c.amount_minor || ' ' || trim(c.currency) AS detail
      FROM business_operation_financial_components c JOIN business_operations o ON o.id = c.operation_id
     WHERE c.active AND c.kind = 'INDEMNITY' AND o.type_code = 'CLAIM' AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
       AND ${ACC('c.account_id')}
     GROUP BY o.account_id, o.id, c.amount_minor, c.currency HAVING count(*) > 1`,
  // Lot 54D (E04, §4.5) : le capital n'est jamais un coût (53D, Q16).
  FIN_PRINCIPAL_AS_COST: `
    SELECT o.account_id, o.id AS operation_id, 'composante #' || c.id || ' = capital ' || fd.principal_amount_minor || ' ' || trim(fd.principal_currency) AS detail
      FROM business_operation_financial_components c
      JOIN business_operations o ON o.id = c.operation_id AND o.type_code = 'FINANCING' AND o.invalidated_at IS NULL
      JOIN business_operation_financing_details fd ON fd.operation_id = o.id
     WHERE c.active AND c.kind = 'REALIZED_COST' AND fd.principal_amount_minor IS NOT NULL
       AND c.amount_minor = fd.principal_amount_minor AND c.currency = fd.principal_currency AND ${ACC('c.account_id')}`,
  // Lot 54D (E01) : candidat en erreur technique dont les reprises bornées sont épuisées.
  T3_TECHNICAL_ERROR_EXHAUSTED: `
    SELECT c.account_id, c.t3_operation_id AS operation_id,
           'document #' || c.file_id || ' : ' || coalesce(c.t3_last_error->>'code', c.t3_reason) || ' (' || c.t3_error_attempts || ' tentatives)' AS detail
      FROM document_operation_candidates c
     WHERE c.status = 'ACTIVE' AND c.t3_reason LIKE 'TECHNICAL_ERROR:%' AND c.t3_retry_at IS NULL AND c.t3_error_attempts > 0
       AND ${ACC('c.account_id')}`,
  // OTHER n'est jamais un repli (P18, C7.7) : il doit être porté par un
  // candidat T1 « OTHER » certain ou par une décision utilisateur.
  OTHER_AS_FALLBACK: `
    SELECT o.account_id, o.id AS operation_id, 'OTHER sans candidat T1 « OTHER » certain ni source utilisateur' AS detail
      FROM business_operations o
     WHERE o.invalidated_at IS NULL AND o.type_code = 'OTHER' AND ${ACC('o.account_id')}
       AND NOT EXISTS (SELECT 1 FROM business_operation_sources s WHERE s.operation_id = o.id AND s.authority = 'USER')
       AND NOT EXISTS (SELECT 1 FROM document_operation_candidates c
                        WHERE c.account_id = o.account_id AND c.type_hint = 'OTHER' AND c.confidence = 'certain'
                          AND (c.t3_operation_id = o.id
                               OR c.file_id IN (SELECT ${KEY('s.source_entity_key')} FROM business_operation_sources s
                                                 WHERE s.operation_id = o.id AND s.source_kind = 'DOCUMENT')))`,
};

async function sampled(q: DiagQuery, inner: string, accountId: number | null, eligibleOnly = false): Promise<{ count: number; samples: HardAnomalySample[] }> {
  const rows = await q(
    `SELECT x.account_id, x.operation_id, x.detail, count(*) OVER () AS total
       FROM (${inner}) x(account_id, operation_id, detail)
      ${eligibleOnly ? `WHERE ${processingEligibleSql('x.account_id')}` : ''}
      ORDER BY x.account_id, x.operation_id NULLS LAST LIMIT ${DIAG_ANOMALY_SAMPLE}`,
    [accountId],
  );
  return {
    count: rows.length ? int(rows[0].total) : 0,
    samples: rows.map((r) => ({ accountId: Number(r.account_id), operationId: num(r.operation_id), detail: String(r.detail ?? '') })),
  };
}

function result(code: HardAnomalyCode, count: number, samples: HardAnomalySample[]): HardAnomalyResult {
  return {
    code, label: HARD_ANOMALY_LABELS[code], count,
    accountIds: [...new Set(samples.map((s) => s.accountId))].slice(0, DIAG_ANOMALY_SAMPLE),
    samples: maskSensitive(samples),
  };
}

/**
 * `eligibleOnly` (lot 82A, C-Q10) : contrôle PLANIFIÉ — comptes éligibles
 * seulement (« aucun contrôle, même en simple constat, sur un compte non
 * actif, suspendu ou en lecture seule »). Les écrans BO (consultation par
 * l'administrateur) gardent la vue complète.
 */
async function detectHardAnomalies(q: DiagQuery, accountId: number | null, eligibleOnly = false): Promise<HardAnomalyResult[]> {
  const out = new Map<HardAnomalyCode, HardAnomalyResult>();
  for (const [code, inner] of Object.entries(ANOMALY_SQL) as Array<[HardAnomalyCode, string]>) {
    const r = await sampled(q, inner, accountId, eligibleOnly);
    out.set(code, result(code, r.count, r.samples));
  }
  for (const [code, x] of Object.entries(IDENTITY_ANOMALY_SQL) as Array<[HardAnomalyCode, { probe: string; sql: string }]>) {
    const [p] = await q(x.probe, [accountId]);
    const r = p?.ok ? await sampled(q, x.sql, accountId, eligibleOnly) : { count: 0, samples: [] };
    out.set(code, result(code, r.count, r.samples));
  }
  return HARD_ANOMALY_CODES.map((c) => out.get(c)!);
}

// ── Service ────────────────────────────────────────────────────────────────

export class OperationDiagnosticsService {
  constructor(private readonly exec: DiagExecutor = readOnlyExecutor) {}

  /** Liste filtrable et paginée (C26.1, B23). */
  async list(f: OperationListFilters): Promise<OperationListResult> {
    const { where, params } = listWhere(f);
    return this.exec(async (q) => {
      const [{ n }] = await q(`SELECT count(*)::int AS n FROM business_operations o ${where}`, params);
      const offset = (f.page - 1) * f.pageSize;
      const rows = await q(
        `SELECT ${LIST_COLUMNS}
           FROM business_operations o JOIN accounts acc ON acc.id = o.account_id
           ${where}
          ORDER BY o.created_at ${f.dir === 'asc' ? 'ASC' : 'DESC'}, o.id ${f.dir === 'asc' ? 'ASC' : 'DESC'}
          LIMIT ${f.pageSize} OFFSET ${offset}`,
        params,
      );
      const total = int(n);
      return {
        items: maskSensitive(rows.map(toListItem)),
        total, page: f.page, pageSize: f.pageSize, totalPages: Math.max(1, Math.ceil(total / f.pageSize)),
      };
    });
  }

  /** Candidats T1 en attente (HOLD) ou en arbitrage, avec leur motif (C5, C26.1). */
  async holds(f: HoldListFilters): Promise<HoldListResult> {
    const params: unknown[] = [];
    const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
    const base = [`c.status = 'ACTIVE'`, `c.t3_outcome IN ('HOLD_UNRESOLVED', 'ARBITRATION_REQUIRED')`];
    if (f.accountId) base.push(`c.account_id = ${p(f.accountId)}`);
    const baseParams = [...params];
    const conds = [...base];
    if (f.outcome) conds.push(`c.t3_outcome = ${p(f.outcome)}`);
    if (f.reason === 'TECHNICAL_ERROR') conds.push(`c.t3_reason LIKE 'TECHNICAL_ERROR:%'`);
    else if (f.reason) conds.push(`c.t3_reason = ${p(f.reason)}`);
    return this.exec(async (q) => {
      const [{ n }] = await q(`SELECT count(*)::int AS n FROM document_operation_candidates c WHERE ${conds.join(' AND ')}`, params);
      const rows = await q(
        `SELECT c.id, c.account_id, acc.name AS account_name, c.file_id, c.candidate_key, c.confidence, c.established,
                c.type_hint, c.summary, c.t3_outcome, c.t3_reason, c.t3_operation_id, c.t3_processed_at, c.created_at,
                c.t3_detail -> 'arbitration' -> 'operationIds' AS proposed, c.t3_detail -> 'plausible' AS plausible,
                c.t3_detail -> 'm3' AS m3, c.t3_detail -> 'm3Batch' AS m3_batch, c.t3_detail -> 'm3Progress' AS m3_progress,
                c.t3_error_attempts, c.t3_retry_at, c.t3_last_error, c.t3_cards_pending
           FROM document_operation_candidates c JOIN accounts acc ON acc.id = c.account_id
          WHERE ${conds.join(' AND ')}
          ORDER BY c.t3_processed_at DESC NULLS LAST, c.id DESC
          LIMIT ${f.pageSize} OFFSET ${(f.page - 1) * f.pageSize}`,
        params,
      );
      const reasons = await q(
        `SELECT c.t3_outcome AS outcome, c.t3_reason AS reason, count(*)::int AS n
           FROM document_operation_candidates c WHERE ${base.join(' AND ')}
          GROUP BY 1, 2 ORDER BY 3 DESC, 1, 2`,
        baseParams,
      );
      const [pending] = await q(
        `SELECT count(*)::int AS n FROM document_operation_candidates c
          WHERE c.t3_pending AND c.status = 'ACTIVE' AND c.established ${f.accountId ? 'AND c.account_id = $1' : ''}`,
        f.accountId ? [f.accountId] : [],
      );
      const total = int(n);
      const ids = (v: unknown) => arr<unknown>(v).map(Number).filter((x) => Number.isSafeInteger(x));
      return {
        items: maskSensitive(rows.map((r): HoldItem => ({
          id: Number(r.id), accountId: Number(r.account_id), accountName: str(r.account_name), fileId: Number(r.file_id),
          candidateKey: String(r.candidate_key), confidence: String(r.confidence), established: Boolean(r.established),
          typeHint: str(r.type_hint), summary: String(r.summary ?? ''), outcome: String(r.t3_outcome),
          reason: str(r.t3_reason), reasonLabel: explainReason(str(r.t3_reason)), operationId: num(r.t3_operation_id),
          proposedOperationIds: [...new Set([...ids(r.proposed), ...ids(r.plausible)])].slice(0, 10),
          processedAt: ts(r.t3_processed_at), createdAt: ts(r.created_at),
          m3: r.t3_reason === 'M3_REQUIRED' || r.m3 ? toM3ProgressView(r.m3, r.m3_batch, r.m3_progress, r.plausible) : null,
          technicalError: String(r.t3_reason ?? '').startsWith('TECHNICAL_ERROR:') ? (() => {
            const le = (r.t3_last_error ?? {}) as Record<string, unknown>;
            return {
              attempts: int(r.t3_error_attempts), retryAt: ts(r.t3_retry_at), exhausted: r.t3_retry_at == null,
              code: str(le.code), message: str(le.message), jobId: num(le.jobId), at: str(le.at),
            };
          })() : null,
          cardsPending: r.t3_cards_pending === true,
        }))),
        total, page: f.page, pageSize: f.pageSize, totalPages: Math.max(1, Math.ceil(total / f.pageSize)),
        reasons: reasons.map((r) => ({ outcome: String(r.outcome), reason: str(r.reason), label: explainReason(str(r.reason)), count: int(r.n) })),
        pendingT3: int(pending?.n),
      };
    });
  }

  /** Détail complet d'une Opération (C26.1, ch. 21) ; `null` si inconnue. */
  async detail(id: number): Promise<OperationDetail | null> {
    return this.exec(async (q) => {
      const [r] = await q(
        `SELECT ${LIST_COLUMNS}, o.provider, o.closed_at, o.updated_at, o.version
           FROM business_operations o JOIN accounts acc ON acc.id = o.account_id WHERE o.id = $1`,
        [id],
      );
      if (!r) return null;
      const base = toListItem(r);
      const accountId = base.accountId;
      const L = DETAIL_LIMIT;

      // Redirection de fusion (F-185) : opération canonique au bout de la chaîne.
      let canonical: number | null = null;
      if (base.mergedIntoOperationId) {
        const [c] = await q(
          `WITH RECURSIVE m AS (
             SELECT id, merged_into_operation_id, 1 AS n FROM business_operations WHERE id = $1 AND account_id = $2
             UNION ALL
             SELECT o.id, o.merged_into_operation_id, m.n + 1 FROM business_operations o JOIN m ON o.id = m.merged_into_operation_id
              WHERE m.n < 10)
           SELECT id FROM m WHERE merged_into_operation_id IS NULL LIMIT 1`,
          [id, accountId],
        );
        canonical = c ? Number(c.id) : null;
      }

      // Listes d'AFFICHAGE (écran) : `DETAIL_LIMIT` lignes ; total réel d'une liste tronquée (`listTotals`).
      const listTotals: Partial<Record<OperationDetailList, number>> = {};
      const list = async (k: OperationDetailList): Promise<Row[]> => {
        const rows = await q(`${OPERATION_DETAIL_LISTS[k].sql} LIMIT ${L}`, [id, accountId]);
        if (rows.length >= L) {
          const [c] = await q(`SELECT count(*)::int AS n FROM (${OPERATION_DETAIL_LISTS[k].sql}) x`, [id, accountId]);
          listTotals[k] = int(c?.n);
        }
        return rows;
      };
      const assetLinks = await list('assetLinks');
      const equipmentLinks = await list('equipmentLinks');
      const sources = await list('sources');
      const components = await list('components');
      const references = await list('references');
      const [contractDetails] = await q(
        `SELECT contract_reference, periodicity, effective_from::text AS effective_from, effective_to::text AS effective_to, updated_at
           FROM business_operation_contract_details WHERE operation_id = $1`, [id]);
      const [financingDetails] = await q(
        `SELECT financing_reference, lender, principal_amount_minor, principal_currency,
                effective_from::text AS effective_from, effective_to::text AS effective_to, updated_at
           FROM business_operation_financing_details WHERE operation_id = $1`, [id]);
      // Sinistre : champs structurés et décomptes seulement — aucun texte libre
      // (circonstances, échanges) n'est rendu par le BO.
      const [claimDetails] = await q(
        `SELECT cd.claim_type, cd.declared_on::text AS declared_on, cd.insurer_claim_ref, cd.insurance_contract_operation_id,
                cd.status, cd.estimated_damage_minor, cd.updated_at,
                (SELECT count(*) FROM business_operation_claim_damages d WHERE d.operation_id = cd.operation_id)::int AS damages
           FROM business_operation_claim_details cd WHERE cd.operation_id = $1`, [id]);
      const mergedFrom = await list('mergedFrom');
      const history = await list('history');
      const matchDecisions = await list('matchDecisions');
      const agendaItems = await list('agendaItems');
      const projectionSuppressions = await list('projectionSuppressions');
      const candidates = await list('candidates');
      // Lot 55B (E) : traitements T3 encore dus pour cette Opération — documents
      // rattachés ou proposés, et documents du même bien (une facture en échec
      // n'est rattachée à rien) : en attente ou bloqués.
      const [etat] = await q(
        `WITH lies AS (
           SELECT c.* FROM document_operation_candidates c
            WHERE c.account_id = $2 AND c.status = 'ACTIVE'
              AND (c.t3_operation_id = $1
                   OR COALESCE(c.t3_detail->'plausible', '[]'::jsonb) @> to_jsonb($1::bigint)
                   OR COALESCE(c.t3_detail->'arbitration'->'operationIds', '[]'::jsonb) @> to_jsonb($1::bigint)
                   OR EXISTS (SELECT 1 FROM asset_files f JOIN business_operation_asset_links l
                                ON l.operation_id = $1 AND l.active AND l.asset_id = COALESCE(f.asset_id, f.linked_asset_id)
                               WHERE f.id = c.file_id AND f.account_id = $2 AND f.deleted_at IS NULL))
         )
         SELECT
           count(*) FILTER (WHERE (t3_reason LIKE 'TECHNICAL_ERROR:%' AND t3_outcome = 'HOLD_UNRESOLVED') OR t3_cards_pending
                              OR (t3_outcome = 'HOLD_UNRESOLVED' AND t3_detail->'m3'->>'status' IN ('ERROR', 'PROMPT_UNAVAILABLE')))::int AS blocked,
           count(*) FILTER (WHERE NOT ((t3_reason LIKE 'TECHNICAL_ERROR:%' AND t3_outcome = 'HOLD_UNRESOLVED') OR t3_cards_pending
                                       OR (t3_outcome = 'HOLD_UNRESOLVED' AND t3_detail->'m3'->>'status' IN ('ERROR', 'PROMPT_UNAVAILABLE')))
                              AND (t3_pending OR (t3_outcome = 'HOLD_UNRESOLVED' AND t3_reason = 'M3_REQUIRED')
                                   OR (t3_outcome = 'ARBITRATION_REQUIRED' AND (t3_operation_id = $1 OR COALESCE(t3_detail->'arbitration'->'operationIds', '[]'::jsonb) @> to_jsonb($1::bigint)))
                                   OR t3_detail->'retro'->>'status' = 'PENDING'))::int AS pending
           FROM lies`, [id, accountId]);
      const [job] = await q(
        `SELECT id, status, origin, trigger_code, business_result, created_at, finished_at, attempts, last_error,
                payload -> 'events' -> -1 ->> 'correlationId' AS correlation_id
           FROM ai_job_queue
          WHERE treatment = 'T3' AND account_id = $1 AND target_type = 'business_operations'
          ORDER BY id DESC LIMIT 1`, [accountId]);

      // Lot 78A (§5, §6) : contrôles d'identité économique (journal 0609) et provenance des valeurs.
      const [journal] = await q(`SELECT to_regclass('business_operation_identity_reviews') IS NOT NULL AS ok`);
      // Lot 79A : séparation encore effective → résumé du bouton « Rétablir » ; rétablie → trace du journal d'audit admin.
      const identityReviews = journal?.ok ? (await q(
        `SELECT r.id, r.kind, r.status, r.operation_id, r.target_operation_id, r.file_id, r.candidate_key, r.source_id, r.basis, r.signals,
                r.against_source_ids, r.review_version, r.correlation_id, r.created_at, r.updated_at, r.resolved_at, r.resolved_by_admin_id,
                CASE WHEN r.kind = 'SEPARATED' THEN ${RESTORE_BLOCK_SQL} END AS restore_block,
                cand.summary AS restore_summary, cand.t3_operation_id AS restore_current_operation_id, cand.payload -> 'financialHints' AS restore_hints,
                aud.admin_user_id AS restored_by_admin_id, aud.admin_email AS restored_by_admin_email, aud."timestamp" AS restored_at, aud.details AS restore_details
           FROM business_operation_identity_reviews r
           JOIN business_operations o ON o.id = r.operation_id AND o.account_id = r.account_id
           LEFT JOIN LATERAL (SELECT c.summary, c.t3_operation_id, c.payload FROM document_operation_candidates c
                               WHERE c.account_id = r.account_id AND c.file_id = r.file_id AND c.candidate_key = r.candidate_key AND c.status = 'ACTIVE'
                               ORDER BY c.id DESC LIMIT 1) cand ON r.kind = 'SEPARATED'
           LEFT JOIN LATERAL (SELECT a.admin_user_id, a.admin_email, a."timestamp", a.details FROM admin_audit_log a
                               WHERE r.status = 'REVERTED' AND a.action_type = '${RESTORE_AUDIT_ACTION}' AND a.target_type = '${RESTORE_AUDIT_TARGET}'
                                 AND a.target_id = r.id AND a.result = 'SUCCESS'
                               ORDER BY a.id DESC LIMIT 1) aud ON true
          WHERE r.account_id = $2 AND (r.operation_id = $1 OR r.target_operation_id = $1)
          ORDER BY r.created_at DESC, r.id DESC LIMIT ${L}`, [id, accountId])).map(identityReviewView) : [];
      const [prov] = await q(`SELECT to_jsonb(o) -> 'attribute_provenance' AS p FROM business_operations o WHERE o.id = $1`, [id]);
      // Lot 85E (ticket PO P1) : acquisition réalisée sans date alors que la fiche d'un bien lié porte une date exploitable.
      let knownDateMissing = false;
      if (r.type_code === 'ACQUISITION' && r.status === 'REALIZED' && !r.realized_date) {
        const { assetDataFacts, canonicalAcquisitionDate } = await import('../consolidation/asset-data');
        const biens = await q(
          `SELECT row_to_json(a.*) AS r FROM business_operation_asset_links l JOIN assets a ON a.id = l.asset_id AND a.account_id = $2 AND a.deleted_at IS NULL
            WHERE l.operation_id = $1 AND l.active`, [id, accountId]);
        knownDateMissing = biens.some((b) => {
          const row = (typeof b.r === 'string' ? JSON.parse(b.r) : b.r) as never;
          return !!(assetDataFacts(row).ACQUISITION?.date ?? canonicalAcquisitionDate(row));
        });
      }

      const withReason = (rows: Row[], col: string) => rows.map((x) => ({ ...x, [`${col}_label`]: explainReason(str(x[col])) }));
      const detail: OperationDetail = {
        operation: {
          ...base,
          provider: str(r.provider),
          plannedDate: str(r.planned_date), startDate: str(r.start_date), realizedDate: str(r.realized_date), endDate: str(r.end_date),
          closedAt: ts(r.closed_at), updatedAt: ts(r.updated_at), version: int(r.version), active: r.invalidated_at == null,
        },
        canonicalOperationId: canonical,
        assetLinks,
        equipmentLinks,
        sources: withReason(sources, 'match_reason'),
        components,
        references,
        contractDetails: contractDetails ?? null,
        financingDetails: financingDetails ?? null,
        claimDetails: claimDetails ?? null,
        mergedFrom,
        history: withReason(history, 'reason_code'),
        matchDecisions: withReason(matchDecisions, 'reason_code'),
        agendaItems,
        projectionSuppressions,
        listTotals,
        displayLimit: L,
        identityReviews,
        attributeProvenance: (prov?.p as Row | null) ?? null,
        candidates: withReason(candidates, 't3_reason').map((c) => ({
          ...c, ai_label: aiRunLabel(c.t3_detail as Record<string, unknown> | null, str(c.t3_outcome), str(c.t3_reason)),
        })),
        reconciliation: reconciliationView({
          pending: int(etat?.pending), blocked: int(etat?.blocked), lastReconciledAt: base.lastReconciledAt,
          active: r.invalidated_at == null && r.merged_into_operation_id == null, knownDateMissing,
        }),
        operationMatchBranch: await (await import('../consolidation/m3')).operationMatchPromptStatus(),
        lastT3Pass: job ? {
          jobId: Number(job.id), status: String(job.status), origin: str(job.origin), triggerCode: str(job.trigger_code),
          businessResult: str(job.business_result), createdAt: ts(job.created_at), finishedAt: ts(job.finished_at),
          attempts: int(job.attempts), lastError: str(job.last_error), correlationId: str(job.correlation_id),
        } : null,
        procedure: CORRECTION_PROCEDURE,
      };
      return maskSensitive(detail);
    });
  }

  /** Anomalies dures seules (tâche planifiée, alerte d'exploitation). */
  async hardAnomalies(accountId: number | null = null, opts: { eligibleOnly?: boolean } = {}): Promise<HardAnomalyResult[]> {
    return this.exec((q) => detectHardAnomalies(q, accountId, opts.eligibleOnly === true));
  }

  /** Les 13 indicateurs C26.2 (compte ou global, période) + anomalies dures. */
  async indicators(period: DiagPeriod, accountId: number | null = null): Promise<IndicatorsReport> {
    return this.exec(async (q) => {
      const pp = [period.from, period.to, accountId];
      const acc = (col: string) => `($3::int IS NULL OR ${col} = $3::int)`;

      const perDay = await q(
        `SELECT to_char((o.created_at AT TIME ZONE 'Europe/Paris')::date, 'YYYY-MM-DD') AS day,
                coalesce(fs.source_kind, 'AUCUNE') AS source_kind, count(*)::int AS n
           FROM business_operations o
           LEFT JOIN LATERAL (SELECT s.source_kind FROM business_operation_sources s
                               WHERE s.operation_id = o.id ORDER BY s.created_at, s.id LIMIT 1) fs ON true
          WHERE o.created_at >= ${FROM('$1')} AND o.created_at < ${TO('$2')} AND ${acc('o.account_id')}
          GROUP BY 1, 2 ORDER BY 1, 2`, pp);
      const [docs] = await q(
        `SELECT count(*)::int AS analysed,
                count(*) FILTER (WHERE EXISTS (
                  SELECT 1 FROM document_operation_candidates c
                   WHERE c.file_id = e.file_id AND c.status = 'ACTIVE' AND c.established AND c.confidence = 'certain'))::int AS with_certain
           FROM document_extractions e
          WHERE e.extracted_at >= ${FROM('$1')} AND e.extracted_at < ${TO('$2')} AND ${acc('e.account_id')}`, pp);
      const outcomes = await q(
        `SELECT c.t3_outcome AS outcome, count(*)::int AS n FROM document_operation_candidates c
          WHERE c.t3_outcome IS NOT NULL AND c.established AND c.confidence = 'certain'
            AND c.t3_processed_at >= ${FROM('$1')} AND c.t3_processed_at < ${TO('$2')} AND ${acc('c.account_id')}
          GROUP BY 1`, pp);
      const types = await q(
        `SELECT o.type_code, count(*)::int AS n FROM business_operations o
          WHERE o.invalidated_at IS NULL AND ($1::int IS NULL OR o.account_id = $1::int) GROUP BY 1`, [accountId]);
      const [cohort] = await q(
        `SELECT count(*)::int AS created,
                count(*) FILTER (WHERE o.merged_into_operation_id IS NOT NULL
                                   AND o.invalidated_at <= o.created_at + interval '7 days')::int AS merged7,
                count(*) FILTER (WHERE o.merged_into_operation_id IS NULL AND o.invalidated_at IS NOT NULL
                                   AND o.invalidated_at <= o.created_at + interval '7 days')::int AS invalidated7
           FROM business_operations o
          WHERE o.created_at >= ${FROM('$1')} AND o.created_at < ${TO('$2')} AND ${acc('o.account_id')}`, pp);
      const [ages] = await q(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE now() - o.created_at < interval '24 hours')::int AS h24,
                count(*) FILTER (WHERE now() - o.created_at >= interval '24 hours' AND now() - o.created_at <= interval '7 days')::int AS d7,
                count(*) FILTER (WHERE now() - o.created_at > interval '7 days' AND now() - o.created_at <= interval '30 days')::int AS d30,
                count(*) FILTER (WHERE now() - o.created_at > interval '30 days')::int AS older
           FROM business_operations o
          WHERE o.invalidated_at IS NULL AND ($1::int IS NULL OR o.account_id = $1::int)
            AND NOT EXISTS (SELECT 1 FROM business_operation_asset_links al WHERE al.operation_id = o.id AND al.active)`, [accountId]);
      const ambiguous = await q(
        `SELECT c.t3_outcome AS outcome, c.t3_reason AS reason, count(*)::int AS n FROM document_operation_candidates c
          WHERE c.status = 'ACTIVE' AND c.t3_outcome IN ('HOLD_UNRESOLVED', 'ARBITRATION_REQUIRED')
            AND ($1::int IS NULL OR c.account_id = $1::int)
          GROUP BY 1, 2 ORDER BY 3 DESC, 1, 2`, [accountId]);
      const { OPERATION_CARD_RULES } = await import('@/services/to-process/operation-cards');
      const cards = await q(
        `SELECT rule_code, count(*)::int AS n FROM to_process_actions
          WHERE resolved_at IS NULL AND rule_code = ANY($1::text[]) AND ($2::int IS NULL OR account_id = $2::int)
          GROUP BY 1`, [[...OPERATION_CARD_RULES], accountId]);
      const t2 = await q(
        `SELECT r.retrieval_methods_json -> 'observability' ->> 'economicMode' AS mode, count(*)::int AS n
           FROM verebona_request_runs r
          WHERE (r.retrieval_methods_json -> 'observability' ->> 'economicMode') IS NOT NULL
            AND r.created_at >= ${FROM('$1')} AND r.created_at < ${TO('$2')} AND ${acc('r.account_id')}
          GROUP BY 1`, pp);
      const anomalies = await detectHardAnomalies(q, accountId);

      const count = (code: HardAnomalyCode) => anomalies.find((a) => a.code === code)?.count ?? 0;
      const values: Record<IndicatorKey, Record<string, unknown>> = {
        createdPerDayBySourceKind: (() => {
          const days = new Map<string, Record<string, number>>();
          const byKind: Record<string, number> = {};
          let total = 0;
          for (const x of perDay) {
            const d = String(x.day);
            const k = String(x.source_kind);
            const n = int(x.n);
            const day = days.get(d) ?? {};
            day[k] = (day[k] ?? 0) + n;
            days.set(d, day);
            byKind[k] = (byKind[k] ?? 0) + n;
            total += n;
          }
          const list = [...days.entries()].map(([day, kinds]) => ({ day, total: Object.values(kinds).reduce((a, b) => a + b, 0), bySourceKind: kinds }));
          const max = list.reduce<{ day: string; total: number } | null>((m, d) => (!m || d.total > m.total ? { day: d.day, total: d.total } : m), null);
          return { total, bySourceKind: byKind, days: list, maxDay: max, averagePerDay: Math.round((total / period.days) * 10) / 10 };
        })(),
        documentsWithCertainCandidate: { analysed: int(docs?.analysed), withCertain: int(docs?.with_certain), pct: pct(int(docs?.with_certain), int(docs?.analysed)) },
        certainCandidatesOutcome: (() => {
          const by: Record<string, number> = Object.fromEntries(outcomes.map((o) => [String(o.outcome), int(o.n)]));
          const total = Object.values(by).reduce((a, b) => a + b, 0);
          const create = by.CREATE_NEW ?? 0;
          const match = by.MATCH_AND_ENRICH ?? 0;
          return { total, create, match, createPct: pct(create, total), matchPct: pct(match, total), byOutcome: by };
        })(),
        typeNull: (() => {
          const by: Record<string, number> = Object.fromEntries(types.map((t) => [t.type_code == null ? 'NULL' : String(t.type_code), int(t.n)]));
          const active = Object.values(by).reduce((a, b) => a + b, 0);
          return { active, count: by.NULL ?? 0, pct: pct(by.NULL ?? 0, active), byType: by };
        })(),
        typeOther: (() => {
          const active = types.reduce((a, t) => a + int(t.n), 0);
          const other = int(types.find((t) => t.type_code === 'OTHER')?.n);
          return { active, count: other, pct: pct(other, active) };
        })(),
        mergedWithin7Days: { created: int(cohort?.created), count: int(cohort?.merged7), pct: pct(int(cohort?.merged7), int(cohort?.created)) },
        invalidatedWithin7Days: { created: int(cohort?.created), count: int(cohort?.invalidated7), pct: pct(int(cohort?.invalidated7), int(cohort?.created)) },
        withoutTargetByAge: { total: int(ages?.total), h24: int(ages?.h24), d7: int(ages?.d7), d30: int(ages?.d30), older: int(ages?.older) },
        ambiguousSources: (() => {
          const byReason = ambiguous.map((a) => ({ outcome: String(a.outcome), reason: str(a.reason), label: explainReason(str(a.reason)), count: int(a.n) }));
          const hold = byReason.filter((a) => a.outcome === 'HOLD_UNRESOLVED').reduce((n, a) => n + a.count, 0);
          const arbitration = byReason.filter((a) => a.outcome === 'ARBITRATION_REQUIRED').reduce((n, a) => n + a.count, 0);
          const openCards: Record<string, number> = Object.fromEntries(cards.map((c) => [String(c.rule_code), int(c.n)]));
          const openCardsTotal = Object.values(openCards).reduce((a, b) => a + b, 0);
          return { total: hold + arbitration, hold, arbitration, byReason, openCards, openCardsTotal };
        })(),
        componentsWithoutActiveSource: { count: count('ACTIVE_COMPONENT_WITHOUT_SOURCE') },
        activeWithoutActiveSource: { count: count('ACTIVE_OPERATION_WITHOUT_SOURCE') },
        crossAccountLinks: { count: count('CROSS_ACCOUNT_LINK') },
        t2EconomicAnswers: (() => {
          const by: Record<string, number> = Object.fromEntries(t2.map((t) => [String(t.mode), int(t.n)]));
          const total = Object.values(by).reduce((a, b) => a + b, 0);
          const o = by.operation_only ?? 0;
          const m = by.mixed ?? 0;
          const f = by.fallback_only ?? 0;
          return { total, operationOnly: o, mixed: m, fallbackOnly: f, operationOnlyPct: pct(o, total), mixedPct: pct(m, total), fallbackOnlyPct: pct(f, total) };
        })(),
      };
      return {
        period, accountId, computedAt: new Date().toISOString(),
        indicators: INDICATORS.map((d) => ({ ...d, value: values[d.key] })),
        anomalies,
        hardAnomalyTotal: anomalies.reduce((n, a) => n + a.count, 0),
        procedure: CORRECTION_PROCEDURE,
      };
    });
  }
}
