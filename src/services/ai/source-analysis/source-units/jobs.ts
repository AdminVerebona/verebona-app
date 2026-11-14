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
import { verificationAutoRetryDue } from './verification-followup';
import { decideRetry, releaseUnschedulablePending, retryFactsOf, retryLimits } from './retry-policy';
import type { T1EnqueueOutcome, T1EnqueueStatus } from '../queue/t1-handler';
import { partitionUnitRefs, relinkFromStored, type StoredUnitView } from './provenance-integrity';
import { provenanceJournalReady, recordProvenanceEvents } from './provenance-repair';
import type { AnalysisContext, ExtractedTable, SourceInput, VisualObservation } from '../types';
import type { AccountCapabilities } from '@/services/account-capabilities.service';
import type { AssetFamily as V2AssetFamily } from '@/lib/referential/v2';
import type { SourceRereadCall, SourceRereadResult } from './source-reread';
import type { ProjectedFact, T1AnalyzeDocumentOutput, T1Fact } from '../master/t1-contract';
import type { RepairPropagationOutcome } from '../operation-candidates/repair-propagation.store';

import { KnownFacts, LocalLinks, factCoreIdentity, factLinkKey, type FactIdentityInput } from './repair-identity';
import type { AnchoredValueDecision } from '../value-decisions/validate';
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
  /** Réponse réelle de la file (`T1EnqueueStatus`). */
  status: T1EnqueueStatus;
  /** Un travail vivant du document est CONFIRMÉ (créé, ou déjà présent) — seule condition de « REQUEUED_T1 ». */
  queued: boolean;
  jobId: number | null;
  /** Motif exact du refus (code de la file) ; null si confirmé. */
  reason: string | null;
  /** Une reprise a-t-elle été consommée ? */
  attemptConsumed: boolean;
  /** Code consigné sur la couverture (`last_retry_result`). */
  result: string;
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

/**
 * Relecture du FICHIER : le document repasse dans la file T1 (traitement
 * technique, non facturé, non annoncé). Lot 53 (D19) : partagée par la
 * reprise d'une lacune de pages, d'une vérification incomplète transitoire,
 * la reprise manuelle du BO et le contrôle de cohérence (`result`).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LOT 114H (Trello #775, P1-B) — PLUS DE REJEU FICTIF
 *
 * Règle remplacée : quelle que soit la réponse de la file, la couverture
 * recevait `retry_attempts = attempt`, `next_retry_at = NULL` et le résultat
 * demandé (« REQUEUED_T1 ») ; les appelants de la reprise planifiée ignoraient
 * le booléen rendu. Un refus consommait donc une reprise, effaçait l'échéance
 * et s'affichait comme une remise en file réussie.
 *
 * Désormais : l'issue RÉELLE de la file est lue (`enqueueFileAnalysesDetailed`),
 * la présence du travail est RELUE en base après la mise en file, et la
 * couverture n'est écrite « remise en file » que si un travail vivant du
 * document est confirmé. Voir `requeueCoverageUpdate` pour chaque issue.
 * Refus définitif, ou transitoire répété jusqu'au plafond : anomalie de
 * Supervision (`ai:t1-requeue:<document>`), résolue à la prochaine mise en
 * file confirmée. La mise en file et l'écriture de la couverture ne peuvent
 * pas partager une transaction (la file a la sienne) : si le processus
 * s'arrête entre les deux, le bail de la ligne expire et la reprise suivante
 * constate le travail vivant (ALREADY_RUNNING) — aucune reprise comptée deux fois.
 * ══════════════════════════════════════════════════════════════════════════
 */
