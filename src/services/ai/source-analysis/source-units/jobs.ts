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
import { buildSourceUnits } from './build-units';
import {
  buildCompletenessReport, computeCoverage, selectRepairUnits, SourceUnitLinker, type EvidenceRef,
} from './coverage';
import {
  loadDocumentSourceUnits, loadUnresolvedDocumentFacts, maxCompletenessRetries, sourceLayerReady, writeSourceLayer, type StoredSourceUnit,
} from './repository';
import { SOURCE_LAYER_VERSION, type CoveredSourceUnit, type SourceLayer, type UnresolvedFactRecord } from './types';
import type { ExtractedTable, VisualObservation } from '../types';
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
});

export interface RetryResult { examined: number; repaired: number; requeued: number; final: number; failed: number; more: boolean; disabled?: boolean }

export async function runCompletenessRetry(opts: { deadline?: number; env?: Record<string, string | undefined> } = {}): Promise<RetryResult> {
  const res: RetryResult = { examined: 0, repaired: 0, requeued: 0, final: 0, failed: 0, more: false };
  if (!(await sourceLayerReady())) return { ...res, disabled: true };
  const s = jobSettings(opts.env);
  const { pgClient } = await import('@/db');
  const rows = (await pgClient.unsafe(
    `SELECT c.file_id, c.account_id, c.extraction_id, c.retry_attempts, c.quality_state,
            af.asset_id, af.linked_asset_id, coalesce(af.retained_title, af.original_filename) AS title, a.owner_user_id
       FROM document_extraction_coverage c
       JOIN asset_files af ON af.id = c.file_id AND af.deleted_at IS NULL
       JOIN accounts a ON a.id = c.account_id
      WHERE c.next_retry_at IS NOT NULL AND c.next_retry_at <= NOW()
      ORDER BY c.next_retry_at
      LIMIT $1`,
    [s.retryBatch + 1] as never[],
  )) as unknown as Row[];
  res.more = rows.length > s.retryBatch;
  for (const r of rows.slice(0, s.retryBatch)) {
    if (opts.deadline && Date.now() > opts.deadline) { res.more = true; break; }
    res.examined++;
    const fileId = Number(r.file_id);
    const accountId = Number(r.account_id);
    const attempt = Number(r.retry_attempts ?? 0) + 1;
    try {
      const out = await retryDocument({
        fileId, accountId, extractionId: r.extraction_id == null ? null : Number(r.extraction_id), attempt,
        maxRetries: s.maxRetries, assetId: Number(r.asset_id ?? r.linked_asset_id ?? 0) || null,
        userId: Number(r.owner_user_id), title: r.title == null ? null : String(r.title),
      });
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
    }
  }
  return res;
}

