/**
 * Tâches planifiées internes de la couche A (lot 34F) — aucune commande
 * d'exploitation, aucun SQL manuel.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 1. `t1-source-units-backfill` — DOCUMENTS HISTORIQUES, SANS RÉANALYSE
 *
 *    Construit progressivement la couche A des documents analysés AVANT le
 *    lot 34F, à partir des données DÉJÀ persistées (texte intégral, tableaux
 *    et cellules, observations visuelles, métadonnées, faits actifs) : unités,
 *    couverture, provenance des faits existants (`source_unit_ids`). Aucun
 *    appel IA, aucune lecture de fichier. Lots successifs de
 *    `T1_BACKFILL_BATCH` (200) documents pendant 8 minutes au plus par
 *    passage, au démarrage puis toutes les heures tant qu'il en reste
 *    (≈ 10 000 à 20 000 documents par heure). Arrêt :
 *    `SCHEDULED_TASK_T1_SOURCE_UNITS_BACKFILL=off`.
 *
 *    Option (DÉSACTIVÉE par défaut) : `T1_BACKFILL_AI_REPAIR=on` programme en
 *    plus la réparation ciblée IA des unités historiques porteuses d'une
 *    valeur et non couvertes (tâche 2, bornée) — coût IA, d'où l'opt-in.
 *
 * 2. `t1-completeness-retry` — REPRISE CIBLÉE (INCOMPLETE_RETRYABLE)
 *
 *    Documents dont une partie n'a pas pu être analysée pour une cause
 *    transitoire (réparation en échec, lot de pages en échec) : nouvelle
 *    réparation des SEULES unités concernées, depuis leur texte persisté
 *    (aucune relecture du fichier) ; une lacune de pages, elle, ne peut être
 *    relue que dans le fichier : le document repasse dans la file T1. Au plus
 *    `T1_COMPLETENESS_MAX_RETRIES` (2) reprises, avec délai croissant ;
 *    au-delà : INCOMPLETE_FINAL, anomalie en Supervision. `T1_RETRY_BATCH`
 *    (10) documents par passage. Arrêt : `SCHEDULED_TASK_T1_COMPLETENESS_RETRY=off`.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { processingEligibleSql } from '@/services/account/processing-eligibility';
import { buildSourceUnits } from './build-units';
import {
  buildCompletenessReport, computeCoverage, resolveTableParents, selectRepairUnits, selectSourceRereadUnits, SourceUnitLinker, withRepairStates,
  type EvidenceRef,
} from './coverage';
import {
  loadDocumentCoverage, loadDocumentSourceUnits, loadUnresolvedDocumentFacts, maxCompletenessRetries, sourceLayerReady, writeSourceLayer,
  type StoredSourceUnit,
} from './repository';
import {
  SOURCE_LAYER_VERSION, type CoveredSourceUnit, type SourceLayer, type T1CoverageDiagnostics, type UnresolvedFactRecord,
} from './types';
import { needsSourceRetryDue, verificationAutoRetryDue } from './verification-followup';
import type { AnalysisContext, ExtractedTable, SourceInput, VisualObservation } from '../types';
import type { AccountCapabilities } from '@/services/account-capabilities.service';
import type { AssetFamily as V2AssetFamily } from '@/lib/referential/v2';
import type { SourceRereadCall, SourceRereadResult } from './source-reread';
import type { T1AnalyzeDocumentOutput, T1Fact } from '../master/t1-contract';

type Row = Record<string, unknown>;
const num = (v: unknown, def: number) => {
  const n = Number(v);
  return v !== undefined && v !== null && String(v).trim() !== '' && Number.isFinite(n) ? n : def;
};
const ON = new Set(['on', 'true', '1', 'yes']);

export const DEFAULT_BACKFILL_BATCH = 200;
export const DEFAULT_RETRY_BATCH = 10;

export function jobSettings(env: Record<string, string | undefined> = process.env) {
  return {
    backfillBatch: Math.min(1_000, Math.max(1, Math.trunc(num(env.T1_BACKFILL_BATCH, DEFAULT_BACKFILL_BATCH)))),
    backfillAiRepair: ON.has((env.T1_BACKFILL_AI_REPAIR ?? '').trim().toLowerCase()),
    retryBatch: Math.min(100, Math.max(1, Math.trunc(num(env.T1_RETRY_BATCH, DEFAULT_RETRY_BATCH)))),
    maxRetries: maxCompletenessRetries(env),
  };
}

/** Délai avant la reprise n°`attempt` (1 h, 4 h, 16 h…). */
export const retryDelayMs = (attempt: number) => 3_600_000 * 4 ** Math.max(0, attempt - 1);

// ══ 1. Reprise des documents historiques (déterministe) ═════════════════════

interface ExtractionRow {
  id: number; account_id: number; file_id: number; full_text: string | null; title: string | null; description: string | null;
  document_date: string | null; supplier_name: string | null; supplier_siret: string | null; amount_cents: number | null;
  document_type_code: string | null; rubric_code: string | null; visual_summary: string | null;
  visual_observations: VisualObservation[] | null; structural_evidence: Record<string, { confidence?: string; excerpt?: string }> | null;
}

interface StoredFactRow {
  id: number; confidence: 'certain' | 'probable' | 'conflictual'; excerpt: string | null; location: Record<string, unknown> | null;
  evidence_origin: string | null; visual_evidence: { description?: string; page?: number } | null;
  value_text: string | null; normalized_value: string | null; label: string | null; attribute: string | null; fact_key: string;
}

/** Métadonnées d'une extraction historique, à la forme du contrat T1 (unités `doc:meta:*`). */
function documentOf(e: ExtractionRow): T1AnalyzeDocumentOutput['document'] {
  const se = e.structural_evidence ?? {};
  const conf = (k: string) => (se[k]?.confidence === 'probable' || se[k]?.confidence === 'conflictual' ? se[k]!.confidence as 'probable' : 'certain');
  const ev = (k: string) => (se[k]?.excerpt ? { excerpt: se[k]!.excerpt! } : {});
  return {
    ...(e.title ? { title: { value: e.title, confidence: conf('title'), evidence: ev('title') } } : {}),
    ...(e.description ? { description: { value: e.description, confidence: conf('description'), evidence: ev('description') } } : {}),
    ...(e.document_date ? { documentDate: { value: e.document_date, confidence: conf('documentDate'), evidence: ev('documentDate') } } : {}),
    ...(e.supplier_name ? { supplier: { name: e.supplier_name, siret: e.supplier_siret, confidence: conf('supplier'), evidence: ev('supplier') } } : {}),
    ...(e.amount_cents !== null && e.amount_cents !== undefined ? { amountCents: { value: Number(e.amount_cents), confidence: conf('amountCents'), evidence: ev('amountCents') } } : {}),
    ...(e.document_type_code || e.rubric_code
      ? { classification: { canonicalType: null, rubricCode: e.rubric_code, documentTypeCode: e.document_type_code, confidence: 1, evidence: ev('documentType') } }
      : {}),
  };
}

