/**
 * Source de tarifs — CDC Assistant §15.9.
 *
 * Le fournisseur est substituable (§5.2) : sa grille tarifaire l'est aussi.
 * Un changement de fournisseur consiste à écrire un nouvel adaptateur, pas à
 * modifier le calcul des coûts.
 */
export interface ModelPrice {
  provider: string;
  model: string;
  /** Micro-unités de devise par token d'entrée. */
  inputMicros: number;
  /** Micro-unités de devise par token de sortie. */
  outputMicros: number;
  currency: string;
  /** Référence du SKU fournisseur, pour rapprochement de facture. */
  sourceReference?: string;
}

export interface PricingSource {
  readonly provider: string;
  readonly name: string;
  isConfigured(): boolean;
  /** Relève les tarifs des modèles demandés. Les absents ne sont pas renvoyés. */
  fetchPrices(models: string[]): Promise<ModelPrice[]>;
}
