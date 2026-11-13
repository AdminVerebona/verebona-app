/**
 * Lot 113AQ (Trello #751) — lecture du diagnostic des contradictions
 * d'attributs d'Opération (contrat `attribute-conflicts-model.ts`).
 *
 * LECTURE SEULE : transaction READ ONLY avec délai côté base
 * (`readOnlyExecutor`), aucune écriture, aucun appel IA, aucune
 * reconsolidation. Bornée et paginée : une page d'Opérations (ordre total
 * compte, identifiant), puis ses sources, ses cartes et ses erreurs T3 en
 * TROIS requêtes groupées (aucun N+1). Le compte de chaque entrée est celui
 * de l'Opération en base (jamais déduit d'une liste).
 */
import {
  CONFLICT_DIAGNOSTIC_PAGE_SIZE, alertState, buildConflictEntries, conflictCounters, occurrenceTimeline,
  type ConflictCounters, type ConflictDiagnosticEntry, type DiagnosticSourceInfo, type OccurrenceInput, type OccurrenceTimelineItem,
  ATTRIBUTE_CONFLICT_DIAGNOSTIC_CONTRACT, ATTRIBUTE_CONFLICT_DIAGNOSTIC_VERSION,
} from './attribute-conflicts-model';
import { ATTRIBUTE_CONFLICT_RULES, ATTRIBUTE_CONFLICT_RULES_VERSION } from '../consolidation/attribute-conflicts';
import { readOnlyExecutor, type DiagExecutor, type DiagQuery } from './service';

/** Opérations dont la provenance porte une ligne (conflit, divergence ou arbitrage BO). */
const HAS_LINES = `o.attribute_provenance IS NOT NULL AND (
     (jsonb_typeof(o.attribute_provenance->'conflicts') = 'array' AND jsonb_array_length(o.attribute_provenance->'conflicts') > 0)
  OR (jsonb_typeof(o.attribute_provenance->'divergences') = 'array' AND jsonb_array_length(o.attribute_provenance->'divergences') > 0)
  OR (jsonb_typeof(o.attribute_provenance->'arbitratedConflicts') = 'array' AND jsonb_array_length(o.attribute_provenance->'arbitratedConflicts') > 0))`;
/** Opérations qui maintiennent l'alerte (même prédicat que l'anomalie dure). */
const HAS_ALERT = `o.attribute_provenance IS NOT NULL AND jsonb_typeof(o.attribute_provenance->'conflicts') = 'array'
  AND jsonb_array_length(o.attribute_provenance->'conflicts') > 0`;

export interface ConflictDiagnosticQuery {
  accountId?: number | null;
  /** `alerting` : Opérations qui maintiennent l'alerte (défaut) ; `all` : y compris divergences et arbitrages. */
  scope?: 'alerting' | 'all';
  page?: number;
  pageSize?: number;
  /** Signalements de l'anomalie de Supervision (lecture chronologique), si connus. */
  occurrences?: readonly OccurrenceInput[];
  anomalyStatus?: 'open' | 'resolved' | null;
  /** Nombre total d'occurrences de l'anomalie (l'historique lu peut être borné). */
  occurrenceCount?: number | null;
  now?: Date;
}

export interface ConflictDiagnostic {
  contract: string;
  contractVersion: number;
  rules: { id: string; version: number };
  generatedAt: string;
  readOnly: true;
  scope: { accountId: number | null; operations: 'alerting' | 'all' };
  page: number;
  pageSize: number;
  totalOperations: number;
  totalPages: number;
  complete: boolean;
  counters: ConflictCounters;
  /** Compteurs de la PAGE (les lignes de toutes les pages ne sont lues qu'à l'export). */
  countersScope: 'page' | 'all';
  alert: ReturnType<typeof alertState>;
  conflicts: ConflictDiagnosticEntry[];
  occurrences: OccurrenceTimelineItem[];
  limits: string[];
}

type Row = Record<string, unknown>;
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const txt = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v ? new Date(String(v)).toISOString() : null);

