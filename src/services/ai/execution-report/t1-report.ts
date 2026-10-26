/**
 * Rapport d'exécution T1 — lot 58C. Un rapport par document (groupe) analysé.
 *
 * INVENTAIRE DES ÉCRITURES T1 (pipeline `runSourceAnalysis`, relu ici) :
 *   1. `persistAnalysisResult`   → document_analysis_runs, document_analysis_proposals
 *   2. `persistDocumentKnowledge` (UNE transaction) → document_extractions (UPSERT
 *      par fichier), document_facts (nouveaux `active`, anciens `superseded`),
 *      document_tables / document_table_cells (idem), couche A :
 *      document_source_units et document_unresolved_facts (remplacés),
 *      document_extraction_coverage (UPSERT), document_operation_candidates
 *   3. `ensureBusinessTitle`      → asset_files.retained_title, document_title_events
 *   4. `applyV2Classification`    → asset_files (rubrique / type), cartes « À traiter »
 *   5. `persistProjectedFacts`    → field_evidence (nouvelles ACTIVE, anciennes SUPERSEDED)
 *   6. `writeMasterDocumentLinks` → document_asset_links ; `writeAutomaticPrimaryColumn` → asset_files.asset_id
 *   7. `syncDocumentRulesFromAnalysis` → document_rule_evaluations (0418), cartes « À traiter »
 *   8. `setState` / `failSources` → asset_files.analysis_state / analysis_fail_reason
 *   9. hors pipeline : couverture (reprises `source-units/jobs`), rejeu
 *      `ai_output_replays` — tracés par leurs propres écrans (BO › Complétude T1).
 *  10. lot 75C : `markOcr` → document_raw_extracts.ocr_* (pages sans couche
 *      texte transcrites par la lecture du modèle) ; `applyReliableFacts` →
 *      attributs métier (assets / equipments / substructures, même primitive
 *      que T3) ; `finalizeRunWrites` → document_analysis_runs.writes_status.
 *
 * Lot 75C — le rapport distingue : données extraites ET enregistrées
 * (`WRITTEN`), extraites mais NON persistées (`NOT_PERSISTED`, `FAILED`),
 * non extraites ou non vérifiables (`NOT_EXAMINED` : page illisible,
 * extract tronqué), volontairement non projetées (`NOT_WRITTEN`, motif), et
 * échecs techniques (étapes `FAILED`, phases). Le statut n'est jamais
 * « réussi » quand une phase est partielle ou en échec.
 *
 * Chaque ligne `WRITTEN` vient d'une RELECTURE en base après l'exécution (ou
 * d'un identifiant rendu par RETURNING). Une donnée déclarée par l'analyse et
 * absente de la base est `NOT_PERSISTED`, avec le motif (étape en échec, ou
 * écartée par l'écriture). Une étape en échec est visible dans `steps`.
 */
import { currentBusinessExecutionId, currentBusinessExecutionOrigin } from '../business-execution/context';
import { pgClient } from '@/db';
import { currentJobContext } from '../queue/job-context';
import {
  errorText, factMatchKey, reportStatus, T1_PROJECTION_REASON, unmatchedDeclared, valueOrRef, valueTypeOf,
  type ReportEntry, type ReportStep,
} from './model';
import { writeExecutionReport } from './repository';
import type { DocumentKnowledge } from '../knowledge/document-knowledge';
import type { ProjectedFact } from '../source-analysis/master/t1-contract';
import type { PersistProjectedFactsResult } from '../source-analysis/steps/persist-evidence.step';
import { PERSISTENCE_BLOCKING_STEPS, PERSISTENCE_SECONDARY_STEPS, type RawExtractSummary } from '../source-analysis/raw-extract/raw-extract.service';
import { ocrGaps, type OcrResult } from '../source-analysis/raw-extract/ocr-pages';
import type { AttributeProjection } from '../source-analysis/steps/apply-reliable-facts.step';

type Row = Record<string, unknown>;

/** Collecte, pendant l'exécution, ce que la base ne dit pas seule : étapes, déclaré, projection. */
export class T1ExecutionRecorder {
  readonly startedAt = new Date();
  readonly steps: ReportStep[] = [];
  knowledge: DocumentKnowledge | null = null;
  extractionId: number | null = null;
  analysisRunId: number | null = null;
  deduplicated = false;
  projection: PersistProjectedFactsResult | null = null;
  masterFacts: ProjectedFact[] = [];
  traceIds: string[] = [];
  /** Échec bloquant du groupe (master, persistance du run, preuves). */
  failure: string | null = null;
  /** Lot 61 : extracts bruts déterministes du groupe (phase EXTRACTION). */
  rawExtracts: RawExtractSummary[] = [];
  /** Lot 75C (B) : transcription des pages sans couche texte, par fichier (null : non persistée). */
  ocr = new Map<number, { result: OcrResult; persisted: boolean }>();
  /** Lot 75C (D) : attributs métier alimentés directement par T1. */
  attributes: AttributeProjection[] = [];
  /** Lot 75C (H) : tentatives d'appel du modèle (trace, modèle, code, étape) — renseignées aussi en ÉCHEC. */
  attempts: AttemptTrace[] = [];

