/**
 * Lot 109K (COR-01) — re-vérification DÉTERMINISTE d'une couverture déjà
 * enregistrée, sans appel IA ni téléchargement (reprise du stock).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * Les documents analysés avant le lot 109K ont été vérifiés par la seule
 * sonde pdf-lib : une page en police composite (CID) y reste « non vérifiée »
 * (VERIFICATION_INCOMPLETE) même quand T1 l'a lue. La preuve manquante existe
 * DÉJÀ en base :
 *   · texte original par page : extract brut pdf.js (`document_raw_extracts`,
 *     lu AVANT le modèle, empreinte SHA-256 du contenu) ;
 *   · lecture T1 : unités de la couche A (`document_source_units`, texte
 *     intégral de la transcription, tableaux, métadonnées).
 * La confrontation (mêmes règles, mêmes seuils que l'analyse, `verifyPdfCoverage`)
 * établit page par page VERIFIED / MISSING / UNVERIFIABLE :
 *   · aucune page n'est promue sans texte original retrouvé ; une page sans
 *     couche texte (scan) reste UNVERIFIABLE ; jamais d'omission « par
 *     pagination » déduite de données reconstruites (`markers: false`) ;
 *   · état de qualité RECALCULÉ par `buildCompletenessReport` (aucun seuil
 *     changé) ; omission objectivée → INCOMPLETE_RETRYABLE et relecture
 *     ciblée du fichier par la file T1 (bornée par les reprises) ;
 *   · EMPREINTE (version des règles + empreinte de l'extract + empreinte de la
 *     lecture) conservée : une même confrontation n'est jamais rejouée.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'node:crypto';
import { buildCompletenessReport } from './coverage';
import { pageTextsFromRawExtract } from './page-text-layer';
import { SOURCE_VERIFIER_VERSION, verifyPdfCoverage, type PageProbe, type SourceVerification } from './source-verification';
import type { CoveredSourceUnit, T1CoverageDiagnostics } from './types';

type Row = Record<string, unknown>;
const nums = (x: unknown): number[] => (Array.isArray(x) ? x.map(Number).filter((n) => Number.isInteger(n) && n > 0) : []);

/** Empreinte d'une confrontation (pure) : règles + texte original + lecture T1. */
export function reverificationFingerprint(p: { extractSha: string | null; units: ReadonlyArray<{ sourceUnitId: string; text: string | null }> }): string {
  const h = createHash('sha256');
  h.update(`v${SOURCE_VERIFIER_VERSION}|${p.extractSha ?? ''}|`);
  for (const u of [...p.units].sort((a, b) => a.sourceUnitId.localeCompare(b.sourceUnitId))) h.update(`${u.sourceUnitId}\u0001${u.text ?? ''}\u0002`);
  return h.digest('hex').slice(0, 32);
}

/** Confrontation pure : extract (texte par page) ↔ unités de la couche A. */
export function reverifyFromStored(p: {
  pageCount: number;
  pageTexts: ReadonlyMap<number, string>;
  /** Pages scannées constatées à l'analyse (sonde). */
  scannedPages: readonly number[];
  rereadPages: readonly number[];
  units: ReadonlyArray<Pick<CoveredSourceUnit, 'page' | 'text' | 'kind'>>;
  extractSha: string | null;
}): SourceVerification {
  const pages: PageProbe[] = [];
  const scans = new Set(p.scannedPages);
  for (let n = 1; n <= p.pageCount; n++) {
    const t = p.pageTexts.get(n);
    // Sonde reconstruite : nature connue seulement par l'analyse (scan) ou la couche texte.
    pages.push({ page: n, kind: scans.has(n) ? 'SCANNED' : t?.trim() ? 'TEXT' : 'UNKNOWN', sample: null });
  }
  const cites = new Set<number>();
  for (const u of p.units) if (typeof u.page === 'number' && u.page > 0 && u.text?.trim()) cites.add(u.page);
  const lecture = p.units.map((u) => u.text ?? '').filter(Boolean).join('\n');
  return verifyPdfCoverage({
    probe: { pageCount: p.pageCount, pages },
    // Jamais d'omission déduite d'une pagination reconstruite : seule la confrontation du texte fait foi.
    cited: { pages: cites, markers: false },
    transcription: lecture,
    hasContent: lecture.trim().length > 0,
    reread: new Set(p.rereadPages),
    textLayer: p.pageTexts,
    textLayerInfo: { origin: 'PERSISTED_RAW_EXTRACT', sourceSha256: p.extractSha ?? '' },
  });
}