function evidenceOfStored(f: StoredFactRow): EvidenceRef {
  const loc = f.location ?? {};
  const t = (loc.table ?? null) as { tableIndex?: number; row?: number; column?: number } | null;
  return {
    provenance: f.evidence_origin === 'VISUAL_ANALYSIS' ? 'VISUAL_ANALYSIS' : 'TEXT_EXTRACTION',
    excerpt: f.excerpt,
    page: typeof loc.page === 'number' ? loc.page : null,
    table: t && typeof t.tableIndex === 'number' && typeof t.row === 'number' && typeof t.column === 'number'
      ? { index: t.tableIndex, row: t.row, column: t.column } : null,
    visualDescription: f.visual_evidence?.description ?? null,
    visualPage: f.visual_evidence?.page ?? null,
    values: [f.value_text, f.normalized_value],
    labels: [f.label, f.attribute, f.fact_key],
  };
}

/** Couche A d'un document historique, depuis ses données persistées (pure). */
export function backfillLayer(p: {
  extraction: ExtractionRow; tables: ExtractedTable[]; facts: StoredFactRow[];
}): { layer: SourceLayer; provenance: Array<{ id: number; ids: string[] }>; repairCandidates: number } {
  const e = p.extraction;
  const units = buildSourceUnits({
    segments: [{ text: e.full_text ?? '', pageOffset: 0, origin: 'BACKFILL' }],
    tables: p.tables,
    visual: { summary: e.visual_summary, observations: e.visual_observations ?? [] },
    document: documentOf(e),
    origin: 'BACKFILL',
  });
  const linker = new SourceUnitLinker(units);
  const provenance = p.facts.map((f) => ({ id: Number(f.id), ids: linker.link(evidenceOfStored(f)), confidence: f.confidence }));
  const meta = new Set<string>();
  for (const v of Object.values(e.structural_evidence ?? {})) {
    if (v?.excerpt) for (const id of linker.link({ excerpt: v.excerpt })) if (!id.startsWith('doc:')) meta.add(id);
  }
  const cov = computeCoverage(units, {
    facts: provenance.map((x) => ({ unitIds: x.ids, confidence: x.confidence })),
    metadataUnitIds: meta,
  });
  const report = buildCompletenessReport(cov, {
    factsCount: p.facts.filter((f) => !f.fact_key.startsWith('visual.')).length,
    unresolvedFacts: [], truncatedSectionsCount: 0, batchedSectionsCount: 0, repairPassCount: 0, chunkCount: 0,
    warningCodes: [], retryAllowed: false,
    // Lot 49B (TC12) : couverture RECONSTRUITE depuis les données persistées, jamais vérifiée
    // sur le document original — jamais COMPLETE (aucune relecture, aucune réanalyse).
    verification: { status: 'RECONSTRUCTED', reason: 'backfill', pagesExpected: null, verified: [], missing: [], unverified: [], scanned: [] },
  });
  return {
    layer: { layerVersion: SOURCE_LAYER_VERSION, units: cov, unresolvedFacts: [], report, retryable: false },
    provenance: provenance.filter((x) => x.ids.length > 0).map(({ id, ids }) => ({ id, ids })),
    repairCandidates: selectRepairUnits(cov, 1).length,
  };
}

export interface BackfillResult { processed: number; failed: number; more: boolean; disabled?: boolean }

export async function runSourceUnitsBackfill(opts: { deadline?: number; env?: Record<string, string | undefined>; maxBatches?: number } = {}): Promise<BackfillResult> {
  const res: BackfillResult = { processed: 0, failed: 0, more: false };
  if (!(await sourceLayerReady())) return { ...res, disabled: true };
  const s = jobSettings(opts.env);
  const { pgClient } = await import('@/db');
  const { getDocumentTables } = await import('../../knowledge/document-knowledge.service');
  // Lots successifs jusqu'à l'échéance du passage (ou `maxBatches`) ; un
  // document en échec n'est pas repris dans le même passage (curseur).
  let apres = 0;
  for (let lot = 0; lot < (opts.maxBatches ?? 1_000); lot++) {
    if (opts.deadline && Date.now() > opts.deadline) { res.more = true; break; }
    const rows = (await pgClient.unsafe(
      `SELECT e.id, e.account_id, e.file_id, e.full_text, e.title, e.description, to_char(e.document_date, 'YYYY-MM-DD') AS document_date,
              e.supplier_name, e.supplier_siret, e.amount_cents::float8 AS amount_cents, e.document_type_code, e.rubric_code,
              e.visual_summary, e.visual_observations, e.structural_evidence
         FROM document_extractions e
         JOIN asset_files af ON af.id = e.file_id AND af.deleted_at IS NULL
        WHERE e.id > $2 AND NOT EXISTS (SELECT 1 FROM document_extraction_coverage c WHERE c.file_id = e.file_id)
          -- Lot 82A (C-Q10, §3.3) : comptes éligibles seulement (repris après réactivation).
          AND ${processingEligibleSql('e.account_id')}
        ORDER BY e.id
        LIMIT $1`,
      [s.backfillBatch + 1, apres] as never[],
    )) as unknown as ExtractionRow[];
    res.more = rows.length > s.backfillBatch;
    for (const e of rows.slice(0, s.backfillBatch)) {
      apres = Number(e.id);
      if (opts.deadline && Date.now() > opts.deadline) { res.more = true; break; }
      try {
        const [tables, facts] = await Promise.all([
          getDocumentTables(e.account_id, e.file_id),
          pgClient.unsafe(
            `SELECT id::float8 AS id, confidence, excerpt, location, evidence_origin, visual_evidence, value_text, normalized_value,
                    label, attribute, fact_key
               FROM document_facts WHERE file_id = $1 AND status = 'active' ORDER BY id`,
            [e.file_id] as never[],
          ) as unknown as Promise<StoredFactRow[]>,
        ]);
        const b = backfillLayer({ extraction: e, tables: tables as unknown as ExtractedTable[], facts });
        const aReparer = s.backfillAiRepair && b.repairCandidates > 0;
        await pgClient.begin(async (tx) => {
          await writeSourceLayer(tx as never, {
            accountId: e.account_id, fileId: e.file_id, extractionId: e.id, layer: b.layer, origin: 'BACKFILL',
            nextRetryAt: aReparer ? new Date() : null,
          });
          if (b.provenance.length > 0) {
            await tx.unsafe(
              `UPDATE document_facts f SET source_unit_ids = ARRAY(SELECT jsonb_array_elements_text(x.ids))
                 FROM jsonb_to_recordset($1::jsonb) AS x(id bigint, ids jsonb)
                WHERE f.id = x.id AND f.file_id = $2 AND f.source_unit_ids IS NULL`,
              [JSON.stringify(b.provenance), e.file_id] as never[],
            );
          }
        });
        res.processed++;
      } catch (err) {
        res.failed++;
        console.error(`[t1-source-units] reprise historique du fichier ${e.file_id} impossible :`, (err as Error).message);
      }
    }
    if (!res.more) break;
  }
  return res;
}

