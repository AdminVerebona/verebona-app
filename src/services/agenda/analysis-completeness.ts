/**
 * Complétude d'une analyse, vue de la synchronisation agenda — CDC 15 T4-08
 * (relecture du lot 14). Pure.
 *
 * La synchronisation d'une source RETIRE les éléments automatiques que la
 * réanalyse ne produit plus. Une analyse vide ou dégradée ne produit rien —
 * non parce que les échéances ont disparu du document, mais parce qu'elle ne
 * les a pas lues. Le retrait n'a donc lieu que si l'analyse est COMPLÈTE :
 * contenu exploitable, extraction entière, prompt maître (pas de repli),
 * aucun fait tronqué ni écarté, source joignable. Indicateur calculé à la
 * mise en file T4 (`onSourceAnalyzed`), porté par le travail jusqu'à la
 * persistance. Absent (travail antérieur, rattachement tardif) : incomplet.
 */
export const INCOMPLETE_ANALYSIS_WARNINGS: ReadonlySet<string> = new Set([
  'NO_EXPLOITABLE_CONTENT',
  'PARTIAL_EXTRACTION',
  'MASTER_FALLBACK_STEPS',
  'FACTS_TRUNCATED',
  'SOURCE_UNREACHABLE',
  // Équivalent : un fait mal formé écarté peut être celui d'une échéance.
  'FACT_INVALID_DROPPED',
  // Lot 34F : une partie de la source n'a pas pu être analysée.
  'SOURCE_UNIT_FAILED',
  'COVERAGE_INCOMPLETE',
]);

export interface AnalysisCompleteness {
  complete: boolean;
  /** Avertissements qui rendent l'analyse incomplète. */
  reasons: string[];
}

export function analysisCompleteness(
  result: { warnings?: ReadonlyArray<{ code: string }> | null } | null | undefined,
): AnalysisCompleteness {
  if (!result || !Array.isArray(result.warnings)) return { complete: false, reasons: ['UNKNOWN'] };
  const reasons = [...new Set(result.warnings.map((w) => w.code).filter((c) => INCOMPLETE_ANALYSIS_WARNINGS.has(c)))].sort();
  return { complete: reasons.length === 0, reasons };
}
