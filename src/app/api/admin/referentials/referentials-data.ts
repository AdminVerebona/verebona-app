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
 *     Chaque Type V2 indique sa règle métier (`DOCUMENT_CATALOG`) — relation
 *     explicite (lot 30). Les codes V1 de la colonne historique
 *     `document_type` suivent, « Actif » s'ils sont proposés par le sélecteur.
 *   · Règles et mappings : applicabilité par famille (code), correspondances
 *     DU CODE réellement appliquées (familles anciennes, anciens libellés de
 *     catégorie, anciens codes documentaires — résolveur unique, lot 30), puis
 *     mappings de taxonomie documentaire (`document_taxonomy_mappings`).
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
import {
  ASSET_FAMILIES as TAXONOMY, LEGACY_ASSET_FAMILIES, LEGACY_CATEGORY_ALIASES, assetFamilyLabel, normalizeAssetCategory,
  toAssetFamilyCode,
} from '@/lib/asset-taxonomy';
import { CAPABILITY_EQUIVALENT_CATEGORIES } from '@/lib/asset-category-legacy';
import { DOCUMENT_TYPE_LIST } from '@/lib/document-type-constants';
import { resolveDocumentCode } from '@/lib/referential/document-codes';
import {
  LEGACY_DOCUMENT_CODE_EQUIVALENTS, LEGACY_DOCUMENT_STORAGE_FALLBACKS,
} from '@/lib/referential/legacy-document-codes';
import { DOCUMENT_CATALOG } from '@/services/canonical/registry/catalogs';

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

/** Libellés des familles : référentiel des biens (lot 30 — plus de table locale). */
export function applicabilityLabel(applicability: Applicability): string {
  if (applicability === 'ALL') return 'Toutes les familles';
  // Lot 32 (PO-Q14) : `MATERIEL_PRO` n'est pas une famille produit — il est
  // affiché sous sa famille normalisée (« Objet »), sans doublon.
  return [...new Set(applicability.map((f) => assetFamilyLabel(toAssetFamilyCode(f) ?? f)))].join(', ');
}

type CountRow = { code: string | null; n: number };

function toMap(rows: CountRow[]): Map<string, number> {
  return new Map(rows.filter((r) => r.code !== null).map((r) => [String(r.code), Number(r.n)]));
}