// ══ 2. Reprise ciblée des documents INCOMPLETE_RETRYABLE ═════════════════════

const toCovered = (u: StoredSourceUnit): CoveredSourceUnit => ({
  sourceUnitId: u.sourceUnitId, kind: u.kind, page: u.page, ordinal: u.ordinal, parentUnitId: u.parentUnitId,
  text: u.text, label: u.label, value: u.value, payload: u.payload ?? {}, location: u.location ?? {},
  origin: u.origin as CoveredSourceUnit['origin'], salient: u.salient, status: u.coverageStatus, reason: u.coverageReason,
  factCount: u.factCount, repairAttempts: u.repairAttempts,
  repairState: (u.repairState ?? null) as CoveredSourceUnit['repairState'],
});

export interface RetryResult { examined: number; repaired: number; requeued: number; final: number; failed: number; more: boolean; disabled?: boolean }

/** Bail d'une reprise en cours (protection contre les exécutions concurrentes ; worker arrêté → reprise après le bail). */
export const RETRY_LEASE_MINUTES = 30;
/** Passages de CONTINUATION (unités jamais examinées faute de budget) au plus par document. */
export function continuationMaxRuns(env: Record<string, string | undefined> = process.env): number {
  return Math.min(200, Math.max(1, Math.trunc(num(env.T1_REPAIR_CONTINUATION_MAX_RUNS, 20))));
}

export async function runCompletenessRetry(opts: { deadline?: number; env?: Record<string, string | undefined> } = {}): Promise<RetryResult> {
  const res: RetryResult = { examined: 0, repaired: 0, requeued: 0, final: 0, failed: 0, more: false };
  if (!(await sourceLayerReady())) return { ...res, disabled: true };
  const s = jobSettings(opts.env);
  const { pgClient } = await import('@/db');
  // Lot 49B (DEV-04) : documents RÉSERVÉS par un bail (SKIP LOCKED) — deux
  // exécutions concurrentes ne traitent jamais le même document ; un worker
  // interrompu libère le document à l'échéance du bail (reprise sans perte).
  const pris = (await pgClient.unsafe(
    `WITH pris AS (
       SELECT c.file_id FROM document_extraction_coverage c
         JOIN asset_files af ON af.id = c.file_id AND af.deleted_at IS NULL
        WHERE c.next_retry_at IS NOT NULL AND c.next_retry_at <= NOW()
          -- Lot 82A (C-Q10, §3.3) : aucune reprise (ni tentative consommée) pour
          -- un compte non éligible ; la demande reste due et repart à la réactivation.
          AND ${processingEligibleSql('c.account_id')}
        ORDER BY c.next_retry_at
        LIMIT $1
        FOR UPDATE OF c SKIP LOCKED
     )
     UPDATE document_extraction_coverage c SET next_retry_at = NOW() + make_interval(mins => $2)
       FROM pris WHERE c.file_id = pris.file_id
     RETURNING c.file_id`,
    [s.retryBatch, RETRY_LEASE_MINUTES] as never[],
  )) as unknown as Array<{ file_id: number }>;
  const rows = pris.length === 0 ? [] : (await pgClient.unsafe(
    `SELECT c.file_id, c.account_id, c.extraction_id, c.retry_attempts, c.quality_state,
            af.asset_id, af.linked_asset_id, coalesce(af.retained_title, af.original_filename) AS title, a.owner_user_id
       FROM document_extraction_coverage c
       JOIN asset_files af ON af.id = c.file_id AND af.deleted_at IS NULL
       JOIN accounts a ON a.id = c.account_id
      WHERE c.file_id = ANY($1::int[])
      ORDER BY c.file_id`,
    [pris.map((x) => Number(x.file_id))] as never[],
  )) as unknown as Row[];
  res.more = pris.length >= s.retryBatch;
  for (const r of rows) {
    const fileId = Number(r.file_id);
    if (opts.deadline && Date.now() > opts.deadline) {
      res.more = true;
      // Échéance du passage : le document réservé est rendu tout de suite.
      await pgClient.unsafe(`UPDATE document_extraction_coverage SET next_retry_at = NOW() WHERE file_id = $1`, [fileId] as never[]).catch(() => undefined);
      continue;
    }
    res.examined++;
    const accountId = Number(r.account_id);
    const attempt = Number(r.retry_attempts ?? 0) + 1;
    try {
      // Lot 83C (R22) : la réparation ciblée REPREND la dernière exécution métier du
      // document — ses appels lui sont rattachés, aucune nouvelle exécution.
      const [{ latestT1ExecutionIdForFile }, { runInBusinessExecution }] = await Promise.all([
        import('../../business-execution/repository'), import('../../business-execution/context'),
      ]);
      const execution = await latestT1ExecutionIdForFile(accountId, fileId);
      const { outcome: out } = await runInBusinessExecution(execution ? [execution] : [], () => retryDocument({
        fileId, accountId, extractionId: r.extraction_id == null ? null : Number(r.extraction_id), attempt,
        qualityState: String(r.quality_state ?? ''),
        maxRetries: s.maxRetries, assetId: Number(r.asset_id ?? r.linked_asset_id ?? 0) || null,
        userId: Number(r.owner_user_id), title: r.title == null ? null : String(r.title), env: opts.env,
      }), { origin: 't1-completeness-retry' });
      if (out === 'requeued') res.requeued++;
      else if (out === 'final') res.final++;
      else res.repaired++;
    } catch (err) {
      res.failed++;
      const msg = (err as Error).message ?? 'erreur';
      console.error(`[t1-completeness-retry] fichier ${fileId} :`, msg);
      // Toute erreur consomme une tentative : jamais de boucle.
      await pgClient.unsafe(
        `UPDATE document_extraction_coverage
            SET retry_attempts = retry_attempts + 1, last_error = left($2, 500), updated_at = NOW(),
                next_retry_at = CASE WHEN retry_attempts + 1 >= $3 THEN NULL ELSE NOW() + make_interval(secs => $4) END
          WHERE file_id = $1`,
        [fileId, msg, s.maxRetries, retryDelayMs(attempt + 1) / 1000] as never[],
      ).catch(() => undefined);
      await pgClient.unsafe(
        `UPDATE document_extraction_coverage SET last_retry_at = NOW(), last_retry_result = 'ERROR' WHERE file_id = $1`, [fileId] as never[],
      ).catch(() => undefined);
    }
  }
  return res;
}

