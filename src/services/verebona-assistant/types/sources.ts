/**
 * Types de sources autorisés — CDC §19.2.
 *
 * Gemini ne peut citer qu'un `sourceId` fourni dans le contexte (§19.2, §18.4).
 * Le serveur résout ensuite titre, extrait, permissions et action d'ouverture.
 */

export const SOURCE_TYPES = [
  'asset_field',        // champ structuré d'un bien
  'document',           // document importé
  'document_extraction',// donnée extraite d'un document
  'agenda_item',        // échéance / événement
  'supplier',           // fournisseur
  'to_process_item',    // élément « À traiter »
  'help_entry',         // article d'aide produit
  'product_rule',       // règle d'offre / règle métier versionnée
] as const;

export type SourceType = (typeof SOURCE_TYPES)[number];

/** Dérivation d'une affirmation (§18.3, §19.1). Reste interne. */
export type Derivation = 'direct' | 'calculated' | 'synthesized';

/** Niveau de soutien d'une réponse (§18.3). Reste interne. */
export type SupportLevel = 'supported' | 'partial' | 'insufficient' | 'conflicting';

/**
 * Source telle que fournie au modèle (données NON fiables — §17.4).
 * L'`id` est interne et opaque pour le modèle.
 */
export interface RetrievedSource {
  id: string;                 // ex: "doc_128", "asset_42", "agenda_9"
  type: SourceType;
  title: string;
  /** Extrait borné (≤ 1 500 car. envoyé au modèle — §17.7 / §19.5). */
  content: string;
  /** Métadonnées utiles au classement/affichage (bien lié, date, statut…). */
  meta?: Record<string, string | number | boolean | null>;
  relevanceScore?: number;
}

/** Source résolue pour affichage (≤ 240 car. visibles — §19.5). */
export interface ResolvedSource {
  /**
   * Identifiant de la source retenue — « doc_128 », « asset_42 »…
   *
   * Il était perdu à la résolution. Sans lui :
   *   · une citation ne peut plus remonter à son document, alors que le §18.5
   *     en fait la condition d'une réponse vérifiable ;
   *   · l'historique du §28 ne peut pas être écrit, la colonne `source_id`
   *     étant obligatoire ;
   *   · le « Pourquoi ? » du §19.7 affiche des identifiants bruts faute de
   *     pouvoir les rapprocher des titres.
   */
  id: string;
  type: SourceType;
  typeLabel: string;
  title: string;
  linkedAssetLabel?: string | null;
  usefulDate?: string | null;
  excerpt: string;            // ≈ 240 caractères
  isAvailable: boolean;       // false = supprimée/inaccessible (§19.10)
  openAction?: import('./actions').VerebonaAction | null;
}

/** Affirmation liée à ses sources — mapping claim↔source (§19.6). */
export interface Claim {
  claimKey: string;
  text: string;
  sourceIds: string[];
  derivation: Derivation;
}
