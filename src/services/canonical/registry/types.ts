/**
 * Registre canonique des champs d'un bien — types publics (CDC 15 §5 REG-01/02, §12).
 *
 * Ce fichier ne contient QUE des types : T1, T2, T3, T4, les exports et
 * `CanonicalAssetView` (agent B) s'appuient dessus. Toute évolution doit
 * rester rétro-compatible.
 */

/**
 * Famille de bien, telle que stockée dans `assets.category`
 * (voir `src/lib/asset-taxonomy.ts`). Les codes historiques `OBJET`
 * (assistant), `MATERIEL_PRO` et `AUTRE` sont ramenés à `OBJECT` par
 * `toAssetFamily()`.
 */
export type AssetFamily = 'IMMOBILIER' | 'VEHICULE' | 'OBJECT';

export const ASSET_FAMILY_CODES: readonly AssetFamily[] = ['IMMOBILIER', 'VEHICULE', 'OBJECT'];

/**
 * Type de valeur canonique.
 * - `money_eur` : montant en euros (nombre décimal, 2 décimales max) — D-09 ;
 * - `money_cents` : montant en centimes (entier), réservé aux clés `*Cents` ;
 * - `date` : chaîne ISO `AAAA-MM-JJ`.
 */
export type CanonicalValueType =
  | 'string'
  | 'number'
  | 'money_eur'
  | 'money_cents'
  | 'date'
  | 'boolean'
  | 'enum'
  | 'json';

/** Transformation appliquée pour recopier la valeur canonique dans une colonne miroir (D-10). */
export type MirrorTransform = 'eur_to_cents' | 'identity' | 'date' | 'integer';

export interface MirrorColumn {
  table: 'assets';
  /** Nom SQL de la colonne (snake_case), ex. `purchase_price_cents`. */
  column: string;
  transform?: MirrorTransform;
}

/** Nature d'un effet agenda : fait passé (HISTORICAL) ou échéance future (DEADLINE). */
export type AgendaNature = 'HISTORICAL' | 'DEADLINE';

/** Type métier d'un événement agenda (clé de `EVENT_CATALOG`). */
export type EventBusinessType =
  | 'purchase'
  | 'maintenance'
  | 'repair'
  | 'inspection'
  | 'insurance'
  | 'warranty'
  | 'contract'
  | 'lease'
  | 'dpe'
  | 'registration'
  | 'claim'
  | 'sale';

export interface AgendaEffect {
  nature: AgendaNature;
  businessType: EventBusinessType;
  /**
   * Récurrence par défaut ÉVENTUELLE (RRULE simplifiée, ex. `FREQ=YEARLY`).
   * Indicative : T4 ne l'applique que si la source la démontre (T4-06, §13).
   */
  recurrence?: string;
}

export interface CompletenessRule {
  /** Information attendue sur la fiche (« information manquante » sinon). */
  required: boolean;
  /** Familles pour lesquelles la règle s'applique (toutes celles du champ si absent). */
  families?: AssetFamily[];
}

/** Cible d'un fait (CDC §5, targetType). Les champs du registre visent un bien. */
export type CanonicalTargetType = 'ASSET' | 'EQUIPMENT' | 'ROOM' | 'DOCUMENT' | 'AGENDA' | 'GENERIC_KNOWLEDGE';