/** Diagnostics conservés d'une couverture (vérification de la source, pertes de normalisation). */
function storedDiagnostics(v: Record<string, unknown> | null | undefined) {
  const d = (v ?? {}) as Partial<T1CoverageDiagnostics> & { continuationRuns?: number };
  const nums = (x: unknown) => (Array.isArray(x) ? x.map(Number).filter((n) => Number.isInteger(n)) : []);
  const verification = d.sourceVerification
    ? {
      status: d.sourceVerification, reason: d.verificationReason ?? null, pagesExpected: d.pagesExpected ?? null,
      verified: [], missing: nums(d.pagesMissing), unverified: nums(d.pagesUnverified), scanned: nums(d.pagesScanned), reread: nums(d.pagesReread),
    }
    : null;
  if (verification && Array.isArray(d.pagesCitedUnverified)) (verification as { citedUnverified?: number[] }).citedUnverified = nums(d.pagesCitedUnverified);
  return {
    verification,
    normalisation: {
      truncations: Number(d.truncations ?? 0), originalsPreserved: Number(d.originalsPreserved ?? 0), losses: Number(d.normalisationLosses ?? 0),
      prunedFields: Number(d.prunedFields ?? 0), prunedOriginalsPreserved: Number(d.prunedOriginalsPreserved ?? 0),
    },
    pagesVerified: Number(d.pagesVerified ?? 0),
    continuationRuns: Number(d.continuationRuns ?? 0),
    // Lot 54G : relectures du fichier (cumul du document).
    sourceReread: { runs: Number(d.sourceRereads ?? 0), failed: Number(d.sourceRereadsFailed ?? 0), resolved: Number(d.sourceRereadResolved ?? 0) },
  };
}

/**
 * Relecture du FICHIER : le document repasse dans la file T1 (traitement
 * technique, non facturé, non annoncé). Consomme une tentative. Lot 53 (D19) :
 * partagée par la reprise d'une lacune de pages, d'une vérification
 * incomplète transitoire et la reprise manuelle du BO (`result`).
 */
export async function requeueDocumentForReread(p: {
  fileId: number; accountId: number; attempt: number; origin: string; result: string;
}): Promise<boolean> {
  const { pgClient } = await import('@/db');
  const { enqueueFileAnalyses } = await import('../queue/t1-handler');
  // Lot 83C (R22) : relecture = reprise ciblée de la dernière exécution du document.
  const acceptes = await enqueueFileAnalyses([p.fileId], p.accountId, { origin: p.origin, billable: false, processingVisibility: 'TECHNICAL', resume: true });
  const ok = acceptes.includes(p.fileId);
  await pgClient.unsafe(
    `UPDATE document_extraction_coverage SET retry_attempts = $2, next_retry_at = NULL, origin = 'RETRY', updated_at = NOW(),
            last_error = $3 WHERE file_id = $1`,
    [p.fileId, p.attempt, ok ? null : 'mise en file T1 refusée'] as never[],
  );
  await pgClient.unsafe(
    `UPDATE document_extraction_coverage SET last_retry_at = NOW(), last_retry_result = $2 WHERE file_id = $1`, [p.fileId, p.result] as never[],
  ).catch(() => undefined);
  return ok;
}

/** Issue d'une reprise ciblée d'un document (lot 83B : détail rendu au contrôle de cohérence). */
export interface DocumentRetryOutcome {
  outcome: 'repaired' | 'requeued' | 'final';
  /** Appels ANALYZE_DOCUMENT de la passe textuelle et de la relecture du fichier. */
  calls: number;
  /** Unités soumises à la passe textuelle. */
  attempted: string[];
  /** Faits nouveaux écrits (aucun fait existant réécrit). */
  newFacts: number;
  /** Résultat consigné sur la couverture (`last_retry_result`). */
  result: string;
}

