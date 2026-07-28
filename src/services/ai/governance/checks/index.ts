/**
 * Les neuf contrôles avant activation — CDC §4.5.5.
 *
 * « Avant activation, exécuter : validation du schéma de sortie, corpus de
 *   référence, absence de contamination entre biens, non-régression sur les
 *   champs critiques, conformité des types documentaires, coût moyen et
 *   latence, taux de sortie invalide, taux de fallback, comparaison à la
 *   version active. »
 *
 * Chaque contrôle est une fonction pure prenant les résultats d'exécution du
 * corpus et rendant un verdict. Les huit premiers sont BLOQUANTS ; la
 * comparaison à la version active est indicative — une dégradation légère peut
 * être acceptée en connaissance de cause, mais elle doit être vue.
 */
import type { CheckResult } from '../types';
import type { CorpusRunResult } from '../corpus/corpus-registry';

export interface CheckInput {
  /** Résultats de la version candidate sur le corpus. */
  candidate: CorpusRunResult;
  /** Résultats de la version active, pour comparaison. */
  baseline: CorpusRunResult | null;
}

/** Seuils d'acceptation. Isolés ici pour être ajustés sans toucher aux contrôles. */
export const CHECK_THRESHOLDS = {
  /** Part maximale de sorties non conformes au schéma. */
  maxInvalidOutputRate: 0.02,
  /** Part maximale d'appels ayant dû basculer sur un modèle de repli. */
  maxFallbackRate: 0.10,
  /** Part minimale de cas du corpus donnant le résultat attendu. */
  minCorpusSuccessRate: 0.90,
  /** Dégradation de coût tolérée par rapport à la version active. */
  maxCostIncreaseRatio: 1.25,
  /** Dégradation de latence tolérée. */
  maxLatencyIncreaseRatio: 1.30,
} as const;

export function runAllChecks(input: CheckInput): CheckResult[] {
  return [
    checkOutputSchema(input),
    checkReferenceCorpus(input),
    checkCrossAssetContamination(input),
    checkCriticalFieldsRegression(input),
    checkDocumentTypeConformity(input),
    checkCostAndLatency(input),
    checkInvalidOutputRate(input),
    checkFallbackRate(input),
    checkBaselineComparison(input),
  ];
}

// ── 1. Validation du schéma de sortie ───────────────────────────────────────
export function checkOutputSchema({ candidate }: CheckInput): CheckResult {
  const failures = candidate.cases.filter((c) => !c.schemaValid);
  return {
    checkCode: 'output_schema',
    label: 'Validation du schéma de sortie',
    passed: failures.length === 0,
    blocking: true,
    detail: failures.length === 0
      ? `${candidate.cases.length} sorties conformes`
      : `${failures.length} sortie(s) non conforme(s) : ${failures.slice(0, 3).map((c) => c.caseId).join(', ')}`,
  };
}

// ── 2. Corpus de référence ──────────────────────────────────────────────────
export function checkReferenceCorpus({ candidate }: CheckInput): CheckResult {
  const rate = ratio(candidate.cases.filter((c) => c.expectedMatch).length, candidate.cases.length);
  return {
    checkCode: 'reference_corpus',
    label: 'Corpus de référence',
    passed: rate >= CHECK_THRESHOLDS.minCorpusSuccessRate,
    blocking: true,
    detail: `${Math.round(rate * 100)} % des cas donnent le résultat attendu (seuil ${Math.round(CHECK_THRESHOLDS.minCorpusSuccessRate * 100)} %)`,
    candidateValue: rate,
  };
}

// ── 3. Absence de contamination entre biens ─────────────────────────────────
export function checkCrossAssetContamination({ candidate }: CheckInput): CheckResult {
  // Contrôle le plus important de la série : une contamination n'est pas une
  // dégradation de qualité, c'est une fuite de données entre objets.
  const contaminated = candidate.cases.filter((c) => c.crossAssetLeak);
  return {
    checkCode: 'cross_asset_contamination',
    label: 'Absence de contamination entre biens',
    passed: contaminated.length === 0,
    blocking: true,
    detail: contaminated.length === 0
      ? 'aucune information rattachée à un bien étranger'
      : `${contaminated.length} cas de contamination : ${contaminated.map((c) => c.caseId).join(', ')}`,
  };
}

// ── 4. Non-régression sur les champs critiques ──────────────────────────────
export function checkCriticalFieldsRegression({ candidate, baseline }: CheckInput): CheckResult {
  if (!baseline) {
    return {
      checkCode: 'critical_fields_regression',
      label: 'Non-régression sur les champs critiques',
      passed: true, blocking: true,
      detail: 'aucune version active — comparaison impossible, contrôle non applicable',
    };
  }
  const before = baseline.criticalFieldsCorrect;
  const after = candidate.criticalFieldsCorrect;
  return {
    checkCode: 'critical_fields_regression',
    label: 'Non-régression sur les champs critiques',
    // Aucune tolérance : un champ critique correct ne doit jamais devenir faux.
    passed: after >= before,
    blocking: true,
    detail: `${after} champs critiques corrects contre ${before} sur la version active`,
    baselineValue: before, candidateValue: after,
  };
}

