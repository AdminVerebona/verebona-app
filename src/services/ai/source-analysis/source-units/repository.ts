/**
 * Couche A de T1 — persistance et LECTURE (lot 34F ; migrations 0295-0297).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * INTERFACE DE LECTURE (T3 et traitements futurs — lot 34E)
 *
 *   loadDocumentSourceUnits(fileId, opts)   unités d'un document, dans l'ordre
 *                                           de lecture, filtrables par état,
 *                                           type, page ; avec leurs faits
 *   loadDocumentCoverage(fileId)            rapport de complétude courant
 *   loadUnresolvedDocumentFacts(fileId)     faits conservés non intégrés
 *   searchDocumentSourceUnits(accountId, terms, opts)
 *                                           unités d'un compte contenant des
 *                                           termes (« 12 rue Victor Hugo »),
 *                                           y compris NON comprises par T1
 *
 * Aucune de ces lectures ne touche au fichier original : c'est la garantie
 * « réinterprétation ultérieure sans relire le fichier ».
 *
 * ÉCRITURE : `writeSourceLayer`, appelée DANS la transaction de
 * `persistDocumentKnowledge` (jamais d'état mixte lisible). Remplacement par
 * fichier. Migrations absentes : rien n'est écrit, signalé une fois.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { wordStartPattern } from '@/lib/search/match-engine';
import type { CoverageStatus, SourceLayer, SourceUnitKind, T1CompletenessReport, T1QualityState, UnresolvedFactRecord } from './types';

type Tx = { unsafe: (q: string, p?: never[]) => Promise<unknown> };
const json = (v: unknown) => JSON.stringify(v ?? null);

const RECONTROLE_MS = 5 * 60_000;
let etat: { ready: boolean; checkedAt: number } | null = null;
let signale = false;

/** Tables 0295 / 0296 et colonne 0297 présentes ? Ne lève jamais (illisible = absent). */
export async function sourceLayerReady(): Promise<boolean> {
  if (etat && (etat.ready || Date.now() - etat.checkedAt < RECONTROLE_MS)) return etat.ready;
  let ready = false;
  try {
    const { pgClient } = await import('@/db');
    const r = (await pgClient.unsafe(
      `SELECT to_regclass('document_source_units') IS NOT NULL
          AND to_regclass('document_extraction_coverage') IS NOT NULL
          AND to_regclass('document_unresolved_facts') IS NOT NULL
          AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
                       AND table_name = 'document_facts' AND column_name = 'source_unit_ids') AS ok`,
    )) as unknown as Array<{ ok: boolean }>;
    ready = Boolean(r[0]?.ok);
  } catch {
    ready = false;
  }
  etat = { ready, checkedAt: Date.now() };
  if (!ready && !signale) {
    signale = true;
    console.error('[t1-source-units] ⚠️ MIGRATIONS 0295-0297 NON APPLIQUÉES : couche A de T1 (unités de la source, couverture) non écrite. '
      + 'Les faits restent écrits comme avant. Voir /api/health (migrations).');
  }
  return ready;
}

/** Réservé aux tests. */
export function __resetSourceLayerReadyForTests(ready: boolean | null = null): void {
  etat = ready === null ? null : { ready, checkedAt: Date.now() };
  signale = false;
}

/** Reprises automatiques d'un document INCOMPLETE_RETRYABLE (`T1_COMPLETENESS_MAX_RETRIES`, 2 par défaut, 0 à 5). */
export function maxCompletenessRetries(env: Record<string, string | undefined> = process.env): number {
  const v = env.T1_COMPLETENESS_MAX_RETRIES;
  const n = Number(v);
  return v !== undefined && v.trim() !== '' && Number.isFinite(n) ? Math.min(5, Math.max(0, Math.trunc(n))) : 2;
}

/** Lignes d'insertion envoyées en JSON (une requête par paquet). */
const PAQUET = 2_000;

/**
 * Remplace la couche A d'un document (unités, faits non résolus, rapport).
 * À appeler dans une transaction.
 */