async function retryDocument(p: {
  fileId: number; accountId: number; extractionId: number | null; attempt: number; maxRetries: number;
  assetId: number | null; userId: number; title: string | null; env?: Record<string, string | undefined>;
  /** Lot 53 (D19) : état de qualité de la ligne réservée. */
  qualityState?: string;
  /**
   * Lot 83B (C-Q7) : passe TEXTUELLE seule sur les unités non couvertes —
   * ni relecture du fichier, ni remise en file T1 (ces maillons relèvent
   * d'un autre diagnostic du contrôle de cohérence).
   */
  textOnly?: boolean;
}): Promise<DocumentRetryOutcome> {
  const { pgClient } = await import('@/db');
  const issue = (outcome: DocumentRetryOutcome['outcome'], result: string): DocumentRetryOutcome => ({ outcome, calls: 0, attempted: [], newFacts: 0, result });

  // Lot 53 (D19) : vérification incomplète — seule une cause transitoire
  // (source illisible) justifie une relecture automatique du fichier ; sinon
  // la reprise est manuelle (BO) et rien n'est rejoué ici (jamais de boucle).
  if (p.qualityState === 'VERIFICATION_INCOMPLETE' && !p.textOnly) {
    const cov = await loadDocumentCoverage(p.fileId, p.accountId);
    const raison = ((cov?.verification ?? {}) as { verificationReason?: string | null }).verificationReason ?? null;
    if (verificationAutoRetryDue({ qualityState: p.qualityState, verificationReason: raison, retryAttempts: p.attempt - 1, maxRetries: p.maxRetries })) {
      await requeueDocumentForReread({ fileId: p.fileId, accountId: p.accountId, attempt: p.attempt, origin: 't1-completeness-retry', result: 'REQUEUED_T1' });
      return issue('requeued', 'REQUEUED_T1');
    }
    // Lot 54G (point 2) : une observation NEEDS_SOURCE (image, scan) a une VRAIE reprise :
    // relecture ciblée du fichier, même si la couverture globale reste non vérifiable.
    const aRelire = p.attempt <= p.maxRetries
      ? selectSourceRereadUnits((await loadDocumentSourceUnits(p.fileId, { accountId: p.accountId, kinds: ['VISUAL_OBSERVATION'], limit: 5_000 })).map(toCovered), sourceRereadCap(p.env))
      : [];
    if (aRelire.length === 0) {
      await pgClient.unsafe(
        `UPDATE document_extraction_coverage SET next_retry_at = NULL, last_retry_at = NOW(), last_retry_result = 'MANUAL_CHECK_REQUIRED' WHERE file_id = $1`,
        [p.fileId] as never[],
      ).catch(() => undefined);
      return issue('repaired', 'MANUAL_CHECK_REQUIRED');
    }
  }

  const stored = await loadDocumentSourceUnits(p.fileId, { accountId: p.accountId, limit: 50_000 });
  const units = stored.map(toCovered);
  const lacunes = units.filter((u) => u.kind === 'PAGE_GAP' && u.status === 'FAILED' && u.payload.retryable === true);

  // Lacune de pages : seule une relecture du fichier peut la combler → file T1.
  if (lacunes.length > 0 && p.attempt <= p.maxRetries && !p.textOnly) {
    await requeueDocumentForReread({ fileId: p.fileId, accountId: p.accountId, attempt: p.attempt, origin: 't1-completeness-retry', result: 'REQUEUED_T1' });
    return issue('requeued', 'REQUEUED_T1');
  }

  const { repairAttemptCap, repairSettings, runRepairPass } = await import('./repair');
  const cap = repairAttemptCap(p.env);
  const cibles = selectRepairUnits(units, cap);
  const couverture = await loadDocumentCoverage(p.fileId, p.accountId);
  const diag = storedDiagnostics(couverture?.verification);
  // Lot 49B (DEV-04) : unités jamais examinées faute de budget — une CONTINUATION ne consomme pas de tentative.
  const enAttente = units.filter((u) => u.repairState === 'PENDING').length;
  const continuation = enAttente > 0 && diag.continuationRuns < continuationMaxRuns(p.env);
  const facts: T1Fact[] = [];
  let failed = new Map<string, { reason: string; retryable: boolean }>();
  let attempted: string[] = [];
  let notAttempted: string[] = [];
  let calls = 0;
  // Lot 54G (point 2) : unités NEEDS_SOURCE — relecture du FICHIER (bornée, comptée à part).
  const sourceCap = sourceRereadCap(p.env);
  const aRelire = p.attempt <= p.maxRetries && !p.textOnly ? selectSourceRereadUnits(units, sourceCap) : [];
  let relecture: SourceRereadResult | null = null;
  const textuelle = cibles.length > 0 && (p.attempt <= p.maxRetries || continuation);
  if (aRelire.length > 0 || textuelle) {
    const [{ loadAnalysisContext }, { getAccountCapabilities }, { loadAssetFamilies }, step] = await Promise.all([
      import('../pipeline'),
      import('@/services/account-capabilities.service'),
      import('../master/rubric-rules'),
      import('../steps/analyze-document.step'),
    ]);
    const ctx = await loadAnalysisContext(p.accountId, p.assetId);
    const capabilities = await getAccountCapabilities(p.accountId);
    const v2Families = await loadAssetFamilies(p.assetId ? [p.assetId] : []);
    if (aRelire.length > 0) {
      relecture = await rereadSource({ ...p, targets: aRelire, ctx: { ...ctx, capabilities }, capabilities, v2Families, call: (c) => step.callAnalyzeDocument(c) });
      facts.push(...relecture.facts);
      calls += relecture.calls;
      console.info(`[t1-source-reread] fichier ${p.fileId} : ${aRelire.length} unité(s) NEEDS_SOURCE, ${relecture.calls} appel(s), `
        + `${relecture.resolved.length} levée(s)${relecture.failed ? `, échec : ${relecture.error}` : ''}`);
    }
    if (textuelle) {
      const r = await runRepairPass({
        input: {
          sourceType: 'file', sourceIds: [p.fileId], accountId: p.accountId, userId: p.userId,
          mimeTypes: ['text/plain'], displayNames: [p.title ?? `document ${p.fileId}`], linkedAssetId: p.assetId,
        },
        groupIndices: [0], ctx: { ...ctx, capabilities }, capabilities,
        v2Families,
        units: cibles, maxCalls: repairSettings(p.env).maxCalls, pass: 1 + p.attempt, call: (c) => step.callAnalyzeDocument(c),
      });
      facts.push(...r.facts);
      calls += r.calls;
      failed = r.failed;
      attempted = r.attempted;
      notAttempted = r.notAttempted;
    }
  }

  // Faits ajoutés : projection (registre, cibles vérifiées), provenance, écriture.
  const linker = new SourceUnitLinker(units);
  const ajout = facts.length > 0 ? await appendRepairedFacts({ ...p, facts, linker }) : { inserted: [], all: [] };
  const nouveaux = ajout.inserted;
  // Couverture : faits de la réparation, y compris ceux déjà écrits par une reprise interrompue (TC11).
  const couvertes = new Set(ajout.all.flatMap((f) => f.sourceUnitIds ?? []).map((id) => id.replace(/:cell:\d+$/, '')));
  // Lignes de tableau incertaines : promues seulement si chaque cellule renseignée est confirmée (DEV-02).
  const confirmations = new Map<string, number>();
  for (const f of ajout.all) {
    if (f.confidence !== 'certain') continue;
    for (const id of new Set((f.sourceUnitIds ?? []).map((x) => x.replace(/:cell:\d+$/, '')))) confirmations.set(id, (confirmations.get(id) ?? 0) + 1);
  }
  const tentees = new Set(attempted);
  const relues = new Set(relecture?.attempted ?? []);
  // Lot 54G : relecture du fichier — levée seulement sur preuve nouvelle, sinon incertitude MAINTENUE.
  const apresRelecture = relecture ? (await import('./source-reread')).applySourceReread(units, relecture) : units;
  let majs: CoveredSourceUnit[] = apresRelecture.map((u) => {
    if (relues.has(u.sourceUnitId)) return u;
    if (!tentees.has(u.sourceUnitId)) return u;
    const base = { ...u, repairAttempts: u.repairAttempts + 1 };
    const f = failed.get(u.sourceUnitId);
    if (f) return { ...base, status: 'FAILED', reason: f.reason };
    if (u.kind === 'TABLE_ROW') {
      const cellules = Array.isArray(u.payload.cells) ? (u.payload.cells as Array<{ value?: unknown }>).filter((x) => x.value !== null && x.value !== undefined).length : 0;
      return cellules > 0 && (confirmations.get(u.sourceUnitId) ?? 0) >= cellules
        ? { ...base, status: 'COVERED', reason: 'table_verified', factCount: u.factCount + (confirmations.get(u.sourceUnitId) ?? 0) }
        : { ...base, status: 'UNCERTAIN', reason: 'table_uncertain' };
    }
    if (couvertes.has(u.sourceUnitId) && (u.status !== 'UNCERTAIN' || (confirmations.get(u.sourceUnitId) ?? 0) > 0)) {
      return { ...base, status: 'COVERED', reason: 'fact', factCount: u.factCount + 1 };
    }
    // Sans preuve suffisante : l'incertitude est MAINTENUE (jamais promue artificiellement).
    if (u.status === 'UNCERTAIN') return base;
    return { ...base, status: 'UNRESOLVED', reason: u.salient ? 'not_extracted' : 'not_structured' };
  });
  // Lot 54G (point 4) : parent TABLE recalculé depuis la couverture réelle de ses lignes.
  majs = resolveTableParents(majs);
  const progression = attempted.some((id) => units.find((u) => u.sourceUnitId === id)?.repairState === 'PENDING') && failed.size === 0;
  const consomme = !(continuation && progression) || relecture !== null;
  const tentativesStockees = consomme ? p.attempt : p.attempt - 1;
  const runs = diag.continuationRuns + (continuation && attempted.length > 0 ? 1 : 0);
  majs = withRepairStates(majs, { attempted: new Set([...tentees, ...relues]), pending: new Set(notAttempted), cap, sourceCap });
  if (runs >= continuationMaxRuns(p.env)) {
    // Plafond de continuation atteint : les unités restantes sont « plafond atteint », explicitement.
    majs = majs.map((u) => (u.repairState === 'PENDING' ? { ...u, repairState: 'EXHAUSTED' } : u));
  }
  const anciens = await loadUnresolvedDocumentFacts(p.fileId, { accountId: p.accountId });
  const unresolved: UnresolvedFactRecord[] = anciens.map(({ id: _i, fileId: _f, createdAt: _c, ...x }) => {
    void _i; void _f; void _c;
    return x.status === 'UNRESOLVED' && x.sourceUnitIds.length > 0 && x.sourceUnitIds.every((id) => couvertes.has(id.replace(/:cell:\d+$/, '')))
      ? { ...x, status: 'RECOVERED' as const } : x;
  });
  const prev = (await pgClient.unsafe(
    `SELECT facts_count, truncated_sections_count, batched_sections_count, repair_pass_count, chunk_count, anomalies
       FROM document_extraction_coverage WHERE file_id = $1`,
    [p.fileId] as never[],
  )) as unknown as Row[];
  const pr = prev[0] ?? {};
  const retryAllowed = tentativesStockees < p.maxRetries;
  const report = buildCompletenessReport(majs, {
    factsCount: Number(pr.facts_count ?? 0) + nouveaux.length,
    unresolvedFacts: unresolved,
    truncatedSectionsCount: Number(pr.truncated_sections_count ?? 0),
    batchedSectionsCount: Number(pr.batched_sections_count ?? 0),
    repairPassCount: Number(pr.repair_pass_count ?? 0) + (attempted.length > 0 ? 1 : 0),
    chunkCount: Number(pr.chunk_count ?? 0),
    warningCodes: Array.isArray(pr.anomalies) && (pr.anomalies as string[]).includes('PARTIAL_EXTRACTION') ? ['PARTIAL_EXTRACTION'] : [],
    retryAllowed,
    verification: diag.verification ? { ...diag.verification, verified: Array.from({ length: diag.pagesVerified }, (_, i) => i + 1) } : null,
    normalisation: diag.normalisation,
    sourceReread: {
      runs: diag.sourceReread.runs + (relecture ? 1 : 0),
      failed: diag.sourceReread.failed + (relecture && (relecture.failed || relecture.resolved.length < relecture.attempted.length) ? 1 : 0),
      resolved: diag.sourceReread.resolved + (relecture?.resolved.length ?? 0),
    },
  });
  if (report.diagnostics) (report.diagnostics as T1CoverageDiagnostics & { continuationRuns?: number }).continuationRuns = runs;
  // Unités en attente avec progression : continuation rapprochée ; sinon délai croissant.
  // Lot 54G (point 2) : relecture du fichier encore due (NEEDS_SOURCE, tentatives restantes) : reprise programmée.
  const relectureDue = needsSourceRetryDue({ needsSourceUnits: report.diagnostics!.needsSourceUnits, retryAttempts: tentativesStockees, maxRetries: p.maxRetries });
  const prochaine = report.qualityState === 'INCOMPLETE_RETRYABLE'
    ? new Date(Date.now() + (progression && report.diagnostics!.pendingRepairUnits > 0 ? 5 * 60_000 : retryDelayMs(tentativesStockees + 1)))
    : relectureDue ? new Date(Date.now() + retryDelayMs(tentativesStockees + 1)) : null;
  const resultatTexte = attempted.length === 0 ? 'NOTHING_TO_REPAIR'
    : failed.size > 0 ? 'REPAIR_FAILED' : nouveaux.length > 0 ? `REPAIRED_${nouveaux.length}` : 'NO_NEW_FACT';
  const resultatRelecture = !relecture ? null
    : relecture.failed && relecture.resolved.length === 0 ? 'SOURCE_REREAD_FAILED'
      : relecture.resolved.length === relecture.attempted.length ? `SOURCE_REREAD_RESOLVED_${relecture.resolved.length}`
        : `SOURCE_REREAD_PARTIAL_${relecture.resolved.length}_OF_${relecture.attempted.length}`;
  const resultat = resultatRelecture && attempted.length === 0 ? resultatRelecture
    : resultatRelecture ? `${resultatRelecture}+${resultatTexte}` : resultatTexte;
  await pgClient.begin(async (tx) => {
    await writeSourceLayer(tx as never, {
      accountId: p.accountId, fileId: p.fileId, extractionId: p.extractionId, origin: 'RETRY',
      layer: { layerVersion: SOURCE_LAYER_VERSION, units: majs, unresolvedFacts: unresolved, report, retryable: report.qualityState === 'INCOMPLETE_RETRYABLE' },
      retryAttempts: tentativesStockees,
      nextRetryAt: prochaine,
      retryResult: resultat,
    });
  });
  const { recordT1Completeness } = await import('./monitoring');
  await recordT1Completeness({ accountId: p.accountId, fileId: p.fileId, report, persisted: true }).catch(() => undefined);
  // Bien rattaché : preuves, T3 et T4 depuis les faits persistés (même chemin que le rattachement tardif).
  if (p.assetId && nouveaux.some((f) => f.canonicalKey)) {
    const { projectDocumentKnowledgeToAsset } = await import('../../knowledge/document-knowledge.service');
    await projectDocumentKnowledgeToAsset({ accountId: p.accountId, userId: p.userId, fileId: p.fileId, assetId: p.assetId })
      .catch((e: Error) => console.error('[t1-completeness-retry] projection sur le bien :', e.message));
  }
  return { outcome: report.qualityState === 'INCOMPLETE_FINAL' ? 'final' : 'repaired', calls, attempted, newFacts: nouveaux.length, result: resultat };
}