// ── 5. Conformité des types documentaires ───────────────────────────────────
export function checkDocumentTypeConformity({ candidate }: CheckInput): CheckResult {
  const wrong = candidate.cases.filter((c) => c.documentTypeCorrect === false);
  return {
    checkCode: 'document_type_conformity',
    label: 'Conformité des types documentaires',
    passed: wrong.length === 0,
    blocking: true,
    detail: wrong.length === 0
      ? 'tous les types documentaires attendus sont reconnus'
      : `${wrong.length} type(s) mal reconnu(s) : ${wrong.slice(0, 3).map((c) => c.caseId).join(', ')}`,
  };
}

// ── 6. Coût moyen et latence ────────────────────────────────────────────────
export function checkCostAndLatency({ candidate, baseline }: CheckInput): CheckResult {
  if (!baseline) {
    return {
      checkCode: 'cost_latency', label: 'Coût moyen et latence',
      passed: true, blocking: true,
      detail: `coût moyen ${candidate.avgCostMicros} micros, latence ${candidate.avgDurationMs} ms — aucune référence`,
      candidateValue: candidate.avgCostMicros,
    };
  }

  const costRatio = safeRatio(candidate.avgCostMicros, baseline.avgCostMicros);
  const latencyRatio = safeRatio(candidate.avgDurationMs, baseline.avgDurationMs);
  const passed = costRatio <= CHECK_THRESHOLDS.maxCostIncreaseRatio
    && latencyRatio <= CHECK_THRESHOLDS.maxLatencyIncreaseRatio;

  return {
    checkCode: 'cost_latency',
    label: 'Coût moyen et latence',
    passed, blocking: true,
    detail: `coût ×${costRatio.toFixed(2)}, latence ×${latencyRatio.toFixed(2)} par rapport à la version active`,
    baselineValue: baseline.avgCostMicros, candidateValue: candidate.avgCostMicros,
  };
}

// ── 7. Taux de sortie invalide ──────────────────────────────────────────────
export function checkInvalidOutputRate({ candidate }: CheckInput): CheckResult {
  const rate = ratio(candidate.cases.filter((c) => !c.schemaValid).length, candidate.cases.length);
  return {
    checkCode: 'invalid_output_rate',
    label: 'Taux de sortie invalide',
    passed: rate <= CHECK_THRESHOLDS.maxInvalidOutputRate,
    blocking: true,
    detail: `${(rate * 100).toFixed(1)} % (seuil ${CHECK_THRESHOLDS.maxInvalidOutputRate * 100} %)`,
    candidateValue: rate,
  };
}

// ── 8. Taux de fallback ─────────────────────────────────────────────────────
export function checkFallbackRate({ candidate }: CheckInput): CheckResult {
  const rate = ratio(candidate.cases.filter((c) => c.usedFallback).length, candidate.cases.length);
  return {
    checkCode: 'fallback_rate',
    label: 'Taux de repli sur un modèle secondaire',
    passed: rate <= CHECK_THRESHOLDS.maxFallbackRate,
    blocking: true,
    detail: `${(rate * 100).toFixed(1)} % (seuil ${CHECK_THRESHOLDS.maxFallbackRate * 100} %)`,
    candidateValue: rate,
  };
}

// ── 9. Comparaison à la version active ──────────────────────────────────────
export function checkBaselineComparison({ candidate, baseline }: CheckInput): CheckResult {
  if (!baseline) {
    return {
      checkCode: 'baseline_comparison', label: 'Comparaison à la version active',
      passed: true, blocking: false, detail: 'première version — aucune comparaison possible',
    };
  }

  const before = ratio(baseline.cases.filter((c) => c.expectedMatch).length, baseline.cases.length);
  const after = ratio(candidate.cases.filter((c) => c.expectedMatch).length, candidate.cases.length);

  return {
    checkCode: 'baseline_comparison',
    label: 'Comparaison à la version active',
    passed: after >= before,
    // Non bloquant : une légère dégradation peut être acceptée en connaissance
    // de cause, mais elle doit être affichée à l'administrateur.
    blocking: false,
    detail: `${Math.round(after * 100)} % contre ${Math.round(before * 100)} % sur la version active`,
    baselineValue: before, candidateValue: after,
  };
}

function ratio(part: number, total: number): number {
  return total === 0 ? 0 : part / total;
}

function safeRatio(candidate: number, baseline: number): number {
  return baseline === 0 ? (candidate === 0 ? 1 : Number.POSITIVE_INFINITY) : candidate / baseline;
}
