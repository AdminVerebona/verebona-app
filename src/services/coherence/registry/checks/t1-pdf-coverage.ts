/**
 * COH-T1-PDF-COVERAGE — couverture des PDF re-vérifiée par la couche texte
 * déterministe (lot 109K, ticket « T1 couverture PDF », COR-01 ; reprise du
 * stock par le registre de cohérence, consignes lot 108).
 *
 * Avant le lot 109K, la couverture d'un PDF n'était confrontée qu'à la sonde
 * pdf-lib, aveugle aux polices composites (CID) : des pages réellement lues
 * restaient « non vérifiées » (VERIFICATION_INCOMPLETE). Ce contrôle repère
 * les couvertures enregistrées par l'ancienne règle et les confronte de
 * nouveau, SANS IA NI TÉLÉCHARGEMENT, à l'extract pdf.js déjà persisté
 * (`stored-reverification.ts`) :
 *   · page retrouvée → VERIFIED (preuve reproductible) ; scan sans couche
 *     texte → UNVERIFIABLE conservé ; omission objectivée → MISSING,
 *     INCOMPLETE_RETRYABLE et relecture ciblée bornée par la file T1 ;
 *   · état de qualité RECALCULÉ par le même rapport (aucun seuil changé) ;
 *   · empreinte de la confrontation : jamais rejouée à l'identique.
 */
import type { CoherenceCheck, Inspection, RepairResult } from '../types';
import { hashOf, idsOf, rows } from '../util';

export const T1_PDF_COVERAGE_SERVICE = 'source-units/stored-reverification#reverifyStoredCoverage';

export const t1PdfCoverageCheck: CoherenceCheck = {
  id: 'COH-T1-PDF-COVERAGE',
  version: 1,
  status: 'ACTIVE',
  title: 'T1 : couverture des PDF confrontée au texte original déterministe',
  domain: 'documents-t1',
  level: 'N3',
  objectType: 'asset_file',
  scope: 'documents du compte en « vérification incomplète » pour pages non vérifiées, vérifiés par une règle antérieure au lot 109K',
  sources: ['document_extraction_coverage', 'document_raw_extracts', 'document_source_units', 'document_unresolved_facts'],
  applicability: 'compte éligible (actif) ; extract brut persisté du même fichier',
  invariant: 'une page n’est vérifiée que si son texte original est retrouvé dans la lecture T1 ; une omission objectivée est MANQUANTE ; une page sans texte confrontable reste NON VÉRIFIABLE',
  anomalies: ['COVERAGE_VERIFIER_OUTDATED'],
  autoRepairWhen: 'couverture enregistrée par la sonde seule (version des règles < 2) et extract pdf.js disponible : confrontation déterministe, état recalculé',
  forbiddenRepairs: ['déclarer COMPLETE sans texte original retrouvé', 'abaisser un seuil de correspondance', 'appeler l’IA', 'télécharger de nouveau le fichier',
    'rejouer une confrontation de même empreinte'],
  services: [T1_PDF_COVERAGE_SERVICE],
  chain: ['EXTRACT', 'T1', 'PERSISTENCE'],
  triggers: ['SOURCE_ANALYZED'],
  frequency: 'campagne quotidienne (stock) ; sans objet pour les nouvelles analyses (règle appliquée à l’écriture)',
  criticality: 'MEDIUM',
  tests: ['L109K-U-COV', 'L109K-U-REVERIFY', 'L109K-E2E-COV'],

  async listObjects(ctx, accountId, afterId, limit) {
    return idsOf(await rows(ctx.sql, `
      SELECT c.file_id AS id FROM document_extraction_coverage c
        JOIN asset_files f ON f.id = c.file_id AND f.deleted_at IS NULL
       WHERE c.account_id = $1 AND c.file_id > $2 AND c.quality_state = 'VERIFICATION_INCOMPLETE'
       ORDER BY c.file_id LIMIT $3`, [accountId, afterId, limit]));
  },

  async objectsForEvent(ctx, accountId, e) {
    if (e.entityId == null) return [];
    return idsOf(await rows(ctx.sql, `SELECT file_id AS id FROM document_extraction_coverage WHERE account_id = $1 AND file_id = $2`, [accountId, e.entityId]));
  },

  async inspect(ctx, accountId, ids) {
    const out = new Map<number, Inspection>();
    const { reverificationDue } = await import('@/services/ai/source-analysis/source-units/stored-reverification');
    const r = await rows(ctx.sql, `
      SELECT c.file_id, c.quality_state, c.verification, (x.file_id IS NOT NULL AND x.extraction_status <> 'FAILED') AS has_extract, x.source_sha256
        FROM document_extraction_coverage c
        LEFT JOIN document_raw_extracts x ON x.file_id = c.file_id AND x.account_id = c.account_id
       WHERE c.account_id = $1 AND c.file_id = ANY($2::int[])`, [accountId, ids]);
    const parId = new Map(r.map((x) => [Number(x.file_id), x]));
    for (const id of ids) {
      const x = parId.get(id);
      if (!x) { out.set(id, { verdict: 'GONE' }); continue; }
      const verification = (x.verification ?? null) as Record<string, unknown> | null;
      const rev = (verification?.reverification ?? null) as { fingerprint?: string; result?: string } | null;
      if (!reverificationDue({ qualityState: String(x.quality_state), verification })) {
        out.set(id, { verdict: 'CONSISTENT', detail: { qualityState: x.quality_state, verifierVersion: verification?.verifierVersion ?? 1, reverification: rev?.result ?? null } });
        continue;
      }
      if (x.has_extract !== true) {
        out.set(id, {
          verdict: 'FINDING', anomaly: 'COVERAGE_VERIFIER_OUTDATED', faultyLink: 'EXTRACT',
          expected: 'extract pdf.js du fichier pour confronter les pages', observed: 'extract absent ou en échec',
          detail: { reason: verification?.verificationReason ?? null }, inputHash: hashOf({ id, extract: null }),
        });
        continue;
      }
      out.set(id, {
        verdict: 'REPAIRABLE', anomaly: 'COVERAGE_VERIFIER_OUTDATED', faultyLink: 'T1',
        expected: 'pages confrontées au texte original déterministe (règles v2)',
        observed: { verifierVersion: verification?.verifierVersion ?? 1, pagesUnverified: verification?.pagesUnverified ?? [] },
        inputHash: hashOf({ id, sha: x.source_sha256 ?? null, v: verification?.verifierVersion ?? 1 }),
      });
    }
    return out;
  },

  async repair(_ctx, accountId, items) {
    const out = new Map<number, RepairResult>();
    const { reverifyStoredCoverage } = await import('@/services/ai/source-analysis/source-units/stored-reverification');
    for (const { id } of items) {
      const r = await reverifyStoredCoverage({ accountId, fileId: id });
      out.set(id, {
        called: true, service: T1_PDF_COVERAGE_SERVICE, aiCalls: 0, reevaluation: 'TECHNICAL_REBUILD',
        ...(r.requeued ? { pending: true } : {}),
        result: { result: r.result, reason: r.reason, qualityBefore: r.qualityBefore, qualityAfter: r.qualityAfter,
          pagesMissing: r.pagesMissing ?? [], pagesUnverifiable: r.pagesUnverifiable ?? [], requeued: r.requeued ?? false },
        rollbackRef: `document_extraction_coverage:file=${id}:verification.reverification`,
      });
    }
    return out;
  },
};