/**
 * Lot 83B (C-Q7, cas « valeur présente dans l'extract, absente de T1, unité
 * NON couverte ») — passe de réparation T1 ciblée EXISTANTE, exécutée tout de
 * suite pour UN document à la demande du contrôle de cohérence : mêmes
 * unités (`selectRepairUnits`), mêmes plafonds (`T1_REPAIR_MAX_CALLS`,
 * tentatives par unité), même consommation d'une reprise
 * (`T1_COMPLETENESS_MAX_RETRIES`), même écriture (faits prouvés par l'unité,
 * couche A, projection sur le bien). Texte persisté seulement : ni relecture
 * du fichier, ni remise en file T1 (`textOnly`).
 *
 * Exclusivité : la ligne de couverture est RÉSERVÉE par le même bail que
 * `t1-completeness-retry` (SKIP LOCKED) ; une reprise déjà programmée
 * (`next_retry_at` futur) ou en cours n'est jamais doublée (`BUSY`), une
 * analyse en cours non plus. Compte non éligible : rien (C-Q10).
 */
export async function repairDocumentSourceUnits(p: {
  accountId: number; fileId: number; env?: Record<string, string | undefined>;
}): Promise<DocumentRetryOutcome | { outcome: 'BUSY' | 'NOT_ELIGIBLE' | 'NO_RETRY_LEFT'; calls: 0; attempted: []; newFacts: 0; result: string }> {
  const vide = (outcome: 'BUSY' | 'NOT_ELIGIBLE' | 'NO_RETRY_LEFT', result: string) => ({ outcome, calls: 0 as const, attempted: [] as [], newFacts: 0 as const, result });
  if (!(await sourceLayerReady())) return vide('BUSY', 'SOURCE_LAYER_NOT_READY');
  const s = jobSettings(p.env);
  const { pgClient } = await import('@/db');
  const pris = (await pgClient.unsafe(
    `WITH pris AS (
       SELECT c.file_id FROM document_extraction_coverage c
         JOIN asset_files af ON af.id = c.file_id AND af.deleted_at IS NULL
        WHERE c.file_id = $1 AND c.account_id = $2 AND (c.next_retry_at IS NULL OR c.next_retry_at <= NOW())
          AND af.analysis_state IS DISTINCT FROM 'ANALYZING' AND af.analysis_state IS DISTINCT FROM 'UPLOADED'
          AND ${processingEligibleSql('c.account_id')}
        FOR UPDATE OF c SKIP LOCKED
     )
     UPDATE document_extraction_coverage c SET next_retry_at = NOW() + make_interval(mins => $3)
       FROM pris WHERE c.file_id = pris.file_id
     RETURNING c.file_id`,
    [p.fileId, p.accountId, RETRY_LEASE_MINUTES] as never[],
  )) as unknown as Array<{ file_id: number }>;
  if (pris.length === 0) {
    const [e] = (await pgClient.unsafe(`SELECT ${processingEligibleSql('$1::int')} AS ok`, [p.accountId] as never[])) as unknown as Array<{ ok: boolean }>;
    return vide(e?.ok === false ? 'NOT_ELIGIBLE' : 'BUSY', e?.ok === false ? 'ACCOUNT_NOT_ELIGIBLE' : 'RETRY_SCHEDULED_OR_IN_PROGRESS');
  }
  const [r] = (await pgClient.unsafe(
    `SELECT c.file_id, c.account_id, c.extraction_id, c.retry_attempts, c.quality_state,
            af.asset_id, af.linked_asset_id, coalesce(af.retained_title, af.original_filename) AS title, a.owner_user_id
       FROM document_extraction_coverage c
       JOIN asset_files af ON af.id = c.file_id AND af.deleted_at IS NULL
       JOIN accounts a ON a.id = c.account_id
      WHERE c.file_id = $1`,
    [p.fileId] as never[],
  )) as unknown as Row[];
  const attempt = Number(r.retry_attempts ?? 0) + 1;
  if (attempt > s.maxRetries) {
    // Plafond de reprises atteint : la ligne est rendue telle quelle (jamais de boucle).
    await pgClient.unsafe(`UPDATE document_extraction_coverage SET next_retry_at = NULL WHERE file_id = $1`, [p.fileId] as never[]);
    return vide('NO_RETRY_LEFT', 'RETRY_CAP_REACHED');
  }
  try {
    // Intégration 83B × 83C (R22) : la relance ciblée décidée par le contrôle de
    // cohérence REPREND la dernière exécution métier T1 du document.
    const [{ latestT1ExecutionIdForFile }, { runInBusinessExecution }] = await Promise.all([
      import('../../business-execution/repository'), import('../../business-execution/context'),
    ]);
    const execution = await latestT1ExecutionIdForFile(p.accountId, p.fileId);
    return await runInBusinessExecution(execution ? [execution] : [], () => retryDocument({
      fileId: p.fileId, accountId: p.accountId, extractionId: r.extraction_id == null ? null : Number(r.extraction_id), attempt,
      qualityState: String(r.quality_state ?? ''), maxRetries: s.maxRetries,
      assetId: Number(r.asset_id ?? r.linked_asset_id ?? 0) || null, userId: Number(r.owner_user_id),
      title: r.title == null ? null : String(r.title), env: p.env, textOnly: true,
    }), { origin: 'coherence-control' });
  } catch (err) {
    // Même règle que la reprise planifiée : toute erreur consomme une tentative.
    await pgClient.unsafe(
      `UPDATE document_extraction_coverage
          SET retry_attempts = retry_attempts + 1, last_error = left($2, 500), updated_at = NOW(), next_retry_at = NULL,
              last_retry_at = NOW(), last_retry_result = 'ERROR'
        WHERE file_id = $1`,
      [p.fileId, (err as Error).message ?? 'erreur'] as never[],
    ).catch(() => undefined);
    throw err;
  }
}

