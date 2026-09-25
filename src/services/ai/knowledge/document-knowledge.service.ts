/**
 * Base de connaissance documentaire — persistance, lecture, recherche,
 * projections (T1 → T2 / T3 / T4 et traitements futurs).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * RÈGLE D'USAGE
 *
 * Après un passage de T1, un traitement qui a besoin du CONTENU d'un document
 * lit d'abord ici (`getDocumentKnowledge`, `searchDocumentKnowledge`). Il ne
 * revient au fichier original que pour une vérification ou une nouvelle
 * analyse du contenu brut. Le fichier reste la preuve de référence.
 *
 * ── ÉCRITURE ──────────────────────────────────────────────────────────────
 *
 * Toujours, quel que soit le rattachement : un document sans bien garde son
 * texte, sa description, ses métadonnées et ses faits. Une nouvelle analyse
 * remplace la ligne courante et fait passer les faits précédents en
 * `superseded` (transaction unique : jamais d'état mixte lisible).
 *
 * ── PROJECTIONS ───────────────────────────────────────────────────────────
 *
 * `projectDocumentKnowledgeToAsset` produit les preuves par champ du bien
 * (`field_evidence`) à partir des faits persistés, puis relance la
 * réconciliation (T3). C'est ce qui permet de rattacher un document à un bien
 * APRÈS son analyse sans relire le fichier.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';
import type { DocumentKnowledge, DocumentFactRecord } from './document-knowledge';
import { factsToExtractedFields } from './document-knowledge';
import type { TableCellRow } from './document-tables';
import type { ExtractedTableCell } from '../source-analysis/types';

const json = (v: unknown) => JSON.stringify(v ?? null);

/** Enregistre la représentation courante d'un document. Rend l'id d'extraction. */
export async function persistDocumentKnowledge(k: DocumentKnowledge): Promise<number> {
  const e = k.extraction;
  let extractionId = 0;

  await pgClient.begin(async (tx) => {
    const rows = await tx.unsafe(
      `INSERT INTO document_extractions (
         account_id, file_id, analysis_run_id, asset_id_at_analysis, engine, source_type, source_version,
         title, description, document_date, supplier_name, supplier_siret, amount_cents, currency,
         full_text, full_text_chars, document_type_code, rubric_code, has_exploitable_content,
         structural_evidence, metadata, fact_count, provider, model, prompt_version, operation_trace_id,
         visual_summary, visual_observations,
         extracted_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::date,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21::jsonb,$22,$23,$24,$25,$26,$27,$28::jsonb, now(), now())
       ON CONFLICT (file_id) DO UPDATE SET
         account_id = EXCLUDED.account_id,
         analysis_run_id = EXCLUDED.analysis_run_id,
         asset_id_at_analysis = EXCLUDED.asset_id_at_analysis,
         engine = EXCLUDED.engine,
         source_type = EXCLUDED.source_type,
         source_version = EXCLUDED.source_version,
         title = EXCLUDED.title,
         description = EXCLUDED.description,
         document_date = EXCLUDED.document_date,
         supplier_name = EXCLUDED.supplier_name,
         supplier_siret = EXCLUDED.supplier_siret,
         amount_cents = EXCLUDED.amount_cents,
         currency = EXCLUDED.currency,
         full_text = EXCLUDED.full_text,
         full_text_chars = EXCLUDED.full_text_chars,
         document_type_code = EXCLUDED.document_type_code,
         rubric_code = EXCLUDED.rubric_code,
         has_exploitable_content = EXCLUDED.has_exploitable_content,
         structural_evidence = EXCLUDED.structural_evidence,
         metadata = EXCLUDED.metadata,
         fact_count = EXCLUDED.fact_count,
         provider = EXCLUDED.provider,
         model = EXCLUDED.model,
         prompt_version = EXCLUDED.prompt_version,
         operation_trace_id = EXCLUDED.operation_trace_id,
         visual_summary = EXCLUDED.visual_summary,
         visual_observations = EXCLUDED.visual_observations,
         extracted_at = now(),
         updated_at = now()
       RETURNING id`,
      [
        e.accountId, e.fileId, e.analysisRunId, e.assetIdAtAnalysis, e.engine, e.sourceType, e.sourceVersion,
        e.title, e.description, e.documentDate, e.supplierName, e.supplierSiret, e.amountCents, e.currency,
        e.fullText, e.fullText?.length ?? 0, e.documentTypeCode, e.rubricCode, e.hasExploitableContent,
        json(e.structuralEvidence), json(e.metadata), k.facts.length, e.provider, e.model, e.promptVersion, e.operationTraceId,
        e.visualSummary ?? null, json(e.visualObservations ?? []),
      ] as never[],
    );
    extractionId = (rows as unknown as Array<{ id: number }>)[0].id;

    // Les faits précédents ne sont pas effacés : ils cessent d'être courants.
    await tx.unsafe(
      `UPDATE document_facts SET status = 'superseded' WHERE file_id = $1 AND status = 'active'`,
      [e.fileId] as never[],
    );
    // Idem pour les tableaux : une nouvelle lecture remplace la structure.
    await tx.unsafe(
      `UPDATE document_tables SET status = 'superseded' WHERE file_id = $1 AND status = 'active'`,
      [e.fileId] as never[],
    );
    for (const t of k.tables ?? []) {
      const [row] = (await tx.unsafe(
        `INSERT INTO document_tables (
           account_id, file_id, extraction_id, table_index, title, page_start, page_end,
           column_count, row_count, columns, confidence, uncertain, issues,
           source_version, provider, model, prompt_version, status
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13::jsonb,$14,$15,$16,$17,'active')
         RETURNING id`,
        [
          e.accountId, e.fileId, extractionId, t.index, t.title, t.pageStart, t.pageEnd,
          t.columnCount, t.rowCount, json(t.columns), t.confidence, t.uncertain, json(t.issues),
          e.sourceVersion, e.provider, e.model, e.promptVersion,
        ] as never[],
      )) as unknown as Array<{ id: number }>;
      if (t.cells.length === 0) continue;
      // Une seule requête par tableau : les cellules voyagent en JSON.
      await tx.unsafe(
        `INSERT INTO document_table_cells (
           table_id, account_id, file_id, row_index, column_index, row_header, column_header, column_path,
           value_text, normalized_value, value_type, is_empty, colspan, rowspan, page, confidence
         )
         SELECT $1, $2, $3, c.row, c.column, c."rowHeader", c."columnHeader", coalesce(c."columnPath", '[]'::jsonb),
                c.value, c.normalized, c."valueType", c.value IS NULL, coalesce(c.colspan, 1), coalesce(c.rowspan, 1),
                c.page, c.confidence
           FROM jsonb_to_recordset($4::jsonb) AS c(
             "row" int, "column" int, "rowHeader" text, "columnHeader" text, "columnPath" jsonb,
             value text, normalized text, "valueType" text, colspan int, rowspan int, page int, confidence text
           )`,
        [row.id, e.accountId, e.fileId, json(t.cells)] as never[],
      );
    }

    for (const f of k.facts) {
      await tx.unsafe(
        `INSERT INTO document_facts (
           account_id, file_id, extraction_id, fact_key, subject, attribute, label,
           value_text, value_number, value_unit, value_json, normalized_value, period_start, period_end,
           confidence, excerpt, location, source_type, provider, model, prompt_version, status,
           evidence_origin, visual_evidence
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13::date,$14::date,$15,$16,$17::jsonb,$18,$19,$20,$21,'active',$22,$23::jsonb)`,
        [
          e.accountId, e.fileId, extractionId, f.factKey, f.subject, f.attribute, f.label,
          f.valueText, f.valueNumber, f.valueUnit, json(f.valueJson), f.normalizedValue, f.periodStart, f.periodEnd,
          // Observation visuelle : aucune citation (la contrainte 0161 l'impose aussi).
          f.confidence, f.evidenceOrigin === 'VISUAL_ANALYSIS' ? null : f.excerpt, json(f.location), e.sourceType, e.provider, e.model, e.promptVersion,
          f.evidenceOrigin ?? 'TEXT_EXTRACTION',
          f.evidenceOrigin === 'VISUAL_ANALYSIS' && f.visualEvidence ? json({ ...f.visualEvidence, fileId: e.fileId }) : null,
        ] as never[],
      );
    }
  });

  return extractionId;
}

