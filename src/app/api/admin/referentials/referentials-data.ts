/**
 * Référentiels — CDC Back-Office V1 §9 (REFD-001 à REFD-006).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * PHOTOGRAPHIE COURANTE, EN LECTURE SEULE
 *
 * Les référentiels sont versionnés dans le code (§22) et restent la source de
 * vérité. Le BO les consulte et affiche le nombre d'utilisations actuel de
 * chaque valeur (REFD-003), sans seuil « rarement utilisé » (REFD-004), sans
 * historique (REFD-005) et sans aucune écriture (REFD-006).
 *
 *   · Familles et sous-catégories de biens : classement du code
 *     (`lib/asset-taxonomy.ts`) ; utilisations = biens non supprimés, comptés
 *     sur les colonnes réellement écrites par l'application
 *     (`assets.category`, `assets.subtype`, `assets.object_category`).
 *     Les tables `asset_types` / `asset_type_subcategories` ne sont plus
 *     lues : alimentées par un seed manuel, elles étaient vides en preprod
 *     (onglets « Familles » et « Sous-catégories » vides, 2 oct. 2026), et
 *     `assets.asset_type_id` n'est pas renseigné par la création de bien.
 *     Valeurs présentes en base mais absentes du classement (familles
 *     anciennes, « Studio »…) : listées « Inactif », pour rester visibles.
 *   · Rubriques et Types de documents : référentiel V2 du code
 *     (`lib/referential/v2`) ; utilisations = documents non supprimés classés.
 *   · Règles et mappings : applicabilité par famille (code) et mappings de
 *     taxonomie documentaire (`document_taxonomy_mappings`).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';
import {
  ASSET_FAMILIES,
  DOCUMENT_TYPES,
  REFERENTIAL_VERSION,
  RUBRICS,
  getRubric,
  type Applicability,
} from '@/lib/referential/v2';
import { ASSET_FAMILIES as TAXONOMY, assetFamilyLabel, normalizeAssetCategory } from '@/lib/asset-taxonomy';

export interface ReferentialRow {
  code: string;
  label: string;
  /** Statut actif/inactif lorsqu'il existe (REFD-002), sinon `null`. */
  active: boolean | null;
  /** Nombre d'utilisations courant ; `null` si non mesurable. */
  usage: number | null;
  /** Informations complémentaires de lecture (parent, rubrique, familles…). */
  details: string | null;
}

export interface ReferentialsSnapshot {
  version: string;
  assetFamilies: ReferentialRow[];
  assetSubcategories: ReferentialRow[];
  rubrics: ReferentialRow[];
  documentTypes: ReferentialRow[];
  applicability: ReferentialRow[];
  mappings: ReferentialRow[];
}

const FAMILY_LABELS: Record<string, string> = {
  IMMOBILIER: 'Immobilier',
  VEHICULE: 'Véhicule',
  MATERIEL_PRO: 'Matériel professionnel',
  OBJECT: 'Objet',
};

export function applicabilityLabel(applicability: Applicability): string {
  if (applicability === 'ALL') return 'Toutes les familles';
  return applicability.map((f) => FAMILY_LABELS[f] ?? f).join(', ');
}

type CountRow = { code: string | null; n: number };

function toMap(rows: CountRow[]): Map<string, number> {
  return new Map(rows.filter((r) => r.code !== null).map((r) => [String(r.code), Number(r.n)]));
}

/** Rubriques et Types V2, enrichis de leurs utilisations (pure). */
export function buildCodeReferentials(
  rubricUsage: ReadonlyMap<string, number>,
  typeUsage: ReadonlyMap<string, number>,
): Pick<ReferentialsSnapshot, 'rubrics' | 'documentTypes' | 'applicability'> {
  const rubrics = [...RUBRICS]
    .sort((a, b) => a.displayOrder - b.displayOrder)
    .map((r) => ({
      code: r.code,
      label: r.label,
      active: null,
      usage: rubricUsage.get(r.code) ?? 0,
      details: applicabilityLabel(r.applicability),
    }));
  const documentTypes = DOCUMENT_TYPES.map((t) => ({
    code: t.code,
    label: t.label,
    active: null,
    usage: typeUsage.get(t.code) ?? 0,
    details: `${getRubric(t.rubric)?.label ?? t.rubric}${t.userOnly ? ' — choix utilisateur uniquement' : ''}`,
  }));
  const applicability = [
    ...RUBRICS.map((r) => ({
      code: r.code,
      label: `Rubrique « ${r.label} »`,
      active: null,
      usage: rubricUsage.get(r.code) ?? 0,
      details: `${applicabilityLabel(r.applicability)}${r.contextual ? ' — visibilité contextuelle' : ''}`,
    })),
    ...DOCUMENT_TYPES.filter((t) => t.applicability !== 'ALL').map((t) => ({
      code: t.code,
      label: `Type « ${t.label} »`,
      active: null,
      usage: typeUsage.get(t.code) ?? 0,
      details: applicabilityLabel(t.applicability),
    })),
  ];
  return { rubrics, documentTypes, applicability };
}