  ok(step: string, detail?: Record<string, unknown>): void {
    this.steps.push({ step, status: 'OK', error: null, detail: detail ?? null });
  }
  fail(step: string, e: unknown, detail?: Record<string, unknown>): void {
    this.steps.push({ step, status: 'FAILED', error: errorText(e), ...(detail ? { detail } : {}) });
  }
  skip(step: string, why: string): void {
    this.steps.push({ step, status: 'SKIPPED', error: null, detail: { why } });
  }
  /** Exécute une étape BLOQUANTE : résultat enregistré, erreur relevée. */
  async run<T>(step: string, fn: () => Promise<T>): Promise<T> {
    try {
      const r = await fn();
      this.ok(step);
      return r;
    } catch (e) {
      this.fail(step, e);
      throw e;
    }
  }
}

const n = (v: unknown) => (v == null ? null : Number(v));

/** Lot 75C (H) : une tentative d'appel du modèle pour ce document. */
interface AttemptTrace {
  traceId: string;
  model: string | null;
  modelRank: string | null;
  outcome: string | null;
  errorCode: string | null;
  failureFamily: string | null;
  stage: string | null;
  callKind: string | null;
  operationCode: string | null;
}

/** Identifiant de trace porté par une erreur de la passerelle (ou sa cause). Pur. */
export function traceIdsOfError(e: unknown): string[] {
  const out: string[] = [];
  let x: unknown = e;
  for (let i = 0; i < 5 && x && typeof x === 'object'; i++) {
    const t = (x as { traceId?: unknown }).traceId;
    if (typeof t === 'string' && t) out.push(t);
    x = (x as { cause?: unknown }).cause;
  }
  return out;
}

/**
 * Lot 75C (ticket T1 résiduels, H) — tentatives d'appel du modèle pour ce
 * document depuis `since` (diagnostics d'appel, par fichier source, joints à
 * l'événement d'usage pour le code d'erreur) : rattachées au rapport T1 MÊME
 * quand Gemini échoue. Ne lève jamais (rapport réduit à l'identifiant porté
 * par l'erreur).
 */
export async function collectAttemptTraces(p: { accountId: number; fileIds: number[]; since: Date; error?: unknown }): Promise<{ traceIds: string[]; attempts: AttemptTrace[] }> {
  const deLErreur = traceIdsOfError(p.error);
  let attempts: AttemptTrace[] = [];
  try {
    const rows = (await pgClient.unsafe(
      `SELECT d.trace_id, d.model, d.model_rank, d.outcome, d.failure_family, d.failure_stage, d.call_kind, d.operation_code, u.error_code
         FROM ai_call_diagnostics d
         LEFT JOIN ai_usage_event u ON u.id = d.usage_event_id
        WHERE d.account_id = $1 AND d.source_ids && $2::int[] AND d.created_at >= $3
        ORDER BY d.id LIMIT 50`,
      [p.accountId, p.fileIds, p.since.toISOString()] as never[],
    )) as unknown as Row[];
    attempts = rows.map((r) => ({
      traceId: String(r.trace_id), model: (r.model as string | null) ?? null, modelRank: (r.model_rank as string | null) ?? null,
      outcome: (r.outcome as string | null) ?? null, errorCode: (r.error_code as string | null) ?? null,
      failureFamily: (r.failure_family as string | null) ?? null, stage: (r.failure_stage as string | null) ?? null,
      callKind: (r.call_kind as string | null) ?? null, operationCode: (r.operation_code as string | null) ?? null,
    }));
  } catch (e) {
    console.error('[execution-report] tentatives du modèle non relues :', errorText(e));
  }
  return { traceIds: [...new Set([...deLErreur, ...attempts.map((a) => a.traceId)])], attempts };
}

type T1PhaseState = 'SUCCEEDED' | 'PARTIAL' | 'FAILED' | 'NOT_RUN';
interface T1Phase { state: T1PhaseState; detail: Record<string, unknown> }

/**
 * Lot 61 (ticket T1 §6, §7 D) — statut SÉPARÉ des trois phases (pur) :
 *   · extraction   : extract brut déterministe (réutilisé ou non, pages sans
 *     couche texte → OCR par le modèle, troncature) ;
 *   · structuration : appel master (code et étape de l'erreur) ;
 *   · persistance  : écritures bloquantes / secondaires.
 * Écrit dans `sources.phases` du rapport : n'altère pas le statut métier.
 */
export function t1Phases(rec: Pick<T1ExecutionRecorder, 'steps' | 'rawExtracts' | 'failure'> & Partial<Pick<T1ExecutionRecorder, 'ocr'>>): { extraction: T1Phase; structuring: T1Phase; persistence: T1Phase } {
  const step = (name: string) => rec.steps.find((s) => s.step === name);
  const raws = rec.rawExtracts;
  const ecriture = step('RAW_EXTRACT');
  const extraction: T1Phase = raws.length === 0 && ecriture?.status !== 'FAILED'
    ? { state: 'NOT_RUN', detail: { reason: 'aucun extract brut (source non fichier)' } }
    : extractionPhase(raws, rec.ocr ?? new Map(), ecriture?.status === 'FAILED' ? ecriture.error ?? 'échec' : null);
  const m = step('MASTER');
  const structuring: T1Phase = !m ? { state: 'NOT_RUN', detail: {} }
    : m.status === 'OK' ? { state: 'SUCCEEDED', detail: m.detail ?? {} }
      : { state: 'FAILED', detail: { error: m.error ?? null, ...(m.detail ?? {}) } };
  let persistence: T1Phase;
  if (structuring.state !== 'SUCCEEDED') persistence = { state: 'NOT_RUN', detail: { reason: 'structuration non aboutie' } };
  else {
    const bloquantes: readonly string[] = PERSISTENCE_BLOCKING_STEPS;
    const ko = rec.steps.filter((s) => s.status === 'FAILED' && bloquantes.includes(s.step));
    const secondaires = rec.steps.filter((s) => s.status === 'FAILED' && (PERSISTENCE_SECONDARY_STEPS as readonly string[]).includes(s.step));
    persistence = ko.length || rec.failure
      ? { state: 'FAILED', detail: { failedSteps: ko.map((s) => ({ step: s.step, error: s.error ?? null })), failure: rec.failure } }
      : secondaires.length ? { state: 'PARTIAL', detail: { failedSteps: secondaires.map((s) => ({ step: s.step, error: s.error ?? null })) } }
        : { state: 'SUCCEEDED', detail: {} };
  }
  return { extraction, structuring, persistence };
}