export interface CanonicalFieldDef {
  /** Clé canonique stable, ex. `acquisitionDate`. */
  key: string;
  /** Libellé français. */
  label: string;
  families: AssetFamily[];
  valueType: CanonicalValueType;
  /** Unité canonique (`EUR`, `cents`, `km`, `m2`, `kWh/m2/an`, `kg CO2/m2/an`…). */
  unit?: string;
  /** Valeurs admises pour `enum` (codes stockés). */
  enumValues?: readonly string[];
  /** Libellés des valeurs d'enum (code → libellé), reconnus aussi en entrée. */
  enumLabels?: Readonly<Record<string, string>>;
  /** Nombre entier attendu (`number` seulement). */
  integer?: boolean;
  /** Bornes admises (`number`, `money_*`). */
  range?: { min?: number; max?: number };
  /**
   * Alias historiques ou bruts (variantes de keyCharacteristics, clés
   * d'extraction, clés de l'assistant) résolus vers `key`. Jamais écrits.
   */
  aliases: string[];
  /**
   * Formulations reconnues par l'assistant dans un message (sans accents,
   * minuscules) — reprises de `verebona-assistant/commands/asset-fields.ts`.
   * Ce ne sont pas des clés : elles ne passent pas par `resolveAlias`.
   */
  assistantPhrases?: string[];
  /**
   * Unité de la valeur portée par un alias quand elle diffère de l'unité
   * canonique (ex. `purchasePriceCents` → `cents` pour `acquisitionPrice`).
   * À transmettre à `normalizeValue(..., { sourceUnit })`.
   */
  aliasUnits?: Readonly<Record<string, string>>;
  /** Colonnes historiques synchronisées depuis keyCharacteristics (D-10). */
  mirrorColumns?: MirrorColumn[];
  agendaEffect?: AgendaEffect;
  assistantReadable: boolean;
  assistantWritable: boolean;
  completenessRule?: CompletenessRule;
  /**
   * Donnée personnelle ou sensible : masquée dans les traces, les journaux et
   * tout ce qui est transmis au modèle. Elle reste restituable à son
   * propriétaire par une réponse DÉTERMINISTE du serveur (lot 29, ticket 8a).
   */
  sensitive?: boolean;
  /**
   * Restitution composée (lot 29, ticket 8a §G) : quand ce champ est demandé,
   * la réponse déterministe assemble ces champs, dans cet ordre — clés d'un
   * même groupe jointes par une espace, groupes séparés par une virgule, champs
   * vides omis (ex. adresse complète : adresse, complément, code postal + ville, pays).
   */
  composedDisplay?: ReadonlyArray<ReadonlyArray<string>>;
  /** Cible par défaut du fait (ASSET si absent). */
  targetType?: CanonicalTargetType;
  /**
   * Cibles admises (lot 13, T1-04) : `['ASSET']` par défaut. Un champ
   * déclaré pour `EQUIPMENT` ou `ROOM` peut porter un fait ciblé sur un
   * équipement ou une pièce ; jamais rabattu sur le bien parent.
   * Prime sur `targetType` (historique, cible unique).
   */
  targetTypes?: CanonicalTargetType[];
  /**
   * Saisie UNIQUEMENT (décision PO D-D, lot 20) : la valeur n'est jamais
   * inférée par l'IA. Absent du FIELD_CATALOG des prompts T1, jamais
   * projetée comme fait canonique, jamais écrite comme preuve ni appliquée
   * par T3 ; `writeCanonicalAssetField` refuse toute origine autre que
   * USER / ADMIN / IMPORT (`INPUT_ONLY_FIELD`). Ex. prix et surface d'annonce.
   */
  inputOnly?: boolean;
  /** Section de la fiche (`AssetDetailsTab`) — information d'affichage. */
  section?: string;
  /**
   * Capacité de CATÉGORIE requise (lot 32, L32-1), en plus de la famille :
   * `registration` — le bien doit porter une immatriculation
   * (`assetHasRegistration`, `@/lib/asset-capabilities` : pas un vélo).
   * Hors capacité, le champ n'est ni proposé ni écrit automatiquement
   * (`isFieldApplicableToAsset`).
   */
  requiresCapability?: 'registration';
}

/** Résolution détaillée d'une clé brute. */
export interface AliasResolution {
  key: string;
  /** Unité portée par la clé brute, si différente de l'unité canonique. */
  sourceUnit?: string;
  /** true si la clé brute est la clé canonique elle-même. */
  canonical: boolean;
}

/** Catégorie d'une clé volontairement absente du registre. */
export type ExclusionKind =
  /** Donnée technique ou d'affichage (alertes, historiques, origines). */
  | 'TECHNICAL'
  /** Colonne d'identité du bien, hors keyCharacteristics (nom, famille, statut). */
  | 'IDENTITY_COLUMN'
  /** Fait porté par le document, pas par le bien (montant, fournisseur…). */
  | 'DOCUMENT'
  /** Informations complémentaires des exports (D-12). */
  | 'ADDITIONAL_INFO'
  /** Clé rencontrée mais non classée : question ouverte (voir README). */
  | 'UNCLASSIFIED';

export interface ExcludedKey {
  key: string;
  kind: ExclusionKind;
  reason: string;
}

export type NormalizeResult = { ok: true; value: unknown } | { ok: false; reason: string };

export interface NormalizeOptions {
  /**
   * Unité de la valeur brute quand elle diffère de l'unité canonique
   * (`cents`, `EUR`, `k€`, `miles`, `ha`…). Seule conversion autorisée (T1-03).
   */
  sourceUnit?: string;
}

/* ── Catalogues (T4-01, T4-04, T4-13) ─────────────────────────────────────── */

/** Catégorie d'affichage accueil proposée par défaut (T4-02 : selon nature, pas selon origine). */
export type DefaultHomeCategory = 'action' | 'information';

