/**
 * Carte #838 (B2, AC07–AC16/AC22, sous-ensemble automatisable) — la
 * COUVERTURE d'une analyse T1 se prouve hors fournisseur : un JSON valide ne
 * suffit JAMAIS à déclarer « complète » une analyse dont la source n'a pas été
 * entièrement lue, vérifiée et rattachée.
 *
 * Fixtures SYNTHÉTIQUES (aucun document client, aucun appel Gemini) : PDF
 * multipages avec page manquante, scan/JPEG non vérifiable, tableau multipage
 * fusionné incertain, saturation (sections tronquées), unités omises, faits
 * écartés, doublons, réparations épuisées. Les stockages existants (original,
 * PDF, OCR, unités, continuation) ne sont pas recréés : seul le rapport de
 * complétude (`buildCompletenessReport`) et la vérification de la source sont
 * exercés. Ne simule AUCUNE preuve de fidélité à un vrai document.
 */
import { describe, expect, it } from 'vitest';
import { buildCompletenessReport, type ReportInput } from '../coverage';
import { verifyNonPdf } from '../source-verification';
import type { CoveredSourceUnit } from '../types';

const base: ReportInput = {
  factsCount: 4, unresolvedFacts: [], truncatedSectionsCount: 0, batchedSectionsCount: 0, repairPassCount: 0, chunkCount: 1,
  warningCodes: [], retryAllowed: false,
  verification: { status: 'VERIFIED', reason: null, pagesExpected: 3, verified: [1, 2, 3], missing: [], unverified: [], scanned: [] },
};
let n = 0;
const unite = (over: Partial<CoveredSourceUnit> = {}): CoveredSourceUnit => ({
  sourceUnitId: `page:1:block:${n++}`, kind: 'TEXT_BLOCK', page: 1, ordinal: n, parentUnitId: null, text: 'Total TTC : 1 234,50 €',
  payload: {}, location: { page: 1 }, origin: 'PDF_TEXT', salient: true, status: 'COVERED', reason: 'fact', repairAttempts: 0, repairState: null,
  ...over,
} as CoveredSourceUnit);

describe('C838-B2 — jamais COMPLETE sur simple JSON valide', () => {
  it('C838-B2-01 — tout couvert et source vérifiée : COMPLETE (référence)', () => {
    expect(buildCompletenessReport([unite(), unite({ page: 2 })], base).qualityState).toBe('COMPLETE');
  });

  it('C838-B2-02 — PDF multipages, page MANQUANTE sans reprise admissible : INCOMPLETE_FINAL, page tracée', () => {
    const r = buildCompletenessReport([unite()], {
      ...base, verification: { status: 'PARTIAL', reason: 'pages_missing', pagesExpected: 3, verified: [1, 2], missing: [3], unverified: [], scanned: [] },
    });
    expect(r.qualityState).toBe('INCOMPLETE_FINAL');
    expect(r.anomalies).toEqual(expect.arrayContaining(['PAGE_MISSING', 'COVERAGE_INCOMPLETE']));
    expect(r.diagnostics?.pagesMissing).toEqual([3]);
  });

  it('C838-B2-03 — scan / JPEG simulé : couverture NON VÉRIFIABLE préservée (jamais COMPLETE, même JSON valide)', () => {
    const r = buildCompletenessReport([unite({ origin: 'OCR' as never })], { ...base, verification: verifyNonPdf({ mimeTypes: ['image/jpeg'], textSource: false, hasContent: true }) });
    expect(r.qualityState).toBe('VERIFICATION_INCOMPLETE');
    expect(r.diagnostics?.sourceVerification).toBe('UNVERIFIABLE');
    expect(r.anomalies).toEqual(expect.arrayContaining(['COVERAGE_UNVERIFIED']));
  });

  it('C838-B2-04 — saturation (sections TRONQUÉES) : INCOMPLETE, limitation visible, jamais « réussie »', () => {
    const r = buildCompletenessReport([unite()], { ...base, truncatedSectionsCount: 2 });
    expect(['INCOMPLETE_FINAL', 'INCOMPLETE_RETRYABLE']).toContain(r.qualityState);
    expect(r.anomalies).toContain('FACTS_TRUNCATED');
    expect(r.truncatedSectionsCount).toBe(2);
  });

  it('C838-B2-05 — tableau multipage fusionné INCERTAIN, unité omise (non résolue) : COMPLETE_WITH_UNRESOLVED, rien de supprimé', () => {
    const units = [
      unite(),
      unite({ kind: 'TABLE', page: 2, status: 'UNCERTAIN', reason: 'table_merged_pages' }),
      unite({ page: 3, status: 'UNRESOLVED', reason: 'no_fact' }),
    ];
    const r = buildCompletenessReport(units, base);
    expect(r.qualityState).toBe('COMPLETE_WITH_UNRESOLVED');
    expect(r).toMatchObject({ totalSourceUnits: 3, coveredUnits: 1, uncertainUnits: 1, unresolvedUnits: 1 });
    // Somme des états = total : aucune unité disparue en silence.
    expect(r.coveredUnits + r.nonInformationalUnits + r.unresolvedUnits + r.uncertainUnits + r.failedUnits).toBe(r.totalSourceUnits);
  });

  it('C838-B2-06 — faits non retenus (écartés à la 1re passe) et doublons : comptés, jamais COMPLETE', () => {
    const r = buildCompletenessReport([unite(), unite()], {
      ...base,
      unresolvedFacts: [
        { status: 'UNRESOLVED', reason: 'NO_EVIDENCE' } as never,
        { status: 'UNRESOLVED', reason: 'INVALID_SCHEMA' } as never,
        { status: 'RETAINED', reason: 'VALUE_TRUNCATED' } as never,
      ],
    });
    expect(r.droppedFactsCount).toBe(2);
    expect(r.qualityState).toBe('COMPLETE_WITH_UNRESOLVED');
    expect(r.anomalies).toContain('FACT_INVALID_DROPPED');
  });

  it('C838-B2-07 — réparation BORNÉE épuisée : signalée, pas de deuxième appel systématique, jamais COMPLETE', () => {
    const r = buildCompletenessReport([unite({ status: 'UNRESOLVED', reason: 'repair_failed', repairAttempts: 1, repairState: 'EXHAUSTED' as never })], { ...base, repairPassCount: 1 });
    expect(r.qualityState).toBe('COMPLETE_WITH_UNRESOLVED');
    expect(r.anomalies).toContain('REPAIR_EXHAUSTED');
    expect(r.repairPassCount).toBe(1);
  });
});
