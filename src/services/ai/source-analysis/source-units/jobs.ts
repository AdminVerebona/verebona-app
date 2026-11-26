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
  loadAllDocumentSourceUnits, loadDocumentCoverage, loadDocumentSourceUnits, loadUnresolvedDocumentFacts, maxCompletenessRetries, sourceLayerReady, writeSourceLayer,
  type StoredSourceUnit,
} from './repository';
import {
  SOURCE_LAYER_VERSION, type CoveredSourceUnit, type SourceLayer, type T1CoverageDiagnostics, type UnresolvedFactRecord,
} from './types';
import { verificationAutoRetryDue } from './verification-followup';
import { decideRequeueAdmission, decideRetry, releaseUnschedulablePending, retryFactsOf, retryLimits } from './retry-policy';
import {
  claimRequeueRequest, markRequeueStep, noteKnownRequest, readRequeueRequest, requeueActionOf, requeueEvidenceFingerprint, requeueRequestKey,
  requeueRequestsReady, RequeueIdentityUnavailableError,
  type RequeueClaim, type RequeueRequestRecord, type RequeueRequestState, type RequeueSteps,
} from './requeue-identity';
import { loadEvidenceDependencies } from './evidence-version';
import type { RequeueOrigin } from './retry-policy';
import type { T1EnqueueOutcome, T1EnqueueStatus } from '../queue/t1-handler';
import { partitionUnitRefs, relinkFromStored, type StoredUnitView } from './provenance-integrity';
import { provenanceJournalReady, recordProvenanceEvents } from './provenance-repair';
import type { AnalysisContext, ExtractedTable, SourceInput, VisualObservation } from '../types';
import type { AccountCapabilities } from '@/services/account-capabilities.service';
import type { AssetFamily as V2AssetFamily } from '@/lib/referential/v2';
import type { SourceRereadCall, SourceRereadResult } from './source-reread';
import type { ProjectedFact, T1AnalyzeDocumentOutput, T1Fact } from '../master/t1-contract';
import type { RepairPropagationOutcome } from '../operation-candidates/repair-propagation.store';

import { FactRefs, KnownFacts, LocalLinks, factCoreIdentity, type FactIdentityInput } from './repair-identity';
import type { RepairCallEnvelope, RepairReceivedDecision } from './repair';
type Row = Record<string, unknown>;
const num = (v: unknown, def: number) => {
  const n = Number(v);
  return v !== undefined && v !== null && String(v).trim() !== '' && Number.isFinite(n) ? n : def;
};
const ON = new Set(['on', 'true', '1', 'yes']);

const DEFAULT_BACKFILL_BATCH = 200;
const DEFAULT_RETRY_BATCH = 10;

function jobSettings(env: Record<string, string | undefined> = process.env) {
  return {
    backfillBatch: Math.min(1_000, Math.max(1, Math.trunc(num(env.T1_BACKFILL_BATCH, DEFAULT_BACKFILL_BATCH)))),
    backfillAiRepair: ON.has((env.T1_BACKFILL_AI_REPAIR ?? '').trim().toLowerCase()),
    retryBatch: Math.min(100, Math.max(1, Math.trunc(num(env.T1_RETRY_BATCH, DEFAULT_RETRY_BATCH)))),
    maxRetries: maxCompletenessRetries(env),
  };
}

