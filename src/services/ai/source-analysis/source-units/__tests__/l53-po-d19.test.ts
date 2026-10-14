/**
 * Lot 53 — retour PO D19 : ne jamais qualifier de « complète » une analyse T1
 * dont la couverture documentaire n'est pas vérifiable. État
 * VERIFICATION_INCOMPLETE (« vérification incomplète — pages non
 * vérifiables ») ; motif, pages, statut et prochaine action visibles dans
 * BO › Complétude T1 ; reprise organisée (automatique si la cause est
 * transitoire, manuelle sinon), tracée, sans boucle.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildCompletenessReport, type ReportInput } from '../coverage';
import { verificationNotApplicable, verificationUnverifiable, verifyNonPdf } from '../source-verification';
import { verificationAutoRetryDue, verificationFollowup } from '../verification-followup';
import { T1_COMPLETENESS_ANOMALIES, T1_QUALITY_STATES } from '../types';

const base: ReportInput = {
  factsCount: 3, unresolvedFacts: [], truncatedSectionsCount: 0, batchedSectionsCount: 0, repairPassCount: 0, chunkCount: 0,
  warningCodes: [], retryAllowed: true,
};
const rapport = (verification: ReportInput['verification']) => buildCompletenessReport([], { ...base, verification });
const lire = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');

describe('PO-D19 — couverture non vérifiable : jamais « complète »', () => {
  it('PO-D19-01 — image ou scan : vérification incomplète (jamais COMPLETE ni COMPLETE_WITH_UNRESOLVED), anomalie visible', () => {
    const r = rapport(verifyNonPdf({ mimeTypes: ['image/jpeg'], textSource: false, hasContent: true }));
    expect(r.qualityState).toBe('VERIFICATION_INCOMPLETE');
    expect(r.anomalies).toEqual(expect.arrayContaining(['COVERAGE_UNVERIFIED', 'PAGE_UNVERIFIED']));
    expect(r.diagnostics).toMatchObject({ sourceVerification: 'UNVERIFIABLE', verificationReason: 'image_not_checkable' });
  });

  it('PO-D19-02 — PDF : pages non vérifiées → vérification incomplète ; pages manquantes → reprise (inchangé) ; vérifié → complète', () => {
    const partiel = rapport({ status: 'PARTIAL', reason: 'pages_unverified', pagesExpected: 4, verified: [1, 2], missing: [], unverified: [3, 4], scanned: [3, 4] });
    expect(partiel.qualityState).toBe('VERIFICATION_INCOMPLETE');
    expect(partiel.diagnostics?.pagesUnverified).toEqual([3, 4]);
    const manquant = rapport({ status: 'PARTIAL', reason: 'pages_missing', pagesExpected: 4, verified: [1, 2, 3], missing: [4], unverified: [], scanned: [] });
    expect(manquant.qualityState).toBe('INCOMPLETE_RETRYABLE');
    expect(rapport({ status: 'VERIFIED', reason: null, pagesExpected: 2, verified: [1, 2], missing: [], unverified: [], scanned: [] }).qualityState).toBe('COMPLETE');
    // Texte préextrait (lien web) : la source EST le texte — complète.
    expect(rapport(verificationNotApplicable('text_source')).qualityState).toBe('COMPLETE');
    // Couverture reconstruite (documents historiques) : jamais vérifiée.
    expect(rapport({ status: 'RECONSTRUCTED', reason: 'backfill', pagesExpected: null, verified: [], missing: [], unverified: [], scanned: [] }).qualityState)
      .toBe('VERIFICATION_INCOMPLETE');
    // Un échec reste prioritaire (incomplète, pas « vérification incomplète »).
    expect(buildCompletenessReport([], { ...base, truncatedSectionsCount: 1, verification: verificationUnverifiable('source_unreadable') }).qualityState)
      .toBe('INCOMPLETE_FINAL');
  });

  it('PO-D19-03 — suivi : motif, pages concernées, statut et prochaine action', () => {
    const f = verificationFollowup({ qualityState: 'VERIFICATION_INCOMPLETE', sourceVerification: 'PARTIAL', verificationReason: 'pages_unverified', pagesUnverified: [4, 3] })!;
    expect(f).toMatchObject({ pages: [3, 4], autoRetry: false, manualRetry: true, status: 'vérification incomplète — contrôle manuel' });
    expect(f.reason).toMatch(/pages non vérifiées/);
    expect(f.nextAction).toBe('Contrôler les pages 3, 4 dans le document, puis relancer l’analyse si une information manque.');
    const img = verificationFollowup({ qualityState: 'VERIFICATION_INCOMPLETE', sourceVerification: 'UNVERIFIABLE', verificationReason: 'image_not_checkable' })!;
    expect(img.reason).toMatch(/image ou scan/);
    expect(img.nextAction).toMatch(/Contrôler visuellement/);
    const hist = verificationFollowup({ qualityState: 'VERIFICATION_INCOMPLETE', sourceVerification: 'RECONSTRUCTED', verificationReason: null })!;
    expect(hist.reason).toMatch(/reconstruite/);
    expect(verificationFollowup({ qualityState: 'COMPLETE' })).toBeNull();
  });

  it('PO-D19-04 — reprise organisée : automatique seulement pour une cause transitoire, bornée (jamais de boucle) ; sinon manuelle', () => {
    const illisible = { qualityState: 'VERIFICATION_INCOMPLETE', verificationReason: 'source_unreadable', maxRetries: 2 };
    expect(verificationAutoRetryDue({ ...illisible, retryAttempts: 0 })).toBe(true);
    expect(verificationAutoRetryDue({ ...illisible, retryAttempts: 1 })).toBe(true);
    expect(verificationAutoRetryDue({ ...illisible, retryAttempts: 2 })).toBe(false);
    expect(verificationAutoRetryDue({ ...illisible, verificationReason: 'image_not_checkable', retryAttempts: 0 })).toBe(false);
    expect(verificationAutoRetryDue({ ...illisible, qualityState: 'COMPLETE_WITH_UNRESOLVED', retryAttempts: 0 })).toBe(false);
    const auto = verificationFollowup({ ...illisible, sourceVerification: 'UNVERIFIABLE', retryAttempts: 0, retryScheduled: true })!;
    expect(auto).toMatchObject({ autoRetry: true, nextAction: 'Relecture automatique du fichier programmée.' });
    // Écriture : relecture programmée par défaut ; reprise : relecture du fichier ou contrôle manuel tracé.
    expect(lire('src/services/ai/source-analysis/source-units/repository.ts')).toMatch(/verificationAutoRetryDue\(\{ qualityState: r\.qualityState/);
    const jobs = lire('src/services/ai/source-analysis/source-units/jobs.ts');
    expect(jobs).toContain("p.qualityState === 'VERIFICATION_INCOMPLETE'");
    expect(jobs).toContain("last_retry_result = 'MANUAL_CHECK_REQUIRED'");
    expect(lire('src/app/api/admin/ai/t1-completeness/retry/route.ts')).toContain("result: 'REQUEUED_T1_ADMIN'");
  });

  it('PO-D19-05 — BO et base : état et anomalie déclarés, libellés explicites, migration 0354 (contrainte + requalification sans réécrire la date)', () => {
    expect(T1_QUALITY_STATES).toContain('VERIFICATION_INCOMPLETE');
    expect(T1_COMPLETENESS_ANOMALIES).toContain('COVERAGE_UNVERIFIED');
    const panel = lire('src/app/admin/ai-executions/_components/T1CompletenessPanel.tsx');
    expect(panel).toContain("VERIFICATION_INCOMPLETE: 'vérification incomplète — pages non vérifiables'");
    expect(panel).toContain('Prochaine action');
    const m = lire('src/db/migrations/0354_t1_verification_incomplete.sql');
    expect(m).toMatch(/VERIFICATION_INCOMPLETE/);
    expect(m).toMatch(/DROP CONSTRAINT IF EXISTS document_extraction_coverage_quality_chk/);
    expect(m).toMatch(/WHERE quality_state = 'COMPLETE_WITH_UNRESOLVED'/);
    expect(m).not.toMatch(/updated_at\s*=/);
    expect(lire('src/db/ai-schema.ts')).toContain("'VERIFICATION_INCOMPLETE'");
  });

  it('PO-D19-06 — Supervision : une vérification incomplète n’est pas un échec définitif (anomalie résolue, pas créée)', async () => {
    const reportAnomaly = vi.fn(async () => undefined);
    const autoResolveAnomaly = vi.fn(async () => undefined);
    vi.doMock('@/services/admin/anomaly.service', () => ({ reportAnomaly, autoResolveAnomaly }));
    const { recordT1Completeness } = await import('../monitoring');
    const r = rapport(verifyNonPdf({ mimeTypes: ['image/png'], textSource: false, hasContent: true }));
    await recordT1Completeness({ accountId: 1, fileId: 9, report: r, persisted: true });
    expect(reportAnomaly).not.toHaveBeenCalled();
    expect(autoResolveAnomaly).toHaveBeenCalledWith('ai:t1-completeness:9', expect.objectContaining({ cause: 'analyse VERIFICATION_INCOMPLETE' }));
    vi.doUnmock('@/services/admin/anomaly.service');
  });
});
