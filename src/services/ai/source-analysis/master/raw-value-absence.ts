/**
 * Carte #838 (B1, AC08/AC13) — MOTIF CODIFIÉ de l'absence de valeur littérale
 * (`rawValue`) d'un fait T1, validé APRÈS lecture et AVANT persistance.
 *
 * Le contrat T1 v7 garde `rawValue` FACULTATIF (aucune évolution du contrat,
 * aucun changement d'empreinte ni du prompt actif) : la règle est appliquée
 * côté Verebona, sur le fait prêt à écrire.
 *
 *   1. la source fournit un littéral et le modèle l'a rendu → `rawValue`
 *      conservé EXACTEMENT (aucun motif) ;
 *   2. sinon, un motif EXPLICITE et VÉRIFIABLE est persisté avec le fait
 *      (`document_facts.raw_value_absence`), chacun avec sa précondition
 *      contrôlée sur la preuve du même fait :
 *
 *   · `VISUAL_ONLY`           observation visuelle (`VISUAL_ANALYSIS` avec
 *                             description) : aucun littéral textualisable ;
 *   · `ILLEGIBLE`             observation visuelle signalée ILLISIBLE par
 *                             l'amont (jamais déduite ici) : exige
 *                             `VISUAL_ANALYSIS` et l'absence d'extrait ;
 *   · `SOURCE_UNIT_REFERENCE` littéral non recopié (valeur longue…) mais
 *                             référencé de façon PÉRENNE par les unités source
 *                             du fait (`source_unit_ids`) : exige au moins une
 *                             unité et un extrait ;
 *   · `LITERAL_IN_EXCERPT`    littéral présent dans la citation littérale
 *                             (`excerpt`) persistée avec le fait, sans unité
 *                             source : exige un extrait non vide ;
 *   · `DERIVED_BY_RULE`       valeur produite par une règle déterministe de
 *                             projection : exige `projection_origin` =
 *                             `DETERMINISTIC_RULE` ;
 *   · `NO_LITERAL`            valeur sans littéral par nature (booléen de
 *                             présence) : exige `value_type` = `boolean` ;
 *   · `UNJUSTIFIED`           AUCUN motif vérifiable : le fait est conservé
 *                             (aucune perte d'information) mais SIGNALÉ —
 *                             jamais un `null` silencieux.
 *
 * Aucune valeur n'est inventée : un motif dit POURQUOI il n'y a pas de
 * littéral, il ne remplace jamais la valeur. Les faits écrits avant cette
 * carte gardent `raw_value_absence` NULL et sont lus `LEGACY_UNSPECIFIED`
 * (motif non renseigné) — aucune migration ne leur attribue de motif.
 */

export const RAW_VALUE_ABSENCE_CODES = [
  'VISUAL_ONLY', 'ILLEGIBLE', 'SOURCE_UNIT_REFERENCE', 'LITERAL_IN_EXCERPT', 'DERIVED_BY_RULE', 'NO_LITERAL', 'UNJUSTIFIED',
] as const;
export type RawValueAbsenceCode = (typeof RAW_VALUE_ABSENCE_CODES)[number];

/** Lecture d'un fait antérieur à la carte #838 (colonne NULL et `raw_value` absent) : motif non renseigné. */
export const LEGACY_RAW_VALUE_ABSENCE = 'LEGACY_UNSPECIFIED' as const;

export const RAW_VALUE_ABSENCE_LABELS: Record<RawValueAbsenceCode | typeof LEGACY_RAW_VALUE_ABSENCE, string> = {
  VISUAL_ONLY: 'Observation visuelle : aucun texte littéral à recopier',
  ILLEGIBLE: 'Zone illisible : valeur observée, littéral non transcriptible',
  SOURCE_UNIT_REFERENCE: 'Littéral conservé par référence aux unités de la source',
  LITERAL_IN_EXCERPT: 'Littéral présent dans la citation conservée',
  DERIVED_BY_RULE: 'Valeur produite par une règle déterministe',
  NO_LITERAL: 'Valeur sans littéral par nature (présence / absence)',
  UNJUSTIFIED: 'Absence de littéral NON JUSTIFIÉE — à vérifier',
  LEGACY_UNSPECIFIED: 'Motif non renseigné (fait antérieur à la carte #838)',
};