// ── Lecture ────────────────────────────────────────────────────────────────

export interface StoredTable {
  id: number;
  fileId: number;
  index: number;
  title: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  columns: Array<{ header: string; path: string[] }>;
  rowCount: number;
  columnCount: number;
  confidence: string;
  uncertain: boolean;
  issues: string[];
  cells: ExtractedTableCell[];
}

async function loadTables(where: string, params: unknown[]): Promise<StoredTable[]> {
  const tables = (await pgClient.unsafe(
    `SELECT id::float8 AS id, file_id AS "fileId", table_index AS index, title, page_start AS "pageStart", page_end AS "pageEnd",
            columns, row_count AS "rowCount", column_count AS "columnCount", confidence, uncertain, issues
       FROM document_tables WHERE ${where} AND status = 'active' ORDER BY table_index`,
    params as never[],
  )) as unknown as Array<Omit<StoredTable, 'cells'>>;
  if (tables.length === 0) return [];
  const cells = (await pgClient.unsafe(
    `SELECT table_id::float8 AS "tableId", row_index AS row, column_index AS column, row_header AS "rowHeader",
            column_header AS "columnHeader", column_path AS "columnPath", value_text AS value,
            normalized_value AS normalized, value_type AS "valueType", colspan, rowspan, page, confidence
       FROM document_table_cells WHERE table_id = ANY($1::bigint[]) ORDER BY table_id, row_index, column_index`,
    [tables.map((t) => t.id)] as never[],
  )) as unknown as Array<ExtractedTableCell & { tableId: number }>;
  return tables.map((t) => ({ ...t, cells: cells.filter((c) => c.tableId === t.id).map(({ tableId: _t, ...c }) => c) }));
}