/** Délai avant la reprise n°`attempt` (1 h, 4 h, 16 h…). */
const retryDelayMs = (attempt: number) => 3_600_000 * 4 ** Math.max(0, attempt - 1);

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
  /** Lot 113AK : provenance déjà posée (lue par la reprise historique pour la vérifier). */
  source_unit_ids?: string[] | null;
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
  const provenance = p.facts.map((f) => ({ id: Number(f.id), ids: linker.link(evidenceOfStored(f)), confidence: f.confidence, values: evidenceOfStored(f).values }));
  const meta = new Set<string>();
  for (const v of Object.values(e.structural_evidence ?? {})) {
    if (v?.excerpt) for (const id of linker.link({ excerpt: v.excerpt })) if (!id.startsWith('doc:')) meta.add(id);
  }
  const cov = computeCoverage(units, {
    facts: provenance.map((x) => ({ unitIds: x.ids, confidence: x.confidence, values: x.values })),
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

/**
 * Lot 113AK (#736) — provenance déjà posée sur des faits historiques, vérifiée
 * contre les unités reconstruites (pure) : rend les faits à corriger.
 */
export function verifierProvenanceHistorique(facts: readonly StoredFactRow[], units: readonly StoredUnitView[]): Array<{
  id: number; before: string[]; after: string[] | null; invalid: string[]; status: 'RELINKED' | 'NOT_RECONSTRUCTIBLE';
}> {
  const ids = new Set(units.map((u) => u.sourceUnitId));
  const out: ReturnType<typeof verifierProvenanceHistorique> = [];
  for (const f of facts) {
    const avant = Array.isArray(f.source_unit_ids) ? f.source_unit_ids.map(String) : [];
    if (avant.length === 0) continue;
    const { valid, invalid } = partitionUnitRefs(avant, ids);
    if (invalid.length === 0) continue;
    const relie = relinkFromStored({ excerpt: f.excerpt, location: f.location, evidenceOrigin: f.evidence_origin, visualEvidence: f.visual_evidence ?? null }, units);
    const apres = relie.length ? [...new Set([...valid, ...relie])] : valid.length ? valid : null;
    out.push({ id: Number(f.id), before: avant, after: apres, invalid, status: relie.length ? 'RELINKED' : 'NOT_RECONSTRUCTIBLE' });
  }
  return out;
}

interface BackfillResult { processed: number; failed: number; more: boolean; disabled?: boolean }

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
                    label, attribute, fact_key, source_unit_ids
               FROM document_facts WHERE file_id = $1 AND status = 'active' ORDER BY id`,
            [e.file_id] as never[],
          ) as unknown as Promise<StoredFactRow[]>,
        ]);
        const b = backfillLayer({ extraction: e, tables: tables as unknown as ExtractedTable[], facts });
        const aReparer = s.backfillAiRepair && b.repairCandidates > 0;
        // Lot 113AK (#736) : une provenance DÉJÀ posée (analyse dont la couche A n'a pas été écrite) n'est plus laissée
        // telle quelle : vérifiée contre les unités reconstruites du MÊME document, rétablie depuis l'extrait, la
        // cellule ou l'observation conservés, sinon retirée (« provenance non reconstituable », valeur conservée).
        const corrections = verifierProvenanceHistorique(facts, b.layer.units);
        const journal = corrections.length > 0 && await provenanceJournalReady(pgClient as never);
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
          for (const c of corrections) {
            await tx.unsafe(
              `UPDATE document_facts SET source_unit_ids = $3::text[]${journal ? ', provenance_status = $5' : ''}
                WHERE id = $1 AND file_id = $2 AND source_unit_ids IS NOT DISTINCT FROM $4::text[]`,
              [c.id, e.file_id, c.after, c.before, ...(journal ? [c.status] : [])] as never[],
            );
          }
          if (journal) {
            await recordProvenanceEvents(tx as never, corrections.flatMap((c) => c.invalid.map((u) => ({
              accountId: e.account_id, fileId: e.file_id, subject: 'FACT' as const, factId: c.id, extractionId: e.id, sourceUnitId: u,
              status: c.status, cause: 'UNIT_MISSING_AFTER_LAYER_REBUILD', phase: 'BACKFILL' as const,
              detail: { before: c.before, after: c.after, beforeStatus: null },
            }))));
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

export const toCovered = (u: StoredSourceUnit): CoveredSourceUnit => ({
  sourceUnitId: u.sourceUnitId, kind: u.kind, page: u.page, ordinal: u.ordinal, parentUnitId: u.parentUnitId,
  text: u.text, label: u.label, value: u.value, payload: u.payload ?? {}, location: u.location ?? {},
  origin: u.origin as CoveredSourceUnit['origin'], salient: u.salient, status: u.coverageStatus, reason: u.coverageReason,
  factCount: u.factCount, repairAttempts: u.repairAttempts,
  repairState: (u.repairState ?? null) as CoveredSourceUnit['repairState'],
  // Lot 113AN : provenance de couverture et politique conservées d'une réécriture à l'autre.
  coverageProvenance: (typeof u.coverageProvenance === 'string' ? JSON.parse(u.coverageProvenance) : u.coverageProvenance) ?? null,
  residualPolicy: u.residualPolicy ?? null,
});

interface RetryResult {
  examined: number; repaired: number; requeued: number; final: number; failed: number; more: boolean; disabled?: boolean;
  /** Lot 114H (#775, P1-B) : remises en file T1 demandées mais NON confirmées (refus, compte non éligible) — jamais comptées « requeued ». */
  notQueued: number;
}

/** Bail d'une reprise en cours (protection contre les exécutions concurrentes ; worker arrêté → reprise après le bail). */
const RETRY_LEASE_MINUTES = 30;

export async function runCompletenessRetry(opts: { deadline?: number; env?: Record<string, string | undefined> } = {}): Promise<RetryResult> {
  const res: RetryResult = { examined: 0, repaired: 0, requeued: 0, final: 0, failed: 0, more: false, notQueued: 0 };
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
      else if (out === 'not_queued') res.notQueued++;
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
export function storedDiagnostics(v: Record<string, unknown> | null | undefined) {
  const d = (v ?? {}) as Partial<T1CoverageDiagnostics> & { continuationRuns?: number };
  const nums = (x: unknown) => (Array.isArray(x) ? x.map(Number).filter((n) => Number.isInteger(n)) : []);
  const verification = d.sourceVerification
    ? {
      status: d.sourceVerification, reason: d.verificationReason ?? null, pagesExpected: d.pagesExpected ?? null,
      verified: [], missing: nums(d.pagesMissing), unverified: nums(d.pagesUnverified), scanned: nums(d.pagesScanned), reread: nums(d.pagesReread),
    }
    : null;
  if (verification && Array.isArray(d.pagesCitedUnverified)) (verification as { citedUnverified?: number[] }).citedUnverified = nums(d.pagesCitedUnverified);
  // Lot 109K (COR-01) : le verdict par page survit aux reprises (jamais perdu par une réécriture de la couverture).
  if (verification && Array.isArray(d.pageDetails)) Object.assign(verification, { pageDetails: d.pageDetails });
  if (verification && d.verifierVersion) Object.assign(verification, { verifierVersion: d.verifierVersion });
  if (verification && d.textLayer) Object.assign(verification, { textLayer: d.textLayer });
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
    // Lot 109K (COR-02) : dernière propagation d'une réparation (conservée d'une reprise à l'autre).
    repairPropagation: (d.repairPropagation ?? null) as Record<string, unknown> | null,
    // Lot 113AN : réparation de couverture de l'analyse (conservée d'une reprise à l'autre).
    coverageRepair: (d.coverageRepair ?? null) as T1CoverageDiagnostics['coverageRepair'] | null,
  };
}

/** Lot 109K (COR-02) : résumé borné d'une propagation pour le diagnostic de couverture. */
function propagationSummary(o: RepairPropagationOutcome): Record<string, unknown> {
  return {
    decision: o.decision, reason: o.reason, newFacts: o.newFactIds.length, categories: o.categories,
    candidates: o.candidates.slice(0, 10).map((c) => ({ key: c.candidateKey, decision: c.decision, from: c.previousId, to: c.newId, changes: c.changes.slice(0, 12) })),
    t3: o.t3, at: new Date().toISOString(),
  };
}

/** Lot 114H (#775, P1-B) — refus TRANSITOIRES de mise en file tolérés avant de consommer une reprise. */
export const REQUEUE_TRANSIENT_MAX = 3;
/** Délai avant de retenter une mise en file refusée pour une cause transitoire (15 min, 30 min, 1 h…). */
const requeueTransientDelayMs = (refusals: number) => 15 * 60_000 * 2 ** Math.max(0, refusals - 1);
const requeueFingerprint = (fileId: number) => `ai:t1-requeue:${fileId}`;

/** Issue d'une demande de relecture du fichier par la file T1 (lot 114H, #775 P1-B). */
export interface RequeueResult {
  /**
   * Réponse réelle de la file (`T1EnqueueStatus`), ou, lot 115H (#785) :
   *   `NOT_ADMISSIBLE` (§ 1) la demande a été refusée par la règle commune AVANT
   *          tout enfilement (plafond à zéro, atteint ou abaissé). Aucun travail
   *          créé, aucune reprise consommée, aucune reprise promise ;
   *   `IDENTICAL_REQUEST_ALIVE` (§ 2) une demande RIGOUREUSEMENT identique
   *          (mêmes preuves) est déjà servie par un travail vivant : il est
   *          CONSTATÉ, sans nouvel enfilement, sans passage supplémentaire et
   *          sans aucune consommation ;
   *   `ALREADY_SATISFIED` (§ 2) la même demande a déjà été servie par un travail
   *          TERMINÉ dont le résultat est acquis, et aucune preuve n'a changé
   *          depuis : la rejouer refarait à l'identique. Rien n'est consommé.
   */
  status: T1EnqueueStatus | 'NOT_ADMISSIBLE' | 'IDENTICAL_REQUEST_ALIVE' | 'ALREADY_SATISFIED'
    /**
     * Carte #837 (A3) : la MÊME demande canonique est tenue par une autre exécution (bail vivant) — rien n'est
     * réservé, enfilé, consommé ni écrit par cet appel.
     */
    | 'IDENTICAL_REQUEST_IN_PROGRESS'
    /**
     * Carte #837 (A2) : le travail était déjà TERMINÉ à l'inspection — jamais « en file » (`queued` faux) ;
     * `businessResult` dit s'il a réussi au sens métier.
     */
    | 'COMPLETED';
  /** Un travail vivant du document est CONFIRMÉ (créé, ou déjà présent) — seule condition de « REQUEUED_T1 ». */
  queued: boolean;
  jobId: number | null;
  /** Motif exact du refus (code de la file) ; null si confirmé. */
  reason: string | null;
  /** Une reprise a-t-elle été consommée ? */
  attemptConsumed: boolean;
  /** Code consigné sur la couverture (`last_retry_result`). */
  result: string;
  /** Carte #837 (A2) : résultat métier du travail terminé (`COMPLETED`, `ALREADY_SATISFIED`). */
  businessResult?: string | null;
  /** Carte #837 (B2) : étapes dont l'écriture n'a PAS été confirmée (jamais absorbées en silence). */
  traceErrors?: string[];
}

/** Écritures de la couverture après une demande de mise en file (pure, testée). */
export function requeueCoverageUpdate(p: {
  status: T1EnqueueStatus; attempt: number; result: string; reason: string | null; maxRetries: number;
  /** Refus transitoires déjà subis par cette demande. */
  transientRefusals: number;
  /** Demande de la tâche planifiée (la ligne est sous bail : l'échéance doit être reposée). */
  scheduled: boolean; nowMs: number;
}): {
  result: string; consumeAttempt: boolean; transientRefusals: number; lastError: string | null; alert: boolean;
  /** `Date` : échéance à poser ; `null` : aucune ; `'KEEP'` : échéance inchangée. */
  nextRetryAt: Date | null | 'KEEP';
} {
  switch (p.status) {
    case 'ACCEPTED':
      return { result: p.result, consumeAttempt: true, transientRefusals: 0, lastError: null, alert: false, nextRetryAt: null };
    case 'ALREADY_RUNNING':
      // Le travail vivant n'est pas né de CETTE demande : aucune reprise consommée (tentatives exactes).
      return { result: 'REQUEUE_ALREADY_RUNNING', consumeAttempt: false, transientRefusals: 0, lastError: null, alert: false, nextRetryAt: null };
    case 'ACCOUNT_NOT_ELIGIBLE':
      // La demande reste DUE : la tâche planifiée ne prend que les comptes éligibles (lot 82A) et repart à la réactivation.
      return {
        result: 'REQUEUE_ACCOUNT_NOT_ELIGIBLE', consumeAttempt: false, transientRefusals: p.transientRefusals,
        lastError: 'mise en file T1 refusée : compte non éligible au traitement', alert: false,
        nextRetryAt: p.scheduled ? new Date(p.nowMs) : 'KEEP',
      };
    case 'REJECTED_TRANSIENT': {
      const n = p.transientRefusals + 1;
      const erreur = `mise en file T1 refusée (transitoire) : ${p.reason ?? 'cause inconnue'}`;
      if (n <= REQUEUE_TRANSIENT_MAX) {
        return {
          result: 'REQUEUE_REJECTED_TRANSIENT', consumeAttempt: false, transientRefusals: n, lastError: erreur, alert: false,
          nextRetryAt: p.scheduled ? new Date(p.nowMs + requeueTransientDelayMs(n)) : 'KEEP',
        };
      }
      // Refus transitoires répétés : une reprise est consommée (jamais de boucle) ; au plafond, plus d'échéance.
      const reste = p.attempt < p.maxRetries;
      return {
        result: 'REQUEUE_REJECTED_TRANSIENT', consumeAttempt: true, transientRefusals: 0, lastError: erreur, alert: !reste,
        nextRetryAt: !p.scheduled ? 'KEEP' : reste ? new Date(p.nowMs + retryDelayMs(p.attempt + 1)) : null,
      };
    }
    case 'REJECTED_FINAL':
      return {
        result: 'REQUEUE_REJECTED_FINAL', consumeAttempt: false, transientRefusals: 0, alert: true,
        lastError: `mise en file T1 refusée (définitif) : ${p.reason ?? 'cause inconnue'}`, nextRetryAt: null,
      };
  }
}

// ── Lot 115H (#785, § 2) : lecture des preuves d'une couverture ─────────────

type DiagVerification = { verificationReason?: unknown; pagesMissing?: unknown; reverification?: { fingerprint?: unknown } };
const diagDe = (v: unknown): DiagVerification => {
  const o = (typeof v === 'string' ? JSON.parse(v) : v) as DiagVerification | null;
  return o && typeof o === 'object' ? o : {};
};
function lireMotifVerification(v: unknown): string | null {
  const r = diagDe(v).verificationReason;
  return typeof r === 'string' ? r : null;
}
function lirePagesManquantes(v: unknown): number[] {
  const m = diagDe(v).pagesMissing;
  return Array.isArray(m) ? m.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
}
function lireEmpreinteReverification(v: unknown): string | null {
  const f = diagDe(v).reverification?.fingerprint;
  return typeof f === 'string' ? f : null;
}

/**
 * Carte #837 (A2) — un travail TERMINÉ n'est un résultat ACQUIS que si son
 * résultat MÉTIER le dit (pure). `DONE` seul ne prouve rien : un travail clos
 * en `FAILED` métier, `SUPERSEDED`, `TARGET_GONE`, `ABSTAIN` ou sans résultat
 * consigné n'a pas satisfait la demande.
 */
export function doneJobSatisfies(businessResult: string | null | undefined): boolean {
  return businessResult === 'APPLIED' || businessResult === 'NO_CHANGE';
}

/** Libellé court d'un motif de refus d'admission (journaux, jamais de contenu). */
const MOTIF_REFUS: Record<string, string> = {
  RETRIES_DISABLED: 'remise en file T1 refusée : les reprises sont désactivées',
  RETRY_CAP_REACHED: 'remise en file T1 refusée : plafond de reprises atteint',
  SOURCE_NOT_AVAILABLE: 'remise en file T1 refusée : fichier source absent ou supprimé (non relisible)',
  NOTHING_TO_RETRY: 'remise en file T1 refusée : le document est complet, aucune action utile',
  ACCOUNT_NOT_ELIGIBLE: 'remise en file T1 refusée : compte non éligible au traitement',
  AI_TREATMENT_BLOCKED: 'remise en file T1 refusée : traitement T1 suspendu ou arrêté',
  ACCOUNT_AI_BUDGET_REACHED: 'remise en file T1 refusée : plafond de coût IA du compte atteint',
  IDENTITY_UNAVAILABLE: 'remise en file T1 refusée : identité des demandes indisponible (migrations 1805 / 1970)',
};

/**
 * Lot 115H (#785, § 2), complété par la carte #837 (A2) — demande d'identité
 * DÉJÀ CONNUE (`CONFIRMED` ou `OBSERVED`) : que faire ?
 *
 * `null` : la demande repart (re-réservation, dans ses bornes). Sinon l'issue
 * est rendue telle quelle : aucun enfilement, aucune consommation.
 *   · travail VIVANT (`PENDING` / `RUNNING` — seuls états vivants) : constaté ;
 *   · travail `DONE` dont le résultat MÉTIER est acquis (`APPLIED`,
 *     `NO_CHANGE`) et preuves inchangées (l'empreinte est dans l'identité) :
 *     `ALREADY_SATISFIED`, jamais « en file » ;
 *   · `DONE` en échec métier (ou sans résultat), `FAILED`, `CANCELLED`, aucun
 *     travail : décision EXPLICITE de reprise (consignée), jamais un acquis.
 */
async function courtCircuitDemandeConnue(p: {
  fileId: number; accountId: number; origin: string; demande: RequeueRequestRecord; origine: RequeueOrigin;
}): Promise<RequeueResult | null> {
  const { demande } = p;
  const { inspectCorrelatedJob } = await import('../../queue/job-queue.repository');
  const travail = await inspectCorrelatedJob({
    treatment: 'T1', accountId: p.accountId, targetType: 'asset_file', targetId: p.fileId, jobId: demande.jobId,
  });
  if (travail.state === 'ALIVE') {
    await noteKnownRequest({ requestId: demande.id, fromState: demande.state, toState: 'OBSERVED', jobId: travail.jobId, reason: 'IDENTICAL_REQUEST_ALIVE' });
    console.info(`[t1-requeue] document ${p.fileId} (${p.origin}, ${p.origine}) : demande identique déjà servie par le travail `
      + `${travail.jobId} (${travail.status}) — constatée, aucun passage supplémentaire, aucune reprise consommée.`);
    return {
      status: 'IDENTICAL_REQUEST_ALIVE', queued: true, jobId: travail.jobId, reason: null,
      attemptConsumed: false, result: 'REQUEUE_IDENTICAL_ALIVE',
    };
  }
  if (travail.state === 'DONE' && doneJobSatisfies(travail.businessResult)) {
    await noteKnownRequest({ requestId: demande.id, fromState: demande.state, jobId: travail.jobId, reason: 'ALREADY_SATISFIED' });
    console.info(`[t1-requeue] document ${p.fileId} (${p.origin}, ${p.origine}) : demande identique déjà servie par le travail `
      + `${travail.jobId} terminé (${travail.businessResult}) — non rejouée (preuves inchangées).`);
    return {
      status: 'ALREADY_SATISFIED', queued: false, jobId: travail.jobId, reason: 'ALREADY_SATISFIED',
      attemptConsumed: false, result: 'REQUEUE_ALREADY_SATISFIED', businessResult: travail.businessResult,
    };
  }
  // DONE en échec métier, FAILED, CANCELLED ou disparu : la MÊME demande a droit à une nouvelle tentative, dans ses bornes.
  const motif = travail.state === 'DONE' ? `travail précédent DONE, résultat métier ${travail.businessResult ?? 'absent'} (non acquis)` : `travail précédent ${travail.state}`;
  await noteKnownRequest({ requestId: demande.id, fromState: demande.state, reason: motif });
  console.info(`[t1-requeue] document ${p.fileId} (${p.origin}, ${p.origine}) : ${motif} — nouvelle tentative examinée dans ses bornes.`);
  return null;
}

/** Attente maximale de la clôture d'une demande identique tenue par une autre exécution (carte #837, A3). */
const REQUEUE_IN_PROGRESS_WAIT_MS = 10_000;

/** Fencing perdu à la clôture d'une demande (carte #837, B3/B2) : la transaction est annulée. */
class RequeueLeaseLostError extends Error {
  constructor(id: number) {
    super(`demande de reprise ${id} : bail perdu avant la clôture — rien n'est compté par cette exécution`);
    this.name = 'RequeueLeaseLostError';
  }
}