type FamilyCountRow = { family: string; n: number };
type CategoryCountRow = { family: string; value: string | null; n: number };

/**
 * Familles et sous-catégories de biens (pure) : le classement du code, dans
 * son ordre, puis les valeurs rencontrées en base hors classement.
 */
export function buildAssetTaxonomyReferentials(
  familyCounts: FamilyCountRow[],
  categoryCounts: CategoryCountRow[],
): Pick<ReferentialsSnapshot, 'assetFamilies' | 'assetSubcategories'> {
  const familyUsage = new Map<string, number>();
  for (const r of familyCounts) familyUsage.set(r.family, (familyUsage.get(r.family) ?? 0) + Number(r.n));

  // Catégorie stockée → clé « famille|valeur » ; anciens libellés ramenés aux actuels.
  const categoryUsage = new Map<string, number>();
  for (const r of categoryCounts) {
    const value = r.family === 'OBJECT' ? (r.value?.trim() || null) : normalizeAssetCategory(r.value);
    const key = `${r.family}|${value ?? ''}`;
    categoryUsage.set(key, (categoryUsage.get(key) ?? 0) + Number(r.n));
  }

  const known = new Set(TAXONOMY.map((f) => f.code as string));
  const assetFamilies: ReferentialRow[] = [
    ...TAXONOMY.map((f) => ({
      code: f.code,
      label: f.label,
      active: true,
      usage: familyUsage.get(f.code) ?? 0,
      details: (ASSET_FAMILIES as readonly string[]).includes(f.code) ? null : 'Hors familles du référentiel documentaire',
    })),
    ...[...familyUsage.entries()]
      .filter(([code]) => !known.has(code))
      .map(([code, n]) => ({ code, label: assetFamilyLabel(code), active: false, usage: n, details: 'Famille ancienne, plus proposée' })),
  ];

  const listed = new Set<string>();
  const assetSubcategories: ReferentialRow[] = [];
  for (const f of TAXONOMY) {
    for (const c of f.categories) {
      const key = `${f.code}|${c.value}`;
      listed.add(key);
      assetSubcategories.push({ code: c.value, label: c.label, active: true, usage: categoryUsage.get(key) ?? 0, details: f.label });
    }
  }
  for (const [key, n] of categoryUsage) {
    if (listed.has(key)) continue;
    const [family, value] = [key.slice(0, key.indexOf('|')), key.slice(key.indexOf('|') + 1)];
    assetSubcategories.push(value
      ? { code: value, label: value, active: false, usage: n, details: `${assetFamilyLabel(family)} — hors classement` }
      : { code: '—', label: 'Catégorie non renseignée', active: null, usage: n, details: assetFamilyLabel(family) });
  }
  return { assetFamilies, assetSubcategories };
}

export async function loadReferentials(): Promise<ReferentialsSnapshot> {
  const [familyCounts, categoryCounts, rubricCounts, typeCounts, mappings] = await Promise.all([
    pgClient.unsafe<FamilyCountRow[]>(
      `SELECT category AS family, count(*)::int AS n FROM assets
        WHERE deleted_at IS NULL GROUP BY category`,
    ),
    pgClient.unsafe<CategoryCountRow[]>(
      `SELECT category AS family,
              CASE WHEN category = 'OBJECT' THEN object_category ELSE subtype END AS value,
              count(*)::int AS n
         FROM assets WHERE deleted_at IS NULL GROUP BY 1, 2`,
    ),
    pgClient.unsafe<CountRow[]>(
      `SELECT rubric_code AS code, count(*)::int AS n FROM asset_files
        WHERE deleted_at IS NULL AND rubric_code IS NOT NULL GROUP BY rubric_code`,
    ),
    pgClient.unsafe<CountRow[]>(
      `SELECT document_type_code AS code, count(*)::int AS n FROM asset_files
        WHERE deleted_at IS NULL AND document_type_code IS NOT NULL GROUP BY document_type_code`,
    ),
    pgClient.unsafe<Array<{ mapping_type: string; raw_label: string; canonical_code: string; canonical_label: string; status: string; n: number | null }>>(
      `SELECT m.mapping_type, m.raw_label, m.canonical_code, m.canonical_label, m.status,
              CASE WHEN m.mapping_type = 'function_code'
                   THEN (SELECT count(*)::int FROM asset_files f
                          WHERE f.deleted_at IS NULL AND f.retained_function_code = m.canonical_code)
              END AS n
         FROM document_taxonomy_mappings m
        ORDER BY m.mapping_type, m.raw_label`,
    ),
  ]);

  const code = buildCodeReferentials(toMap(rubricCounts), toMap(typeCounts));
  return {
    version: REFERENTIAL_VERSION,
    ...buildAssetTaxonomyReferentials(familyCounts, categoryCounts),
    ...code,
    mappings: mappings.map((m) => ({
      code: m.canonical_code,
      label: `${m.raw_label} → ${m.canonical_label}`,
      active: m.status === 'active',
      usage: m.n === null ? null : Number(m.n),
      details: m.mapping_type === 'function_code' ? 'Fonction documentaire' : 'Libellé de date',
    })),
  };
}
