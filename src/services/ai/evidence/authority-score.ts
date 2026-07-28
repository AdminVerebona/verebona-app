/**
 * Score d'autorité documentaire — CDC §4.2.7.
 *
 * Le score sert au moteur de réconciliation à trancher entre deux preuves
 * contradictoires. Il est DÉTERMINISTE et VERSIONNÉ : « La matrice doit être
 * versionnée et testable. Elle ne doit pas être entièrement déléguée au LLM. »
 *
 * La matrice fine par champ (acte > compromis > saisie manuelle…) est construite
 * au LOT 3 dans `reconciliation/decision/authority-matrix.ts`. Ce module fournit
 * le score de base par type de document, utilisé dès le lot 2 pour horodater
 * correctement les preuves.
 */
export const AUTHORITY_MATRIX_VERSION = 'v1-2026-07';

/** Autorité de base par type de document canonique. Échelle 0-100. */
const BASE_AUTHORITY: Record<string, number> = {
  ACTE_AUTHENTIQUE: 100,
  ACTE_NOTARIE: 100,
  CERTIFICAT_IMMATRICULATION: 95,
  CARTE_GRISE: 95,
  MESURAGE_LEGAL: 90,
  COMPROMIS_VENTE: 85,
  CONTRAT_ASSURANCE: 80,
  CERTIFICAT_GARANTIE: 80,
  AVIS_ECHEANCE: 75,
  DPE: 75,
  DIAGNOSTIC: 70,
  CONTRAT_LOA: 70,
  CONTRAT_LLD: 70,
  FACTURE: 60,
  BON_COMMANDE: 55,
  RAPPORT_ENTRETIEN: 55,
  DEVIS: 40,
  ANNONCE_COMMERCIALE: 25,
  PHOTO: 20,
  AUTRE: 30,
};

/** Décote appliquée à une source web : moins vérifiable qu'un document. */
const WEB_LINK_PENALTY = 15;

export interface AuthorityInput {
  documentType?: string;
  documentDate?: Date | null;
  isWebLink?: boolean;
}

export function computeAuthorityScore(input: AuthorityInput): number {
  const base = BASE_AUTHORITY[(input.documentType ?? 'AUTRE').toUpperCase()] ?? BASE_AUTHORITY.AUTRE;
  const penalty = input.isWebLink ? WEB_LINK_PENALTY : 0;
  return Math.max(0, Math.min(100, base - penalty));
}

/** Expose la table pour les tests de non-régression du lot 3. */
export function getBaseAuthorityTable(): Readonly<Record<string, number>> {
  return BASE_AUTHORITY;
}