/**
 * Carte #837 (D1) — SUITE D'UNE CAMPAGNE, consignée par l'exécution elle-même
 * (corrélation explicite, immuable). Table absente : avertissement, la suite
 * reste comptée « non corrélée » au bilan — jamais 0.
 */
export async function recordCampaignFollowUp(p: {
  campaignRef: string; accountId: number; fileId: number; kind: 'TEXT_REPAIR' | 'SOURCE_REREAD' | 'REQUEUE_T1';
  requestId?: number | null; jobId?: number | null; businessExecutionId?: string | null;
  calls?: number | null; callsFailed?: number | null; costMicros?: number | null; costUnknownCalls?: number | null;
  result?: string | null; businessSuccess?: boolean | null; unitsAttempted?: number | null; unitsRepaired?: number | null;
  residualUnits?: number | null; qualityBefore?: string | null; qualityAfter?: string | null;
}): Promise<boolean> {
  try {
    const { pgClient } = await import('@/db');
    await pgClient.unsafe(
      `/* c837:followup */ INSERT INTO t1_campaign_followups
         (campaign_ref, account_id, file_id, kind, request_id, job_id, business_execution_id, calls, calls_failed, cost_micros,
          cost_unknown_calls, result, business_success, units_attempted, units_repaired, residual_units, quality_before, quality_after)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
      [p.campaignRef, p.accountId, p.fileId, p.kind, p.requestId ?? null, p.jobId ?? null, p.businessExecutionId ?? null,
        p.calls ?? null, p.callsFailed ?? null, p.costMicros ?? null, p.costUnknownCalls ?? null, p.result ?? null,
        p.businessSuccess ?? null, p.unitsAttempted ?? null, p.unitsRepaired ?? null, p.residualUnits ?? null,
        p.qualityBefore ?? null, p.qualityAfter ?? null] as never[],
    );
    return true;
  } catch (e) {
    console.warn(`[t1-campaign] suite ${p.kind} du document ${p.fileId} (${p.campaignRef}) non consignée :`, (e as Error).message);
    return false;
  }
}

/** Campagne de réévaluation qui a programmé la reprise de cette couverture (carte #837, D1) ; null : aucune. */
export function campaignRefOf(verification: unknown): string | null {
  const v = (typeof verification === 'string' ? JSON.parse(verification) : verification) as { scheduledBy?: { origin?: unknown } } | null;
  const o = v?.scheduledBy?.origin;
  return typeof o === 'string' && o.startsWith('t1-coverage-reassessment:') ? o : null;
}

/**
 * Relecture du FICHIER : le document repasse dans la file T1 (traitement
 * technique, non facturé, non annoncé). Lot 53 (D19) : partagée par la
 * reprise d'une lacune de pages, d'une vérification incomplète transitoire,
 * la reprise manuelle du BO et le contrôle de cohérence (`result`).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LOT 114H (Trello #775, P1-B) — PLUS DE REJEU FICTIF : l'issue RÉELLE de la
 * file est lue, la présence du travail est RELUE en base, et la couverture
 * n'est écrite « remise en file » que si un travail vivant est confirmé.
 *
 * LOT 115H (Trello #785, § 1, § 2, § 4) — droit contrôlé et réservé AVANT tout
 * enfilement ; identité persistante de la demande ; reprise après panne.
 *
 * CARTE TRELLO #837 — RÉSIDUS DU LOT 115H
 *   A1  ADMISSION COMMUNE avant tout enfilement : fichier présent et non
 *       supprimé, action utile, compte éligible, traitement T1 non suspendu,
 *       plafond de coût IA du compte, puis plafond de reprises sous verrou.
 *       Refus = aucun travail, aucune consommation, motif consigné.
 *   A2  Seuls PENDING / RUNNING sont VIVANTS. Un travail déjà `DONE` à
 *       l'inspection n'est plus rendu « en file » : son résultat MÉTIER est
 *       lu, et la demande est close `COMPLETED` (succès ou échec métier).
 *   A3  IDENTITÉ CANONIQUE (compte, document, action, preuves) et réservation
 *       ATOMIQUE sous bail ; migration 1805 / 1970 absente = refus visible.
 *   A4  Un refus DÉFINITIF retire l'échéance (plus de « reprise programmée »
 *       fictive, plus de boucle du planificateur) ; l'échéance historique est
 *       conservée dans la trace. Un refus TEMPORAIRE garde la demande due.
 *   B2  Étapes confirmées sous jeton ; consommation (compteur) et clôture de
 *       la demande dans UNE transaction ; erreurs de trace rendues
 *       (`traceErrors`), jamais absorbées.
 * ══════════════════════════════════════════════════════════════════════════
 */
export async function requeueDocumentForRereadDetailed(p: {
  fileId: number; accountId: number; attempt: number; origin: string; result: string;
  /** Demande de la tâche planifiée `t1-completeness-retry` (ligne sous bail). */
  scheduled?: boolean;
  env?: Record<string, string | undefined>;
  /**
   * Lot 115H (#785, § 1) : origine de la demande — PROVENANCE seulement (carte
   * #837, A3 : elle ne fait plus partie de l'identité). Aucune origine n'a de
   * privilège : la règle d'admission est la même pour toutes.
   */
  requestedBy?: RequeueOrigin;
  /** Identité IMPOSÉE de la demande (action distincte justifiée par l'appelant). */
  requestKey?: string;
  /** Carte #837 (D1) : campagne de réévaluation à l'origine de la reprise (corrélation explicite). */
  campaignRef?: string | null;
}): Promise<RequeueResult> {
  const { pgClient } = await import('@/db');
  const limites = retryLimits(p.env);
  const origine: RequeueOrigin = p.requestedBy ?? (p.scheduled ? 'SCHEDULER' : 'OTHER');
  const action = requeueActionOf(p.origin);
  // Faits d'admission ET preuves, lus ensemble et filtrés par le compte (codes et compteurs seulement).
  const [etat] = (await pgClient.unsafe(
    `SELECT c.retry_attempts, c.quality_state, c.anomalies, c.unresolved_units, c.uncertain_units, c.failed_units,
            c.layer_version, to_jsonb(c) ->> 'source_verification' AS source_verification,
            to_jsonb(c) -> 'verification' AS verification, (c.file_id IS NOT NULL) AS has_coverage,
            (SELECT x.source_sha256 FROM document_raw_extracts x WHERE x.file_id = f.id AND x.account_id = $2) AS source_sha256,
            (af.id IS NOT NULL) AS file_present, (af.deleted_at IS NULL) AS file_alive,
            ${processingEligibleSql('$2::int')} AS account_eligible
       FROM (SELECT $1::int AS id) f
       LEFT JOIN asset_files af ON af.id = f.id AND af.account_id = $2
       LEFT JOIN document_extraction_coverage c ON c.file_id = f.id AND c.account_id = $2`,
    [p.fileId, p.accountId] as never[],
  ).catch(() => [])) as unknown as Array<{
    retry_attempts: number | null; quality_state: string | null; anomalies: string[] | null;
    unresolved_units: number | null; uncertain_units: number | null; failed_units: number | null;
    layer_version: number | null; source_verification: string | null; verification: unknown; source_sha256: string | null;
    has_coverage?: boolean | null; file_present?: boolean | null; file_alive?: boolean | null; account_eligible?: boolean | null;
  }>;
  const ligne = etat !== undefined && (etat.has_coverage ?? etat.retry_attempts != null) === true;
  const tentativesLues = ligne ? Number(etat!.retry_attempts ?? 0) || 0 : Math.max(0, p.attempt - 1);

  /** Écrit un REFUS (aucune consommation) sur la couverture — carte #837 (A4) : échéance retirée si le refus est définitif. */
  const refuser = async (motif: string, temporary: boolean, attemptsSeen: number): Promise<RequeueResult> => {
    const resultat = `REQUEUE_NOT_ADMISSIBLE:${motif}`;
    // Demande PLANIFIÉE (la ligne est sous le bail de la tâche) : refus DÉFINITIF → l'échéance est RETIRÉE (sinon le
    // bail expirait et le planificateur reprenait le document en boucle, affiché « reprise programmée ») ; refus
    // TEMPORAIRE → la demande reste due, une heure plus tard. Demande MANUELLE (BO, cohérence) : l'échéance n'est
    // pas touchée — elle peut porter une continuation légitime ; l'affichage ne la présente comme « reprise
    // programmée » que si une reprise est encore admissible (`scheduleAdmissible`), et la tâche la rejuge à son tour.
    const garder = !p.scheduled;
    const prochaine = temporary && p.scheduled ? new Date(Date.now() + 3_600_000).toISOString() : null;
    await pgClient.unsafe(
      `UPDATE document_extraction_coverage
          SET last_retry_at = NOW(), last_retry_result = $3, last_error = $4, updated_at = NOW(),
              verification = jsonb_set(coalesce(verification, '{}'::jsonb), '{requeue}',
                $5::jsonb || jsonb_build_object('previousNextRetryAt', to_jsonb(next_retry_at)), true),
              next_retry_at = CASE WHEN $6::boolean THEN next_retry_at ELSE $7::timestamptz END
        WHERE file_id = $1 AND account_id = $2`,
      [p.fileId, p.accountId, resultat, MOTIF_REFUS[motif] ?? `remise en file T1 refusée : ${motif}`,
        JSON.stringify({
          status: 'NOT_ADMISSIBLE', reason: motif, temporary, jobId: null, origin: p.origin, requestedBy: origine, action,
          at: new Date().toISOString(), attemptConsumed: false, maxRetries: limites.maxRetries, retryAttempts: attemptsSeen,
        }), garder, prochaine] as never[],
    ).catch(() => undefined);
    console.warn(`[t1-requeue] fichier ${p.fileId} (${p.origin}, ${origine}) : demande REFUSÉE avant tout enfilement — ${motif} `
      + `(${attemptsSeen} reprise(s) consommée(s), plafond ${limites.maxRetries}${temporary ? ', cause temporaire' : ''}).`);
    return { status: 'NOT_ADMISSIBLE', queued: false, jobId: null, reason: motif, attemptConsumed: false, result: resultat };
  };

  // ══════════════════════════════════════════════════════════════════════
  // CARTE #837 (A3) — MIGRATION 1805 / 1970 OBLIGATOIRE : FAIL-CLOSED VISIBLE
  // Règle remplacée : sans la table des demandes, la reprise continuait SANS
  // identité persistante (double réservation inter-origines, reprise après
  // panne non garantie). Elle est maintenant REFUSÉE, avec un motif nommé, une
  // trace sur la couverture et une anomalie de Supervision.
  // ══════════════════════════════════════════════════════════════════════
  const indisponible = async (): Promise<RequeueResult> => {
    console.error(`[t1-requeue] fichier ${p.fileId} : ${MOTIF_REFUS.IDENTITY_UNAVAILABLE}.`);
    try {
      const { reportAnomaly } = await import('@/services/admin/anomaly.service');
      await reportAnomaly({
        domain: 'ai', fingerprint: 'ai:t1-requeue-identity-unavailable', accountId: null,
        title: 'Remises en file T1 refusées : identité des demandes indisponible (migrations 1805 / 1970 non appliquées)',
        detail: { fileId: p.fileId, origin: p.origin }, materialKey: 'IDENTITY_UNAVAILABLE',
      } as never);
    } catch { /* la Supervision ne fait jamais échouer le refus */ }
    return refuser('IDENTITY_UNAVAILABLE', true, tentativesLues);
  };
  if (!(await requeueRequestsReady())) return indisponible();

  // Carte #837 (C2) : empreinte VERSIONNÉE de toutes les dépendances lues, en plus des codes et compteurs.
  const dependances = await loadEvidenceDependencies(pgClient as never, p.accountId, p.fileId);
  const empreinte = requeueEvidenceFingerprint({
    qualityState: etat?.quality_state ?? null, anomalies: etat?.anomalies ?? null,
    verificationReason: lireMotifVerification(etat?.verification),
    sourceVerification: etat?.source_verification ?? null,
    pagesMissing: lirePagesManquantes(etat?.verification),
    unresolvedUnits: etat?.unresolved_units ?? null, uncertainUnits: etat?.uncertain_units ?? null,
    failedUnits: etat?.failed_units ?? null,
    reverificationFingerprint: lireEmpreinteReverification(etat?.verification),
    sourceSha256: etat?.source_sha256 ?? null, layerVersion: etat?.layer_version ?? null,
    dependencies: dependances.fingerprint,
  });
  const cle = requeueRequestKey({ action, evidenceFingerprint: empreinte, explicit: p.requestKey ?? null });

  // ══════════════════════════════════════════════════════════════════════
  // CARTE #837 (A1) — ADMISSION COMMUNE (toutes origines, aucun privilège)
  // ══════════════════════════════════════════════════════════════════════
  let traitementOk = true;
  try {
    const { isTreatmentRunnable } = await import('../../queue/runnable-guard');
    traitementOk = await isTreatmentRunnable('T1');
  } catch { /* garde illisible : même politique que la passerelle (échec ouvert documenté) */ }
  let budgetAtteint = false;
  try {
    const { costCapReachedFor } = await import('../../gateway/account-cost-cap');
    budgetAtteint = (await costCapReachedFor(p.accountId)) !== null;
  } catch { /* idem : plafond non vérifiable → la passerelle tranchera à l'appel */ }
  const blocage = decideRequeueAdmission({
    filePresent: etat?.file_present ?? null, fileAlive: etat?.file_alive ?? null, accountEligible: etat?.account_eligible ?? null,
    treatmentRunnable: traitementOk, costCapReached: budgetAtteint, qualityState: ligne ? etat?.quality_state ?? null : null, action,
  });

  let prise: RequeueClaim | null = null;
  let attendu: RequeueRequestState | null = null;
  // Une AUTRE exécution tient la même demande (bail vivant, quelques secondes) : on attend sa clôture, puis on CONSTATE
  // son issue (travail vivant, terminé…) — jamais un second travail, jamais une seconde consommation.
  const finAttente = Date.now() + REQUEUE_IN_PROGRESS_WAIT_MS;
  try {
    for (let tour = 0; tour < 200 && prise === null; tour++) {
      const connue = await readRequeueRequest({ accountId: p.accountId, fileId: p.fileId, requestKey: cle });
      if (connue && (connue.state === 'CONFIRMED' || connue.state === 'OBSERVED')) {
        const court = await courtCircuitDemandeConnue({ fileId: p.fileId, accountId: p.accountId, origin: p.origin, demande: connue, origine });
        if (court) return court;
        attendu = connue.state;
      }
      if (connue && connue.state === 'RESERVED' && connue.leaseAlive) {
        if (Date.now() >= finAttente) { prise = { kind: 'IN_PROGRESS', requestId: connue.id }; break; }
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
      const c = await claimRequeueRequest({
        accountId: p.accountId, fileId: p.fileId, requestKey: cle, origin: p.origin, requestedBy: origine, evidenceFingerprint: empreinte,
        maxRetries: limites.maxRetries, hasCoverage: ligne, callerAttempts: Math.max(0, p.attempt - 1),
        admissionBlock: blocage ? { code: blocage.block, temporary: blocage.temporary } : null, expectedState: attendu,
        campaignRef: p.campaignRef ?? null,
      });
      if (c.kind === 'IN_PROGRESS' && Date.now() < finAttente) { await new Promise((r) => setTimeout(r, 100)); continue; }
      if (c.kind !== 'CHANGED') prise = c;
    }
  } catch (e) {
    if (e instanceof RequeueIdentityUnavailableError) return indisponible();
    throw e;
  }
  if (prise === null || prise.kind === 'IN_PROGRESS') {
    // Une AUTRE exécution tient la MÊME demande (bail vivant) : rien n'est réservé, enfilé ni écrit ici.
    console.info(`[t1-requeue] document ${p.fileId} (${p.origin}, ${origine}) : demande identique en cours de traitement par une autre exécution — rien n'est doublé.`);
    return {
      status: 'IDENTICAL_REQUEST_IN_PROGRESS', queued: false, jobId: null, reason: 'REQUEST_IN_PROGRESS',
      attemptConsumed: false, result: 'REQUEUE_IDENTICAL_IN_PROGRESS',
    };
  }
  if (prise.kind === 'REFUSED') return refuser(prise.block, prise.temporary, prise.attemptsBefore);
  if (prise.kind !== 'RESERVED') throw new Error('issue de réservation inattendue');
  const reservation = prise;

  // ══════════════════════════════════════════════════════════════════════
  // CARTE #837 (B2) — ÉTAPES CONFIRMÉES SOUS JETON ; ERREURS RENDUES
  // ══════════════════════════════════════════════════════════════════════
  const traceErrors: string[] = [];
  const etape = async (steps: RequeueSteps, extra: { jobId?: number | null; reason?: string | null } = {}) => {
    const nom = Object.keys(steps).join('+');
    try {
      if (!(await markRequeueStep({ requestId: reservation.requestId, leaseToken: reservation.leaseToken, steps, ...extra }))) traceErrors.push(`${nom}:LEASE_LOST`);
    } catch (e) {
      traceErrors.push(`${nom}:${String((e as Error).message ?? e).slice(0, 120)}`);
      console.error(`[t1-requeue] demande ${reservation.requestId} : étape « ${nom} » non consignée :`, (e as Error).message);
    }
  };

  let issue: T1EnqueueOutcome;
  try {
    const { enqueueFileAnalysesDetailed } = await import('../queue/t1-handler');
    // Lot 83C (R22) : relecture = reprise ciblée de la dernière exécution du document.
    // Lot 115H (#785, § 2) : `OBSERVE_ONLY` — aucune demande de passage supplémentaire à la clôture d'un travail en cours.
    const issues = await enqueueFileAnalysesDetailed([p.fileId], p.accountId, {
      origin: p.origin, billable: false, processingVisibility: 'TECHNICAL', resume: true, onRunning: 'OBSERVE_ONLY',
    });
    issue = issues.find((o) => o.fileId === p.fileId) ?? { fileId: p.fileId, status: 'REJECTED_TRANSIENT', jobId: null, reason: 'NO_OUTCOME' };
  } catch (e) {
    issue = { fileId: p.fileId, status: 'REJECTED_TRANSIENT', jobId: null, reason: 'ENQUEUE_ERROR', error: String((e as Error).message ?? e).slice(0, 300) };
  }
  await etape({ enqueued: true }, { jobId: issue.jobId, reason: issue.reason });
  // ══════════════════════════════════════════════════════════════════════
  // CONTRÔLE FINAL EN BASE (lot 115H § 2) — carte #837 (A2) : seuls PENDING /
  // RUNNING sont vivants ; un `DONE` est QUALIFIÉ par son résultat métier.
  // ══════════════════════════════════════════════════════════════════════
  /** Travail déjà terminé à l'inspection (carte #837, A2) : né de CETTE demande ou seulement constaté. */
  let termine: { own: boolean; businessResult: string | null; success: boolean } | null = null;
  if (issue.status === 'ACCEPTED' || issue.status === 'ALREADY_RUNNING') {
    const { inspectCorrelatedJob } = await import('../../queue/job-queue.repository');
    const travail = await inspectCorrelatedJob({
      treatment: 'T1', accountId: p.accountId, targetType: 'asset_file', targetId: p.fileId, jobId: issue.jobId,
    });
    if (travail.state === 'NONE') {
      issue = { fileId: p.fileId, status: 'REJECTED_TRANSIENT', jobId: null, reason: 'JOB_NOT_FOUND_AFTER_ENQUEUE' };
    } else if (travail.state === 'FAILED' || travail.state === 'CANCELLED') {
      issue = { fileId: p.fileId, status: 'REJECTED_TRANSIENT', jobId: travail.jobId, reason: `JOB_${travail.state}_AFTER_ENQUEUE` };
    } else if (travail.state === 'DONE') {
      termine = { own: issue.status === 'ACCEPTED', businessResult: travail.businessResult, success: doneJobSatisfies(travail.businessResult) };
      issue = { ...issue, jobId: travail.jobId };
    } else if (issue.jobId === null) {
      issue = { ...issue, jobId: travail.jobId };
    }
    await etape({ inspected: true }, { jobId: travail.jobId });
  }
  const [avant] = (await pgClient.unsafe(
    `SELECT to_jsonb(c) -> 'verification' -> 'requeue' ->> 'transientRefusals' AS refus FROM document_extraction_coverage c WHERE c.file_id = $1 AND c.account_id = $2`,
    [p.fileId, p.accountId] as never[],
  ).catch(() => [])) as unknown as Array<{ refus: string | null }>;
  const maj = requeueCoverageUpdate({
    status: issue.status, attempt: p.attempt, result: p.result, reason: issue.reason, maxRetries: jobSettings(p.env).maxRetries,
    transientRefusals: Number(avant?.refus ?? 0) || 0, scheduled: p.scheduled === true, nowMs: Date.now(),
  });
  if (termine) {
    // Le travail a DÉJÀ écrit sa couverture : l'échéance n'est pas réécrite ; le résultat dit l'issue MÉTIER.
    maj.nextRetryAt = 'KEEP';
    maj.result = termine.own
      ? (termine.success ? 'REQUEUE_COMPLETED' : 'REQUEUE_COMPLETED_BUSINESS_FAILED')
      : (termine.success ? 'REQUEUE_OBSERVED_COMPLETED' : 'REQUEUE_OBSERVED_BUSINESS_FAILED');
  }
  const garder = maj.nextRetryAt === 'KEEP';
  const queued = !termine && (issue.status === 'ACCEPTED' || issue.status === 'ALREADY_RUNNING');
  const etatFinal: RequeueRequestState = maj.consumeAttempt ? 'CONFIRMED' : queued || termine ? 'OBSERVED' : 'RELEASED';
  // ══════════════════════════════════════════════════════════════════════
  // CARTE #837 (B2) — CONSOMMATION ET CLÔTURE DE LA DEMANDE DANS UNE SEULE
  // TRANSACTION, sous le jeton de la réservation. Règle de consommation du lot
  // 114H inchangée (`requeueCoverageUpdate`) : la réservation est TENUE ou
  // RENDUE. Jeton perdu (bail expiré et demande reprise ou restituée) : rien
  // n'est compté ici, la transaction est annulée.
  // ══════════════════════════════════════════════════════════════════════
  try {
    await pgClient.begin(async (tx) => {
      const t = tx as unknown as { unsafe: (q: string, v?: never[]) => Promise<unknown> };
      const fin = (await t.unsafe(
        `/* c837:req-final */ UPDATE t1_requeue_requests
            SET state = $3, attempt_consumed = $4, job_id = COALESCE($5::bigint, job_id), reason = $6,
                steps = steps || '{"counted":true}'::jsonb, lease_token = NULL, lease_expires_at = NULL, updated_at = NOW()
          WHERE id = $1 AND lease_token = $2::uuid AND state = 'RESERVED'
          RETURNING id`,
        [reservation.requestId, reservation.leaseToken, etatFinal, maj.consumeAttempt, issue.jobId, termine ? `DONE:${termine.businessResult ?? 'NONE'}` : issue.reason] as never[],
      )) as unknown[];
      if (fin.length === 0) throw new RequeueLeaseLostError(reservation.requestId);
      await t.unsafe(
        `UPDATE document_extraction_coverage
            SET retry_attempts = CASE WHEN $3::boolean THEN GREATEST(retry_attempts, $4::int)
                                      WHEN $8::boolean THEN GREATEST(0, retry_attempts - 1)
                                      ELSE retry_attempts END,
                next_retry_at = CASE WHEN $5::boolean THEN next_retry_at ELSE $6::timestamptz END,
                origin = CASE WHEN $3::boolean THEN 'RETRY' ELSE origin END,
                last_error = $7, updated_at = NOW()
          WHERE file_id = $1 AND account_id = $2`,
        [p.fileId, p.accountId, maj.consumeAttempt, p.attempt, garder, garder || maj.nextRetryAt === null ? null : (maj.nextRetryAt as Date).toISOString(),
          maj.lastError, reservation.reservedAttempt !== null] as never[],
      );
    });
  } catch (e) {
    if (!(e instanceof RequeueLeaseLostError)) throw e;
    console.error(`[t1-requeue] fichier ${p.fileId} : ${e.message}.`);
    return {
      status: issue.status, queued: false, jobId: issue.jobId, reason: 'REQUEST_LEASE_LOST', attemptConsumed: false,
      result: 'REQUEUE_LEASE_LOST', traceErrors: [...traceErrors, 'counted:LEASE_LOST'],
    };
  }
  // Diagnostic (colonnes 0329) : issue exacte de la demande, sans contenu ; l'étape n'est notée que si l'écriture a eu lieu.
  const diagnostique = await pgClient.unsafe(
    `UPDATE document_extraction_coverage
        SET last_retry_at = NOW(), last_retry_result = $3,
            verification = jsonb_set(coalesce(verification, '{}'::jsonb), '{requeue}', $4::jsonb, true)
      WHERE file_id = $1 AND account_id = $2`,
    [p.fileId, p.accountId, maj.result, JSON.stringify({
      status: termine ? 'COMPLETED' : issue.status, reason: issue.reason, jobId: issue.jobId, origin: p.origin, requestedBy: origine,
      at: new Date().toISOString(), transientRefusals: maj.transientRefusals, attemptConsumed: maj.consumeAttempt,
      requestId: reservation.requestId, ...(termine ? { businessResult: termine.businessResult, businessSuccess: termine.success } : {}),
    })] as never[],
  ).then(() => true).catch((e: Error) => { traceErrors.push(`diagnosed:${e.message.slice(0, 120)}`); return false; });
  if (diagnostique) {
    await pgClient.unsafe(
      `/* c837:req-diag */ UPDATE t1_requeue_requests SET steps = steps || '{"diagnosed":true}'::jsonb WHERE id = $1 AND state = $2 RETURNING id`,
      [reservation.requestId, etatFinal] as never[],
    ).catch((e: Error) => { traceErrors.push(`diagnosed:${e.message.slice(0, 120)}`); });
  }
  // Carte #837 (D1) : suite de campagne corrélée explicitement (demande → travail).
  if (p.campaignRef && issue.jobId !== null && (maj.consumeAttempt || termine?.own)) {
    await recordCampaignFollowUp({
      campaignRef: p.campaignRef, accountId: p.accountId, fileId: p.fileId, kind: 'REQUEUE_T1', requestId: reservation.requestId, jobId: issue.jobId,
      result: maj.result, businessSuccess: termine ? termine.success : null, qualityBefore: etat?.quality_state ?? null,
    });
  }
  if (!queued && !termine) console.warn(`[t1-requeue] fichier ${p.fileId} (${p.origin}) : remise en file T1 non confirmée — ${issue.status}${issue.reason ? ` (${issue.reason})` : ''}`);
  if (traceErrors.length) console.error(`[t1-requeue] demande ${reservation.requestId} : trace incomplète (${traceErrors.join(', ')}) — reprise par la récupération des réservations.`);
  // Supervision : une vraie erreur est visible ; elle se résout à la prochaine mise en file confirmée.
  try {
    const { autoResolveAnomaly, reportAnomaly } = await import('@/services/admin/anomaly.service');
    if (maj.alert) {
      await reportAnomaly({
        domain: 'ai', fingerprint: requeueFingerprint(p.fileId), accountId: p.accountId,
        title: `Relecture T1 non mise en file (document ${p.fileId}) : ${issue.status}${issue.reason ? ` — ${issue.reason}` : ''}`,
        detail: { fileId: p.fileId, status: issue.status, reason: issue.reason, origin: p.origin, attempt: p.attempt },
        materialKey: `${issue.status}:${issue.reason ?? ''}`,
      });
    } else if (queued || termine?.success) {
      await autoResolveAnomaly(requeueFingerprint(p.fileId), { origin: 't1_requeue', cause: `mise en file T1 confirmée (${termine ? 'travail terminé' : issue.status})` });
    }
  } catch { /* la Supervision ne fait jamais échouer une reprise */ }
  return {
    status: termine ? 'COMPLETED' : issue.status, queued, jobId: issue.jobId, reason: queued ? null : termine ? `DONE:${termine.businessResult ?? 'NONE'}` : issue.reason,
    attemptConsumed: maj.consumeAttempt, result: maj.result,
    ...(termine ? { businessResult: termine.businessResult } : {}),
    ...(traceErrors.length ? { traceErrors } : {}),
  };
}
/**
 * Forme historique (booléen) de `requeueDocumentForRereadDetailed`, gardée pour le contrôle de cohérence.
 * Lot 114H (#775) : `true` signifie désormais « un travail vivant du document est confirmé » (créé OU déjà
 * présent) ; un travail déjà en file n'est plus rendu comme un refus.
 */
export async function requeueDocumentForReread(p: {
  fileId: number; accountId: number; attempt: number; origin: string; result: string;
  /** Lot 115H (#785, § 1) : origine de la demande (défaut : `OTHER`). Le droit est contrôlé pour elle aussi. */
  requestedBy?: RequeueOrigin;
}): Promise<boolean> {
  return (await requeueDocumentForRereadDetailed(p)).queued;
}

/** Issue d'une reprise ciblée d'un document (lot 83B : détail rendu au contrôle de cohérence). */
interface DocumentRetryOutcome {
  /** `not_queued` (lot 114H, #775) : remise en file T1 demandée mais NON confirmée — jamais « requeued ». */
  outcome: 'repaired' | 'requeued' | 'final' | 'not_queued';
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
  // ══════════════════════════════════════════════════════════════════════
  // CARTE #854 (R4) — REPRISE SANS IA DES DÉCISIONS D'UNE PASSE ANTÉRIEURE
  // Manifeste resté en attente (arrêt entre les faits et les décisions),
  // incident réessayable, écriture non confirmée : réévalués sur le contexte
  // persisté avec le contrat FIGÉ de leur appel, écrits sans doublon, relus,
  // AVANT toute sélection d'unités — une décision prouvée n'est jamais
  // redemandée au modèle. Bornée (`RECEIPT_RECOVERY_MAX`), jamais de boucle.
  // ══════════════════════════════════════════════════════════════════════
  const decisionsMod = await import('./repair-decisions');
  const repriseDecisions = await decisionsMod.recoverDecisionReceipts({ accountId: p.accountId, fileId: p.fileId, extractionId: p.extractionId, assetId: p.assetId })
    .catch((e: Error) => {
      if (e instanceof decisionsMod.DecisionPassCrashSimulated) throw e;
      console.error(`[t1-completeness-retry] reprise des décisions du fichier ${p.fileId} impossible :`, e.message);
      return null;
    });

  // Lot 53 (D19) : vérification incomplète — seule une cause transitoire
  // (source illisible) justifie une relecture automatique du fichier ; sinon
  // la reprise est manuelle (BO) et rien n'est rejoué ici (jamais de boucle).
  if (p.qualityState === 'VERIFICATION_INCOMPLETE' && !p.textOnly) {
    const cov = await loadDocumentCoverage(p.fileId, p.accountId);
    const raison = ((cov?.verification ?? {}) as { verificationReason?: string | null }).verificationReason ?? null;
    // Carte #837 (D1) : campagne de réévaluation qui a programmé cette reprise (corrélation explicite des suites).
    const campagneVerif = campaignRefOf(cov?.verification);
    // Lot 114H (#775) : `maxRetries = 0` désactive toute reprise automatique (`verificationAutoRetryDue` : 0 < 0 faux).
    if (verificationAutoRetryDue({ qualityState: p.qualityState, verificationReason: raison, retryAttempts: p.attempt - 1, maxRetries: p.maxRetries })) {
      // Lot 114H (#775, P1-B) : « REQUEUED_T1 » seulement si la file confirme un travail vivant.
      const rq = await requeueDocumentForRereadDetailed({ fileId: p.fileId, accountId: p.accountId, attempt: p.attempt, origin: 't1-completeness-retry', result: 'REQUEUED_T1', scheduled: true, env: p.env, campaignRef: campagneVerif });
      return issue(rq.queued ? 'requeued' : 'not_queued', rq.result);
    }
    // Lot 54G (point 2) : une observation NEEDS_SOURCE (image, scan) a une VRAIE reprise :
    // relecture ciblée du fichier, même si la couverture globale reste non vérifiable.
    const aRelire = p.attempt <= p.maxRetries
      ? selectSourceRereadUnits((await loadDocumentSourceUnits(p.fileId, { accountId: p.accountId, kinds: ['VISUAL_OBSERVATION'], limit: 5_000 })).map(toCovered), sourceRereadCap(p.env))
      : [];
    if (aRelire.length === 0) {
      // Lot 109K (COR-01) : avant tout contrôle manuel, confrontation DÉTERMINISTE des pages au texte original
      // déjà persisté (aucune IA, empreinte : jamais rejouée à l'identique).
      const { reverificationDue, reverifyStoredCoverage } = await import('./stored-reverification');
      if (reverificationDue({ qualityState: p.qualityState, verification: cov?.verification })) {
        const rv = await reverifyStoredCoverage({ accountId: p.accountId, fileId: p.fileId, maxRetries: p.maxRetries });
        if (rv.result !== 'SKIPPED') return issue(rv.requeued ? 'requeued' : 'repaired', `REVERIFIED_${rv.result}`);
      }
      await pgClient.unsafe(
        `UPDATE document_extraction_coverage SET next_retry_at = NULL, last_retry_at = NOW(), last_retry_result = 'MANUAL_CHECK_REQUIRED' WHERE file_id = $1`,
        [p.fileId] as never[],
      ).catch(() => undefined);
      return issue('repaired', 'MANUAL_CHECK_REQUIRED');
    }
  }

  const stored = await loadAllDocumentSourceUnits(p.fileId, { accountId: p.accountId });
  // Lot 113AN (#741) : unités d'abord RÉCONCILIÉES avec les données persistées (faits, décisions de valeur,
  // métadonnées, tableaux) — seules les vraies lacunes sont envoyées au modèle ; aucun appel pour un faux négatif.
  const [{ loadStoredReconciliationInput }, { reconcileCoverage, reconciliationSummary, residualCounts, withResidualPolicies }] = await Promise.all([
    import('./stored-reconciliation'), import('./coverage-reconciliation'),
  ]);
  const sqlR = pgClient as unknown as Parameters<typeof loadStoredReconciliationInput>[0];
  const units = reconcileCoverage(stored.map(toCovered), { ...(await loadStoredReconciliationInput(sqlR, p.accountId, p.fileId)), stage: 'STORED' });
  const couverture = await loadDocumentCoverage(p.fileId, p.accountId);
  const diag = storedDiagnostics(couverture?.verification);
  // Carte #837 (D1) : campagne de réévaluation qui a programmé cette reprise (corrélation explicite des suites).
  const campagne = campaignRefOf(couverture?.verification);
  // ══════════════════════════════════════════════════════════════════════
  // LOT 114H (Trello #775, P1-A) — GARDE D'ENTRÉE : la règle unique décide
  //
  // Règle remplacée : chaque maillon testait sa propre borne (`attempt <=
  // maxRetries`, passages de continuation) et la reprise d'un document sans
  // action exécutable consommait une tentative puis se reprogrammait. Avant
  // tout appel IA, `decideRetry` dit ce qui reste admissible ; sans action
  // (ni automatique, ni reprise manuelle demandée), AUCUN appel n'est fait,
  // aucune tentative n'est consommée, et l'écriture finale retire l'échéance.
  // ══════════════════════════════════════════════════════════════════════
  const limits = { ...retryLimits(p.env), maxRetries: p.maxRetries };
  const verifStockee = { qualityState: p.qualityState ?? couverture?.qualityState ?? null, verificationReason: diag.verification?.reason ?? null, pagesMissing: diag.verification?.missing ?? [] };
  const entree = decideRetry(retryFactsOf(units, verifStockee, limits), { retryAttempts: p.attempt - 1, continuationRuns: diag.continuationRuns }, limits);
  const admissible = entree.automatic || entree.manual;

  // Lacune de pages, ou page manquante (omission objectivée) : seule une relecture du fichier peut la combler → file T1.
  // Lot 114H (#775) : la page manquante n'avait AUCUNE action — la reprise tournait à vide ; elle suit la lacune de pages.
  if (entree.actions.includes('REQUEUE_T1') && !p.textOnly) {
    const rq = await requeueDocumentForRereadDetailed({ fileId: p.fileId, accountId: p.accountId, attempt: p.attempt, origin: 't1-completeness-retry', result: 'REQUEUED_T1', scheduled: true, env: p.env, campaignRef: campagne });
    return issue(rq.queued ? 'requeued' : 'not_queued', rq.result);
  }

  const { repairSettings, runRepairPass } = await import('./repair');
  const cap = limits.unitCap;
  // Lot 49B (DEV-04) : unités jamais examinées faute de budget — une CONTINUATION ne consomme pas de tentative.
  const continuation = entree.actions.includes('CONTINUATION');
  const resteUneReprise = limits.maxRetries > 0 && p.attempt <= limits.maxRetries;
  // Lot 114H (#775) : au-delà du plafond de reprises, une continuation ne soumet QUE les unités en attente
  // (jamais d'appel IA « gratuit » pour des unités déjà examinées).
  const cibles = selectRepairUnits(units, cap).filter((u) => resteUneReprise || u.repairState === 'PENDING');
  const facts: T1Fact[] = [];
  let failed = new Map<string, { reason: string; retryable: boolean }>();
  let attempted: string[] = [];
  let notAttempted: string[] = [];
  let calls = 0;
  // Lot 54G (point 2) : unités NEEDS_SOURCE — relecture du FICHIER (bornée, comptée à part).
  const sourceCap = sourceRereadCap(p.env);
  const aRelire = admissible && resteUneReprise && !p.textOnly ? selectSourceRereadUnits(units, sourceCap) : [];
  let relecture: SourceRereadResult | null = null;
  // Lot 114G (#760, P1-02 / P1-03) : liens locaux fait ↔ unité et décisions de valeur de la passe de
  // réparation — jusqu'ici perdus par la reprise différée (seuls faits et compteurs étaient repris).
  let liensLocaux: Map<T1Fact, string[]> | undefined;
  // Carte #854 (R1, R3) : enveloppe de contrat de CHAQUE appel et décisions REÇUES (retenues et rejetées avant validation).
  let enveloppes: RepairCallEnvelope[] = [];
  let decisionsRecues: RepairReceivedDecision[] = [];
  // Lot 115F (#792, écart P1-03) : liens explicites par identifiant cité, et associations ambiguës refusées.
  let liensPasse = { byCitedId: 0, ambiguous: 0 };
  // ══════════════════════════════════════════════════════════════════════
  // LOT 115F (Trello #792, écart P2-10) — APPELS ET COÛT, PAR FAMILLE
  //
  // La reprise différée (texte ciblé) et la relecture du FICHIER sont deux
  // familles d'appels distinctes : leurs appels, leurs échecs et leur coût ne
  // sont plus additionnés sous un seul compteur `calls`. Un coût que la
  // passerelle n'a pas rendu reste INCONNU (jamais zéro) : le nombre d'appels
  // concernés est consigné, et le BO l'affiche.
  // ══════════════════════════════════════════════════════════════════════
  const cout = {
    textCalls: 0, textCallsFailed: 0, textCostMicros: 0, textCostUnknownCalls: 0,
    rereadCalls: 0, rereadCallsFailed: 0,
  };
  const textuelle = admissible && cibles.length > 0 && (resteUneReprise || continuation);
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
      cout.rereadCalls = relecture.calls;
      // Relecture en échec : l'appel a bien été émis (compté), son résultat est perdu.
      cout.rereadCallsFailed = relecture.failed ? 1 : 0;
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
      liensLocaux = r.links;
      liensPasse = { byCitedId: r.linksByCitedId, ambiguous: r.linksAmbiguous };
      // Passe sans journal de réception (double de test, version antérieure) : aucune décision reçue, jamais une erreur.
      decisionsRecues = r.received ?? [];
      enveloppes = r.envelopes ?? [];
      cout.textCalls = r.calls;
      cout.textCallsFailed = r.callsFailed;
      cout.textCostMicros = r.costMicros;
      cout.textCostUnknownCalls = r.costUnknownCalls;
    }
  }

  // Faits ajoutés : projection (registre, cibles vérifiées), provenance, écriture.
  const linker = new SourceUnitLinker(units);
  const ajout: Awaited<ReturnType<typeof appendRepairedFacts>> = facts.length > 0
    ? await appendRepairedFacts({ ...p, facts, linker, localLinks: liensLocaux, propagationOrigin: p.textOnly ? 'coherence-control' : 't1-completeness-retry' })
    : { inserted: [], all: [] };
  const nouveaux = ajout.inserted;
  // Lot 114G (#760, P1-02) puis carte #854 : décisions de valeur de la réparation — APRÈS le commit des faits,
  // manifeste, contrat de leur appel, contexte persisté, écriture transactionnelle, relecture exacte — AVANT la
  // réconciliation qui suit, laquelle ne relit que les décisions CONFIRMÉES.
  const passId = `rp:${p.fileId}:${p.attempt}:${(await import('crypto')).randomUUID().slice(0, 8)}`;
  const decisionsDiag = await decisionsMod.persistRepairDecisions({
    accountId: p.accountId, fileId: p.fileId, extractionId: p.extractionId, assetId: p.assetId, passId,
    passOrigin: p.textOnly ? 'coherence-control' : continuation ? 'continuation' : 't1-completeness-retry',
    received: decisionsRecues, envelopes: enveloppes, units, factIdsByRef: ajout.factIdsByRef ?? new Map(),
  });
  const decisionsIncompletes = decisionsDiag.state === 'INCOMPLETE' || repriseDecisions?.state === 'INCOMPLETE';
  const decisionsReprenables = Boolean(decisionsDiag.retryable || repriseDecisions?.retryable);
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
  // Lot 113AN : réconciliation APRÈS l'ajout des faits (relus en base) et des décisions — faits relus d'une
  // autre unité, valeurs déjà structurées, répétitions ; jamais une promotion sans preuve.
  majs = reconcileCoverage(majs, { ...(await loadStoredReconciliationInput(sqlR, p.accountId, p.fileId)), stage: attempted.length > 0 ? 'REPAIR' : 'STORED' });
  const progression = attempted.some((id) => units.find((u) => u.sourceUnitId === id)?.repairState === 'PENDING') && failed.size === 0;
  // Lot 114H (#775) : rien d'admissible à l'entrée → rien n'a été tenté, aucune tentative consommée.
  const consomme = admissible && (!(continuation && progression) || relecture !== null);
  const tentativesStockees = consomme ? p.attempt : p.attempt - 1;
  const runs = diag.continuationRuns + (continuation && attempted.length > 0 ? 1 : 0);
  majs = withRepairStates(majs, { attempted: new Set([...tentees, ...relues]), pending: new Set(notAttempted), cap, sourceCap });
  // Lot 113AN : politique explicite de chaque unité restante.
  majs = withResidualPolicies(majs);
  // Lot 114H (#775, P1-A) : ce qui reste admissible APRÈS cette passe (règle unique). Règle remplacée : au plafond
  // de continuation, les unités en attente passaient « épuisées » alors qu'elles n'avaient jamais été tentées ;
  // l'attente est maintenant levée avec le motif du plafond (`REPAIR_NOT_RUN:<motif>`), distinct de REPAIR_EXHAUSTED.
  const suite = decideRetry(retryFactsOf(majs, verifStockee, limits), { retryAttempts: tentativesStockees, continuationRuns: runs }, limits);
  if (!suite.automatic) majs = releaseUnschedulablePending(majs, suite);
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
  const retryAllowed = suite.automatic;
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
  if (report.diagnostics) {
    // Lot 114G (#760, P1-02 / P1-03 / P2-10) : ce que CETTE reprise a reçu, validé, écrit et rattaché.
    (report.diagnostics as T1CoverageDiagnostics & { deferredRepair?: Record<string, unknown> }).deferredRepair = {
      calls, attemptedUnits: attempted.length, newFacts: nouveaux.length,
      decisions: decisionsDiag,
      // Carte #854 (R4) : reprise SANS IA de réceptions antérieures (null : rien à reprendre).
      ...(repriseDecisions ? { decisionsRecovery: repriseDecisions } : {}),
      // Lot 115F (#792, écart P2-10) : appels de CETTE reprise par famille, échecs et coût rendu
      // (`costUnknownCalls` : appels dont le coût n'a pas été rendu — inconnu, jamais zéro).
      textRepair: {
        calls: cout.textCalls, callsFailed: cout.textCallsFailed,
        costMicros: cout.textCostMicros, costUnknownCalls: cout.textCostUnknownCalls,
      },
      sourceReread: { calls: cout.rereadCalls, callsFailed: cout.rereadCallsFailed },
      // Lot 115F (#792, écart P1-03) : rattachements de CETTE passe — liens explicites, ambiguïtés refusées,
      // appariements par ordre et relecture des unités prouvantes enregistrées.
      ...(ajout.linkage ? { linkage: { ...ajout.linkage, ...liensPasse } } : { linkage: liensPasse }),
    };
    if (diag.coverageRepair) report.diagnostics.coverageRepair = diag.coverageRepair;
    report.diagnostics.reconciliation = reconciliationSummary(majs, 'STORED');
    report.diagnostics.residualPolicies = residualCounts(majs);
  }
  // Lot 109K (COR-02) : diagnostic de la propagation de CETTE reprise (sinon le précédent est conservé).
  if (report.diagnostics) {
    const pr = ajout.propagation ? propagationSummary(ajout.propagation) : diag.repairPropagation;
    if (pr) report.diagnostics.repairPropagation = pr;
  }
  // Unités en attente avec progression : continuation rapprochée ; sinon délai croissant.
  // Lot 54G (point 2) : relecture du fichier encore due (NEEDS_SOURCE, tentatives restantes) : reprise programmée.
  // Lot 114H (#775, P1-A) : une échéance n'existe QUE si la règle unique admet une action automatique.
  // Carte #854 (R4) : décisions non confirmées mais reprenables SANS IA — reprise rapprochée de la seule persistance
  // (aucune tentative IA consommée à l'entrée sans action admissible, règle 114H ; reprises bornées par réception).
  const prochaine = !suite.automatic ? (decisionsIncompletes && decisionsReprenables ? new Date(Date.now() + 5 * 60_000) : null)
    : new Date(Date.now() + (progression && suite.actions.includes('CONTINUATION') ? 5 * 60_000 : retryDelayMs(tentativesStockees + 1)));
  const resultatTexte = !admissible ? `RETRY_NOT_ADMISSIBLE:${entree.blocked ?? 'NOTHING_TO_RETRY'}`
    : attempted.length === 0 ? 'NOTHING_TO_REPAIR'
    : failed.size > 0 ? 'REPAIR_FAILED' : nouveaux.length > 0 ? `REPAIRED_${nouveaux.length}` : 'NO_NEW_FACT';
  const resultatRelecture = !relecture ? null
    : relecture.failed && relecture.resolved.length === 0 ? 'SOURCE_REREAD_FAILED'
      : relecture.resolved.length === relecture.attempted.length ? `SOURCE_REREAD_RESOLVED_${relecture.resolved.length}`
        : `SOURCE_REREAD_PARTIAL_${relecture.resolved.length}_OF_${relecture.attempted.length}`;
  const resultatBase = resultatRelecture && attempted.length === 0 ? resultatRelecture
    : resultatRelecture ? `${resultatRelecture}+${resultatTexte}` : resultatTexte;
  // Carte #854 (R4) : passe aux décisions non confirmées — jamais un succès de persistance (motifs au diagnostic).
  const resultat = decisionsIncompletes ? `${resultatBase}+DECISIONS_INCOMPLETE` : resultatBase;
  await pgClient.begin(async (tx) => {
    await writeSourceLayer(tx as never, {
      accountId: p.accountId, fileId: p.fileId, extractionId: p.extractionId, origin: 'RETRY',
      layer: { layerVersion: SOURCE_LAYER_VERSION, units: majs, unresolvedFacts: unresolved, report, retryable: report.qualityState === 'INCOMPLETE_RETRYABLE' },
      retryAttempts: tentativesStockees,
      nextRetryAt: prochaine,
      retryResult: resultat,
      env: { ...(p.env ?? process.env), T1_COMPLETENESS_MAX_RETRIES: String(p.maxRetries) },
    });
  });
  const { recordT1Completeness } = await import('./monitoring');
  await recordT1Completeness({ accountId: p.accountId, fileId: p.fileId, report, persisted: true }).catch(() => undefined);
  // ══════════════════════════════════════════════════════════════════════
  // CARTE #837 (D1, D2) — SUITES D'UNE CAMPAGNE, CORRÉLÉES ET QUALIFIÉES
  // Chaque famille réellement exécutée (réparation textuelle, relecture du
  // fichier) consigne SES appels, SON coût rendu (inconnu compté à part) et
  // son issue MÉTIER : unités réellement couvertes après la passe, résidus
  // encore présents. Une suite sans unité réparée n'est pas un succès.
  // ══════════════════════════════════════════════════════════════════════
  if (campagne && (textuelle || relecture)) {
    const residus = report.unresolvedUnits + report.uncertainUnits + report.failedUnits;
    const { currentBusinessExecutionId } = await import('../../business-execution/context');
    const executionId = currentBusinessExecutionId();
    if (textuelle) {
      await recordCampaignFollowUp({
        campaignRef: campagne, accountId: p.accountId, fileId: p.fileId, kind: 'TEXT_REPAIR', businessExecutionId: executionId,
        calls: cout.textCalls, callsFailed: cout.textCallsFailed, costMicros: cout.textCostMicros, costUnknownCalls: cout.textCostUnknownCalls,
        result: resultatTexte, businessSuccess: majs.some((u) => tentees.has(u.sourceUnitId) && u.status === 'COVERED'),
        unitsAttempted: attempted.length, unitsRepaired: majs.filter((u) => tentees.has(u.sourceUnitId) && u.status === 'COVERED').length,
        residualUnits: residus, qualityBefore: p.qualityState ?? null, qualityAfter: report.qualityState,
      });
    }
    if (relecture) {
      // La passerelle ne rend pas le coût d'une relecture du fichier à cet endroit : INCONNU pour chaque appel émis.
      await recordCampaignFollowUp({
        campaignRef: campagne, accountId: p.accountId, fileId: p.fileId, kind: 'SOURCE_REREAD', businessExecutionId: executionId,
        calls: cout.rereadCalls, callsFailed: cout.rereadCallsFailed, costMicros: null, costUnknownCalls: cout.rereadCalls,
        result: resultatRelecture, businessSuccess: relecture.resolved.length > 0,
        unitsAttempted: relecture.attempted.length, unitsRepaired: relecture.resolved.length,
        residualUnits: residus, qualityBefore: p.qualityState ?? null, qualityAfter: report.qualityState,
      });
    }
  }
  // Bien rattaché : preuves, T3 et T4 depuis les faits persistés (même chemin que le rattachement tardif).
  if (p.assetId && nouveaux.some((f) => f.canonicalKey)) {
    const { projectDocumentKnowledgeToAsset } = await import('../../knowledge/document-knowledge.service');
    await projectDocumentKnowledgeToAsset({ accountId: p.accountId, userId: p.userId, fileId: p.fileId, assetId: p.assetId })
      .catch((e: Error) => console.error('[t1-completeness-retry] projection sur le bien :', e.message));
  }
  return { outcome: report.qualityState === 'INCOMPLETE_FINAL' ? 'final' : 'repaired', calls, attempted, newFacts: nouveaux.length, result: resultat };
}