export async function writeSourceLayer(tx: Tx, p: {
  accountId: number; fileId: number; extractionId: number | null; layer: SourceLayer;
  origin?: 'ANALYSIS' | 'BACKFILL' | 'RETRY';
  /** Reprise : tentatives déjà consommées. */
  retryAttempts?: number;
  nextRetryAt?: Date | null;
  lastError?: string | null;
}): Promise<void> {
  const { layer } = p;
  let retryAttempts = p.retryAttempts ?? 0;
  if ((p.origin ?? 'ANALYSIS') === 'ANALYSIS') {
    // Les reprises consommées survivent à une nouvelle analyse (une lacune de
    // pages repasse par la file T1) : jamais de boucle analyse ↔ reprise.
    const prev = (await tx.unsafe(
      `SELECT retry_attempts FROM document_extraction_coverage WHERE file_id = $1`, [p.fileId] as never[],
    )) as Array<{ retry_attempts: number }>;
    retryAttempts = Number(prev[0]?.retry_attempts ?? 0);
    if (layer.report.qualityState === 'INCOMPLETE_RETRYABLE' && retryAttempts >= maxCompletenessRetries()) {
      layer.report.qualityState = 'INCOMPLETE_FINAL';
      layer.retryable = false;
    }
  }
  await tx.unsafe(`DELETE FROM document_source_units WHERE file_id = $1`, [p.fileId] as never[]);
  for (let i = 0; i < layer.units.length; i += PAQUET) {
    const lot = layer.units.slice(i, i + PAQUET).map((u) => ({
      id: u.sourceUnitId, kind: u.kind, page: u.page, ordinal: u.ordinal, parent: u.parentUnitId,
      content: u.text, label: u.label ?? null, val: u.value ?? null, payload: u.payload ?? {}, location: u.location ?? {},
      origin: u.origin, salient: u.salient, status: u.status, reason: u.reason, facts: u.factCount, attempts: u.repairAttempts,
    }));
    await tx.unsafe(
      `INSERT INTO document_source_units (
         account_id, file_id, extraction_id, source_unit_id, kind, page, ordinal, parent_unit_id, content_text, label, value_text,
         payload, location, origin, salient, coverage_status, coverage_reason, fact_count, repair_attempts, layer_version
       )
       SELECT $1, $2, $3, u.id, u.kind, u.page, u.ordinal, u.parent, u.content, u.label, u.val,
              coalesce(u.payload, '{}'::jsonb), coalesce(u.location, '{}'::jsonb), u.origin, coalesce(u.salient, false),
              u.status, u.reason, coalesce(u.facts, 0), coalesce(u.attempts, 0), $5
         FROM jsonb_to_recordset($4::jsonb) AS u(
           id text, kind text, page int, ordinal int, parent text, content text, label text, val text,
           payload jsonb, location jsonb, origin text, salient boolean, status text, reason text, facts int, attempts int
         )
       ON CONFLICT (file_id, source_unit_id) DO NOTHING`,
      [p.accountId, p.fileId, p.extractionId, json(lot), layer.layerVersion] as never[],
    );
  }
  await tx.unsafe(`DELETE FROM document_unresolved_facts WHERE file_id = $1`, [p.fileId] as never[]);
  for (let i = 0; i < layer.unresolvedFacts.length; i += PAQUET) {
    const lot = layer.unresolvedFacts.slice(i, i + PAQUET).map((f) => ({
      reason: f.reason, status: f.status, units: f.sourceUnitIds, rawKey: f.rawKey, canonicalKey: f.canonicalKey,
      rawValue: f.rawValue, payload: f.originalPayload ?? null, pass: f.pass, detail: f.detail ?? null,
    }));
    await tx.unsafe(
      `INSERT INTO document_unresolved_facts (
         account_id, file_id, extraction_id, reason, status, source_unit_ids, raw_key, canonical_key, raw_value,
         original_payload, pass, detail
       )
       SELECT $1, $2, $3, f.reason, f.status, ARRAY(SELECT jsonb_array_elements_text(coalesce(f.units, '[]'::jsonb))),
              f."rawKey", f."canonicalKey", f."rawValue", f.payload, f.pass, f.detail
         FROM jsonb_to_recordset($4::jsonb) AS f(
           reason text, status text, units jsonb, "rawKey" text, "canonicalKey" text, "rawValue" text,
           payload jsonb, pass text, detail text
         )`,
      [p.accountId, p.fileId, p.extractionId, json(lot)] as never[],
    );
  }
  const r = layer.report;
  await tx.unsafe(
    `INSERT INTO document_extraction_coverage (
       file_id, account_id, extraction_id, total_units, covered_units, non_informational_units, unresolved_units,
       uncertain_units, failed_units, facts_count, dropped_facts_count, truncated_sections_count, batched_sections_count,
       chunk_count, repair_pass_count, coverage_ratio, quality_state, anomalies, origin, layer_version,
       retry_attempts, next_retry_at, last_error, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::text[],$19,$20,$21,$22::timestamptz,$23, NOW())
     ON CONFLICT (file_id) DO UPDATE SET
       account_id = EXCLUDED.account_id, extraction_id = EXCLUDED.extraction_id,
       total_units = EXCLUDED.total_units, covered_units = EXCLUDED.covered_units,
       non_informational_units = EXCLUDED.non_informational_units, unresolved_units = EXCLUDED.unresolved_units,
       uncertain_units = EXCLUDED.uncertain_units, failed_units = EXCLUDED.failed_units,
       facts_count = EXCLUDED.facts_count, dropped_facts_count = EXCLUDED.dropped_facts_count,
       truncated_sections_count = EXCLUDED.truncated_sections_count, batched_sections_count = EXCLUDED.batched_sections_count,
       chunk_count = EXCLUDED.chunk_count, repair_pass_count = EXCLUDED.repair_pass_count,
       coverage_ratio = EXCLUDED.coverage_ratio, quality_state = EXCLUDED.quality_state, anomalies = EXCLUDED.anomalies,
       origin = EXCLUDED.origin, layer_version = EXCLUDED.layer_version, retry_attempts = EXCLUDED.retry_attempts,
       next_retry_at = EXCLUDED.next_retry_at, last_error = EXCLUDED.last_error, updated_at = NOW()`,
    [
      p.fileId, p.accountId, p.extractionId, r.totalSourceUnits, r.coveredUnits, r.nonInformationalUnits, r.unresolvedUnits,
      r.uncertainUnits, r.failedUnits, r.factsCount, r.droppedFactsCount, r.truncatedSectionsCount, r.batchedSectionsCount,
      r.chunkCount, r.repairPassCount, r.coverageRatio, r.qualityState, r.anomalies, p.origin ?? 'ANALYSIS', layer.layerVersion,
      retryAttempts,
      (p.nextRetryAt !== undefined ? p.nextRetryAt : (r.qualityState === 'INCOMPLETE_RETRYABLE' ? new Date(Date.now() + 15 * 60_000) : null))?.toISOString() ?? null,
      p.lastError ?? null,
    ] as never[],
  );
}