export async function requeueDocumentForRereadDetailed(p: {
  fileId: number; accountId: number; attempt: number; origin: string; result: string;
  /** Demande de la tâche planifiée `t1-completeness-retry` (ligne sous bail). */
  scheduled?: boolean;
  env?: Record<string, string | undefined>;
}): Promise<RequeueResult> {
  const { pgClient } = await import('@/db');
  let issue: T1EnqueueOutcome;
  try {
    const { enqueueFileAnalysesDetailed } = await import('../queue/t1-handler');
    // Lot 83C (R22) : relecture = reprise ciblée de la dernière exécution du document.
    const issues = await enqueueFileAnalysesDetailed([p.fileId], p.accountId, { origin: p.origin, billable: false, processingVisibility: 'TECHNICAL', resume: true });
    issue = issues.find((o) => o.fileId === p.fileId) ?? { fileId: p.fileId, status: 'REJECTED_TRANSIENT', jobId: null, reason: 'NO_OUTCOME' };
  } catch (e) {
    issue = { fileId: p.fileId, status: 'REJECTED_TRANSIENT', jobId: null, reason: 'ENQUEUE_ERROR', error: String((e as Error).message ?? e).slice(0, 300) };
  }
  // Présence du travail RELUE après l'opération : le travail créé (quel que soit son état), ou un travail vivant du document.
  if (issue.status === 'ACCEPTED' || issue.status === 'ALREADY_RUNNING') {
    const vivant = (await pgClient.unsafe(
      `SELECT id FROM ai_job_queue
        WHERE treatment = 'T1' AND account_id = $1 AND target_type = 'asset_file' AND target_id = $2
          AND (id = $3 OR status IN ('PENDING', 'RUNNING'))
        ORDER BY id DESC LIMIT 1`,
      [p.accountId, String(p.fileId), issue.jobId] as never[],
    ).catch(() => [])) as unknown as Array<{ id: number }>;
    if (vivant.length === 0) issue = { fileId: p.fileId, status: 'REJECTED_TRANSIENT', jobId: null, reason: 'JOB_NOT_FOUND_AFTER_ENQUEUE' };
    else if (issue.jobId === null) issue = { ...issue, jobId: Number(vivant[0].id) };
  }
  const [avant] = (await pgClient.unsafe(
    `SELECT to_jsonb(c) -> 'verification' -> 'requeue' ->> 'transientRefusals' AS refus FROM document_extraction_coverage c WHERE c.file_id = $1 AND c.account_id = $2`,
    [p.fileId, p.accountId] as never[],
  ).catch(() => [])) as unknown as Array<{ refus: string | null }>;
  const maj = requeueCoverageUpdate({
    status: issue.status, attempt: p.attempt, result: p.result, reason: issue.reason, maxRetries: jobSettings(p.env).maxRetries,
    transientRefusals: Number(avant?.refus ?? 0) || 0, scheduled: p.scheduled === true, nowMs: Date.now(),
  });
  const garder = maj.nextRetryAt === 'KEEP';
  await pgClient.unsafe(
    `UPDATE document_extraction_coverage
        SET retry_attempts = CASE WHEN $3::boolean THEN GREATEST(retry_attempts, $4::int) ELSE retry_attempts END,
            next_retry_at = CASE WHEN $5::boolean THEN next_retry_at ELSE $6::timestamptz END,
            origin = CASE WHEN $3::boolean THEN 'RETRY' ELSE origin END,
            last_error = $7, updated_at = NOW()
      WHERE file_id = $1 AND account_id = $2`,
    [p.fileId, p.accountId, maj.consumeAttempt, p.attempt, garder, garder || maj.nextRetryAt === null ? null : (maj.nextRetryAt as Date).toISOString(), maj.lastError] as never[],
  );
  // Colonnes 0329 (dernière reprise, diagnostics) : écrites si présentes — issue exacte de la demande, sans contenu.
  await pgClient.unsafe(
    `UPDATE document_extraction_coverage
        SET last_retry_at = NOW(), last_retry_result = $3,
            verification = jsonb_set(coalesce(verification, '{}'::jsonb), '{requeue}', $4::jsonb, true)
      WHERE file_id = $1 AND account_id = $2`,
    [p.fileId, p.accountId, maj.result, JSON.stringify({
      status: issue.status, reason: issue.reason, jobId: issue.jobId, origin: p.origin, at: new Date().toISOString(),
      transientRefusals: maj.transientRefusals, attemptConsumed: maj.consumeAttempt,
    })] as never[],
  ).catch(() => undefined);
  const queued = issue.status === 'ACCEPTED' || issue.status === 'ALREADY_RUNNING';
  if (!queued) console.warn(`[t1-requeue] fichier ${p.fileId} (${p.origin}) : remise en file T1 non confirmée — ${issue.status}${issue.reason ? ` (${issue.reason})` : ''}`);
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
    } else if (queued) {
      await autoResolveAnomaly(requeueFingerprint(p.fileId), { origin: 't1_requeue', cause: `mise en file T1 confirmée (${issue.status})` });
    }
  } catch { /* la Supervision ne fait jamais échouer une reprise */ }
  return { status: issue.status, queued, jobId: issue.jobId, reason: queued ? null : issue.reason, attemptConsumed: maj.consumeAttempt, result: maj.result };
}