/**
 * Lot 114G (#760, P1-02) puis carte #854 (P1-02 de #835) : décisions de valeur des reprises différées —
 * contrat figé PAR APPEL, validation sur les connaissances PERSISTÉES, persistance des décisions ET des rejets
 * (journal 2012), relecture EXACTE, reprise sans IA. Voir `repair-decisions.ts`.
 */
export { persistRepairDecisions, recoverDecisionReceipts, type RepairDecisionsDiag } from './repair-decisions';

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
function sourceRereadCap(env: Record<string, string | undefined> = process.env): number {
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

/**
 * Projette et AJOUTE les faits d'une reprise (les faits existants ne sont pas réécrits).
 * Lot 109K (COR-02) : faits réellement ajoutés → propagation CIBLÉE vers les
 * candidats du document et T3 (`operation-candidates/repair-propagation.store`),
 * pour toute réparation (reprise de couverture, réexamen des décisions).
 */
export async function appendRepairedFacts(p: {
  fileId: number; accountId: number; extractionId: number | null; assetId: number | null; facts: T1Fact[]; linker: SourceUnitLinker;
  /** Origine consignée de la propagation (défaut : `t1-repair`). */
  propagationOrigin?: string;
  /**
   * Lot 114G (#760, P1-03) : unités CIBLÉES qui prouvent chaque fait rendu par la passe de réparation
   * (`runRepairPass().links`). Fournies, elles font foi ; le rattachement n'est recalculé sur tout le
   * document que pour un fait sans lien local (relecture du fichier, lien inexploitable), et c'est compté.
   */
  localLinks?: ReadonlyMap<T1Fact, readonly string[]>;
}): Promise<{
  inserted: ProjectedFact[]; all: ProjectedFact[]; propagation?: RepairPropagationOutcome;
  /** Lot 114G (#760) : empreinte du fait rendu (`t1FactRef`) → fait(s) persistés, nouveaux ou déjà présents. */
  factIdsByRef?: Map<string, number[]>;
  /**
   * Lot 114G (#760, P1-03 / P1-04) : origine des rattachements et issue de la déduplication.
   * Lot 115F (#792, écart P1-03) : appariements par ordre (`localOrdered`) et relecture des unités
   * prouvantes réellement enregistrées (`verified` / `mismatched`).
   */
  linkage?: {
    local: number; relinked: number; relinkedReason: string | null; duplicates: number; relinkedExisting: number;
    localOrdered: number; verified: number; mismatched: number;
  };
}> {
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
  // Lot 114G (#760, P1-03) : le lien LOCAL de la réparation (unité ciblée qui prouve le fait) est conservé
  // jusqu'à l'écriture. Sans lien local exploitable seulement, rattachement recalculé sur le document.
  const locaux = new LocalLinks(p.localLinks);
  // Lot 115F (#792, écart P1-04) : chaque fait consomme SON empreinte (plus de « première empreinte de la clé »).
  const refs = new FactRefs(p.facts as Array<T1Fact & { t1FactRef?: string }>);
  const linkage = {
    local: 0, relinked: 0, relinkedReason: null as string | null, duplicates: 0, relinkedExisting: 0,
    /** Lot 115F (#792, écart P1-03) : liens locaux appariés par ORDRE (faits de même clé, unités différentes). */
    localOrdered: 0,
    /** Lot 115F (#792, écart P1-03) : faits dont le `source_unit_ids` relu en base diffère de celui écrit. */
    verified: 0, mismatched: 0,
  };
  for (const f of projection.facts) {
    const local = locaux.takeDetailed(f);
    if (local?.ids.length) {
      f.sourceUnitIds = local.ids;
      linkage.local++;
      if (local.ordered) linkage.localOrdered++;
      continue;
    }
    f.sourceUnitIds = p.linker.link({
      provenance: f.provenance, excerpt: f.evidence?.excerpt ?? null, page: f.evidence?.page ?? null,
      // Lot 54G : fait visuel d'une relecture du fichier — rattaché à son observation.
      visualDescription: f.visualEvidence?.description ?? null, visualPage: f.visualEvidence?.page ?? null,
      values: [f.rawValue, f.value], labels: [f.rawKey, f.label, f.attribute],
    });
    linkage.relinked++;
    linkage.relinkedReason ??= p.localLinks ? 'LOCAL_LINK_ABSENT' : 'NO_LOCAL_LINKS_PROVIDED';
  }
  const records = projection.facts.map((f) => toFact(projectedFactToExtractedField(f)));
  const identiteDe = (r: (typeof records)[number]): FactIdentityInput => ({
    key: r.canonicalKey ?? r.factKey, value: r.valueText, excerpt: r.evidenceOrigin === 'VISUAL_ANALYSIS' ? null : r.excerpt,
    targetType: r.targetType ?? null, targetEntityId: r.targetEntityId ?? null,
    sourceUnitIds: r.sourceUnitIds ?? null,
  });
  const canonical = await documentFactsCanonicalReady();
  // Lot 109K (COR-02) : faits actifs AVANT l'ajout (diff avant / après de la propagation).
  const { activeFactIds, propagateRepairToCandidates } = await import('../operation-candidates/repair-propagation.store');
  const avant = await activeFactIds(p.fileId, p.accountId);
  const factIdsByRef = new Map<string, number[]>();
  const noter = (f: ProjectedFact, id: number) => {
    const ref = refs.take(f);
    if (ref) factIdsByRef.set(ref, [...new Set([...(factIdsByRef.get(ref) ?? []), id])]);
  };
  const neufs: ProjectedFact[] = [];
  /** Lot 115F (#792, écart P1-03) : unités prouvantes ATTENDUES par fait persisté — relues après le commit. */
  const attendus = new Map<number, Set<string>>();
  // ══════════════════════════════════════════════════════════════════════
  // LOT 114G (#760, P1-04) — DÉDUPLICATION PAR IDENTITÉ, SOUS VERROU
  //
  // Règle remplacée : « déjà écrit » = même valeur + même extrait (la clé du
  // fait était lue puis ignorée). Deux faits distincts de même valeur et de
  // même extrait (deux attributs, deux cibles) étaient éliminés à tort.
  // L'identité est maintenant celle de l'analyse (`factFingerprint`) : clé,
  // valeur, cible, extrait — `repair-identity.ts`. Un même fait relu ailleurs
  // (même numéro sur une autre page) reste UN fait : ses unités prouvantes
  // sont complétées, jamais une seconde ligne.
  //
  // Deux reprises concurrentes du même document : le verrou consultatif de
  // transaction sérialise lecture des faits écrits ET insertion ; la seconde
  // relit les faits de la première et n'écrit aucun doublon. Une reprise
  // interrompue après l'écriture des faits (TC11) reste idempotente.
  // ══════════════════════════════════════════════════════════════════════
  await pgClient.begin(async (tx) => {
    await tx.unsafe(`SELECT pg_advisory_xact_lock(hashtext('t1-repair-facts:' || $1::text))`, [p.fileId] as never[]);
    const ecrits = (await tx.unsafe(
      `SELECT id, coalesce(${canonical ? 'canonical_key, ' : ''}fact_key) AS key, value_text AS value, excerpt,
              ${canonical ? 'target_type AS "targetType", target_entity_id AS "targetEntityId",' : ''}
              source_unit_ids AS "sourceUnitIds"
         FROM document_facts WHERE file_id = $1 AND account_id = $2 AND status = 'active'`,
      [p.fileId, p.accountId] as never[],
    )) as unknown as Array<FactIdentityInput & { id: number }>;
    const connus = new KnownFacts(ecrits.map((r) => ({ ...r, id: Number(r.id) })));
    const parId = new Map(ecrits.map((r) => [Number(r.id), r]));
    const aEcrire: Array<{ fait: ProjectedFact; record: (typeof records)[number] }> = [];
    // Faits de CE lot déjà retenus pour écriture : un second fait identique du même lot complète le premier.
    const duLot = new Map<string, { fait: ProjectedFact; record: (typeof records)[number] }>();
    for (const [i, f] of projection.facts.entries()) {
      const identite = identiteDe(records[i]);
      const id = connus.match(identite);
      if (id === null) {
        const cle = factCoreIdentity(identite);
        const premier = duLot.get(cle);
        if (premier) {
          linkage.duplicates++;
          const unites = [...new Set([...(premier.fait.sourceUnitIds ?? []), ...(f.sourceUnitIds ?? [])])];
          premier.fait.sourceUnitIds = unites;
          premier.record.sourceUnitIds = unites;
          continue;
        }
        const x = { fait: f, record: records[i] };
        duLot.set(cle, x);
        aEcrire.push(x);
        continue;
      }
      linkage.duplicates++;
      noter(f, id);
      // P1-03 : fait déjà présent RELU dans une unité ciblée — ses unités prouvantes sont complétées (jamais retirées).
      const deja = new Set((parId.get(id)?.sourceUnitIds ?? []) as string[]);
      const ajout = (f.sourceUnitIds ?? []).filter((u) => !deja.has(u));
      attendus.set(id, new Set([...deja, ...(f.sourceUnitIds ?? [])]));
      if (ajout.length > 0) {
        await tx.unsafe(
          `UPDATE document_facts SET source_unit_ids = ARRAY(SELECT DISTINCT unnest(coalesce(source_unit_ids, '{}'::text[]) || $3::text[]))
            WHERE id = $1 AND account_id = $2`,
          [id, p.accountId, ajout] as never[],
        );
        linkage.relinkedExisting++;
      }
    }
    if (aEcrire.length === 0) return;
    const ids = await insertFactRows(tx as never, {
      accountId: p.accountId, fileId: p.fileId, sourceType: ext.source_type === 'web_link' ? 'web_link' : 'asset_file',
      provider: ext.provider == null ? null : String(ext.provider), model: ext.model == null ? null : String(ext.model),
      promptVersion: ext.prompt_version == null ? null : String(ext.prompt_version),
    }, Number(ext.id), aEcrire.map((x) => x.record), { canonical, provenance: true });
    aEcrire.forEach((x, i) => {
      if (ids[i] !== undefined) { noter(x.fait, ids[i]); attendus.set(ids[i], new Set(x.fait.sourceUnitIds ?? [])); }
      neufs.push(x.fait);
    });
    await tx.unsafe(`UPDATE document_extractions SET fact_count = fact_count + $2, updated_at = NOW() WHERE id = $1`,
      [Number(ext.id), aEcrire.length] as never[]);
  });
  // ══════════════════════════════════════════════════════════════════════
  // LOT 115F (Trello #792, écart P1-03) — RELECTURE DU `source_unit_ids` ÉCRIT
  //
  // Les liens n'étaient jamais RELUS : une écriture partielle ou un tableau
  // tronqué restait invisible. Après le commit, les unités prouvantes
  // attendues sont confrontées à celles réellement enregistrées ; tout écart
  // est compté et consigné (jamais une erreur : les faits sont écrits).
  // ══════════════════════════════════════════════════════════════════════
  if (attendus.size > 0) {
    try {
      const relus = (await pgClient.unsafe(
        `SELECT id, source_unit_ids AS ids FROM document_facts WHERE id = ANY($1::int[]) AND account_id = $2`,
        [[...attendus.keys()], p.accountId] as never[],
      )) as unknown as Array<{ id: number; ids: string[] | null }>;
      for (const r of relus) {
        const ecrits = new Set((r.ids ?? []).map(String));
        const attendu = attendus.get(Number(r.id)) ?? new Set<string>();
        if ([...attendu].every((x) => ecrits.has(x))) linkage.verified++;
        else linkage.mismatched++;
      }
      if (linkage.mismatched > 0) {
        console.warn(`[t1-repair] fichier ${p.fileId} : ${linkage.mismatched} fait(s) dont les unités prouvantes relues diffèrent de celles écrites.`);
      }
    } catch (e) {
      console.warn(`[t1-repair] relecture des unités prouvantes du fichier ${p.fileId} impossible :`, (e as Error).message);
    }
  }
  if (neufs.length === 0) return { inserted: [], all: projection.facts, factIdsByRef, linkage };
  // Après commit des faits : la propagation ne peut jamais les emporter (elle ne lève pas).
  const propagation = await propagateRepairToCandidates({ accountId: p.accountId, fileId: p.fileId, beforeFactIds: avant, origin: p.propagationOrigin ?? 't1-repair' });
  return { inserted: neufs, all: projection.facts, propagation, factIdsByRef, linkage };
}

/**
 * Carte #854 (R2) — RÉSOLUTION DES FAITS CITÉS PAR LES DÉCISIONS vers les faits
 * PERSISTÉS du document (lecture seule, aucune écriture, aucun appel IA).
 *
 * Les faits de la réponse cités par une décision (y compris un fait hors de
 * la zone ciblée, ou un rappel d'un fait ancien) passent par la MÊME
 * projection que l'écriture des faits (`appendRepairedFacts`), puis sont
 * rapprochés des faits ACTIFS du bon compte et du bon document
 * (`resolveFactReference` : identité exacte, sinon clé + valeur + cible ;
 * plusieurs : ambigu ; aucun : inconnu). Une erreur SQL LÈVE (jamais un
 * ensemble vide) : l'appelant rend la décision « non évaluée », réessayable.
 */
export async function resolvePersistedFactRefs(p: {
  accountId: number; fileId: number; assetId: number | null; facts: ReadonlyArray<T1Fact & { t1FactRef?: string }>;
}): Promise<Map<string, import('./repair-identity').FactReferenceResolution>> {
  const out = new Map<string, import('./repair-identity').FactReferenceResolution>();
  const facts = p.facts.filter((f) => f.t1FactRef);
  if (facts.length === 0) return out;
  const [{ projectDocumentFacts }, { toFact }, { projectedFactToExtractedField }, step, registry, { resolveFactReference }] = await Promise.all([
    import('../projection/document-projection'),
    import('../../knowledge/document-knowledge'),
    import('../steps/persist-evidence.step'),
    import('../steps/analyze-document.step'),
    import('@/services/canonical/registry'),
    import('./repair-identity'),
  ]);
  const { pgClient } = await import('@/db');
  const ext = ((await pgClient.unsafe(
    `SELECT id, document_type_code, to_char(document_date, 'YYYY-MM-DD') AS document_date FROM document_extractions WHERE file_id = $1 AND account_id = $2`,
    [p.fileId, p.accountId] as never[],
  )) as unknown as Row[])[0];
  const verif = await step.verifyAll({ entities: { assets: [], rooms: [], equipments: [], suppliers: [], multiAsset: false } } as never, facts as T1Fact[], p.accountId);
  if (p.assetId) verif.verifiedIds.ASSET.add(p.assetId);
  const famille = p.assetId
    ? ((await pgClient.unsafe(`SELECT category FROM assets WHERE id = $1 AND account_id = $2`, [p.assetId, p.accountId] as never[])) as unknown as Row[])[0]?.category
    : null;
  const projection = projectDocumentFacts({
    document: {
      ...(ext?.document_date ? { documentDate: { value: String(ext.document_date), confidence: 'certain', evidence: {} } } : {}),
      ...(ext?.document_type_code ? { classification: { documentTypeCode: String(ext.document_type_code), confidence: 1, evidence: {} } } : {}),
    },
    entities: { assets: [], rooms: [], equipments: [], suppliers: [], multiAsset: false },
    facts: facts as T1Fact[],
  }, {
    knownAssetId: p.assetId, documentAssetId: p.assetId,
    assetFamilies: new Map(p.assetId ? [[p.assetId, registry.toAssetFamily(famille == null ? null : String(famille))]] : []),
    verifiedIds: verif.verifiedIds,
  });
  const rows = ((await pgClient.unsafe(
    `SELECT f.id::float8 AS id, coalesce(to_jsonb(f)->>'canonical_key', f.fact_key) AS key, f.value_text AS value, f.excerpt,
            to_jsonb(f)->>'target_type' AS "targetType", to_jsonb(f)->>'target_entity_id' AS "targetEntityId"
       FROM document_facts f WHERE f.file_id = $1 AND f.account_id = $2 AND f.status = 'active'`,
    [p.fileId, p.accountId] as never[],
  )) as unknown as Array<FactIdentityInput & { id: number }>).map((r) => ({
    ...r, id: Number(r.id), targetEntityId: r.targetEntityId == null ? null : Number(r.targetEntityId),
  }));
  const refs = new FactRefs(facts);
  for (const f of projection.facts) {
    const ref = refs.take(f);
    if (!ref || out.has(ref)) continue;
    const r = toFact(projectedFactToExtractedField(f));
    out.set(ref, resolveFactReference({
      key: r.canonicalKey ?? r.factKey, value: r.valueText, excerpt: r.evidenceOrigin === 'VISUAL_ANALYSIS' ? null : r.excerpt,
      targetType: r.targetType ?? null, targetEntityId: r.targetEntityId ?? null,
    }, rows));
  }
  return out;
}
