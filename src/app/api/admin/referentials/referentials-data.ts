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
 *   · Familles et sous-catégories de biens : `asset_types`,
 *     `asset_type_subcategories` (seeds) ; utilisations = biens non supprimés.
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

export async function loadReferentials(): Promise<ReferentialsSnapshot> {
  const [families, subcategories, rubricCounts, typeCounts, mappings] = await Promise.all([
    pgClient.unsafe<Array<{ code: string; label: string; is_enabled: boolean; n: number }>>(
      `SELECT t.code, t.label, t.is_enabled, count(a.id)::int AS n
         FROM asset_types t
         LEFT JOIN assets a ON a.asset_type_id = t.id AND a.deleted_at IS NULL
        GROUP BY t.id ORDER BY t.display_order, t.label`,
    ),
    pgClient.unsafe<Array<{ code: string; label: string; is_enabled: boolean; parent: string; n: number }>>(
      `SELECT s.code, s.label, s.is_enabled, t.label AS parent, count(a.id)::int AS n
         FROM asset_type_subcategories s
         JOIN asset_types t ON t.id = s.asset_type_id
         LEFT JOIN assets a ON a.asset_type_subcategory_id = s.id AND a.deleted_at IS NULL
        GROUP BY s.id, t.label, t.display_order ORDER BY t.display_order, s.display_order, s.label`,
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
    assetFamilies: families.map((f) => ({
      code: f.code,
      label: f.label,
      active: Boolean(f.is_enabled),
      usage: Number(f.n),
      details: (ASSET_FAMILIES as readonly string[]).includes(f.code) ? null : 'Hors familles du référentiel documentaire',
    })),
    assetSubcategories: subcategories.map((s) => ({
      code: s.code,
      label: s.label,
      active: Boolean(s.is_enabled),
      usage: Number(s.n),
      details: s.parent,
    })),
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