/** Tableaux courants d'un document (structure complète). */
export function getDocumentTables(accountId: number, fileId: number): Promise<StoredTable[]> {
  return loadTables('account_id = $1 AND file_id = $2', [accountId, fileId]);
}

/** Un tableau précis — revalidation ciblée (T2-07) : on relit CE tableau, pas le document. */
export async function getDocumentTable(accountId: number, tableId: number): Promise<StoredTable | null> {
  return (await loadTables('account_id = $1 AND id = $2', [accountId, tableId]))[0] ?? null;
}

/**
 * Cellules des lignes où un terme apparaît (en-tête de ligne, de colonne,
 * titre ou valeur) — avec TOUTES les cellules de ces lignes, pour que T2
 * puisse lire l'intersection ligne / colonne sans rouvrir le document.
 */
export async function searchTableCells(
  accountId: number,
  terms: string[],
  opts: { assetId?: number | null; limit?: number } = {},
): Promise<TableCellRow[]> {
  const clean = terms.map((t) => t.trim()).filter((t) => t.length >= 3).slice(0, 8);
  if (clean.length === 0) return [];
  const hay = `unaccent(lower(coalesce(c.row_header,'') || ' ' || coalesce(c.column_header,'') || ' ' || coalesce(c.value_text,'') || ' ' || coalesce(t.title,'')))`;
  const cond = clean.map((_, i) => `${hay} LIKE unaccent(lower($${i + 3}))`).join(' OR ');
  const rows = await pgClient.unsafe(
    `WITH lignes AS (
       SELECT DISTINCT c.table_id, c.row_index
         FROM document_table_cells c
         JOIN document_tables t ON t.id = c.table_id AND t.status = 'active'
         JOIN asset_files af ON af.id = t.file_id AND af.deleted_at IS NULL
        WHERE c.account_id = $1
          AND ($2::int IS NULL OR af.asset_id = $2 OR af.linked_asset_id = $2)
          AND (${cond})
        LIMIT ${Math.min(Math.max(opts.limit ?? 200, 1), 500)}
     )
     SELECT c.table_id::float8 AS "tableId", t.file_id AS "fileId",
            coalesce(af.retained_title, af.original_filename) AS "documentTitle",
            t.title AS "tableTitle", t.uncertain AS "tableUncertain",
            c.row_index AS row, c.column_index AS column, c.row_header AS "rowHeader",
            c.column_header AS "columnHeader", c.column_path AS "columnPath",
            c.value_text AS value, c.normalized_value AS normalized, c.page, c.confidence
       FROM lignes l
       JOIN document_table_cells c ON c.table_id = l.table_id AND c.row_index = l.row_index
       JOIN document_tables t ON t.id = c.table_id
       JOIN asset_files af ON af.id = t.file_id
      ORDER BY c.table_id, c.row_index, c.column_index`,
    [accountId, opts.assetId ?? null, ...clean.map((t) => `%${t}%`)] as never[],
  );
  return rows as unknown as TableCellRow[];
}