// ── Lecture ────────────────────────────────────────────────────────────────

export interface StoredSourceUnit {
  fileId: number;
  accountId: number;
  sourceUnitId: string;
  kind: SourceUnitKind;
  page: number | null;
  ordinal: number;
  parentUnitId: string | null;
  text: string | null;
  label: string | null;
  value: string | null;
  payload: Record<string, unknown>;
  location: Record<string, unknown>;
  origin: string;
  salient: boolean;
  coverageStatus: CoverageStatus;
  coverageReason: string | null;
  factCount: number;
  repairAttempts: number;
  /** Faits actifs rattachés à l'unité (provenance inverse), si demandés. */
  facts?: Array<{ id: number; factKey: string; canonicalKey: string | null; valueText: string | null; confidence: string }>;
}

const UNIT_COLUMNS = `
  u.file_id AS "fileId", u.account_id AS "accountId", u.source_unit_id AS "sourceUnitId", u.kind, u.page, u.ordinal,
  u.parent_unit_id AS "parentUnitId", u.content_text AS text, u.label, u.value_text AS value, u.payload, u.location,
  u.origin, u.salient, u.coverage_status AS "coverageStatus", u.coverage_reason AS "coverageReason",
  u.fact_count AS "factCount", u.repair_attempts AS "repairAttempts"`;

export interface LoadSourceUnitsOptions {
  /** Contrôle d'appartenance (recommandé hors traitement interne). */
  accountId?: number;
  statuses?: CoverageStatus[];
  kinds?: SourceUnitKind[];
  pages?: { from?: number; to?: number };
  /** Pagination par ordre de lecture. */
  afterOrdinal?: number;
  limit?: number;
  /** Joindre les faits actifs de chaque unité (provenance). */
  withFacts?: boolean;
}

/**
 * Unités de la source d'un document, dans l'ordre de lecture. Vide si la
 * couche A n'existe pas (document jamais analysé, ou pas encore repris).
 */
