/**
 * Statuts d'un bien — LISTE OFFICIELLE.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * Carte #849 (arbitrages PO du 25/11/2026) — DEUX STATUTS, RIEN D'AUTRE :
 *
 *   EN_SERVICE  bien actif (valeur par défaut) : modifiable, compté dans le
 *               quota de biens ;
 *   TRANSMIS    hors portefeuille actif (masqué par défaut, filtre « Biens
 *               transmis ») : CONSULTATION SEULE stricte (documents,
 *               Opérations, historique, exports lisibles), HORS quota de
 *               biens. Seules actions : « Remettre en service » et
 *               « Supprimer définitivement ».
 *
 * VENDU et ARCHIVED (lot 32, PO-Q11) sont RETIRÉS du référentiel métier :
 * la vente reste une Opération de cession (date / prix / justificatifs si
 * connus), sans statut distinct ; aucun bouton Archiver. La migration 2013
 * convertit VENDU → TRANSMIS et ARCHIVED → TRANSMIS (anciens DETRUIT
 * compris, convertis en ARCHIVED par 0278) et TRACE l'ancien statut
 * (`canonical_field_writes`), sans faux événement.
 *
 * Anciennes valeurs (lisibles, jamais proposées) : EN_MAINTENANCE,
 * HORS_SERVICE, EN_PANNE, EN_REPARATION, INACTIF → EN_SERVICE ; VENDU,
 * ARCHIVED, DETRUIT → TRANSMIS.
 *
 * Les statuts des ÉQUIPEMENTS d'un bien (`EQUIPMENT_STATUSES`) ne sont pas
 * concernés.
 *
 * Module PUR : importable côté client.
 * ══════════════════════════════════════════════════════════════════════════
 */

export const ASSET_STATUSES = ['EN_SERVICE', 'TRANSMIS'] as const;
export type AssetStatus = typeof ASSET_STATUSES[number];

/** Valeur par défaut de la colonne (`assets.status`). */
export const DEFAULT_ASSET_STATUS: AssetStatus = 'EN_SERVICE';

/** #849 : seul statut compté dans le quota de biens (avec `deleted_at IS NULL`). */
export const QUOTA_COUNTED_ASSET_STATUS: AssetStatus = 'EN_SERVICE';

export const ASSET_STATUS_LABELS: Readonly<Record<AssetStatus, string>> = {
  EN_SERVICE: 'En service',
  TRANSMIS: 'Transmis',
};

/**
 * Biens SORTIS du portefeuille actif : masqués par défaut des listes et des
 * compteurs de l'accueil, exclus de la résolution standard de l'assistant.
 */
export const OUT_OF_PORTFOLIO_ASSET_STATUSES = ['TRANSMIS'] as const;

/** Statuts en consultation seule (fiche non modifiable). #849 : TRANSMIS. */
const READ_ONLY_ASSET_STATUSES = ['TRANSMIS'] as const;

/** Anciennes valeurs → statut officiel (migrations 0278 et 2013, lecture des données non migrées). */
export const LEGACY_ASSET_STATUS_MAP: Readonly<Record<string, AssetStatus>> = {
  EN_MAINTENANCE: 'EN_SERVICE',
  HORS_SERVICE: 'EN_SERVICE',
  EN_PANNE: 'EN_SERVICE',
  EN_REPARATION: 'EN_SERVICE',
  INACTIF: 'EN_SERVICE',
  VENDU: 'TRANSMIS',
  ARCHIVED: 'TRANSMIS',
  DETRUIT: 'TRANSMIS',
};

/**
 * #849 — condition SQL des biens COMPTÉS dans le quota de biens : non
 * supprimés ET en service. Un bien TRANSMIS n'en consomme pas (ses fichiers
 * restent comptés dans les quotas documents / stockage). `alias` facultatif.
 */
export function quotaCountedAssetSql(alias?: string): string {
  const c = alias ? `${alias}.` : '';
  return `(${c}deleted_at IS NULL AND ${c}status = 'EN_SERVICE')`;
}

/** #849 — message du refus d'écriture sur un bien TRANSMIS (code `ASSET_READ_ONLY`). */
export const ASSET_READ_ONLY_MESSAGE =
  'Ce bien est transmis : il est en consultation seule. Remettez-le en service pour le modifier.';

/**
 * #849 — condition SQL « bien modifiable » (écritures, rattachements) : ni
 * transmis, ni verrouillé par l'offre. `alias` : alias SQL de `assets`.
 */
export function assetWritableSql(alias: string): string {
  return `(${alias}.status IS DISTINCT FROM 'TRANSMIS' AND COALESCE(${alias}.lock_state, 'NONE') = 'NONE')`;
}

/**
 * #849 — condition SQL « fiche ouvrable en lecture » : un bien TRANSMIS se
 * consulte ; seul le verrou de l'offre empêche l'ouverture.
 */
export function assetOpenableSql(alias: string): string {
  return `(COALESCE(${alias}.lock_state, 'NONE') = 'NONE')`;
}

function isAssetStatus(value: unknown): value is AssetStatus {
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

/** Variante du badge (composant `Badge` existant) : actif ou transmis. */
export function assetStatusBadgeVariant(value: string | null | undefined): 'active' | 'sold' | 'secondary' {
  return normalizeAssetStatus(value) === 'EN_SERVICE' ? 'active' : 'sold';
}