export interface StoredExtraction {
  id: number;
  accountId: number;
  fileId: number;
  engine: string;
  title: string | null;
  description: string | null;
  documentDate: string | null;
  supplierName: string | null;
  amountCents: number | null;
  currency: string;
  fullText: string | null;
  visualSummary: string | null;
  visualObservations: unknown[];
  documentTypeCode: string | null;
  rubricCode: string | null;
  structuralEvidence: Record<string, unknown>;
  metadata: Record<string, unknown>;
  factCount: number;
  model: string | null;
  promptVersion: string | null;
  extractedAt: string;
}

export interface StoredFact extends DocumentFactRecord {
  id: number;
  fileId: number;
  extractionId: number;
  model: string | null;
  promptVersion: string | null;
  createdAt: string;
}

const EXTRACTION_COLUMNS = `
  id, account_id AS "accountId", file_id AS "fileId", engine, title, description,
  to_char(document_date, 'YYYY-MM-DD') AS "documentDate", supplier_name AS "supplierName",
  amount_cents::int AS "amountCents", currency, full_text AS "fullText",
  visual_summary AS "visualSummary", visual_observations AS "visualObservations",
  document_type_code AS "documentTypeCode", rubric_code AS "rubricCode",
  structural_evidence AS "structuralEvidence", metadata, fact_count AS "factCount",
  model, prompt_version AS "promptVersion", extracted_at AS "extractedAt"`;

/** Colonnes d'un fait, préfixées par l'alias de table (`f.` ou rien). */
function factColumns(alias = ''): string {
  const a = alias ? `${alias}.` : '';
  return `
  ${a}id::float8 AS id, ${a}file_id AS "fileId", ${a}extraction_id AS "extractionId", ${a}fact_key AS "factKey",
  ${a}subject, ${a}attribute, ${a}label,
  ${a}value_text AS "valueText", ${a}value_number::float8 AS "valueNumber", ${a}value_unit AS "valueUnit",
  ${a}value_json AS "valueJson", ${a}normalized_value AS "normalizedValue",
  to_char(${a}period_start, 'YYYY-MM-DD') AS "periodStart", to_char(${a}period_end, 'YYYY-MM-DD') AS "periodEnd",
  ${a}confidence, ${a}excerpt, ${a}location,
  ${a}evidence_origin AS "evidenceOrigin", ${a}visual_evidence AS "visualEvidence", ${a}model, ${a}prompt_version AS "promptVersion", ${a}created_at AS "createdAt"`;
}

/** Représentation courante d'un document (null si T1 n'est jamais passé). */
export async function getDocumentKnowledge(
  accountId: number,
  fileId: number,
): Promise<{ extraction: StoredExtraction; facts: StoredFact[] } | null> {
  const rows = await pgClient.unsafe(
    `SELECT ${EXTRACTION_COLUMNS} FROM document_extractions WHERE account_id = $1 AND file_id = $2 LIMIT 1`,
    [accountId, fileId] as never[],
  );
  const extraction = (rows as unknown as StoredExtraction[])[0];
  if (!extraction) return null;
  const facts = await pgClient.unsafe(
    `SELECT ${factColumns()} FROM document_facts WHERE file_id = $1 AND status = 'active' ORDER BY id`,
    [fileId] as never[],
  );
  return { extraction, facts: facts as unknown as StoredFact[] };
}