/** Lot 54G : relectures du FICHIER au plus par unité NEEDS_SOURCE (= reprises automatiques, 1 au moins). */
export function sourceRereadCap(env: Record<string, string | undefined> = process.env): number {
  return Math.max(1, maxCompletenessRetries(env));
}

/**
 * Lot 54G (point 2) : relecture du FICHIER ORIGINAL des unités NEEDS_SOURCE.
 * Fichier du compte uniquement (adaptateur : contrôle d'appartenance) ; un
 * fichier introuvable ou illisible est une relecture en échec (tentative comptée).
 */
async function rereadSource(p: {
  fileId: number; accountId: number; userId: number; assetId: number | null; env?: Record<string, string | undefined>;
  targets: CoveredSourceUnit[]; ctx: AnalysisContext; capabilities: AccountCapabilities; v2Families: V2AssetFamily[];
  call: SourceRereadCall;
}): Promise<SourceRereadResult> {
  const [{ runSourceReread }, { FileSourceAdapter }, { repairSettings }, { chunkSettings, fetchSourceBytes }] = await Promise.all([
    import('./source-reread'), import('../adapters/file-source.adapter'), import('./repair'), import('./page-chunks'),
  ]);
  let input: SourceInput;
  try {
    input = await new FileSourceAdapter().prepare({ sourceIds: [p.fileId], accountId: p.accountId, userId: p.userId, linkedAssetId: p.assetId });
  } catch (e) {
    return { attempted: p.targets.map((u) => u.sourceUnitId), resolved: [], facts: [], pages: [], calls: 0, failed: true, error: (e as Error).message };
  }
  return runSourceReread({
    input, ctx: p.ctx, capabilities: p.capabilities, v2Families: p.v2Families, targets: p.targets,
    maxCalls: repairSettings(p.env).maxCalls, chunkPages: chunkSettings(p.env).chunkPages, call: p.call, fetchBytes: fetchSourceBytes,
  });
}