export interface EventCatalogEntry {
  businessType: EventBusinessType;
  label: string;
  /** Natures possibles pour ce type d'événement. */
  natures: AgendaNature[];
  /** Catégorie accueil par nature (HISTORICAL → information, D-14). */
  homeCategory: Partial<Record<AgendaNature, DefaultHomeCategory | 'selon_evenement'>>;
  /** Un événement historique n'est jamais notifié (D-14). */
  notifiable: Partial<Record<AgendaNature, boolean>>;
  /** Clés canoniques qui produisent cet événement. */
  fieldKeys: string[];
  families: AssetFamily[];
  /** Intitulé type de l'événement (« Achat », « Contrôle technique »…). */
  titleTemplate: string;
  /** Remarque métier (ex. D-15 : sinistre → historique seul). */
  note?: string;
  /** Codes historiques équivalents (`EVENT_TYPES`, `DEADLINE_TYPES`…). */
  aliases?: string[];
}

/** Autorité d'un type documentaire pour créer un événement sans validation (T4-04). */
export type DocumentAuthority = 'AUTHORITATIVE' | 'SUPPORTING' | 'WEAK';

/** Forme de preuve d'exécution acceptée pour clore une échéance (T4-13). */
export interface CompletionProofShape {
  /** Code court de la forme de preuve. */
  code: string;
  /** Description de ce qui doit figurer dans le document. */
  description: string;
  /** Statut produit quand cette forme est présente (T4-12 : jamais déduit de la seule date). */
  establishes: 'completed' | 'not_proven';
  /** Types d'événement concernés (tous ceux du document si absent). */
  businessTypes?: EventBusinessType[];
}

export interface DocumentCatalogEntry {
  /** Code de type documentaire (celui de `AUTHORIZED_CREATION_TYPES` et du référentiel). */
  code: string;
  label: string;
  authority: DocumentAuthority;
  /** Autorise la création automatique d'un événement agenda (T4-04). */
  mayCreateAgenda: boolean;
  /** Types d'événement que ce document peut créer ou prouver. */
  businessTypes: EventBusinessType[];
  /** Formes de preuve reconnues (T4-13) ; vide = ne prouve jamais une exécution. */
  completionProofs: CompletionProofShape[];
  families: AssetFamily[];
  /** Alias de codes documentaires rencontrés (anciens codes, variantes). */
  aliases?: string[];
  /**
   * Création automatique LIMITÉE à ces types et natures d'événement
   * (décision PO D-B, lot 20 : un constat de sinistre crée le sinistre
   * HISTORIQUE, rien d'autre — toute autre échéance qu'il porte est
   * proposée). Absent : tout événement que le document produit.
   */
  creationScope?: { businessTypes: EventBusinessType[]; natures: AgendaNature[] };
}

/* ── DTO pour les prompts (R6) ────────────────────────────────────────────── */

export interface PromptFieldDTO {
  key: string;
  label: string;
  valueType: CanonicalValueType;
  unit?: string;
  enumValues?: string[];
  agenda?: { nature: AgendaNature; businessType: EventBusinessType };
  /**
   * Cibles admises DANS LE CONTEXTE du prompt : ASSET seulement si le champ
   * s'applique à la famille du bien connu ; EQUIPMENT / ROOM si déclarés.
   */
  targets: CanonicalTargetType[];
  assistantWritable: boolean;
}

export interface PromptEventDTO {
  businessType: EventBusinessType;
  label: string;
  natures: AgendaNature[];
  fieldKeys: string[];
}

export interface PromptDocumentDTO {
  code: string;
  label: string;
  authority: DocumentAuthority;
  mayCreateAgenda: boolean;
  businessTypes: EventBusinessType[];
  completionProofs: { code: string; description: string; establishes: 'completed' | 'not_proven' }[];
}

export interface PromptCatalogDTO {
  version: string;
  family: AssetFamily | null;
  fields: PromptFieldDTO[];
  events: PromptEventDTO[];
  documents: PromptDocumentDTO[];
}

/* ── Projection officielle pour la LECTURE T2 (lot 30, AC19 / AC20) ───────── */

/**
 * Champ lisible par l'assistant T2, tel que le voient le matcher déterministe
 * ET le FIELD_CATALOG de UNDERSTAND. Dérivé de `CanonicalFieldDef` seul.
 */
export interface T2ReadFieldDTO {
  key: string;
  label: string;
  families: AssetFamily[];
  /** Cibles admises (`fieldTargetTypes`). */
  targets: CanonicalTargetType[];
  valueType: CanonicalValueType;
  unit?: string;
  enumValues?: string[];
  enumLabels?: Record<string, string>;
  /** Donnée sensible : lisible par son propriétaire, masquée dans les traces. */
  sensitive: boolean;
  /**
   * Vocabulaire OFFICIEL du champ pour T2 (sans accent, minuscules) : libellé
   * puis `assistantPhrases`. Les `aliases` (clés techniques ou historiques)
   * n'en font JAMAIS partie (AC20).
   */
  phrases: string[];
}

export interface T2ReadCatalogDTO {
  version: string;
  fields: T2ReadFieldDTO[];
}
