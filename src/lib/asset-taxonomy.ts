/**
 * Classement des biens : Famille de bien → Catégorie de bien.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * SOURCE UNIQUE
 *
 * Les listes de sous-types étaient recopiées dans `AssetFormDialog` et
 * `AssetDetailsTab`, et divergeaient déjà du besoin (« Garage », « Local
 * commercial », pas d'Immeuble ni de Mobil-home, pas de Camping-car ni de
 * Bateau). Elles vivent désormais ici.
 *
 *   Famille        Catégories
 *   ─────────────  ───────────────────────────────────────────────────────
 *   Véhicule       Voiture ; Moto ; Vélo ; Camping-car ; Bateau ; Camion
 *   Immobilier     Maison ; Appartement ; Immeuble ; Terrain ; Garage/box ;
 *                  Mobil-home ; Local professionnel/commercial
 *   Objet          Tech / IT / Électronique ; Loisir / Sport ;
 *                  Maison & équipement
 *
 * ── STOCKAGE (INCHANGÉ) ───────────────────────────────────────────────────
 *
 *   - Famille           → `assets.category`   (VEHICULE | IMMOBILIER | OBJECT)
 *   - Catégorie Immo/Véhicule → `assets.subtype` (libellé, ex. « Maison »)
 *   - Catégorie Objet   → `assets.object_category` (OBJECT_CATEGORY_*)
 *
 * Le schéma n'est pas modifié : l'API, les exports, l'IA et le référentiel
 * documentaire V2 lisent déjà ces colonnes. Les deux libellés renommés sont
 * migrés en base (0138) et reconnus en lecture (`normalizeAssetCategory`).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { OBJECT_CATEGORY_LABELS, type ObjectCategory } from '@/types/domain';

export type AssetFamilyCode = 'VEHICULE' | 'IMMOBILIER' | 'OBJECT';

export interface AssetCategoryOption {
  /** Valeur enregistrée (subtype, ou code OBJECT_CATEGORY_* pour Objet). */
  value: string;
  label: string;
}

export interface AssetFamilyDefinition {
  code: AssetFamilyCode;
  label: string;
  categories: AssetCategoryOption[];
}

const libelles = (values: string[]): AssetCategoryOption[] => values.map((v) => ({ value: v, label: v }));

/** Familles proposées, dans l'ordre d'affichage. */
export const ASSET_FAMILIES: AssetFamilyDefinition[] = [
  {
    code: 'VEHICULE',
    label: 'Véhicule',
    categories: libelles(['Voiture', 'Moto', 'Vélo', 'Camping-car', 'Bateau', 'Camion']),
  },
  {
    code: 'IMMOBILIER',
    label: 'Immobilier',
    categories: libelles([
      'Maison',
      'Appartement',
      'Immeuble',
      'Terrain',
      'Garage/box',
      'Mobil-home',
      'Local professionnel/commercial',
    ]),
  },
  {
    code: 'OBJECT',
    label: 'Objet',
    categories: (Object.keys(OBJECT_CATEGORY_LABELS) as ObjectCategory[]).map((code) => ({
      value: code,
      label: OBJECT_CATEGORY_LABELS[code],
    })),
  },
];

const FAMILY_BY_CODE = new Map(ASSET_FAMILIES.map((f) => [f.code, f]));

export function getAssetFamily(code: string | null | undefined): AssetFamilyDefinition | undefined {
  return code ? FAMILY_BY_CODE.get(code as AssetFamilyCode) : undefined;
}

/** Libellé de famille (« Véhicule »…), repli sur le code. */
export function assetFamilyLabel(code: string | null | undefined): string {
  if (!code) return '';
  return getAssetFamily(code)?.label ?? LEGACY_FAMILY_LABELS[code] ?? code;
}

/** Familles anciennes, encore possibles en base mais plus proposées. */
const LEGACY_FAMILY_LABELS: Record<string, string> = {
  MATERIEL_PRO: 'Matériel pro',
  AUTRE: 'Autre',
};

/** Catégories d'une famille. Vide pour une famille inconnue. */
export function getAssetCategories(familyCode: string | null | undefined): AssetCategoryOption[] {
  return getAssetFamily(familyCode)?.categories ?? [];
}

/** Anciens libellés → libellés actuels (données et saisies antérieures). */
export const LEGACY_CATEGORY_ALIASES: Record<string, string> = {
  garage: 'Garage/box',
  box: 'Garage/box',
  'local commercial': 'Local professionnel/commercial',
  'local professionnel': 'Local professionnel/commercial',
  'mobil home': 'Mobil-home',
  mobilhome: 'Mobil-home',
  'camping car': 'Camping-car',
  campingcar: 'Camping-car',
};

/** Normalise une catégorie Immo/Véhicule saisie ou stockée sous un ancien libellé. */
export function normalizeAssetCategory(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return LEGACY_CATEGORY_ALIASES[trimmed.toLowerCase()] ?? trimmed;
}

/** Libellé de catégorie d'un bien, quelle que soit sa famille. */
export function assetCategoryLabel(asset: {
  category: string;
  subtype?: string | null;
  objectCategory?: string | null;
}): string | null {
  if (asset.category === 'OBJECT') {
    return asset.objectCategory
      ? OBJECT_CATEGORY_LABELS[asset.objectCategory as ObjectCategory] ?? asset.objectCategory
      : null;
  }
  return normalizeAssetCategory(asset.subtype);
}

/**
 * Options d'un sélecteur de catégorie : celles de la famille, plus la valeur
 * courante si elle n'y figure pas (catégorie ancienne comme « Studio ») —
 * pour ne jamais effacer silencieusement ce qui est enregistré.
 */
export function categoryOptionsWithCurrent(
  familyCode: string | null | undefined,
  current: string | null | undefined,
): AssetCategoryOption[] {
  const options = getAssetCategories(familyCode);
  const normalized = familyCode === 'OBJECT' ? current : normalizeAssetCategory(current);
  if (normalized && !options.some((o) => o.value === normalized)) {
    return [...options, { value: normalized, label: normalized }];
  }
  return options;
}