/** Vrai si le document possède une représentation T1 exploitable. */
export async function hasDocumentKnowledge(fileId: number): Promise<boolean> {
  const rows = await pgClient.unsafe(
    `SELECT 1 FROM document_extractions WHERE file_id = $1 LIMIT 1`,
    [fileId] as never[],
  );
  return (rows as unknown as unknown[]).length > 0;
}

/**
 * Vrai si le document possède des faits T1 actifs, donc projetables sur un
 * bien. Une représentation issue du moteur historique (texte seul, sans
 * faits) ne suffit pas : le rattachement doit alors relancer l'analyse.
 */
export async function hasProjectableKnowledge(fileId: number): Promise<boolean> {
  const rows = await pgClient.unsafe(
    `SELECT 1 FROM document_facts WHERE file_id = $1 AND status = 'active' LIMIT 1`,
    [fileId] as never[],
  );
  return (rows as unknown as unknown[]).length > 0;
}

// ── Recherche (T2, niveau 2) ───────────────────────────────────────────────

export interface KnowledgeFactHit extends StoredFact {
  documentTitle: string | null;
  assetId: number | null;
  /** Nombre de termes de la requête retrouvés dans le fait (0 à n). */
  matchedTerms: number;
}

export interface KnowledgeTextHit {
  fileId: number;
  title: string | null;
  assetId: number | null;
  snippet: string;
  matchedTerms: number;
}

/**
 * Faits actifs du compte correspondant aux termes (sujet, attribut, libellé,
 * clé, valeur). Insensible à la casse et aux accents. Les faits des
 * documents supprimés sont exclus.
 */
export async function searchDocumentFacts(
  accountId: number,
  terms: string[],
  opts: { assetId?: number | null; limit?: number } = {},
): Promise<KnowledgeFactHit[]> {
  const clean = terms.map((t) => t.trim()).filter((t) => t.length >= 3).slice(0, 8);
  if (clean.length === 0) return [];
  const haystack = `unaccent(lower(coalesce(f.fact_key,'') || ' ' || coalesce(f.subject,'') || ' ' || coalesce(f.attribute,'') || ' ' || coalesce(f.label,'') || ' ' || coalesce(f.value_text,'')))`;
  const scoreSql = clean.map((_, i) => `(CASE WHEN ${haystack} LIKE unaccent(lower($${i + 3})) THEN 1 ELSE 0 END)`).join(' + ');
  const params: unknown[] = [accountId, opts.assetId ?? null, ...clean.map((t) => `%${t}%`)];
  const rows = await pgClient.unsafe(
    `SELECT * FROM (
       SELECT ${factColumns('f')},
              coalesce(af.retained_title, af.original_filename) AS "documentTitle",
              coalesce(af.asset_id, af.linked_asset_id) AS "assetId",
              (${scoreSql}) AS "matchedTerms"
         FROM document_facts f
         JOIN asset_files af ON af.id = f.file_id AND af.deleted_at IS NULL
        WHERE f.account_id = $1 AND f.status = 'active'
          AND ($2::int IS NULL OR af.asset_id = $2 OR af.linked_asset_id = $2)
     ) s
     WHERE s."matchedTerms" > 0
     ORDER BY s."matchedTerms" DESC, s.id DESC
     LIMIT ${Math.min(Math.max(opts.limit ?? 20, 1), 100)}`,
    params as never[],
  );
  return rows as unknown as KnowledgeFactHit[];
}

/**
 * Documents dont le contenu extrait (titre, description, émetteur, texte
 * intégral) contient les termes. Rend un extrait autour de la 1re occurrence.
 */