/** Ce que le contrôle lit d'un fait prêt à persister (forme `DocumentFactRecord`). */
export interface RawValueAbsenceInput {
  rawValue?: string | number | boolean | null;
  excerpt?: string | null;
  evidenceOrigin?: string | null;
  visualEvidence?: { description?: string | null } | null;
  sourceUnitIds?: readonly string[] | null;
  projectionOrigin?: string | null;
  valueType?: string | null;
  /** Motif proposé par l'amont (ex. `ILLEGIBLE`) — validé, jamais cru sur parole. */
  rawValueAbsence?: string | null;
}

const vide = (v: unknown): boolean => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

/** Un littéral est-il présent ? (`0` et `false` sont des littéraux.) */
export function hasRawLiteral(f: Pick<RawValueAbsenceInput, 'rawValue'>): boolean {
  return !vide(f.rawValue);
}

/** Précondition VÉRIFIABLE d'un motif sur la preuve du même fait (pure). */
export function rawValueAbsenceHolds(code: RawValueAbsenceCode, f: RawValueAbsenceInput): boolean {
  const visuel = f.evidenceOrigin === 'VISUAL_ANALYSIS';
  switch (code) {
    case 'VISUAL_ONLY': return visuel && !vide(f.visualEvidence?.description);
    case 'ILLEGIBLE': return visuel && vide(f.excerpt);
    case 'SOURCE_UNIT_REFERENCE': return !visuel && (f.sourceUnitIds?.length ?? 0) > 0 && !vide(f.excerpt);
    case 'LITERAL_IN_EXCERPT': return !visuel && !vide(f.excerpt);
    case 'DERIVED_BY_RULE': return f.projectionOrigin === 'DETERMINISTIC_RULE';
    case 'NO_LITERAL': return f.valueType === 'boolean';
    case 'UNJUSTIFIED': return true;
  }
}

export type RawValueAbsenceCheck =
  /** Littéral présent : conservé tel quel, aucun motif. */
  | { status: 'LITERAL'; code: null }
  /** Absence justifiée par un motif vérifié. */
  | { status: 'JUSTIFIED'; code: Exclude<RawValueAbsenceCode, 'UNJUSTIFIED'> }
  /** Aucun motif vérifiable : fait conservé et SIGNALÉ. `rejected` : motif proposé par l'amont invalide. */
  | { status: 'UNJUSTIFIED'; code: 'UNJUSTIFIED'; rejected: string | null };

/**
 * Règle de validation métier (pure) : motif proposé par l'amont s'il est
 * vérifiable, sinon motif déduit de la preuve (ordre du plus spécifique au
 * plus général), sinon `UNJUSTIFIED` signalé.
 */
export function checkRawValueAbsence(f: RawValueAbsenceInput): RawValueAbsenceCheck {
  if (hasRawLiteral(f)) return { status: 'LITERAL', code: null };
  const propose = f.rawValueAbsence ?? null;
  let rejete: string | null = null;
  if (propose !== null) {
    if ((RAW_VALUE_ABSENCE_CODES as readonly string[]).includes(propose) && propose !== 'UNJUSTIFIED'
      && rawValueAbsenceHolds(propose as RawValueAbsenceCode, f)) {
      return { status: 'JUSTIFIED', code: propose as Exclude<RawValueAbsenceCode, 'UNJUSTIFIED'> };
    }
    rejete = propose;
  }
  const ordre: Array<Exclude<RawValueAbsenceCode, 'UNJUSTIFIED' | 'ILLEGIBLE'>> = [
    'DERIVED_BY_RULE', 'VISUAL_ONLY', 'SOURCE_UNIT_REFERENCE', 'LITERAL_IN_EXCERPT', 'NO_LITERAL',
  ];
  for (const code of ordre) if (rawValueAbsenceHolds(code, f)) return { status: 'JUSTIFIED', code };
  return { status: 'UNJUSTIFIED', code: 'UNJUSTIFIED', rejected: rejete };
}

/**
 * Lecture (API, export) d'un fait persisté : motif écrit, `null` si le
 * littéral est présent, `LEGACY_UNSPECIFIED` pour un fait antérieur sans
 * motif — jamais un motif inventé.
 */
export function readRawValueAbsence(row: { rawValue?: unknown; rawValueAbsence?: unknown }): RawValueAbsenceCode | typeof LEGACY_RAW_VALUE_ABSENCE | null {
  if (!vide(row.rawValue)) return null;
  const v = typeof row.rawValueAbsence === 'string' ? row.rawValueAbsence : null;
  if (v && (RAW_VALUE_ABSENCE_CODES as readonly string[]).includes(v)) return v as RawValueAbsenceCode;
  return LEGACY_RAW_VALUE_ABSENCE;
}