/**
 * Lot 75C (A, B, G) — phase EXTRACTION : couche texte ET transcription des
 * pages sans couche texte. Lacunes nommées (`gaps`) : extract absent ou en
 * échec, tronqué, pages illisibles ou non attribuables, transcription non
 * enregistrée, identité du contenu non vérifiée, type non lu. Pure.
 */
function extractionPhase(raws: RawExtractSummary[], ocr: Map<number, { result: OcrResult; persisted: boolean }>, ecriture: string | null): T1Phase {
  const gaps: string[] = [];
  if (ecriture) gaps.push(`extract brut non enregistré : ${ecriture}`);
  for (const r of raws) {
    const o = ocr.get(r.fileId);
    if (r.status === 'FAILED') gaps.push(`fichier ${r.fileId} : lecture déterministe impossible (${r.error ?? 'échec'})`);
    if (r.status === 'NOT_SUPPORTED') gaps.push(`fichier ${r.fileId} : type sans lecture déterministe (lecture par le modèle seule)`);
    if (r.truncated) gaps.push(`fichier ${r.fileId} : extract tronqué — ${r.truncationReason ?? 'borne atteinte'}`);
    if (r.identity === 'UNVERIFIED') gaps.push(`fichier ${r.fileId} : identité du contenu réutilisé non vérifiable`);
    if (r.pagesWithoutText.length > 0) {
      if (!o) gaps.push(`fichier ${r.fileId} : pages ${r.pagesWithoutText.join(', ')} sans couche texte, transcription non disponible`);
      else {
        if (!o.persisted) gaps.push(`fichier ${r.fileId} : transcription des pages sans couche texte non enregistrée`);
        for (const g of ocrGaps(o.result)) gaps.push(`fichier ${r.fileId} : ${g}`);
      }
    }
  }
  const failed = ecriture !== null || raws.some((r) => r.status === 'FAILED' && !r.truncated);
  return {
    state: failed ? 'FAILED' : gaps.length ? 'PARTIAL' : 'SUCCEEDED',
    detail: {
      ...(gaps.length ? { gaps } : {}),
      files: raws.map((r) => {
        const o = ocr.get(r.fileId);
        return {
          fileId: r.fileId, status: r.status, method: r.method, pageCount: r.pageCount, pagesWithText: r.pagesWithText,
          pagesWithoutText: r.pagesWithoutText, truncated: r.truncated, truncationReason: r.truncationReason, chars: r.chars,
          reused: r.reused, identity: r.identity, error: r.error,
          ...(o ? { ocr: { status: o.result.status, recognized: o.result.recognized, unreadable: o.result.unreadable, chars: o.result.chars, persisted: o.persisted } } : {}),
        };
      }),
    },
  };
}

/** Colonnes de `document_extractions` rapportées une à une (emplacement exact). */
const EXTRACTION_COLUMNS = [
  'title', 'description', 'document_date', 'supplier_name', 'supplier_siret', 'amount_cents', 'currency',
  'document_type_code', 'rubric_code', 'has_exploitable_content', 'multi_asset', 'fact_count',
  'full_text', 'full_text_chars', 'visual_summary', 'visual_observations', 'structural_evidence', 'metadata',
  'source_type', 'source_version', 'asset_id_at_analysis', 'provider', 'model', 'prompt_version', 'operation_trace_id',
] as const;

/** Lot 61 : colonnes de `document_raw_extracts` rapportées (extract brut). */
const RAW_EXTRACT_COLUMNS = [
  'extraction_status', 'method', 'page_count', 'pages_with_text', 'pages_without_text', 'truncated', 'truncation_reason',
  'full_text', 'full_text_chars', 'pages', 'extraction_error', 'source_sha256', 'extractor_version',
] as const;

const DOCUMENT_COLUMNS = [
  'analysis_state', 'analysis_fail_reason', 'retained_title', 'title_source', 'rubric_code', 'document_type_code',
  'rubric_origin', 'type_origin', 'classification_state', 'asset_id', 'document_date', 'supplier', 'amount_cents', 'description',
] as const;

/** Une ligne par colonne écrite, valeur recopiée ou référencée. */
function columnEntry(section: string, table: string, id: unknown, column: string, raw: unknown, base: Partial<ReportEntry> = {}): ReportEntry {
  const v = raw instanceof Date ? raw.toISOString() : raw;
  const { value, ref } = valueOrRef(v);
  return {
    section, tableName: table, recordId: id == null ? null : String(id), columnPath: column,
    value, ref, valueType: ref ? `${valueTypeOf(v)} (référencé)` : valueTypeOf(v), writeResult: 'WRITTEN', ...base,
  };
}

async function safeRows(steps: ReportStep[], label: string, sql: string, params: unknown[]): Promise<Row[] | null> {
  try {
    return (await pgClient.unsafe(sql, params as never[])) as unknown as Row[];
  } catch (e) {
    steps.push({ step: `RELECTURE_${label}`, status: 'FAILED', error: errorText(e) });
    return null;
  }
}

