/**
 * Relecture du lot 14 — une réanalyse vide ou dégradée ne retire rien
 * (CDC 15 T4-08) : complétude de l'analyse, portée jusqu'au travail T4.
 */
import { describe, it, expect, vi } from 'vitest';
import { analysisCompleteness, INCOMPLETE_ANALYSIS_WARNINGS } from '../analysis-completeness';
import { enqueueT4Candidates } from '@/services/ai/agenda';

describe('complétude d’une analyse', () => {
  it('complète : aucun avertissement d’incomplétude (les autres ne comptent pas)', () => {
    expect(analysisCompleteness({ warnings: [] })).toEqual({ complete: true, reasons: [] });
    expect(analysisCompleteness({ warnings: [{ code: 'AMBIGUOUS_ASSET' }, { code: 'UNIT_MISMATCH' }] }).complete).toBe(true);
  });
  it('incomplète : contenu inexploitable, extraction partielle, repli, troncature, source injoignable, fait écarté', () => {
    for (const code of ['NO_EXPLOITABLE_CONTENT', 'PARTIAL_EXTRACTION', 'MASTER_FALLBACK_STEPS', 'FACTS_TRUNCATED', 'SOURCE_UNREACHABLE', 'FACT_INVALID_DROPPED']) {
      expect(INCOMPLETE_ANALYSIS_WARNINGS.has(code)).toBe(true);
      expect(analysisCompleteness({ warnings: [{ code }, { code }] })).toEqual({ complete: false, reasons: [code] });
    }
  });
  it('inconnue (pas de résultat) : incomplète', () => {
    expect(analysisCompleteness(null)).toEqual({ complete: false, reasons: ['UNKNOWN'] });
  });
});

describe('mise en file T4', () => {
  it('la complétude est portée par le travail', async () => {
    const enqueue = vi.fn(async (_x: Record<string, unknown>) => ({ jobId: 1 }));
    await enqueueT4Candidates(
      { accountId: 1, userId: 2, assetId: 3, leadSourceId: 4, candidates: [], analysisComplete: false, incompleteReasons: ['PARTIAL_EXTRACTION'] },
      { enqueue: enqueue as never, isTriggerActive: async () => true },
    );
    expect(enqueue.mock.calls[0][0]).toMatchObject({ payload: { analysisComplete: false, incompleteReasons: ['PARTIAL_EXTRACTION'] } });
  });
});