/** Une couverture enregistrée relève-t-elle de la re-vérification ? (pure) */
export function reverificationDue(c: { qualityState: string; verification: Record<string, unknown> | null | undefined }): boolean {
  const d = (c.verification ?? {}) as Partial<T1CoverageDiagnostics> & { reverification?: { fingerprint?: string } };
  return c.qualityState === 'VERIFICATION_INCOMPLETE'
    && d.sourceVerification === 'PARTIAL'
    && d.verificationReason === 'pages_unverified'
    && Number(d.verifierVersion ?? 1) < SOURCE_VERIFIER_VERSION;
}

export interface ReverificationOutcome {
  fileId: number;
  /** SKIPPED : non concerné, déjà confronté (même empreinte) ou preuve indisponible. */
  result: 'VERIFIED' | 'STILL_INCOMPLETE' | 'MISSING_PAGES' | 'SKIPPED';
  reason: string;
  qualityBefore: string | null;
  qualityAfter: string | null;
  pagesVerified?: number[];
  pagesMissing?: number[];
  pagesUnverifiable?: number[];
  /** Relecture ciblée demandée à la file T1 (omission objectivée, reprises restantes). */
  requeued?: boolean;
}

/**
 * Re-vérifie UN document à partir de ses données persistées (voir l'en-tête).
 * Idempotente : une même empreinte n'est jamais rejouée ; aucune écriture sur
 * un document dont la couverture a changé entre-temps (garde optimiste).
 */