export async function searchDocumentText(
  accountId: number,
  terms: string[],
  opts: { assetId?: number | null; limit?: number } = {},
): Promise<KnowledgeTextHit[]> {
  const clean = terms.map((t) => t.trim()).filter((t) => t.length >= 3).slice(0, 8);
  if (clean.length === 0) return [];
  const haystack = `unaccent(lower(coalesce(e.title,'') || ' ' || coalesce(e.description,'') || ' ' || coalesce(e.supplier_name,'') || ' ' || coalesce(e.full_text,'')))`;
  const scoreSql = clean.map((_, i) => `(CASE WHEN ${haystack} LIKE unaccent(lower($${i + 3})) THEN 1 ELSE 0 END)`).join(' + ');
  const params: unknown[] = [accountId, opts.assetId ?? null, ...clean.map((t) => `%${t}%`)];
  const rows = await pgClient.unsafe(
    `SELECT * FROM (
       SELECT e.file_id AS "fileId", e.title,
              coalesce(af.asset_id, af.linked_asset_id) AS "assetId",
              coalesce(e.full_text, e.description, '') AS body,
              (${scoreSql}) AS "matchedTerms"
         FROM document_extractions e
         JOIN asset_files af ON af.id = e.file_id AND af.deleted_at IS NULL
        WHERE e.account_id = $1
          AND ($2::int IS NULL OR af.asset_id = $2 OR af.linked_asset_id = $2)
     ) s
     WHERE s."matchedTerms" > 0
     ORDER BY s."matchedTerms" DESC
     LIMIT ${Math.min(Math.max(opts.limit ?? 10, 1), 50)}`,
    params as never[],
  );
  return (rows as unknown as Array<Omit<KnowledgeTextHit, 'snippet'> & { body: string }>).map((r) => ({
    fileId: r.fileId,
    title: r.title,
    assetId: r.assetId,
    matchedTerms: Number(r.matchedTerms),
    snippet: snippetAround(r.body, clean),
  }));
}

