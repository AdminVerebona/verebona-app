/**
 * Niveaux de confiance — CDC §14.4 : trois niveaux qualitatifs (certain,
 * probable, conflictuel), ordonnés pour le tri et la combinaison des preuves.
 */
import type { EvidenceConfidence } from '../../evidence/evidence.types';

const RANK: Record<EvidenceConfidence, number> = {
  certain: 3, probable: 2, conflictual: 1,
};

/** Rang numérique d'un niveau de confiance, pour le tri des preuves. */
export function confidenceRank(c: EvidenceConfidence): number {
  return RANK[c];
}

export function isAtLeast(actual: EvidenceConfidence, required: EvidenceConfidence): boolean {
  return RANK[actual] >= RANK[required];
}

/** Confiance résultante d'un ensemble de preuves : la plus faible l'emporte. */
export function weakestConfidence(values: EvidenceConfidence[]): EvidenceConfidence {
  if (values.length === 0) return 'conflictual';
  return values.reduce((acc, v) => (RANK[v] < RANK[acc] ? v : acc), 'certain' as EvidenceConfidence);
}

/**
 * Écart d'autorité en deçà duquel deux sources sont réputées équivalentes.
 * Sous ce seuil, une divergence produit un conflit plutôt qu'une mise à jour
 * (CDC §4.2.4, ligne « preuve contradictoire de même autorité »).
 */
export const AUTHORITY_EQUIVALENCE_MARGIN = 10;
