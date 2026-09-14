/**
 * Types de base du référentiel documentaire V2 — CDC V2.0 §2, §3, §13.2.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI UN RÉFÉRENTIEL DANS LE CODE
 *
 * La V1 faisait de la base et du back-office la source de vérité. Le §13.2
 * inverse la décision : « Rubriques, Types, mapping Type → Rubrique,
 * applicabilité par famille/sous-type de bien et règles de traitement sont
 * versionnés dans le code. Aucun CRUD back-office n'est nécessaire en V2. »
 *
 * Ce choix a une conséquence directe sur ce fichier : l'invariant « 1 Type =
 * 1 Rubrique » n'est plus une contrainte d'intégrité à espérer en base, c'est
 * une propriété du type TypeScript. Un Type déclare SA rubrique ; il n'existe
 * aucune façon d'en déclarer deux. Le §13.2 exige en plus un refus au
 * build/test — assuré par `assertReferentialIntegrity()` dans `index.ts`.
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Familles de biens, alignées sur `asset_types.code` (seed `asset_types`). */
export type AssetFamily = 'IMMOBILIER' | 'VEHICULE' | 'MATERIEL_PRO' | 'OBJECT';

export const ASSET_FAMILIES: readonly AssetFamily[] = [
  'IMMOBILIER',
  'VEHICULE',
  'MATERIEL_PRO',
  'OBJECT',
] as const;

/**
 * Applicabilité d'une Rubrique ou d'un Type aux familles de biens (§3.2).
 *
 * `'ALL'` correspond à la colonne « Tous » du CDC. La nuance « Tous selon
 * pertinence » du CDC n'est pas modélisée séparément : elle décrit le
 * jugement de l'IA au moment de classer, pas une restriction d'affichage.
 * La traiter comme une troisième valeur créerait une règle de visibilité que
 * personne ne saurait appliquer de façon déterministe.
 */
export type Applicability = 'ALL' | readonly AssetFamily[];

/** Codes des huit Rubriques du §3.2. */
export type RubricCode =
  | 'PROPERTY_MANAGEMENT'
  | 'CONTRACTS_WARRANTIES_DOCS'
  | 'MAINTENANCE_WORKS'
  | 'INSURANCE_CLAIMS'
  | 'COMPLIANCE_CONTROLS'
  | 'MEDIA'
  | 'RENTAL_MANAGEMENT'
  | 'OTHER_DOCUMENTS';

export interface RubricDefinition {
  code: RubricCode;
  /** Libellé visible dans l'UX. */
  label: string;
  /** Finalité, reprise telle quelle dans le prompt d'optimisation (§11.4). */
  purpose: string;
  /** Ce que la Rubrique ne couvre PAS — décisif pour §3.4. */
  exclusions: string;
  applicability: Applicability;
  /** Ordre d'affichage croissant. */
  displayOrder: number;
  /**
   * Rubrique contextuelle : sa visibilité dépend d'un état métier et non du
   * seul référentiel (§6.2 pour « Gestion locative »).
   */
  contextual?: boolean;
  /** Rubrique de dernier recours, toujours affichée en dernier (§3.3). */
  fallback?: boolean;
}

export interface DocumentTypeDefinition {
  /** Code technique, unique sur l'ensemble du référentiel. */
  code: string;
  /** Libellé visible. Plusieurs Types peuvent partager le libellé « Autre ». */
  label: string;
  /** Rubrique propriétaire. Unique par construction (§2.2). */
  rubric: RubricCode;
  applicability: Applicability;
  /** Finalité du document, utilisée par le prompt (§3.4, §11.4). */
  purpose: string;
  /**
   * Type « Autre » de la Rubrique (§2.2) : réservé au choix utilisateur,
   * jamais proposé ni sélectionné par l'IA (§5.2, DOC-08).
   */
  userOnly?: boolean;
}