/** Construit les lignes du rapport par relecture en base (exporté pour les tests). */
export async function buildT1Entries(rec: T1ExecutionRecorder, p: { accountId: number; fileId: number }): Promise<{ entries: ReportEntry[]; readSteps: ReportStep[]; counters: Record<string, number> }> {
  const entries: ReportEntry[] = [];
  const readSteps: ReportStep[] = [];
  const knowledgeOk = rec.steps.some((s) => s.step === 'KNOWLEDGE' && s.status === 'OK');
  const knowledgeErr = rec.steps.find((s) => s.step === 'KNOWLEDGE' && s.status === 'FAILED')?.error ?? null;
  const ac = p.accountId; const f = p.fileId;
  const c: Record<string, number> = {};
  const inc = (k: string, by = 1) => { c[k] = (c[k] ?? 0) + by; };

  // ── 0. Lot 61 : extract brut déterministe (phase EXTRACTION), relu en base ──
  if (rec.rawExtracts.length > 0) {
    const ids = rec.rawExtracts.map((r) => r.fileId);
    const raws = await safeRows(readSteps, 'RAW_EXTRACT', `SELECT id, file_id, ${RAW_EXTRACT_COLUMNS.join(', ')} FROM document_raw_extracts WHERE file_id = ANY($1::int[]) AND account_id = $2 ORDER BY file_id`, [ids, ac]);
    for (const r of raws ?? []) {
      const resume = rec.rawExtracts.find((x) => x.fileId === Number(r.file_id));
      const base: Partial<ReportEntry> = resume?.reused
        ? { writeResult: 'OBSERVED', reasonCode: 'RAW_EXTRACT_REUSED', reason: 'Extract brut réutilisé (même fichier, même extracteur) : aucune ré-extraction', links: { fileId: Number(r.file_id) } }
        : { links: { fileId: Number(r.file_id) } };
      for (const col of RAW_EXTRACT_COLUMNS) entries.push(columnEntry('RAW_EXTRACT', 'document_raw_extracts', r.id, col, r[col], base));
      inc('rawExtractPages', Number(r.page_count ?? 0));
      inc('rawExtractChars', Number(r.full_text_chars ?? 0));
      if (resume?.reused) inc('rawExtractReused');
    }
  }

  // ── 0 bis. Lot 75C (B) : transcription des pages sans couche texte ────────
  for (const [fileId, o] of rec.ocr) {
    for (const pg of o.result.pages) {
      const base = {
        section: 'OCR_PAGE', tableName: 'document_raw_extracts', columnPath: 'ocr_pages', label: `Page ${pg.page}`,
        links: { fileId, page: pg.page, status: pg.status, provenance: pg.provenance, chars: pg.chars, sourceUnitIds: pg.sourceUnitIds, zones: pg.zones.length },
      };
      if (pg.status === 'RECOGNIZED') {
        const { value, ref } = valueOrRef(pg.text);
        entries.push({ ...base, value, ref, valueType: ref ? 'string (référencé)' : 'string',
          writeResult: o.persisted ? 'WRITTEN' : 'NOT_PERSISTED', reasonCode: o.persisted ? pg.provenance : 'OCR_NOT_PERSISTED',
          reason: o.persisted ? 'Texte reconnu par la lecture du modèle, enregistré à part de la couche texte' : 'Texte reconnu, transcription non enregistrée' });
        inc('ocrPagesRecognized');
      } else if (pg.status === 'EMPTY') {
        entries.push({ ...base, writeResult: 'OBSERVED', reasonCode: 'OCR_PAGE_EMPTY', reason: pg.reason });
      } else {
        entries.push({ ...base, writeResult: 'NOT_EXAMINED', reasonCode: pg.status === 'UNREADABLE' ? 'OCR_PAGE_UNREADABLE' : 'OCR_PAGE_UNATTRIBUTED', reason: pg.reason });
        inc('ocrPagesUnreadable');
      }
    }
  }

  // ── 1. Run d'analyse et propositions ──────────────────────────────────────
  if (rec.analysisRunId != null) {
    const runs = await safeRows(readSteps, 'RUN', `SELECT id, status, prompt_version, model, is_current_reference FROM document_analysis_runs WHERE id = $1 AND account_id = $2`, [rec.analysisRunId, ac]);
    for (const r of runs ?? []) {
      entries.push({
        section: 'ANALYSIS_RUN', tableName: 'document_analysis_runs', recordId: String(r.id), columnPath: 'status', value: r.status,
        recordStatus: String(r.status), writeResult: 'WRITTEN', reason: rec.deduplicated ? 'Run existant réutilisé (même empreinte d’entrée)' : null,
        links: { promptVersion: r.prompt_version, model: r.model, currentReference: r.is_current_reference },
      });
    }
    const props = await safeRows(readSteps, 'PROPOSALS', `SELECT id, proposal_type, target_key, canonical_code, display_label, proposed_value_json, confidence, status FROM document_analysis_proposals WHERE run_id = $1 AND account_id = $2 ORDER BY id`, [rec.analysisRunId, ac]);
    for (const r of props ?? []) {
      entries.push(columnEntry('PROPOSAL', 'document_analysis_proposals', r.id, 'proposed_value_json', r.proposed_value_json, {
        fieldKey: (r.canonical_code ?? r.target_key) as string | null, label: r.display_label as string | null, recordStatus: r.status as string | null,
        links: { proposalType: r.proposal_type, confidence: r.confidence },
      }));
      inc('proposals');
    }
  }

  // ── 2. Base de connaissance (une transaction) ─────────────────────────────
  const declaredFacts = rec.knowledge?.facts ?? [];
  c.factsDeclared = declaredFacts.length;
  if (!knowledgeOk) {
    // Rien de la transaction n'est écrit : chaque donnée déclarée est NON enregistrée, avec le motif.
    const motif = knowledgeErr ? `Transaction de la base de connaissance en échec : ${knowledgeErr}` : 'Étape non exécutée';
    if (rec.knowledge) {
      entries.push({ section: 'DECLARED', tableName: 'document_extractions', columnPath: 'full_text', value: null,
        ...(() => { const { ref } = valueOrRef(rec.knowledge!.extraction.fullText ?? ''); return { ref }; })(),
        writeResult: 'NOT_PERSISTED', reasonCode: 'KNOWLEDGE_TRANSACTION_FAILED', reason: motif });
      for (const d of declaredFacts) {
        const { value, ref } = valueOrRef({ valueText: d.valueText, valueNumber: d.valueNumber, valueUnit: d.valueUnit, normalizedValue: d.normalizedValue });
        entries.push({
          section: 'DECLARED', tableName: 'document_facts', columnPath: 'value_text', fieldKey: d.canonicalKey ?? d.factKey, label: d.label,
          entityType: d.targetType ?? null, entityId: d.targetEntityId ?? null, value, ref, writeResult: 'NOT_PERSISTED',
          reasonCode: 'KNOWLEDGE_TRANSACTION_FAILED', reason: motif,
          links: { subject: d.subject, attribute: d.attribute, rawKey: d.rawKey ?? null, confidence: d.confidence, excerpt: d.excerpt },
        });
      }
      for (const t of rec.knowledge.tables ?? []) {
        entries.push({ section: 'DECLARED', tableName: 'document_tables', label: (t as { title?: string | null }).title ?? null,
          writeResult: 'NOT_PERSISTED', reasonCode: 'KNOWLEDGE_TRANSACTION_FAILED', reason: motif });
      }
      c.factsNotPersisted = declaredFacts.length;
    }
  } else {
    const ex = await safeRows(readSteps, 'EXTRACTION', `SELECT id, analysis_run_id, ${EXTRACTION_COLUMNS.join(', ')} FROM document_extractions WHERE file_id = $1 AND account_id = $2`, [f, ac]);
    const row = ex?.[0];
    if (row) {
      rec.extractionId = Number(row.id);
      for (const col of EXTRACTION_COLUMNS) entries.push(columnEntry('EXTRACTION', 'document_extractions', row.id, col, row[col]));
    }
    const eid = rec.extractionId;
    if (eid != null) {
      const facts = await safeRows(readSteps, 'FACTS', `SELECT * FROM document_facts WHERE extraction_id = $1 AND account_id = $2 AND status = 'active' ORDER BY id`, [eid, ac]);
      for (const r of facts ?? []) {
        const { value, ref } = valueOrRef({
          valueText: r.value_text, valueNumber: r.value_number == null ? null : Number(r.value_number), valueUnit: r.value_unit,
          valueJson: r.value_json, normalizedValue: r.normalized_value, rawValue: r.raw_value, periodStart: r.period_start, periodEnd: r.period_end,
        });
        entries.push({
          section: 'FACT', tableName: 'document_facts', recordId: String(r.id), columnPath: 'value_text,value_number,value_json,normalized_value',
          fieldKey: (r.canonical_key ?? r.fact_key) as string, label: (r.label as string | null) ?? null,
          entityType: (r.target_type as string | null) ?? null, entityId: n(r.target_entity_id), value, ref,
          valueType: (r.value_type as string | null) ?? valueTypeOf(r.value_text ?? r.value_number), recordStatus: String(r.status),
          writeResult: 'WRITTEN', reasonCode: r.canonical_key ? 'CANONICAL' : 'GENERIC',
          links: {
            factKey: r.fact_key, canonicalKey: r.canonical_key, rawKey: r.raw_key, subject: r.subject, attribute: r.attribute,
            unit: r.value_unit ?? r.canonical_unit, confidence: r.confidence, excerpt: r.excerpt, location: r.location,
            provenance: r.evidence_origin, targetLabel: r.target_entity_label, targetConfidence: r.target_confidence,
            sourceUnitIds: r.source_unit_ids, projectionOrigin: r.projection_origin, projectionRule: r.projection_rule,
            semanticEvent: r.semantic_event_type,
          },
        });
        inc(r.canonical_key ? 'factsCanonical' : 'factsGeneric');
      }
      c.factsPersisted = (facts ?? []).length;
      // Déclaré ↔ persisté : ce qui manque est identifié, jamais supposé écrit.
      if (facts) {
        const manquants = unmatchedDeclared(declaredFacts, facts.map((r) => factMatchKey({ factKey: r.fact_key as string, valueText: r.value_text as string | null, valueNumber: r.value_number as string | null })),
          (d) => factMatchKey({ factKey: d.factKey, valueText: d.valueText, valueNumber: d.valueNumber }));
        for (const d of manquants) {
          entries.push({
            section: 'DECLARED', tableName: 'document_facts', columnPath: 'value_text', fieldKey: d.canonicalKey ?? d.factKey, label: d.label,
            value: { valueText: d.valueText, valueNumber: d.valueNumber, valueUnit: d.valueUnit }, writeResult: 'NOT_PERSISTED',
            reasonCode: 'ABSENT_AFTER_WRITE', reason: 'Fait déclaré par l’analyse, absent de document_facts après la transaction',
          });
        }
        c.factsNotPersisted = manquants.length;
      }

      const tables = await safeRows(readSteps, 'TABLES', `SELECT id, table_index, title, page_start, page_end, column_count, row_count, columns, confidence, uncertain, issues, status FROM document_tables WHERE extraction_id = $1 AND account_id = $2 AND status = 'active' ORDER BY table_index`, [eid, ac]);
      for (const t of tables ?? []) {
        entries.push(columnEntry('TABLE', 'document_tables', t.id, 'columns', t.columns, {
          label: (t.title as string | null) ?? `Tableau ${t.table_index}`, recordStatus: String(t.status),
          links: { tableIndex: t.table_index, pages: [t.page_start, t.page_end], rows: t.row_count, columns: t.column_count, confidence: t.confidence, uncertain: t.uncertain, issues: t.issues },
        }));
        inc('tables');
        const cells = await safeRows(readSteps, 'CELLS', `SELECT id, row_index, column_index, row_header, column_header, value_text, normalized_value, value_type, is_empty, page, confidence FROM document_table_cells WHERE table_id = $1 AND account_id = $2 ORDER BY row_index, column_index`, [t.id, ac]);
        for (const cl of cells ?? []) {
          entries.push(columnEntry('CELL', 'document_table_cells', cl.id, 'value_text', cl.value_text, {
            label: `${t.title ?? `Tableau ${t.table_index}`} — L${cl.row_index} C${cl.column_index}`, valueType: (cl.value_type as string | null) ?? 'string',
            links: { tableId: t.id, row: cl.row_index, column: cl.column_index, rowHeader: cl.row_header, columnHeader: cl.column_header, normalized: cl.normalized_value, empty: cl.is_empty, page: cl.page, confidence: cl.confidence },
          }));
          inc('cells');
        }
      }

      const units = await safeRows(readSteps, 'SOURCE_UNITS', `SELECT id, source_unit_id, kind, page, ordinal, parent_unit_id, content_text, label, value_text, payload, origin, coverage_status, coverage_reason, fact_count, repair_state FROM document_source_units WHERE file_id = $1 AND account_id = $2 AND extraction_id = $3 ORDER BY ordinal`, [f, ac, eid]);
      for (const u of units ?? []) {
        entries.push(columnEntry('SOURCE_UNIT', 'document_source_units', u.id, 'content_text', u.content_text, {
          label: `${u.kind} ${u.source_unit_id}`, recordStatus: (u.coverage_status as string | null) ?? null,
          reasonCode: (u.coverage_reason as string | null) ?? null,
          links: { unitId: u.source_unit_id, kind: u.kind, page: u.page, parent: u.parent_unit_id, label: u.label, valueText: u.value_text, origin: u.origin, facts: u.fact_count, repairState: u.repair_state, payload: valueOrRef(u.payload).value ?? (u.payload == null ? null : 'référencé') },
        }));
        inc('sourceUnits');
      }

      const unresolved = await safeRows(readSteps, 'UNRESOLVED', `SELECT id, reason, status, source_unit_ids, raw_key, canonical_key, raw_value, original_payload, pass, detail FROM document_unresolved_facts WHERE file_id = $1 AND account_id = $2 ORDER BY id`, [f, ac]);
      for (const u of unresolved ?? []) {
        entries.push(columnEntry('UNRESOLVED', 'document_unresolved_facts', u.id, 'original_payload', u.original_payload, {
          fieldKey: (u.canonical_key ?? u.raw_key) as string | null, recordStatus: (u.status as string | null) ?? null,
          reasonCode: String(u.reason), reason: (u.detail as string | null) ?? null,
          links: { rawKey: u.raw_key, canonicalKey: u.canonical_key, rawValue: u.raw_value, pass: u.pass, sourceUnitIds: u.source_unit_ids },
        }));
        inc('unresolved');
      }

      const cov = await safeRows(readSteps, 'COVERAGE', `SELECT file_id, quality_state, coverage_ratio, total_units, covered_units, unresolved_units, failed_units, facts_count, dropped_facts_count, truncated_sections_count, anomalies, source_verification, verification FROM document_extraction_coverage WHERE file_id = $1 AND account_id = $2`, [f, ac]);
      if (cov?.[0]) {
        const r = cov[0];
        entries.push(columnEntry('COVERAGE', 'document_extraction_coverage', r.file_id, 'quality_state', r.quality_state, {
          recordStatus: (r.source_verification as string | null) ?? null,
          links: { coverageRatio: r.coverage_ratio == null ? null : Number(r.coverage_ratio), totalUnits: r.total_units, coveredUnits: r.covered_units, unresolvedUnits: r.unresolved_units, failedUnits: r.failed_units, facts: r.facts_count, droppedFacts: r.dropped_facts_count, truncated: r.truncated_sections_count, anomalies: r.anomalies, verification: r.verification },
        }));
      }

      const cands = await safeRows(readSteps, 'OPERATION_CANDIDATES', `SELECT id, candidate_key, established, confidence, type_hint, status_hint, summary, payload, status FROM document_operation_candidates WHERE file_id = $1 AND account_id = $2 AND extraction_id = $3 AND status <> 'SUPERSEDED' ORDER BY id`, [f, ac, eid]);
      for (const o of cands ?? []) {
        entries.push(columnEntry('OPERATION_CANDIDATE', 'document_operation_candidates', o.id, 'payload', o.payload, {
          label: (o.summary as string | null) ?? (o.candidate_key as string), recordStatus: String(o.status),
          links: { key: o.candidate_key, established: o.established, confidence: o.confidence, type: o.type_hint, statusHint: o.status_hint },
        }));
        inc('operationCandidates');
      }
    }
  }

  // ── 3. Projection des faits sur les fiches (preuves) ─────────────────────
  for (const s of rec.projection?.skipped ?? []) {
    const fct = s.fact;
    entries.push({
      section: 'PROJECTION', tableName: 'field_evidence', fieldKey: fct.canonicalKey ?? fct.rawKey, label: fct.label,
      entityType: fct.target.targetType, entityId: fct.target.targetEntityId, value: fct.value, valueType: fct.valueType ?? valueTypeOf(fct.value),
      writeResult: s.reason === 'WRITE_FAILED' || s.reason === 'SCHEMA_NOT_READY' ? 'FAILED' : 'NOT_WRITTEN',
      reasonCode: s.reason, reason: T1_PROJECTION_REASON[s.reason] ?? s.reason,
      links: { rawKey: fct.rawKey, subject: fct.subject, attribute: fct.attribute, excerpt: fct.evidence?.excerpt ?? null, page: fct.evidence?.page ?? null, confidence: fct.confidence },
    });
    inc(`projection_${s.reason}`);
  }
  const evidenceIds = [...(rec.projection?.evidenceIds.values() ?? [])];
  if (evidenceIds.length) {
    const ev = await safeRows(readSteps, 'EVIDENCE', `SELECT id, asset_id, field_key, value_json, normalized_value, status, lifecycle_status, target_type, target_entity_id, confidence, evidence_excerpt, analysis_run_id FROM field_evidence WHERE id = ANY($1::int[]) AND account_id = $2 ORDER BY id`, [evidenceIds, ac]);
    const lues = new Set((ev ?? []).map((r) => Number(r.id)));
    for (const r of ev ?? []) {
      entries.push(columnEntry('EVIDENCE', 'field_evidence', r.id, 'value_json', r.value_json, {
        fieldKey: String(r.field_key), entityType: (r.target_type as string | null) ?? 'ASSET', entityId: n(r.target_entity_id) ?? n(r.asset_id),
        recordStatus: `${r.status}/${r.lifecycle_status ?? 'ACTIVE'}`,
        links: { assetId: r.asset_id, normalized: r.normalized_value, confidence: r.confidence, excerpt: r.evidence_excerpt, analysisRunId: r.analysis_run_id },
      }));
    }
    for (const id of evidenceIds.filter((x) => !lues.has(x))) {
      entries.push({ section: 'EVIDENCE', tableName: 'field_evidence', recordId: String(id), writeResult: 'NOT_PERSISTED', reasonCode: 'ABSENT_AFTER_WRITE', reason: 'Identifiant rendu par l’écriture, introuvable à la relecture' });
    }
    c.evidenceWritten = lues.size;
  }
  if (rec.projection) c.evidenceSuperseded = rec.projection.superseded.count;
  // Lot 75C (C) : écritures de preuve réellement échouées (étape de source : supersede, cibles).
  for (const w of rec.projection?.writeErrors ?? []) {
    if (w.stage === 'RECORD') continue; // déjà une ligne PROJECTION / WRITE_FAILED
    entries.push({ section: 'EVIDENCE', tableName: 'field_evidence', writeResult: 'FAILED', reasonCode: `EVIDENCE_${w.stage}_FAILED`, reason: w.message });
  }

  // ── 3 bis. Lot 75C (D) : attributs métier alimentés directement par T1 ────
  for (const a of rec.attributes) {
    const writeResult = a.outcome === 'WRITTEN' ? 'WRITTEN' : a.outcome === 'FAILED' ? 'FAILED'
      : a.outcome === 'NOT_CONFIRMED' ? 'DECIDED_NOT_CONFIRMED' : 'NOT_WRITTEN';
    entries.push({
      section: 'ATTRIBUTE', tableName: a.targetType === 'ASSET' ? 'assets' : a.targetType === 'EQUIPMENT' ? 'equipments' : 'substructures',
      recordId: String(a.entityId), columnPath: 'key_characteristics', fieldKey: a.fieldKey, entityType: a.targetType, entityId: a.entityId,
      value: a.value as never, valueType: valueTypeOf(a.value), writeResult, reasonCode: a.outcome === 'WRITTEN' ? a.reasonCode : `${a.outcome}:${a.reasonCode}`,
      reason: a.reason, links: { evidenceIds: a.evidenceIds },
    });
    inc(`attribute_${a.outcome}`);
  }

  // ── 4. Document, titre, liens, règles « À traiter » ───────────────────────
  const doc = await safeRows(readSteps, 'DOCUMENT', `SELECT id, ${DOCUMENT_COLUMNS.join(', ')} FROM asset_files WHERE id = $1 AND account_id = $2`, [f, ac]);
  if (doc?.[0]) {
    const titres = await safeRows(readSteps, 'TITLE', `SELECT id, outcome, reason FROM document_title_events WHERE file_id = $1 AND account_id = $2 AND created_at >= $3 ORDER BY id DESC LIMIT 1`, [f, ac, rec.startedAt.toISOString()]);
    for (const col of DOCUMENT_COLUMNS) {
      const written = col === 'analysis_state' || (col === 'retained_title' && titres?.[0]?.outcome === 'UPDATED');
      entries.push(columnEntry('DOCUMENT', 'asset_files', f, col, doc[0][col], written ? {} : {
        writeResult: 'OBSERVED',
        reason: col === 'retained_title' && titres?.[0]
          ? `Titre non modifié par ce passage (${titres[0].outcome}${titres[0].reason ? ` — ${titres[0].reason}` : ''})`
          : 'Valeur en place relue après l’exécution (écrite par ce passage ou antérieure)',
      }));
    }
  }
  const links = await safeRows(readSteps, 'LINKS', `SELECT id, asset_id, equipment_id, room_id, link_role, origin, confidence, status, updated_at FROM document_asset_links WHERE file_id = $1 AND account_id = $2 AND removed_at IS NULL ORDER BY id`, [f, ac]);
  for (const l of links ?? []) {
    const ce = new Date(String(l.updated_at)).getTime() >= rec.startedAt.getTime();
    entries.push({
      section: 'LINK', tableName: 'document_asset_links', recordId: String(l.id), columnPath: 'link_role', value: l.link_role,
      entityType: l.equipment_id ? 'EQUIPMENT' : l.room_id ? 'ROOM' : 'ASSET', entityId: n(l.equipment_id) ?? n(l.room_id) ?? n(l.asset_id),
      recordStatus: String(l.status), writeResult: ce ? 'WRITTEN' : 'OBSERVED', reason: ce ? null : 'Lien antérieur, inchangé par ce passage',
      links: { origin: l.origin, confidence: l.confidence == null ? null : Number(l.confidence) },
    });
  }
  if (rec.analysisRunId != null) {
    const rules = await safeRows(readSteps, 'RULES', `SELECT id, rule_code, field_key, decision, reason_code, action_id, write_verified, error, failed_step, pertinence FROM document_rule_evaluations WHERE account_id = $1 AND file_id = $2 AND run_ref = $3 ORDER BY id`, [ac, f, `analysis_run:${rec.analysisRunId}`]);
    for (const r of rules ?? []) {
      entries.push({
        section: 'RULE', tableName: 'document_rule_evaluations', recordId: String(r.id), columnPath: 'decision', fieldKey: (r.field_key as string | null) ?? null,
        label: String(r.rule_code), value: r.decision, recordStatus: (r.pertinence as string | null) ?? null,
        writeResult: r.error ? 'FAILED' : 'WRITTEN', reasonCode: (r.reason_code as string | null) ?? null, reason: (r.error as string | null) ?? null,
        links: { actionId: r.action_id, writeVerified: r.write_verified, failedStep: r.failed_step },
      });
    }
  }
  return { entries, readSteps, counters: c };
}