/** Projette et AJOUTE les faits d'une reprise (les faits existants ne sont pas réécrits). */
async function appendRepairedFacts(p: {
  fileId: number; accountId: number; extractionId: number | null; assetId: number | null; facts: T1Fact[]; linker: SourceUnitLinker;
}) {
  const [{ projectDocumentFacts }, { toFact }, { projectedFactToExtractedField }, step, { insertFactRows }, { documentFactsCanonicalReady }, registry] = await Promise.all([
    import('../projection/document-projection'),
    import('../../knowledge/document-knowledge'),
    import('../steps/persist-evidence.step'),
    import('../steps/analyze-document.step'),
    import('../../knowledge/document-knowledge.service'),
    import('../../evidence/canonical-columns'),
    import('@/services/canonical/registry'),
  ]);
  const { pgClient } = await import('@/db');
  const ext = ((await pgClient.unsafe(
    `SELECT id, source_type, provider, model, prompt_version, document_type_code, to_char(document_date, 'YYYY-MM-DD') AS document_date
       FROM document_extractions WHERE file_id = $1`,
    [p.fileId] as never[],
  )) as unknown as Row[])[0];
  if (!ext) return { inserted: [], all: [] };
  const verif = await step.verifyAll({ entities: { assets: [], rooms: [], equipments: [], suppliers: [], multiAsset: false } } as never, p.facts, p.accountId);
  if (p.assetId) verif.verifiedIds.ASSET.add(p.assetId);
  const famille = p.assetId
    ? ((await pgClient.unsafe(`SELECT category FROM assets WHERE id = $1`, [p.assetId] as never[])) as unknown as Row[])[0]?.category
    : null;
  const projection = projectDocumentFacts({
    document: {
      ...(ext.document_date ? { documentDate: { value: String(ext.document_date), confidence: 'certain', evidence: {} } } : {}),
      ...(ext.document_type_code ? { classification: { documentTypeCode: String(ext.document_type_code), confidence: 1, evidence: {} } } : {}),
    },
    entities: { assets: [], rooms: [], equipments: [], suppliers: [], multiAsset: false },
    facts: p.facts,
  }, {
    knownAssetId: p.assetId, documentAssetId: p.assetId,
    assetFamilies: new Map(p.assetId ? [[p.assetId, registry.toAssetFamily(famille == null ? null : String(famille))]] : []),
    verifiedIds: verif.verifiedIds,
  });
  for (const f of projection.facts) {
    f.sourceUnitIds = p.linker.link({
      provenance: f.provenance, excerpt: f.evidence?.excerpt ?? null, page: f.evidence?.page ?? null,
      // Lot 54G : fait visuel d'une relecture du fichier — rattaché à son observation.
      visualDescription: f.visualEvidence?.description ?? null, visualPage: f.visualEvidence?.page ?? null,
      values: [f.rawValue, f.value], labels: [f.rawKey, f.label, f.attribute],
    });
  }
  // Lot 49B (TC11) : reprise IDEMPOTENTE — un fait déjà écrit (worker interrompu
  // entre l'écriture des faits et celle de la couche A) n'est jamais dupliqué.
  const existants = new Set(((await pgClient.unsafe(
    `SELECT coalesce(canonical_key, fact_key) AS k, coalesce(value_text, '') AS v, coalesce(excerpt, '') AS e
       FROM document_facts WHERE file_id = $1 AND status = 'active'`,
    [p.fileId] as never[],
  )) as unknown as Array<{ k: string; v: string; e: string }>).map((x) => `${x.v}\u0001${x.e}`));
  const neufs = projection.facts.filter((f) => !existants.has(`${f.value === null ? '' : String(f.value)}\u0001${f.evidence?.excerpt ?? ''}`));
  if (neufs.length === 0) return { inserted: [], all: projection.facts };
  const records = neufs.map((f) => toFact(projectedFactToExtractedField(f)));
  const canonical = await documentFactsCanonicalReady();
  await pgClient.begin(async (tx) => {
    await insertFactRows(tx as never, {
      accountId: p.accountId, fileId: p.fileId, sourceType: ext.source_type === 'web_link' ? 'web_link' : 'asset_file',
      provider: ext.provider == null ? null : String(ext.provider), model: ext.model == null ? null : String(ext.model),
      promptVersion: ext.prompt_version == null ? null : String(ext.prompt_version),
    }, Number(ext.id), records, { canonical, provenance: true });
    await tx.unsafe(`UPDATE document_extractions SET fact_count = fact_count + $2, updated_at = NOW() WHERE id = $1`,
      [Number(ext.id), records.length] as never[]);
  });
  return { inserted: neufs, all: projection.facts };
}