/**
 * Forme historique (booléen) de `requeueDocumentForRereadDetailed`, gardée pour le contrôle de cohérence.
 * Lot 114H (#775) : `true` signifie désormais « un travail vivant du document est confirmé » (créé OU déjà
 * présent) ; un travail déjà en file n'est plus rendu comme un refus.
 */
export async function requeueDocumentForReread(p: {
  fileId: number; accountId: number; attempt: number; origin: string; result: string;
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

  // Lot 53 (D19) : vérification incomplète — seule une cause transitoire
  // (source illisible) justifie une relecture automatique du fichier ; sinon
  // la reprise est manuelle (BO) et rien n'est rejoué ici (jamais de boucle).
  if (p.qualityState === 'VERIFICATION_INCOMPLETE' && !p.textOnly) {
    const cov = await loadDocumentCoverage(p.fileId, p.accountId);
    const raison = ((cov?.verification ?? {}) as { verificationReason?: string | null }).verificationReason ?? null;
    // Lot 114H (#775) : `maxRetries = 0` désactive toute reprise automatique (`verificationAutoRetryDue` : 0 < 0 faux).
    if (verificationAutoRetryDue({ qualityState: p.qualityState, verificationReason: raison, retryAttempts: p.attempt - 1, maxRetries: p.maxRetries })) {
      // Lot 114H (#775, P1-B) : « REQUEUED_T1 » seulement si la file confirme un travail vivant.
      const rq = await requeueDocumentForRereadDetailed({ fileId: p.fileId, accountId: p.accountId, attempt: p.attempt, origin: 't1-completeness-retry', result: 'REQUEUED_T1', scheduled: true, env: p.env });
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

  const stored = await loadDocumentSourceUnits(p.fileId, { accountId: p.accountId, limit: 50_000 });
  // Lot 113AN (#741) : unités d'abord RÉCONCILIÉES avec les données persistées (faits, décisions de valeur,
  // métadonnées, tableaux) — seules les vraies lacunes sont envoyées au modèle ; aucun appel pour un faux négatif.
  const [{ loadStoredReconciliationInput }, { reconcileCoverage, reconciliationSummary, residualCounts, withResidualPolicies }] = await Promise.all([
    import('./stored-reconciliation'), import('./coverage-reconciliation'),
  ]);
  const sqlR = pgClient as unknown as Parameters<typeof loadStoredReconciliationInput>[0];
  const units = reconcileCoverage(stored.map(toCovered), { ...(await loadStoredReconciliationInput(sqlR, p.accountId, p.fileId)), stage: 'STORED' });
  const couverture = await loadDocumentCoverage(p.fileId, p.accountId);
  const diag = storedDiagnostics(couverture?.verification);
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
    const rq = await requeueDocumentForRereadDetailed({ fileId: p.fileId, accountId: p.accountId, attempt: p.attempt, origin: 't1-completeness-retry', result: 'REQUEUED_T1', scheduled: true, env: p.env });
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
  let decisionsRecues: AnchoredValueDecision[] = [];
  let decisionsEcartees = { schemaInvalid: 0, unitNotFound: 0 };
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
      decisionsRecues = r.decisions;
      decisionsEcartees = r.decisionsDropped;
    }
  }

  // Faits ajoutés : projection (registre, cibles vérifiées), provenance, écriture.
  const linker = new SourceUnitLinker(units);
  const ajout: Awaited<ReturnType<typeof appendRepairedFacts>> = facts.length > 0
    ? await appendRepairedFacts({ ...p, facts, linker, localLinks: liensLocaux, propagationOrigin: p.textOnly ? 'coherence-control' : 't1-completeness-retry' })
    : { inserted: [], all: [] };
  const nouveaux = ajout.inserted;
  // Lot 114G (#760, P1-02) : décisions de valeur de la réparation — validées, rattachées, persistées
  // (idempotent) AVANT la réconciliation qui suit, laquelle les relit en base.
  const decisionsDiag = await persistRepairDecisions({
    accountId: p.accountId, fileId: p.fileId, extractionId: p.extractionId, decisions: decisionsRecues,
    units, facts, factIdsByRef: ajout.factIdsByRef ?? new Map(),
  });
  // Décisions écartées dès la passe (mal formées, unité ciblée introuvable) : comptées, jamais silencieuses.
  decisionsDiag.received += decisionsEcartees.schemaInvalid + decisionsEcartees.unitNotFound;
  if (decisionsEcartees.schemaInvalid) decisionsDiag.skipped.SCHEMA_INVALID = decisionsEcartees.schemaInvalid;
  if (decisionsEcartees.unitNotFound) decisionsDiag.skipped.UNIT_NOT_IN_TARGET_ZONE = decisionsEcartees.unitNotFound;
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
      decisions: decisionsDiag, ...(ajout.linkage ? { linkage: ajout.linkage } : {}),
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
  const prochaine = !suite.automatic ? null
    : new Date(Date.now() + (progression && suite.actions.includes('CONTINUATION') ? 5 * 60_000 : retryDelayMs(tentativesStockees + 1)));
  const resultatTexte = !admissible ? `RETRY_NOT_ADMISSIBLE:${entree.blocked ?? 'NOTHING_TO_RETRY'}`
    : attempted.length === 0 ? 'NOTHING_TO_REPAIR'
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
      env: { ...(p.env ?? process.env), T1_COMPLETENESS_MAX_RETRIES: String(p.maxRetries) },
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

/** Lot 114G (#760, P1-02) : bilan des décisions de valeur d'une reprise différée. */
export interface RepairDecisionsDiag {
  received: number; valid: number; invalid: number; persisted: number;
  /** Décisions non exploitées, par motif (contrat non porté, table absente, écriture impossible, rejets de validation). */
  skipped: Record<string, number>;
}

/**
 * Lot 114G (Trello #760, P1-02) — DÉCISIONS DE VALEUR D'UNE RÉPARATION DIFFÉRÉE.
 *
 * `runRepairPass()` rend des décisions (STRUCTURED, COMPONENT_OR_CONTEXT,
 * NOT_RETAINED, UNDETERMINED) ; l'analyse initiale les conserve depuis 113AN,
 * la reprise manuelle ou planifiée les perdait. Elles suivent ici le MÊME
 * chemin : validation (`validateValueDecisions`, contrat effectif), rattachement
 * à l'unité et aux faits persistés, écriture idempotente (`insertValueDecisions`).
 * Une décision invalide est écrite comme telle (jamais une justification),
 * comme à l'analyse. Ne lève jamais : une écriture impossible est comptée.
 */
export async function persistRepairDecisions(p: {
  accountId: number; fileId: number; extractionId: number | null;
  decisions: readonly AnchoredValueDecision[];
  units: readonly CoveredSourceUnit[];
  facts: readonly T1Fact[];
  factIdsByRef: ReadonlyMap<string, readonly number[]>;
}): Promise<RepairDecisionsDiag> {
  const diag: RepairDecisionsDiag = { received: p.decisions.length, valid: 0, invalid: 0, persisted: 0, skipped: {} };
  const ecarter = (motif: string, n: number) => { if (n > 0) diag.skipped[motif] = (diag.skipped[motif] ?? 0) + n; };
  if (p.decisions.length === 0) return diag;
  try {
    const [{ valueDecisionsCapability }, { validateValueDecisions, factContextOf }, { insertValueDecisions, valueDecisionsTableReady }, { pgClient }] = await Promise.all([
      import('../value-decisions/contract'), import('../value-decisions/validate'), import('../value-decisions/store'), import('@/db'),
    ]);
    const ext = ((await pgClient.unsafe(
      `SELECT prompt_version FROM document_extractions WHERE file_id = $1 AND account_id = $2`, [p.fileId, p.accountId] as never[],
    )) as unknown as Row[])[0];
    const promptVersion = ext?.prompt_version == null ? null : String(ext.prompt_version);
    // Mêmes conditions que la persistance de l'analyse : contrat porté par la version de prompt effective.
    const cap = await valueDecisionsCapability();
    if (!cap.carried || (cap.version !== null && promptVersion !== null && cap.version !== promptVersion)) {
      ecarter('CONTRACT_NOT_CARRIED', p.decisions.length);
      return diag;
    }
    if (!(await valueDecisionsTableReady())) { ecarter('TABLE_MISSING', p.decisions.length); return diag; }
    // Seuls les faits réellement PERSISTÉS (nouveaux ou déjà présents) peuvent justifier une décision.
    const gardes = (p.facts as Array<T1Fact & { t1FactRef?: string }>).filter((f) => f.t1FactRef && p.factIdsByRef.has(f.t1FactRef));
    const preparees = validateValueDecisions(p.decisions, {
      units: p.units,
      keptFactRefs: new Set(gardes.map((f) => f.t1FactRef!)),
      candidateKeys: new Set(),
      facts: factContextOf(gardes as never, p.units),
    });
    diag.valid = preparees.filter((d) => d.validity === 'VALID').length;
    diag.invalid = preparees.length - diag.valid;
    for (const d of preparees) if (d.validity === 'INVALID') ecarter(`INVALID:${d.invalidReason ?? 'UNKNOWN'}`, 1);
    if (preparees.length === 0) return diag;
    await pgClient.begin(async (tx) => {
      diag.persisted = await insertValueDecisions(tx as never, {
        accountId: p.accountId, fileId: p.fileId, extractionId: p.extractionId, analysisRunId: null, promptVersion,
        factIds: p.factIdsByRef,
      }, preparees);
    });
  } catch (e) {
    ecarter('WRITE_FAILED', p.decisions.length);
    console.error(`[t1-completeness-retry] décisions de valeur du fichier ${p.fileId} non écrites :`, (e as Error).message);
  }
  return diag;
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
  /** Lot 114G (#760, P1-03 / P1-04) : origine des rattachements et issue de la déduplication. */
  linkage?: { local: number; relinked: number; relinkedReason: string | null; duplicates: number; relinkedExisting: number };
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
  const refs = new Map<string, string[]>();
  for (const f of p.facts) {
    const ref = (f as T1Fact & { t1FactRef?: string }).t1FactRef;
    if (ref) refs.set(factLinkKey(f), [...(refs.get(factLinkKey(f)) ?? []), ref]);
  }
  const linkage = { local: 0, relinked: 0, relinkedReason: null as string | null, duplicates: 0, relinkedExisting: 0 };
  for (const f of projection.facts) {
    const local = locaux.take(f);
    if (local?.length) {
      f.sourceUnitIds = local;
      linkage.local++;
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
    const ref = refs.get(factLinkKey(f))?.[0];
    if (ref) factIdsByRef.set(ref, [...new Set([...(factIdsByRef.get(ref) ?? []), id])]);
  };
  const neufs: ProjectedFact[] = [];
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
    aEcrire.forEach((x, i) => { if (ids[i] !== undefined) noter(x.fait, ids[i]); neufs.push(x.fait); });
    await tx.unsafe(`UPDATE document_extractions SET fact_count = fact_count + $2, updated_at = NOW() WHERE id = $1`,
      [Number(ext.id), aEcrire.length] as never[]);
  });
  if (neufs.length === 0) return { inserted: [], all: projection.facts, factIdsByRef, linkage };
  // Après commit des faits : la propagation ne peut jamais les emporter (elle ne lève pas).
  const propagation = await propagateRepairToCandidates({ accountId: p.accountId, fileId: p.fileId, beforeFactIds: avant, origin: p.propagationOrigin ?? 't1-repair' });
  return { inserted: neufs, all: projection.facts, propagation, factIdsByRef, linkage };
}
