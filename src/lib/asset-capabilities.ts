/**
 * Fonctions offertes selon la catégorie d'un bien — Centre d'aide GAP-04 / GAP-08.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE SEULE LISTE PAR FONCTION
 *
 * Trois listes divergentes décidaient des mêmes choses :
 *   - l'onglet « Pièces / Équipements » de la fiche (`assets/[id]/page.tsx`)
 *     admettait l'Immeuble, que les routes API refusaient ensuite ;
 *   - `assetSupportsStructuralFeatures` (routes pièces / équipements, agenda,
 *     documents) comparait « local commercial » en sous-chaîne : le libellé
 *     actuel « Local professionnel/commercial » ne passait nulle part ;
 *   - le CIL acceptait Immeuble et Mobil-home (préparation) et toute la
 *     famille IMMOBILIER (génération), alors que la cible produit est
 *     « Maison + Appartement uniquement ».
 *
 * Ce module est la seule source ; il ne dépend que de `asset-category-legacy`
 * (sans dépendance — il est importé par `types/domain`, que `asset-taxonomy`
 * importe lui-même). Les catégories sont
 * celles de `ASSET_FAMILIES` (lib/asset-taxonomy) ; un test vérifie que
 * chaque entrée ci-dessous y figure.
 *
 * Les libellés anciens encore présents en base (« Studio », « Villa »,
 * « Propriété »…) restent reconnus pour ne pas retirer une fonction à un
 * bien existant.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { capabilityCategoryOf } from './asset-category-legacy';

/** Catégories Immobilier (libellés actuels) qui gèrent pièces et équipements. */
export const ROOM_CAPABLE_CATEGORIES = [
  'Maison',
  'Appartement',
  'Immeuble',
  'Local professionnel/commercial',
] as const;

/** Catégories Immobilier (libellés actuels) éligibles au CIL — Maison + Appartement. */
export const CIL_ELIGIBLE_CATEGORIES = ['Maison', 'Appartement'] as const;

/**
 * Libellés anciens (renommés ou conservés) rattachés à une catégorie actuelle :
 * table unique `asset-category-legacy` (lot 30), partagée avec la taxonomie.
 */
const canonical = capabilityCategoryOf;

function matches(list: readonly string[], subtype: string | null | undefined): boolean {
  const c = canonical(subtype);
  if (!c) return false;
  const lower = c.toLowerCase();
  return list.some((v) => v.toLowerCase() === lower);
}

export interface AssetKind {
  category: string;
  subtype?: string | null;
}

/** Le bien gère-t-il des pièces et des équipements ? */
export function assetSupportsRooms(asset: AssetKind): boolean {
  return asset.category === 'IMMOBILIER' && matches(ROOM_CAPABLE_CATEGORIES, asset.subtype);
}

/** Le bien est-il éligible au Carnet d'information du logement (CIL) ? */
export function isCilEligible(asset: AssetKind): boolean {
  return asset.category === 'IMMOBILIER' && matches(CIL_ELIGIBLE_CATEGORIES, asset.subtype);
}

/** Message commun aux refus d'éligibilité CIL (API et interface). */
export const CIL_NOT_ELIGIBLE_MESSAGE =
  "Le Carnet d'information du logement est disponible pour les maisons et les appartements uniquement.";

// ── Immatriculation (lot 32, ticket L32-1) ────────────────────────────────────

/**
 * Catégories Véhicule SANS immatriculation (non motorisées) : un numéro relevé
 * sur un document de vélo (marquage antivol, numéro de cadre) n'est pas une
 * plaque. Les champs d'immatriculation n'y sont ni proposés (« À traiter »),
 * ni écrits par une origine automatique, ni affichés sur la fiche.
 * Libellés comparés sans casse ni accents ; « VTT » et « Trottinette »
 * (saisies libres anciennes) sont reconnus.
 */
export const UNREGISTERED_VEHICLE_CATEGORIES = ['Vélo', 'VTT', 'Trottinette'] as const;

const sansAccent = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

/** Le bien (véhicule) porte-t-il une immatriculation ? Faux hors famille Véhicule. */
export function assetHasRegistration(asset: AssetKind): boolean {
  if ((asset.category ?? '').trim().toUpperCase() !== 'VEHICULE') return false;
  const c = canonical(asset.subtype);
  if (!c) return true;
  const k = sansAccent(c);
  return !UNREGISTERED_VEHICLE_CATEGORIES.some((v) => sansAccent(v) === k);
}