export async function reverifyStoredCoverage(p: { accountId: number; fileId: number; maxRetries?: number }): Promise<ReverificationOutcome> {
  const { pgClient } = await import('@/db');
  const { loadDocumentCoverage, loadDocumentSourceUnits, loadUnresolvedDocumentFacts, maxCompletenessRetries } = await import('./repository');
  const skip = (reason: string, q: string | null = null): ReverificationOutcome => ({ fileId: p.fileId, result: 'SKIPPED', reason, qualityBefore: q, qualityAfter: q });
  const cov = await loadDocumentCoverage(p.fileId, p.accountId);
  if (!cov) return skip('no_coverage');
  const avant = cov.qualityState;
  if (!reverificationDue({ qualityState: avant, verification: cov.verification })) return skip('not_due', avant);
  const d = (cov.verification ?? {}) as Partial<T1CoverageDiagnostics> & Record<string, unknown>;

  const [x] = (await pgClient.unsafe(
    `SELECT full_text, pages, page_count, extraction_status, full_text_sha256, source_sha256
       FROM document_raw_extracts WHERE file_id = $1 AND account_id = $2`,
    [p.fileId, p.accountId] as never[],
  ).catch(() => [])) as unknown as Row[];
  const stored = await loadDocumentSourceUnits(p.fileId, { accountId: p.accountId, limit: 50_000 });
  const extractSha = (x?.source_sha256 as string | null) ?? null;
  const empreinte = reverificationFingerprint({ extractSha, units: stored });
  const precedente = (d.reverification as { fingerprint?: string } | undefined)?.fingerprint;
  if (precedente === empreinte) return skip('same_fingerprint', avant);

  const pageCount = Number(x?.page_count ?? d.pagesExpected ?? 0);
  const textes = pageTextsFromRawExtract(x?.full_text as string | null, x?.pages as Array<{ page: number; start: number; end: number }> | null);
  const preuveIndisponible = !x || x.extraction_status === 'FAILED' || !pageCount || textes.size === 0
    || (d.pagesExpected != null && Number(d.pagesExpected) !== pageCount);
  const marque = async (result: string, verification: Record<string, unknown>) => {
    await pgClient.unsafe(
      `UPDATE document_extraction_coverage SET verification = $3::jsonb, last_retry_at = NOW(), last_retry_result = $4, updated_at = NOW()
        WHERE file_id = $1 AND account_id = $2 AND quality_state = $5`,
      [p.fileId, p.accountId, JSON.stringify(verification), result, avant] as never[],
    );
  };
  if (preuveIndisponible) {
    // Aucune preuve déterministe disponible : l'incertitude est CONSERVÉE, l'essai est consigné (jamais rejoué).
    await marque('REVERIFY_NO_TEXT_LAYER', { ...d, verifierVersion: SOURCE_VERIFIER_VERSION, reverification: { fingerprint: empreinte, at: new Date().toISOString(), result: 'NO_TEXT_LAYER' } });
    return skip('text_layer_unavailable', avant);
  }

  const units = stored.map((u) => ({ page: u.page, text: u.text, kind: u.kind }));
  const v = reverifyFromStored({
    pageCount, pageTexts: textes, scannedPages: nums(d.pagesScanned), rereadPages: nums(d.pagesReread), units, extractSha,
  });
  const anciens = await loadUnresolvedDocumentFacts(p.fileId, { accountId: p.accountId });
  const covered: CoveredSourceUnit[] = stored.map((u) => ({
    sourceUnitId: u.sourceUnitId, kind: u.kind, page: u.page, ordinal: u.ordinal, parentUnitId: u.parentUnitId,
    text: u.text, label: u.label, value: u.value, payload: u.payload ?? {}, location: u.location ?? {},
    origin: u.origin as CoveredSourceUnit['origin'], salient: u.salient, status: u.coverageStatus, reason: u.coverageReason,
    factCount: u.factCount, repairAttempts: u.repairAttempts, repairState: (u.repairState ?? null) as CoveredSourceUnit['repairState'],
  }));
  const maxRetries = p.maxRetries ?? maxCompletenessRetries();
  const report = buildCompletenessReport(covered, {
    factsCount: cov.factsCount,
    unresolvedFacts: anciens,
    truncatedSectionsCount: cov.truncatedSectionsCount,
    batchedSectionsCount: cov.batchedSectionsCount,
    repairPassCount: cov.repairPassCount,
    chunkCount: cov.chunkCount,
    warningCodes: (cov.anomalies ?? []).includes('PARTIAL_EXTRACTION') ? ['PARTIAL_EXTRACTION'] : [],
    retryAllowed: cov.retryAttempts < maxRetries,
    verification: v,
    normalisation: {
      truncations: Number(d.truncations ?? 0), originalsPreserved: Number(d.originalsPreserved ?? 0), losses: Number(d.normalisationLosses ?? 0),
      prunedFields: Number(d.prunedFields ?? 0), prunedOriginalsPreserved: Number(d.prunedOriginalsPreserved ?? 0),
    },
    sourceReread: { runs: Number(d.sourceRereads ?? 0), failed: Number(d.sourceRereadsFailed ?? 0), resolved: Number(d.sourceRereadResolved ?? 0) },
  });
  const apres = report.qualityState;
  const result: ReverificationOutcome['result'] = v.missing.length > 0 ? 'MISSING_PAGES' : v.status === 'VERIFIED' ? 'VERIFIED' : 'STILL_INCOMPLETE';
  const diagnostics = {
    ...d, ...report.diagnostics,
    // Compteurs conservés de l'analyse (relectures, continuation) : la re-vérification ne les remet jamais à zéro.
    ...(d.continuationRuns != null ? { continuationRuns: d.continuationRuns } : {}),
    reverification: { fingerprint: empreinte, at: new Date().toISOString(), result, qualityBefore: avant, qualityAfter: apres },
  };
  const rows = (await pgClient.unsafe(
    `UPDATE document_extraction_coverage
        SET quality_state = $3, anomalies = $4::text[], source_verification = $5, verification = $6::jsonb,
            last_retry_at = NOW(), last_retry_result = $7, updated_at = NOW()
      WHERE file_id = $1 AND account_id = $2 AND quality_state = $8
      RETURNING file_id`,
    [p.fileId, p.accountId, apres, report.anomalies, v.status, JSON.stringify(diagnostics), `REVERIFIED_${result}`, avant] as never[],
  )) as unknown as Row[];
  if (rows.length === 0) return skip('coverage_changed', avant);
  let requeued = false;
  if (result === 'MISSING_PAGES' && cov.retryAttempts < maxRetries) {
    // Omission OBJECTIVÉE : relecture ciblée par la file T1 (la continuation relit ces seules pages). Bornée.
    const { requeueDocumentForReread } = await import('./jobs');
    requeued = await requeueDocumentForReread({ fileId: p.fileId, accountId: p.accountId, attempt: cov.retryAttempts + 1, origin: 't1-coverage-reverify', result: 'REQUEUED_T1_PAGES_MISSING' });
  }
  console.info(`[t1-coverage-reverify] fichier ${p.fileId} : ${result} (${avant} → ${apres}), ${v.verified.length}/${pageCount} page(s) vérifiée(s)`
    + `${v.missing.length ? `, manquantes ${v.missing.join(',')}` : ''}${v.unverified.length ? `, non vérifiables ${v.unverified.join(',')}` : ''}`);
  return {
    fileId: p.fileId, result, reason: v.reason ?? 'verified', qualityBefore: avant, qualityAfter: apres,
    pagesVerified: v.verified, pagesMissing: v.missing, pagesUnverifiable: v.unverified, requeued,
  };
}