/** Lot 83C : exécution métier T1 courante (contexte explicite ou travail de file). */
function businessExecutionSources(): Record<string, string> {
  const id = currentBusinessExecutionId();
  if (!id?.startsWith('T1:')) return {};
  const origin = currentBusinessExecutionOrigin();
  return { businessExecutionId: id, ...(origin ? { businessExecutionOrigin: origin.slice(0, 80) } : {}) };
}

/**
 * Écrit le rapport T1 d'un groupe. Ne lève JAMAIS : un rapport en échec ne
 * remet pas en cause l'analyse (rapport réduit visible, sinon journal).
 */
export async function writeT1Report(rec: T1ExecutionRecorder, p: { accountId: number; fileId: number; groupSourceIds: number[] }): Promise<number | null> {
  try {
    const ctx = currentJobContext();
    let built: Awaited<ReturnType<typeof buildT1Entries>>;
    try {
      built = await buildT1Entries(rec, p);
    } catch (e) {
      built = { entries: [], readSteps: [{ step: 'RELECTURE', status: 'FAILED', error: errorText(e) }], counters: {} };
    }
    const steps = [...rec.steps, ...(rec.failure ? [{ step: 'GROUPE', status: 'FAILED' as const, error: rec.failure }] : []), ...built.readSteps];
    const counters: Record<string, number> = { ...built.counters, entries: built.entries.length, groupSources: p.groupSourceIds.length };
    for (const e of built.entries) counters[`result_${e.writeResult}`] = (counters[`result_${e.writeResult}`] ?? 0) + 1;
    const phases = t1Phases(rec);
    let status = reportStatus({ failed: rec.failure !== null, entries: built.entries, steps, treatment: 'T1' });
    // Lot 75C : jamais « réussi » quand une phase est partielle ou en échec (extraction tronquée, page illisible…).
    if (status === 'SUCCESS' && Object.values(phases).some((ph) => ph.state === 'PARTIAL' || ph.state === 'FAILED')) status = 'PARTIAL';
    return await writeExecutionReport({
      accountId: p.accountId, treatment: 'T1', scope: 'DOCUMENT', jobId: ctx?.jobId ?? null, jobAttempt: ctx?.jobAttempt ?? null,
      traceIds: [...new Set([...rec.traceIds, ...rec.attempts.map((a) => a.traceId)].filter(Boolean))], fileId: p.fileId, analysisRunId: rec.analysisRunId, extractionId: rec.extractionId,
      triggerCode: ctx?.triggerCode ?? null,
      status,
      counters, steps, startedAt: rec.startedAt,
      sources: {
        groupSourceIds: p.groupSourceIds, deduplicatedRun: rec.deduplicated, phases,
        // Lot 83C (SEM-01, R22) : exécution métier du document (reprises comprises) et son origine.
        ...businessExecutionSources(),
      },
    }, built.entries);
  } catch (e) {
    console.error(`[execution-report] rapport T1 du fichier ${p.fileId} non écrit :`, errorText(e));
    return null;
  }
}
