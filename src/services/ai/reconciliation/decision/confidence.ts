/**
 * Seuils de confiance — CDC §14.4 (point à arbitrer).
 *
 * Valeurs de travail, isolées dans ce seul fichier pour être recalibrées au
 * lot 6 sur le corpus de référence, sans toucher au moteur.
 *
 * Le CDC ne fixe pas de valeurs numériques : il définit trois niveaux
 * qualitatifs. La conversion score → niveau est donc un réglage, pas une règle.
 */
import type { EvidenceConfidence } from '../../evidence/evidence.types';

export const CONFIDENCE_THRESHOLDS = {
  /** Au-delà : la valeur est tenue pour certaine. */
  certain: 0.90,
  /** Au-delà : la valeur est probable. En deçà : conflictuelle. */
  probable: 0.65,
} as const;

export const CONFIDENCE_VERSION = 'v1-2026-07';

export function scoreToConfidence(score: number): EvidenceConfidence {
  if (score >= CONFIDENCE_THRESHOLDS.certain) return 'certain';
  if (score >= CONFIDENCE_THRESHOLDS.probable) return 'probable';
  return 'conflictual';
}

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