export async function loadDocumentSourceUnits(fileId: number, opts: LoadSourceUnitsOptions = {}): Promise<StoredSourceUnit[]> {
  if (!(await sourceLayerReady())) return [];
  const { pgClient } = await import('@/db');
  const rows = (await pgClient.unsafe(
    `SELECT ${UNIT_COLUMNS}
       FROM document_source_units u
      WHERE u.file_id = $1
        AND ($2::int IS NULL OR u.account_id = $2)
        AND ($3::text[] IS NULL OR u.coverage_status = ANY($3::text[]))
        AND ($4::text[] IS NULL OR u.kind = ANY($4::text[]))
        AND ($5::int IS NULL OR u.page >= $5) AND ($6::int IS NULL OR u.page <= $6)
        AND u.ordinal > $7
      ORDER BY u.ordinal
      LIMIT $8`,
    [
      fileId, opts.accountId ?? null, opts.statuses ?? null, opts.kinds ?? null,
      opts.pages?.from ?? null, opts.pages?.to ?? null, opts.afterOrdinal ?? -1, Math.min(Math.max(opts.limit ?? 5_000, 1), 50_000),
    ] as never[],
  )) as unknown as StoredSourceUnit[];
  if (!opts.withFacts || rows.length === 0) return rows;
  const faits = (await pgClient.unsafe(
    `SELECT id::float8 AS id, fact_key AS "factKey", canonical_key AS "canonicalKey", value_text AS "valueText", confidence,
            source_unit_ids AS "unitIds"
       FROM document_facts WHERE file_id = $1 AND status = 'active' AND source_unit_ids IS NOT NULL`,
    [fileId] as never[],
  )) as unknown as Array<{ id: number; factKey: string; canonicalKey: string | null; valueText: string | null; confidence: string; unitIds: string[] }>;
  const parUnite = new Map<string, NonNullable<StoredSourceUnit['facts']>>();
  for (const f of faits) {
    for (const id of new Set((f.unitIds ?? []).map((x) => x.replace(/:cell:\d+$/, '')))) {
      const l = parUnite.get(id) ?? [];
      l.push({ id: f.id, factKey: f.factKey, canonicalKey: f.canonicalKey, valueText: f.valueText, confidence: f.confidence });
      parUnite.set(id, l);
    }
  }
  return rows.map((u) => ({ ...u, facts: parUnite.get(u.sourceUnitId) ?? [] }));
}

export interface StoredCoverage extends T1CompletenessReport {
  fileId: number;
  accountId: number;
  origin: string;
  layerVersion: number;
  retryAttempts: number;
  nextRetryAt: string | null;
  lastError: string | null;
  updatedAt: string;
}

const COVERAGE_COLUMNS = `
  c.file_id AS "fileId", c.account_id AS "accountId", c.total_units AS "totalSourceUnits", c.covered_units AS "coveredUnits",
  c.non_informational_units AS "nonInformationalUnits", c.unresolved_units AS "unresolvedUnits",
  c.uncertain_units AS "uncertainUnits", c.failed_units AS "failedUnits", c.facts_count AS "factsCount",
  c.dropped_facts_count AS "droppedFactsCount", c.truncated_sections_count AS "truncatedSectionsCount",
  c.batched_sections_count AS "batchedSectionsCount", c.chunk_count AS "chunkCount", c.repair_pass_count AS "repairPassCount",
  c.coverage_ratio::float8 AS "coverageRatio", c.quality_state AS "qualityState", c.anomalies, c.origin,
  c.layer_version AS "layerVersion", c.retry_attempts AS "retryAttempts", c.next_retry_at AS "nextRetryAt",
  c.last_error AS "lastError", c.updated_at AS "updatedAt"`;

/** Rapport de complétude courant d'un document (null : aucune couche A). */
export async function loadDocumentCoverage(fileId: number, accountId?: number): Promise<StoredCoverage | null> {
  if (!(await sourceLayerReady())) return null;
  const { pgClient } = await import('@/db');
  const rows = (await pgClient.unsafe(
    `SELECT ${COVERAGE_COLUMNS} FROM document_extraction_coverage c WHERE c.file_id = $1 AND ($2::int IS NULL OR c.account_id = $2)`,
    [fileId, accountId ?? null] as never[],
  )) as unknown as StoredCoverage[];
  return rows[0] ?? null;
}