/** Rubriques et Types V2, enrichis de leurs utilisations (pure). */
export function buildCodeReferentials(
  rubricUsage: ReadonlyMap<string, number>,
  typeUsage: ReadonlyMap<string, number>,
  legacyTypeUsage: ReadonlyMap<string, number> = new Map(),
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
  const documentTypes: ReferentialRow[] = [
    ...DOCUMENT_TYPES.map((t) => {
      const regle = resolveDocumentCode(t.code).catalogCode;
      return {
        code: t.code,
        label: t.label,
        active: null,
        usage: typeUsage.get(t.code) ?? 0,
        details: `${getRubric(t.rubric)?.label ?? t.rubric}${t.userOnly ? ' — choix utilisateur uniquement' : ''}`
          + ` — règle métier : ${regle ?? 'aucune (non autoritaire)'}`,
      };
    }),
    // Codes V1 (colonne historique `document_type`) : lisibles, « Actif »
    // s'ils sont proposés par le sélecteur V1.
    ...DOCUMENT_TYPE_LIST.map((t) => {
      const r = resolveDocumentCode(t.code);
      return {
        code: t.code,
        label: t.label,
        active: r.status === 'ACTIVE',
        usage: legacyTypeUsage.get(t.code) ?? 0,
        details: `Type V1 (document_type)${r.v2Type ? ` — V2 : ${r.v2Type}` : ''}${r.catalogCode ? ` — règle métier : ${r.catalogCode}` : ''}`,
      };
    }),
  ];
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

/**
 * Correspondances DU CODE réellement appliquées (pure) : familles anciennes,
 * anciens libellés de catégorie, anciens codes documentaires et codes du
 * catalogue métier — chacune telle que le résolveur unique la traduit.
 */
export function buildCodeMappings(): ReferentialRow[] {
  const rows: ReferentialRow[] = [];
  for (const [code, f] of Object.entries(LEGACY_ASSET_FAMILIES)) {
    rows.push({ code, label: `${code} → ${assetFamilyLabel(f.family)}`, active: null, usage: null, details: 'Famille de bien ancienne (code)' });
  }
  for (const [ancien, actuel] of Object.entries(LEGACY_CATEGORY_ALIASES)) {
    rows.push({ code: ancien, label: `${ancien} → ${actuel}`, active: null, usage: null, details: 'Catégorie de bien : ancien libellé (code)' });
  }
  for (const [ancien, actuel] of Object.entries(CAPABILITY_EQUIVALENT_CATEGORIES)) {
    rows.push({ code: ancien, label: `${ancien} → capacités de ${actuel}`, active: null, usage: null, details: 'Catégorie de bien conservée (code)' });
  }
  const codes = new Set<string>([
    ...DOCUMENT_TYPE_LIST.map((t) => t.code),
    ...Object.keys(LEGACY_DOCUMENT_CODE_EQUIVALENTS),
    ...Object.keys(LEGACY_DOCUMENT_STORAGE_FALLBACKS),
    ...DOCUMENT_CATALOG.flatMap((d) => [d.code, ...(d.aliases ?? [])]),
  ]);
  for (const code of [...codes].sort()) {
    const r = resolveDocumentCode(code);
    if (r.origin === 'V2_TYPE' && !r.storageCode) continue;
    const cibles = [
      r.v2Type && r.v2Type !== code ? `V2 ${r.v2Type}` : null,
      r.storageCode && r.storageCode !== code ? `V1 ${r.storageCode}` : null,
      r.catalogCode ? `règle ${r.catalogCode}${r.authoritative ? ' (autoritaire)' : ''}` : null,
    ].filter(Boolean);
    rows.push({
      code,
      label: `${code} → ${cibles.join(' · ') || 'aucune correspondance'}`,
      active: null,
      usage: null,
      details: `Code documentaire (code) — ${r.status}`,
    });
  }
  return rows;
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
  // Lot 32 (PO-Q14) : une famille ancienne (`MATERIEL_PRO`, `AUTRE`) n'est
  // pas une famille produit — ses biens sont comptés sous leur famille
  // normalisée (`toAssetFamilyCode`), et elle n'a pas de ligne propre.
  const familyUsage = new Map<string, number>();
  for (const r of familyCounts) {
    const famille = toAssetFamilyCode(r.family) ?? r.family;
    familyUsage.set(famille, (familyUsage.get(famille) ?? 0) + Number(r.n));
  }

  // Catégorie stockée → clé « famille|valeur » ; anciens libellés ramenés aux actuels.
  const categoryUsage = new Map<string, number>();
  for (const r of categoryCounts) {
    const famille = toAssetFamilyCode(r.family) ?? r.family;
    const value = famille === 'OBJECT' ? (r.value?.trim() || null) : normalizeAssetCategory(r.value);
    const key = `${famille}|${value ?? ''}`;
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
  const [familyCounts, categoryCounts, rubricCounts, typeCounts, legacyTypeCounts, mappings] = await Promise.all([
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
    pgClient.unsafe<CountRow[]>(
      `SELECT document_type AS code, count(*)::int AS n FROM asset_files
        WHERE deleted_at IS NULL AND document_type IS NOT NULL GROUP BY document_type`,
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

  const code = buildCodeReferentials(toMap(rubricCounts), toMap(typeCounts), toMap(legacyTypeCounts));
  return {
    version: REFERENTIAL_VERSION,
    ...buildAssetTaxonomyReferentials(familyCounts, categoryCounts),
    ...code,
    mappings: [...buildCodeMappings(), ...mappings.map((m) => ({
      code: m.canonical_code,
      label: `${m.raw_label} → ${m.canonical_label}`,
      active: m.status === 'active',
      usage: m.n === null ? null : Number(m.n),
      details: m.mapping_type === 'function_code' ? 'Fonction documentaire' : 'Libellé de date',
    }))],
  };
}