async function readPage(q: DiagQuery, accountId: number | null, scope: 'alerting' | 'all', page: number, pageSize: number) {
  const where = `${scope === 'all' ? HAS_LINES : HAS_ALERT}${accountId ? ' AND o.account_id = $1' : ' AND $1::int IS NULL'}`;
  const [{ n }] = await q(`SELECT count(*)::int AS n FROM business_operations o WHERE ${where}`, [accountId]);
  const ops = await q(`
    SELECT o.id, o.account_id, o.type_code, o.status, o.technical_label, o.invalidated_at IS NOT NULL AS invalidated,
           o.merged_into_operation_id, o.planned_date::text AS planned_date, o.start_date::text AS start_date,
           o.realized_date::text AS realized_date, o.end_date::text AS end_date, o.provider, o.last_reconciled_at,
           o.attribute_provenance AS provenance
      FROM business_operations o WHERE ${where}
     ORDER BY o.account_id, o.id LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, [accountId]);
  return { total: Number(n), ops };
}

async function readContext(q: DiagQuery, ops: readonly Row[]) {
  const ids = ops.map((o) => Number(o.id));
  if (!ids.length) return { sources: [] as Row[], errors: [] as Row[], cards: [] as Row[], reviews: [] as Row[] };
  const sources = await q(`
    SELECT s.id, s.operation_id, s.account_id, s.source_kind, s.source_entity_key, s.source_role, s.authority, s.active, s.source_version,
           f.id AS file_id, coalesce(f.document_type_code, f.document_type) AS document_type, f.deleted_at IS NOT NULL AS file_deleted
      FROM business_operation_sources s
      LEFT JOIN asset_files f ON s.source_kind = 'DOCUMENT' AND s.source_entity_key ~ '^[0-9]{1,9}$'
                             AND f.id = s.source_entity_key::int AND f.account_id = s.account_id
     WHERE s.operation_id = ANY($1::bigint[])`, [ids]);
  const errors = await q(`
    SELECT c.t3_operation_id AS operation_id, c.account_id, max(coalesce(c.t3_last_error->>'code', c.t3_reason)) AS code
      FROM document_operation_candidates c
     WHERE c.status = 'ACTIVE' AND c.t3_operation_id = ANY($1::bigint[]) AND c.t3_reason LIKE 'TECHNICAL_ERROR:%'
     GROUP BY c.t3_operation_id, c.account_id`, [ids]);
  const cards = await q(`
    SELECT a.id, a.action_kind, a.resolved_at IS NOT NULL AS resolved, i.business_operation_id AS operation_id, a.account_id
      FROM to_process_actions a JOIN agenda_items i ON i.id = a.target_id AND i.account_id = a.account_id
     WHERE a.target_type = 'AGENDA_ITEM' AND a.field_key = 'date' AND i.business_operation_id = ANY($1::bigint[])`, [ids]);
  // Lot 114 (#750, issue C) : cartes « Arbitrer » d'une contradiction réelle d'attribut (sujet = attribut:rôle).
  const attributeCards = await q(`
    SELECT a.id, a.action_kind, a.resolved_at IS NOT NULL AS resolved, (a.trigger_context->>'operationId')::bigint AS operation_id, a.account_id,
           (a.trigger_context->>'field') || ':' || (a.trigger_context->>'role') AS subject
      FROM to_process_actions a
     WHERE a.rule_code = 'OPERATION-ATTRIBUTE' AND a.trigger_context ? 'operationId'
       AND (a.trigger_context->>'operationId')::bigint = ANY($1::bigint[])`, [ids]);
  // Lot 114 (#750, issue B) : examens T3 (table 1690 ; absente avant la migration : aucun examen, jamais une erreur).
  const [t] = await q(`SELECT to_regclass('business_operation_attribute_arbitrations') IS NOT NULL AS ok`, []);
  const reviews = t?.ok === true ? await q(`
    SELECT r.id, r.operation_id, r.account_id, r.field, r.role, r.status, r.outcome, r.confidence, r.reason, r.retained_value, r.value_before, r.value_after,
           r.applied_at IS NOT NULL AS applied, r.evidence, r.requested_at, r.decided_at, r.decider_version, r.ai_trace_id, r.ai_calls, r.error
      FROM business_operation_attribute_arbitrations r
     WHERE r.operation_id = ANY($1::bigint[]) ORDER BY r.id`, [ids]) : [];
  return { sources, errors, cards: [...cards, ...attributeCards], reviews };
}

/** Diagnostic d'une page (écran) — lecture seule. */
export async function readConflictDiagnostic(query: ConflictDiagnosticQuery = {}, exec: DiagExecutor = readOnlyExecutor): Promise<ConflictDiagnostic> {
  const pageSize = Math.max(1, Math.min(200, Math.floor(query.pageSize ?? CONFLICT_DIAGNOSTIC_PAGE_SIZE)));
  const page = Math.max(1, Math.floor(query.page ?? 1));
  const scope = query.scope ?? 'alerting';
  const accountId = query.accountId ?? null;
  const now = query.now ?? new Date();
  const limits: string[] = [];
  const { total, entries } = await exec(async (q) => {
    const { total, ops } = await readPage(q, accountId, scope, page, pageSize);
    const ctx = await readContext(q, ops);
    const entries: ConflictDiagnosticEntry[] = [];
    for (const o of ops) {
      const id = Number(o.id);
      const acc = Number(o.account_id);
      // Isolation : seules les lignes du MÊME compte que l'Opération sont lues pour elle.
      const sources = new Map<number, DiagnosticSourceInfo>();
      for (const s of ctx.sources.filter((x) => Number(x.operation_id) === id && Number(x.account_id) === acc)) {
        sources.set(Number(s.id), {
          sourceId: Number(s.id), kind: txt(s.source_kind), fileId: num(s.file_id), documentType: txt(s.document_type),
          documentRole: txt(s.source_role), authority: txt(s.authority), active: s.active === true,
          availability: s.file_deleted === true ? 'DELETED' : s.active === true ? 'EXISTING' : 'INACTIVE', version: txt(s.source_version),
        });
      }
      const err = ctx.errors.find((x) => Number(x.operation_id) === id && Number(x.account_id) === acc);
      entries.push(...buildConflictEntries({
        accountId: acc, operationId: id, typeCode: txt(o.type_code), status: txt(o.status), technicalLabel: txt(o.technical_label),
        invalidated: o.invalidated === true, mergedInto: num(o.merged_into_operation_id),
        current: { plannedDate: txt(o.planned_date), startDate: txt(o.start_date), realizedDate: txt(o.realized_date), endDate: txt(o.end_date), provider: txt(o.provider) },
        lastReconciledAt: iso(o.last_reconciled_at), provenance: o.provenance, sources,
        technicalError: err ? `erreur technique T3 ${txt(err.code) ?? ''}`.trim() : null,
        arbitrations: ctx.cards.filter((x) => Number(x.operation_id) === id && Number(x.account_id) === acc)
          .map((x) => ({ actionId: Number(x.id), state: x.resolved === true ? 'RESOLVED' as const : 'OPEN' as const, kind: String(x.action_kind), subject: txt(x.subject) })),
        // Le plus récent par sujet (ordre des identifiants) ; isolation par compte comme les autres lectures.
        t3Reviews: new Map(ctx.reviews.filter((x) => Number(x.operation_id) === id && Number(x.account_id) === acc).map((x) => [`${String(x.field)}:${String(x.role)}`, {
          reviewId: Number(x.id), status: String(x.status), outcome: txt(x.outcome), confidence: txt(x.confidence), reason: txt(x.reason),
          retainedValue: txt(x.retained_value), valueBefore: txt(x.value_before), valueAfter: txt(x.value_after), applied: x.applied === true,
          evidence: (Array.isArray(x.evidence) ? x.evidence as Row[] : []).map((e) => ({ fileId: num(e.fileId), excerpt: String(e.excerpt ?? '') })),
          requestedAt: iso(x.requested_at), decidedAt: iso(x.decided_at), promptVersion: txt(x.decider_version), traceId: txt(x.ai_trace_id),
          aiCalls: Number(x.ai_calls ?? 0), error: txt(x.error),
        }])),
      }, now));
    }
    return { total, entries };
  });
  const timeline = query.occurrences ? occurrenceTimeline(query.occurrences) : null;
  if (timeline && query.occurrenceCount != null && query.occurrenceCount > timeline.counters.total) {
    limits.push(`Historique des signalements lu sur les ${timeline.counters.total} plus récents (sur ${query.occurrenceCount}).`);
  }
  if (timeline?.counters.withoutDetail) {
    limits.push(`${timeline.counters.withoutDetail} signalement(s) antérieur(s) sans détail structuré : détail historique non conservé (aucune valeur reconstruite).`);
  }
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (totalPages > 1) limits.push(`Page ${page} / ${totalPages} : compteurs calculés sur la page affichée (export complet : « Exporter JSON »).`);
  const counters = conflictCounters(entries, timeline ? {
    total: query.occurrenceCount ?? timeline.counters.total, material: timeline.counters.material, periodic: timeline.counters.periodic,
  } : undefined);
  return {
    contract: ATTRIBUTE_CONFLICT_DIAGNOSTIC_CONTRACT,
    contractVersion: ATTRIBUTE_CONFLICT_DIAGNOSTIC_VERSION,
    rules: { id: ATTRIBUTE_CONFLICT_RULES, version: ATTRIBUTE_CONFLICT_RULES_VERSION },
    generatedAt: now.toISOString(),
    readOnly: true,
    scope: { accountId, operations: scope },
    page, pageSize, totalOperations: total, totalPages,
    complete: totalPages === 1,
    counters,
    countersScope: totalPages === 1 ? 'all' : 'page',
    alert: alertState(counters, query.anomalyStatus ?? null),
    conflicts: entries,
    occurrences: timeline?.items ?? [],
    limits,
  };
}

/** Lignes matérielles (alerte) de TOUTES les Opérations concernées — détail structuré du producteur. */
export async function alertingConflictLines(exec: DiagExecutor = readOnlyExecutor, opts: { eligibleOnly?: boolean; max?: number } = {}): Promise<{
  lines: Array<{ accountId: number; operationId: number; field: string; role: string; qualification: string; reasonCode: string; values: string[]; retained: string | null }>;
  total: number;
}> {
  const max = Math.max(1, Math.min(1000, opts.max ?? 200));
  return exec(async (q) => {
    const { processingEligibleSql } = await import('@/services/account/processing-eligibility');
    const where = `${HAS_ALERT} AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL${opts.eligibleOnly ? ` AND ${processingEligibleSql('o.account_id')}` : ''}`;
    const [{ n }] = await q(`SELECT count(*)::int AS n FROM business_operations o WHERE ${where}`);
    const rows = await q(`SELECT o.id, o.account_id, o.attribute_provenance AS p FROM business_operations o WHERE ${where} ORDER BY o.account_id, o.id LIMIT ${max}`);
    const lines = rows.flatMap((r) => {
      const p = (r.p ?? {}) as Row;
      const v2 = Number(p.version ?? 1) >= 2;
      return (Array.isArray(p.conflicts) ? (p.conflicts as Row[]) : []).map((c) => ({
        accountId: Number(r.account_id), operationId: Number(r.id), field: String(c.field),
        role: v2 && typeof c.role === 'string' ? c.role : 'UNKNOWN',
        qualification: v2 && typeof c.qualification === 'string' ? c.qualification : 'NON_REQUALIFIE',
        reasonCode: v2 && typeof c.reasonCode === 'string' ? c.reasonCode : 'LEGACY_RULES_NOT_RECHECKED',
        values: (Array.isArray(c.values) ? (c.values as Row[]) : []).map((v) => String(v.value)),
        retained: typeof c.retained === 'string' ? c.retained : null,
      }));
    });
    return { lines, total: Number(n) };
  });
}

export { ATTRIBUTE_CONFLICT_RULES_VERSION };