export interface StoredUnresolvedFact extends UnresolvedFactRecord {
  id: number;
  fileId: number;
  createdAt: string;
}

/** Faits conservés non intégrés tels quels (par défaut : tous les statuts). */
export async function loadUnresolvedDocumentFacts(fileId: number, opts: { accountId?: number; statuses?: string[] } = {}): Promise<StoredUnresolvedFact[]> {
  if (!(await sourceLayerReady())) return [];
  const { pgClient } = await import('@/db');
  return (await pgClient.unsafe(
    `SELECT id::float8 AS id, file_id AS "fileId", reason, status, source_unit_ids AS "sourceUnitIds", raw_key AS "rawKey",
            canonical_key AS "canonicalKey", raw_value AS "rawValue", original_payload AS "originalPayload", pass, detail,
            created_at AS "createdAt"
       FROM document_unresolved_facts
      WHERE file_id = $1 AND ($2::int IS NULL OR account_id = $2) AND ($3::text[] IS NULL OR status = ANY($3::text[]))
      ORDER BY id`,
    [fileId, opts.accountId ?? null, opts.statuses ?? null] as never[],
  )) as unknown as StoredUnresolvedFact[];
}

export interface SourceUnitHit extends StoredSourceUnit {
  documentTitle: string | null;
  assetId: number | null;
  matchedTerms: number;
}

/**
 * Unités d'un compte contenant les termes (début de mot, sans accents ni
 * casse) — documents non supprimés. Sert à retrouver une information que T1
 * n'avait pas su rattacher (« 12 rue Victor Hugo » avant la création du bien).
 */
export async function searchDocumentSourceUnits(
  accountId: number,
  terms: string[],
  opts: { statuses?: CoverageStatus[]; limit?: number; minMatched?: number } = {},
): Promise<SourceUnitHit[]> {
  const clean = terms.map((t) => t.trim()).filter((t) => t.length >= 2).slice(0, 8);
  if (clean.length === 0 || !(await sourceLayerReady())) return [];
  const { pgClient } = await import('@/db');
  const hay = `unaccent(lower(coalesce(u.content_text, '') || ' ' || coalesce(u.label, '') || ' ' || coalesce(u.value_text, '')))`;
  const score = clean.map((_, i) => `(CASE WHEN ${hay} ~ $${i + 4} THEN 1 ELSE 0 END)`).join(' + ');
  const rows = await pgClient.unsafe(
    `SELECT * FROM (
       SELECT ${UNIT_COLUMNS}, coalesce(af.retained_title, af.original_filename) AS "documentTitle",
              coalesce(af.asset_id, af.linked_asset_id) AS "assetId", (${score}) AS "matchedTerms"
         FROM document_source_units u
         JOIN asset_files af ON af.id = u.file_id AND af.deleted_at IS NULL
        WHERE u.account_id = $1 AND ($2::text[] IS NULL OR u.coverage_status = ANY($2::text[]))
     ) s
     WHERE s."matchedTerms" >= $3
     ORDER BY s."matchedTerms" DESC, s."fileId" DESC, s.ordinal
     LIMIT ${Math.min(Math.max(opts.limit ?? 50, 1), 500)}`,
    [accountId, opts.statuses ?? null, Math.max(1, Math.min(opts.minMatched ?? clean.length, clean.length)), ...clean.map(wordStartPattern)] as never[],
  );
  return (rows as unknown as SourceUnitHit[]).map((r) => ({ ...r, matchedTerms: Number(r.matchedTerms) }));
}

/** Documents dont la couche A est à reprendre (états de qualité). */
export async function countByQualityState(): Promise<Record<T1QualityState, number>> {
  const out: Record<T1QualityState, number> = { COMPLETE: 0, COMPLETE_WITH_UNRESOLVED: 0, INCOMPLETE_RETRYABLE: 0, INCOMPLETE_FINAL: 0 };
  if (!(await sourceLayerReady())) return out;
  const { pgClient } = await import('@/db');
  const rows = (await pgClient.unsafe(
    `SELECT quality_state AS q, COUNT(*)::int AS n FROM document_extraction_coverage GROUP BY quality_state`,
  )) as unknown as Array<{ q: T1QualityState; n: number }>;
  for (const r of rows) out[r.q] = Number(r.n);
  return out;
}
