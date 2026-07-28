/**
 * Les neuf contrôles avant activation — CDC §4.5.5.
 *
 * Chaque contrôle est testé sur un cas qui passe et un cas qui échoue : un
 * contrôle qui ne peut jamais échouer ne protège de rien.
 */
import { describe, it, expect } from 'vitest';
import { runAllChecks, CHECK_THRESHOLDS } from '../checks';
import { computeRunSummary } from '../corpus/corpus-registry';
import type { CorpusCaseResult } from '../corpus/corpus-registry';

function testCase(over: Partial<CorpusCaseResult> = {}): CorpusCaseResult {
  return {
    caseId: 'cas-1', category: 'facture_equipement',
    schemaValid: true, expectedMatch: true, documentTypeCorrect: true,
    crossAssetLeak: false, usedFallback: false,
    costMicros: 100, durationMs: 1000, ...over,
  };
}

function run(cases: CorpusCaseResult[], criticalFieldsCorrect = 10) {
  return computeRunSummary('extract_source_v2', 'v2', cases, criticalFieldsCorrect);
}

const nominal = Array.from({ length: 20 }, (_, i) => testCase({ caseId: `cas-${i}` }));

function check(code: string, cases: CorpusCaseResult[], criticalFields = 10, baseline = run(nominal)) {
  return runAllChecks({ candidate: run(cases, criticalFields), baseline })
    .find((c) => c.checkCode === code)!;
}

describe('les neuf contrôles sont exécutés', () => {
  it('produit exactement neuf verdicts', () => {
    expect(runAllChecks({ candidate: run(nominal), baseline: null })).toHaveLength(9);
  });

  it('huit sont bloquants, la comparaison est indicative', () => {
    const checks = runAllChecks({ candidate: run(nominal), baseline: run(nominal) });
    expect(checks.filter((c) => c.blocking)).toHaveLength(8);
    expect(checks.find((c) => c.checkCode === 'baseline_comparison')!.blocking).toBe(false);
  });
});

describe('1. schéma de sortie', () => {
  it('passe sur des sorties conformes', () => {
    expect(check('output_schema', nominal).passed).toBe(true);
  });
  it('échoue sur une seule sortie non conforme', () => {
    expect(check('output_schema', [...nominal, testCase({ caseId: 'x', schemaValid: false })]).passed).toBe(false);
  });
});

describe('3. contamination entre biens — le contrôle le plus important', () => {
  it('passe en l\'absence de fuite', () => {
    expect(check('cross_asset_contamination', nominal).passed).toBe(true);
  });

  it('échoue dès UN SEUL cas de contamination, sans seuil de tolérance', () => {
    const c = check('cross_asset_contamination', [...nominal, testCase({ caseId: 'fuite', crossAssetLeak: true })]);
    expect(c.passed).toBe(false);
    expect(c.blocking).toBe(true);
    expect(c.detail).toContain('fuite');
  });
});

describe('4. non-régression sur les champs critiques', () => {
  it('passe si le nombre de champs corrects se maintient', () => {
    expect(check('critical_fields_regression', nominal, 10).passed).toBe(true);
  });

  it('échoue à la moindre régression, sans tolérance', () => {
    expect(check('critical_fields_regression', nominal, 9).passed).toBe(false);
  });

  it('passe si le candidat fait mieux', () => {
    expect(check('critical_fields_regression', nominal, 12).passed).toBe(true);
  });
});

describe('6. coût et latence', () => {
  it('accepte une hausse modérée', () => {
    const cases = nominal.map((c) => ({ ...c, costMicros: 110 }));
    expect(check('cost_latency', cases).passed).toBe(true);
  });

  it('refuse un doublement du coût', () => {
    const cases = nominal.map((c) => ({ ...c, costMicros: 250 }));
    expect(check('cost_latency', cases).passed).toBe(false);
  });

  it('refuse un doublement de la latence', () => {
    const cases = nominal.map((c) => ({ ...c, durationMs: 2500 }));
    expect(check('cost_latency', cases).passed).toBe(false);
  });
});

describe('7 et 8. taux de sortie invalide et de repli', () => {
  it('refuse un taux d\'invalidité supérieur au seuil', () => {
    const cases = [...nominal];
    cases[0] = testCase({ caseId: 'a', schemaValid: false });
    cases[1] = testCase({ caseId: 'b', schemaValid: false });
    // 2 sur 20 = 10 %, au-delà du seuil de 2 %.
    expect(check('invalid_output_rate', cases).passed).toBe(false);
    expect(CHECK_THRESHOLDS.maxInvalidOutputRate).toBe(0.02);
  });

  it('accepte un repli occasionnel mais refuse un repli systématique', () => {
    const rare = [...nominal];
    rare[0] = testCase({ caseId: 'a', usedFallback: true });
    expect(check('fallback_rate', rare).passed).toBe(true);

    const frequent = nominal.map((c) => ({ ...c, usedFallback: true }));
    expect(check('fallback_rate', frequent).passed).toBe(false);
  });
});

describe('cas de la première version', () => {
  it('ne bloque pas faute de version active à comparer', () => {
    const checks = runAllChecks({ candidate: run(nominal), baseline: null });
    const blockingFailures = checks.filter((c) => c.blocking && !c.passed);
    expect(blockingFailures).toHaveLength(0);
  });

  it('signale explicitement l\'absence de référence', () => {
    const checks = runAllChecks({ candidate: run(nominal), baseline: null });
    expect(checks.find((c) => c.checkCode === 'baseline_comparison')!.detail)
      .toMatch(/première version/i);
  });
});