async function retryDocument(p: {
  fileId: number; accountId: number; extractionId: number | null; attempt: number; maxRetries: number;
  assetId: number | null; userId: number; title: string | null;
}): Promise<'repaired' | 'requeued' | 'final'> {
  const { pgClient } = await import('@/db');
  const stored = await loadDocumentSourceUnits(p.fileId, { accountId: p.accountId, limit: 50_000 });
  const units = stored.map(toCovered);
  const lacunes = units.filter((u) => u.kind === 'PAGE_GAP' && u.status === 'FAILED' && u.payload.retryable === true);

  // Lacune de pages : seule une relecture du fichier peut la combler → file T1.
  if (lacunes.length > 0 && p.attempt <= p.maxRetries) {
    const { enqueueFileAnalyses } = await import('../queue/t1-handler');
    const acceptes = await enqueueFileAnalyses([p.fileId], p.accountId, { origin: 't1-completeness-retry', billable: false });
    await pgClient.unsafe(
      `UPDATE document_extraction_coverage SET retry_attempts = $2, next_retry_at = NULL, origin = 'RETRY', updated_at = NOW(),
              last_error = $3 WHERE file_id = $1`,
      [p.fileId, p.attempt, acceptes.includes(p.fileId) ? null : 'mise en file T1 refusée'] as never[],
    );
    return 'requeued';
  }

  const { repairSettings, runRepairPass } = await import('./repair');
  const maxAttempts = repairSettings().maxPasses + p.maxRetries;
  const cibles = selectRepairUnits(units, Math.max(1, maxAttempts));
  const facts: T1Fact[] = [];
  let failed = new Map<string, { reason: string; retryable: boolean }>();
  let attempted: string[] = [];
  if (cibles.length > 0 && p.attempt <= p.maxRetries) {
    const [{ loadAnalysisContext }, { getAccountCapabilities }, { loadAssetFamilies }, step] = await Promise.all([
      import('../pipeline'),
      import('@/services/account-capabilities.service'),
      import('../master/rubric-rules'),
      import('../steps/analyze-document.step'),
    ]);
    const ctx = await loadAnalysisContext(p.accountId, p.assetId);
    const capabilities = await getAccountCapabilities(p.accountId);
    const r = await runRepairPass({
      input: {
        sourceType: 'file', sourceIds: [p.fileId], accountId: p.accountId, userId: p.userId,
        mimeTypes: ['text/plain'], displayNames: [p.title ?? `document ${p.fileId}`], linkedAssetId: p.assetId,
      },
      groupIndices: [0], ctx: { ...ctx, capabilities }, capabilities,
      v2Families: await loadAssetFamilies(p.assetId ? [p.assetId] : []),
      units: cibles, maxCalls: repairSettings().maxCalls, pass: 1 + p.attempt, call: (c) => step.callAnalyzeDocument(c),
    });
    facts.push(...r.facts);
    failed = r.failed;
    attempted = r.attempted;
  }

  // Faits ajoutés : projection (registre, cibles vérifiées), provenance, écriture.
  const linker = new SourceUnitLinker(units);
  const nouveaux = facts.length > 0 ? await appendRepairedFacts({ ...p, facts, linker }) : [];
  const couvertes = new Set(nouveaux.flatMap((f) => f.sourceUnitIds ?? []).map((id) => id.replace(/:cell:\d+$/, '')));
  const tentees = new Set(attempted);
  const majs: CoveredSourceUnit[] = units.map((u) => {
    if (!tentees.has(u.sourceUnitId)) return u;
    const base = { ...u, repairAttempts: u.repairAttempts + 1 };
    if (couvertes.has(u.sourceUnitId)) return { ...base, status: 'COVERED', reason: 'fact', factCount: u.factCount + 1 };
    const f = failed.get(u.sourceUnitId);
    if (f) return { ...base, status: 'FAILED', reason: f.reason };
    return { ...base, status: 'UNRESOLVED', reason: u.salient ? 'not_extracted' : 'not_structured' };
  });
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
  const retryAllowed = p.attempt < p.maxRetries;
  const report = buildCompletenessReport(majs, {
    factsCount: Number(pr.facts_count ?? 0) + nouveaux.length,
    unresolvedFacts: unresolved,
    truncatedSectionsCount: Number(pr.truncated_sections_count ?? 0),
    batchedSectionsCount: Number(pr.batched_sections_count ?? 0),
    repairPassCount: Number(pr.repair_pass_count ?? 0) + (attempted.length > 0 ? 1 : 0),
    chunkCount: Number(pr.chunk_count ?? 0),
    warningCodes: Array.isArray(pr.anomalies) && (pr.anomalies as string[]).includes('PARTIAL_EXTRACTION') ? ['PARTIAL_EXTRACTION'] : [],
    retryAllowed,
  });
  await pgClient.begin(async (tx) => {
    await writeSourceLayer(tx as never, {
      accountId: p.accountId, fileId: p.fileId, extractionId: p.extractionId, origin: 'RETRY',
      layer: { layerVersion: SOURCE_LAYER_VERSION, units: majs, unresolvedFacts: unresolved, report, retryable: report.qualityState === 'INCOMPLETE_RETRYABLE' },
      retryAttempts: p.attempt,
      nextRetryAt: report.qualityState === 'INCOMPLETE_RETRYABLE' ? new Date(Date.now() + retryDelayMs(p.attempt + 1)) : null,
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
  return report.qualityState === 'INCOMPLETE_FINAL' ? 'final' : 'repaired';
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
  if (!ext) return [];
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
      values: [f.rawValue, f.value], labels: [f.rawKey, f.label, f.attribute],
    });
  }
  const records = projection.facts.map((f) => toFact(projectedFactToExtractedField(f)));
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
  return projection.facts;
}
