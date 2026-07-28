/**
 * Champs critiques — CDC §4.2.6.
 *
 * « Pour ces champs, le moteur doit exiger : un type de document autorisé, une
 *   preuve précise, une valeur normalisée valide, une confiance certain pour une
 *   application automatique. »
 *
 * Les quatre conditions sont CUMULATIVES. Une seule manquante interdit
 * l'application automatique et produit un arbitrage.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LISTE ARRÊTÉE PAR LE RESPONSABLE MÉTIER — décision du 28/07/2026
 * (question 3 du document `03-QUESTIONS-RESPONSABLE-METIER.md`)
 *
 * Retirés de la liste initiale, donc désormais modifiables automatiquement dès
 * lors que la preuve est meilleure : numéro de série et de châssis, valeur
 * estimée, coordonnées bancaires, numéro de contrat, prime d'assurance, statut
 * d'occupation, dates de contrat et de fin de garantie.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { isAuthorizedForCriticalField } from './authority-matrix';
import { isAtLeast } from './confidence';
import type { EvidenceCandidate } from '../types';

export const CRITICAL_FIELDS = new Set<string>([
  // Adresse du bien — l'identifiant le plus structurant d'un bien immobilier.
  'address1', 'address2', 'postalCode', 'city',
  // Plaque d'immatriculation.
  'registrationNumber',
  // Prix d'achat.
  'acquisitionPrice',
]);

export function isCriticalField(fieldKey: string): boolean {
  return CRITICAL_FIELDS.has(fieldKey);
}

export interface CriticalGateResult {
  allowed: boolean;
  /** Conditions non satisfaites, pour affichage dans l'arbitrage. */
  failedConditions: string[];
}

/**
 * Applique les quatre conditions cumulatives. Retourne le détail des échecs :
 * l'utilisateur doit pouvoir comprendre POURQUOI Verebona ne s'est pas permis
 * d'écrire (§4.2.9).
 */
export function checkCriticalGate(
  fieldKey: string,
  candidate: EvidenceCandidate,
): CriticalGateResult {
  const failed: string[] = [];

  // 1. Type de document autorisé
  if (!isAuthorizedForCriticalField(fieldKey, candidate.documentType)) {
    failed.push(`type de document non autorisé pour ce champ (${candidate.documentType ?? 'inconnu'})`);
  }

  // 2. Preuve précise : un extrait littéral exploitable
  if (!candidate.excerpt || candidate.excerpt.trim().length < 3) {
    failed.push('aucun extrait justificatif exploitable');
  }

  // 3. Valeur normalisée valide
  if (candidate.normalized === null || candidate.normalized === '') {
    failed.push('valeur non normalisable');
  }

  // 4. Confiance certaine
  if (!isAtLeast(candidate.confidence, 'certain')) {
    failed.push(`confiance insuffisante (${candidate.confidence})`);
  }

  return { allowed: failed.length === 0, failedConditions: failed };
}
