/**
 * Statuts d'un bien — LISTE OFFICIELLE (décision PO du 07/10/2026, Q11).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * « EN SERVICE, ARCHIVED, TRANSMIS, VENDU (PAS BESOIN DE MAINTENANCE ETC) »
 *
 * Trois listes divergeaient : l'API acceptait EN_PANNE, EN_REPARATION, VENDU,
 * DETRUIT, INACTIF, que la base refusait (contrainte 0121 : EN_SERVICE,
 * EN_MAINTENANCE, HORS_SERVICE, ARCHIVED, TRANSMIS) ; l'interface affichait
 * les uns, À traiter proposait les autres selon la contrainte lue en base.
 *
 * Désormais une seule liste, ici, pour l'API, l'interface (badges, filtres),
 * À traiter (ASSET-STATUS), les exports et l'assistant ; la base la reprend
 * (migration 0278, qui convertit les anciennes valeurs puis pose la
 * contrainte) :
 *
 *   EN_SERVICE  bien actif (valeur par défaut) ;
 *   VENDU       vendu : sorti du portefeuille actif ;
 *   TRANSMIS    transmis (parcours de transmission) : sorti du portefeuille ;
 *   ARCHIVED    archivé : sorti du portefeuille, consultation seule.
 *
 * Anciennes valeurs (lisibles, jamais proposées) : EN_MAINTENANCE,
 * HORS_SERVICE, EN_PANNE, EN_REPARATION, INACTIF → EN_SERVICE (un bien en
 * panne ou en réparation est toujours le sien et en usage) ; DETRUIT →
 * ARCHIVED (il n'existe plus mais son historique reste consultable).
 *
 * Les statuts des ÉQUIPEMENTS d'un bien (`EQUIPMENT_STATUSES` : en service,
 * en panne, en réparation, inactif) ne sont pas concernés.
 *
 * Module PUR : importable côté client.
 * ══════════════════════════════════════════════════════════════════════════
 */

export const ASSET_STATUSES = ['EN_SERVICE', 'VENDU', 'TRANSMIS', 'ARCHIVED'] as const;
export type AssetStatus = typeof ASSET_STATUSES[number];

/** Valeur par défaut de la colonne (`assets.status`). */
export const DEFAULT_ASSET_STATUS: AssetStatus = 'EN_SERVICE';

export const ASSET_STATUS_LABELS: Readonly<Record<AssetStatus, string>> = {
  EN_SERVICE: 'En service',
  VENDU: 'Vendu',
  TRANSMIS: 'Transmis',
  ARCHIVED: 'Archivé',
};

/**
 * Biens SORTIS du portefeuille actif : masqués par défaut des listes et des
 * compteurs de l'accueil, exclus de la résolution standard de l'assistant.
 */
export const OUT_OF_PORTFOLIO_ASSET_STATUSES = ['VENDU', 'TRANSMIS', 'ARCHIVED'] as const;

/** Statuts en consultation seule (fiche non modifiable). VENDU reste modifiable. */
export const READ_ONLY_ASSET_STATUSES = ['TRANSMIS', 'ARCHIVED'] as const;

/** Anciennes valeurs → statut officiel (migration 0278, lecture des données non migrées). */
export const LEGACY_ASSET_STATUS_MAP: Readonly<Record<string, AssetStatus>> = {
  EN_MAINTENANCE: 'EN_SERVICE',
  HORS_SERVICE: 'EN_SERVICE',
  EN_PANNE: 'EN_SERVICE',
  EN_REPARATION: 'EN_SERVICE',
  INACTIF: 'EN_SERVICE',
  DETRUIT: 'ARCHIVED',
};

export function isAssetStatus(value: unknown): value is AssetStatus {
  return typeof value === 'string' && (ASSET_STATUSES as readonly string[]).includes(value);
}

/** Statut officiel d'une valeur stockée (ancienne valeur convertie, vide → EN_SERVICE). */
export function normalizeAssetStatus(value: string | null | undefined): AssetStatus {
  const v = value?.trim().toUpperCase();
  if (!v) return DEFAULT_ASSET_STATUS;
  if (isAssetStatus(v)) return v;
  return LEGACY_ASSET_STATUS_MAP[v] ?? DEFAULT_ASSET_STATUS;
}

export function assetStatusLabel(value: string | null | undefined): string {
  return ASSET_STATUS_LABELS[normalizeAssetStatus(value)];
}

export function isOutOfPortfolioStatus(value: string | null | undefined): boolean {
  return (OUT_OF_PORTFOLIO_ASSET_STATUSES as readonly string[]).includes(normalizeAssetStatus(value));
}

export function isReadOnlyAssetStatus(value: string | null | undefined): boolean {
  return (READ_ONLY_ASSET_STATUSES as readonly string[]).includes(normalizeAssetStatus(value));
}

/** Variante du badge (composant `Badge` existant) : actif, cédé, ou neutre. */
export function assetStatusBadgeVariant(value: string | null | undefined): 'active' | 'sold' | 'secondary' {
  const s = normalizeAssetStatus(value);
  if (s === 'EN_SERVICE') return 'active';
  if (s === 'VENDU' || s === 'TRANSMIS') return 'sold';
  return 'secondary';
}