/** Extrait d'environ 240 caractères autour du premier terme trouvé. */
export function snippetAround(body: string, terms: string[]): string {
  if (!body) return '';
  const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const hay = plain(body);
  let at = -1;
  for (const t of terms) {
    const i = hay.indexOf(plain(t));
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return body.slice(0, 240).trim();
  const start = Math.max(0, at - 100);
  const end = Math.min(body.length, at + 140);
  return `${start > 0 ? '…' : ''}${body.slice(start, end).trim()}${end < body.length ? '…' : ''}`;
}

// ── Projections métier (niveau 3) ──────────────────────────────────────────

/**
 * Projette les faits persistés d'un document sur un bien : preuves par champ
 * (`field_evidence`) puis réconciliation (T3). Aucune lecture du fichier.
 *
 * Rend le nombre de preuves produites (0 si aucune représentation T1).
 */
export async function projectDocumentKnowledgeToAsset(p: {
  accountId: number;
  userId: number;
  fileId: number;
  assetId: number;
}): Promise<number> {
  const knowledge = await getDocumentKnowledge(p.accountId, p.fileId);
  if (!knowledge || knowledge.facts.length === 0) return 0;

  const { persistEvidence } = await import('../source-analysis/steps/persist-evidence.step');
  const byField = await persistEvidence({
    input: {
      sourceType: 'file',
      sourceIds: [p.fileId],
      accountId: p.accountId,
      userId: p.userId,
      mimeTypes: [],
      displayNames: [],
    },
    leadSourceId: p.fileId,
    assetId: p.assetId,
    fields: factsToExtractedFields(knowledge.facts),
    documentType: (knowledge.extraction.metadata?.legacyDocumentType as string | undefined) ?? undefined,
    documentDate: knowledge.extraction.documentDate ?? undefined,
    trace: {
      traceIds: [], operationCodes: ['knowledge_projection'], totalInputTokens: 0, totalOutputTokens: 0,
      totalCostMicros: 0, totalDurationMs: 0, usedFallback: false,
      models: knowledge.extraction.model ? [knowledge.extraction.model] : [],
    },
  });

  // T3 : même moteur que pour un document analysé, déclenché par le rattachement.
  const { reconcileAsset } = await import('../reconciliation');
  await reconcileAsset({
    accountId: p.accountId,
    userId: p.userId,
    assetId: p.assetId,
    triggeredBy: 'document_linked',
    sourceFileId: p.fileId,
  }).catch((e: Error) => console.error('[knowledge] réconciliation après rattachement :', e.message));

  // Rattachement d'un document : impact possible au-delà de ce bien (T3,
  // différé — la réconciliation locale ci-dessus traite l'immédiat).
  const { notifyCoherenceEvent } = await import('../reconciliation/account-reconciliation.service');
  notifyCoherenceEvent(p.accountId, { event: 'document_linked', objectType: 'asset', objectId: p.assetId });

  return byField.size;
}

// ── Moteur historique ──────────────────────────────────────────────────────

/**
 * Représentation minimale issue du moteur historique (`AI_UNIFIED_SOURCE_ANALYSIS`
 * ≠ `enabled`).
 *
 * Ce moteur ne produit ni faits génériques ni extraits justificatifs : seuls
 * le contenu source (texte brut, titre, description, date, émetteur,
 * montant) est repris, depuis ses propositions et `asset_files`. C'est
 * suffisant pour que T2 réponde sur le texte d'un document sans le relire ;
 * les faits génériques arriveront avec le moteur unifié.
 */
export async function persistKnowledgeFromLegacyRun(p: {
  accountId: number;
  fileId: number;
  runId: number;
}): Promise<number | null> {
  const [file] = (await pgClient.unsafe(
    `SELECT extracted_text AS "extractedText", coalesce(asset_id, linked_asset_id) AS "assetId",
            retained_title AS "retainedTitle", description, supplier, amount_cents::int AS "amountCents",
            to_char(document_date, 'YYYY-MM-DD') AS "documentDate", rubric_code AS "rubricCode",
            document_type_code AS "documentTypeCode", document_type AS "documentType"
       FROM asset_files WHERE id = $1 AND account_id = $2`,
    [p.fileId, p.accountId] as never[],
  )) as unknown as Array<Record<string, string | number | null>>;
  if (!file) return null;

  const proposals = (await pgClient.unsafe(
    `SELECT target_key AS "targetKey", proposed_value_json AS "value", confidence
       FROM document_analysis_proposals WHERE run_id = $1 AND proposal_type IN ('field', 'derived_date')`,
    [p.runId] as never[],
  )) as unknown as Array<{ targetKey: string; value: string; confidence: string | null }>;
  const [run] = (await pgClient.unsafe(
    `SELECT model, prompt_version AS "promptVersion" FROM document_analysis_runs WHERE id = $1`,
    [p.runId] as never[],
  )) as unknown as Array<{ model: string | null; promptVersion: string | null }>;

  const proposed = (key: string): unknown => {
    const row = proposals.find((r) => r.targetKey === key);
    if (!row) return undefined;
    try { return JSON.parse(row.value); } catch { return row.value; }
  };
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const date = str(proposed('documentDate')) ?? (file.documentDate as string | null);
  const amount = proposed('amountCents');

  return persistDocumentKnowledge({
    extraction: {
      accountId: p.accountId,
      fileId: p.fileId,
      analysisRunId: p.runId,
      assetIdAtAnalysis: (file.assetId as number | null) ?? null,
      engine: 'legacy',
      sourceType: 'asset_file',
      sourceVersion: null,
      title: str(proposed('retainedTitle')) ?? (file.retainedTitle as string | null),
      description: str(proposed('description')) ?? (file.description as string | null),
      documentDate: date && /^\d{4}-\d{2}-\d{2}/.test(date) ? date.slice(0, 10) : null,
      supplierName: str(proposed('supplier')) ?? (file.supplier as string | null),
      supplierSiret: null,
      amountCents: typeof amount === 'number' ? Math.round(amount) : (file.amountCents as number | null),
      currency: 'EUR',
      fullText: (file.extractedText as string | null)?.trim() || null,
      // L'ancien moteur ne distinguait pas le visuel : rien n'est reconstruit.
      visualSummary: null,
      visualObservations: [],
      documentTypeCode: (file.documentTypeCode as string | null) ?? null,
      rubricCode: (file.rubricCode as string | null) ?? null,
      hasExploitableContent: true,
      structuralEvidence: {},
      metadata: { legacyDocumentType: file.documentType ?? null, genericFacts: 'unavailable_in_legacy_engine' },
      provider: 'gemini',
      model: run?.model ?? null,
      promptVersion: run?.promptVersion ?? null,
      operationTraceId: null,
    },
    facts: [],
  });
}
