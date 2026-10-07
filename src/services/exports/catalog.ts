/**
 * Catalogue des dossiers prêts à l'emploi — CDC Exports V12 §1.2, EXP-001.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * SOURCE UNIQUE DES CODES DE DOSSIER
 *
 * Le code livré portait cinq codes « legacy » (`CIL_REGLEMENTAIRE`,
 * `DOSSIER_VENTE`, `ASSURANCE_ESTIMATION`, `ASSURANCE_INDEMNISATION`,
 * `DOSSIER_COMPLET`) recopiés dans l'interface, les routes, le back-office et
 * l'assistant, et d'autres encore dans le référentiel documentaire
 * (`REVENTE`, `ASSURANCE_DEVIS`, `CIL`…). Le CDC V12 fixe six codes ; ce
 * module est le seul endroit où ils sont définis.
 *
 * Module PUR (aucun accès base) : importé côté serveur ET côté client.
 *
 * Les anciens codes restent reconnus en lecture (`normalizeExportCode`) :
 * la migration 0213 renomme les valeurs stockées, mais un client resté ouvert
 * ou une ligne écrite pendant le déploiement doit encore être comprise.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { assetFamilyLabel, toAssetFamilyCode } from '@/lib/asset-taxonomy';

/** Les six dossiers du CDC V12 (§1.2), dans l'ordre d'affichage. */
export const DOSSIER_CODES = [
  'CIL',
  'DOSSIER_COMPLET',
  'VENTE',
  'LOCATION',
  'ASSURANCE_SOUSCRIPTION',
  'ASSURANCE_SINISTRE',
] as const;

export type DossierCode = (typeof DOSSIER_CODES)[number];

/** Export de données brutes : hors dossiers prêts à l'emploi (EXC-001), code inchangé. */
export const EXPORT_BRUT_CODE = 'EXPORT_BRUT' as const;

export type ExportCode = DossierCode | typeof EXPORT_BRUT_CODE;

export function isDossierCode(x: unknown): x is DossierCode {
  return typeof x === 'string' && (DOSSIER_CODES as readonly string[]).includes(x);
}

/**
 * Anciens codes → codes V12. Relevé exhaustif des valeurs rencontrées dans le
 * code et le schéma avant la migration 0213 :
 *   - `export_generation.export_type` / API / UI : CIL_REGLEMENTAIRE,
 *     DOSSIER_VENTE, DOSSIER_COMPLET, ASSURANCE_ESTIMATION,
 *     ASSURANCE_INDEMNISATION, EXPORT_BRUT ;
 *   - `export_templates.export_type` (commentaire 0045, seeds) : CIL,
 *     DOSSIER_VENTE, ASSURANCE_DEVIS, ASSURANCE_SINISTRE, DOSSIER_COMPLET,
 *     REVENTE, SAV_GARANTIE, AUTRE ;
 *   - `document_type_export_associations.export_type` (seed document_types) :
 *     REVENTE, ASSURANCE_DEVIS, DOSSIER_COMPLET ;
 *   - prévisualisation BO (alias) : ASSURANCE_SINISTRE, ASSURANCE_DEVIS, CIL.
 * `DOSSIER_REVENTE` n'apparaît nulle part mais est cité par le CDC de migration :
 * il est reconnu par prudence. `SAV_GARANTIE` et `AUTRE` n'ont pas d'équivalent
 * V12 : ils ne sont pas renommés (`normalizeExportCode` → null).
 */
export const LEGACY_EXPORT_CODE_MAP: Readonly<Record<string, DossierCode>> = Object.freeze({
  CIL_REGLEMENTAIRE: 'CIL',
  DOSSIER_VENTE: 'VENTE',
  DOSSIER_REVENTE: 'VENTE',
  REVENTE: 'VENTE',
  ASSURANCE_ESTIMATION: 'ASSURANCE_SOUSCRIPTION',
  ASSURANCE_DEVIS: 'ASSURANCE_SOUSCRIPTION',
  ASSURANCE_INDEMNISATION: 'ASSURANCE_SINISTRE',
});

/**
 * Code quelconque (V12, ancien, casse ou espaces variables) → code V12,
 * `EXPORT_BRUT`, ou `null` s'il n'est pas un export connu.
 */
export function normalizeExportCode(code: unknown): DossierCode | typeof EXPORT_BRUT_CODE | null {
  if (typeof code !== 'string') return null;
  const c = code.trim().toUpperCase();
  if (!c) return null;
  if (c === EXPORT_BRUT_CODE) return EXPORT_BRUT_CODE;
  if (isDossierCode(c)) return c;
  return LEGACY_EXPORT_CODE_MAP[c] ?? null;
}

/** Libellés utilisateur (§1.2). */
export const DOSSIER_LABELS: Readonly<Record<DossierCode, string>> = Object.freeze({
  CIL: "Carnet d'information du logement",
  DOSSIER_COMPLET: 'Dossier complet du bien',
  VENTE: 'Kit de mise en vente',
  LOCATION: 'Dossier de mise en location',
  ASSURANCE_SOUSCRIPTION: 'Assurance — souscription / mise à jour',
  ASSURANCE_SINISTRE: 'Assurance — sinistre / indemnisation',
});

/** Libellés courts (historique, listes compactes). */
export const DOSSIER_SHORT_LABELS: Readonly<Record<DossierCode, string>> = Object.freeze({
  CIL: 'CIL',
  DOSSIER_COMPLET: 'Dossier complet',
  VENTE: 'Kit de vente',
  LOCATION: 'Dossier de location',
  ASSURANCE_SOUSCRIPTION: 'Assurance — souscription',
  ASSURANCE_SINISTRE: 'Assurance — sinistre',
});

/** Objectif de chaque dossier, tel qu'affiché dans le catalogue (§1.2). */
export const DOSSIER_DESCRIPTIONS: Readonly<Record<DossierCode, string>> = Object.freeze({
  CIL: "État structuré des informations et documents disponibles pour constituer le CIL d'une maison ou d'un appartement.",
  DOSSIER_COMPLET: 'Synthèse, historique, documents, photos et échéances du bien, prêts à transmettre.',
  VENTE: 'Fiche de vente, conditions, photos et éléments valorisants.',
  LOCATION: 'Fiche locative, conditions, équipements, diagnostics et photos.',
  ASSURANCE_SOUSCRIPTION: 'Dossier factuel pour votre assureur : valeur, état, protections, justificatifs.',
  ASSURANCE_SINISTRE: 'Dossier de preuves : chronologie, dommages, photos, devis et échanges.',
});

export const EXPORT_BRUT_LABEL = 'Export données brutes';

/** Libellé d'un code quelconque (ancien compris) ; repli sur le code brut. */
export function exportCodeLabel(code: string | null | undefined, short = false): string {
  const n = normalizeExportCode(code);
  if (n === EXPORT_BRUT_CODE) return EXPORT_BRUT_LABEL;
  if (n) return short ? DOSSIER_SHORT_LABELS[n] : DOSSIER_LABELS[n];
  return code ?? '';
}

// ── Familles ────────────────────────────────────────────────────────────────

/** Familles du CDC (§1.2, §4.2). */
export const EXPORT_FAMILIES = ['IMMOBILIER', 'VEHICULE', 'OBJET'] as const;
export type ExportFamily = (typeof EXPORT_FAMILIES)[number];

export const EXPORT_FAMILY_LABELS: Readonly<Record<ExportFamily, string>> = Object.freeze({
  // Lot 30 : libellés du référentiel des biens.
  IMMOBILIER: assetFamilyLabel('IMMOBILIER'),
  VEHICULE: assetFamilyLabel('VEHICULE'),
  OBJET: assetFamilyLabel('OBJECT'),
});

/**
 * `assets.category` → famille CDC. En base, l'objet est stocké `OBJECT`
 * (lib/asset-taxonomy) ; les familles anciennes (`MATERIEL_PRO`, `AUTRE`) sont
 * traitées comme des objets. `null` : valeur inconnue.
 */
export function toExportFamily(category: string | null | undefined): ExportFamily | null {
  // Résolveur unique des familles (lot 30) ; seul le nom de la famille objet diffère ici.
  const f = toAssetFamilyCode(category);
  return f === 'OBJECT' ? 'OBJET' : f ?? null;
}

/** Familles éligibles par dossier (§1.2). LOCATION : immobilier seulement en V1. */
export const DOSSIER_FAMILIES: Readonly<Record<DossierCode, readonly ExportFamily[]>> = Object.freeze({
  CIL: ['IMMOBILIER'],
  DOSSIER_COMPLET: ['IMMOBILIER', 'VEHICULE', 'OBJET'],
  VENTE: ['IMMOBILIER', 'VEHICULE', 'OBJET'],
  LOCATION: ['IMMOBILIER'],
  ASSURANCE_SOUSCRIPTION: ['IMMOBILIER', 'VEHICULE', 'OBJET'],
  ASSURANCE_SINISTRE: ['IMMOBILIER', 'VEHICULE', 'OBJET'],
});

/**
 * Le dossier est-il proposé pour cette famille ? Accepte la famille CDC ou la
 * catégorie stockée (`OBJECT`…). Règle de FAMILLE uniquement : le CIL exige
 * en plus une maison ou un appartement (`isCilEligible`, lib/asset-capabilities).
 */
export function isDossierEligibleForFamily(code: string, family: string | null | undefined): boolean {
  const c = normalizeExportCode(code);
  if (!c || c === EXPORT_BRUT_CODE) return false;
  const f = toExportFamily(family);
  return f != null && DOSSIER_FAMILIES[c].includes(f);
}

/** Message d'inéligibilité par famille (catalogue, API). */
export function familyIneligibilityMessage(code: DossierCode): string {
  switch (code) {
    case 'CIL':
      return "Le Carnet d'information du logement est disponible pour les maisons et les appartements uniquement.";
    case 'LOCATION':
      return 'Le dossier de mise en location est disponible pour les biens immobiliers uniquement.';
    default:
      return "Ce dossier n'est pas disponible pour cette famille de bien.";
  }
}

// ── Informations complémentaires utilisées par dossier (DEC-007, §6.2) ─────

export type AdditionalInfoSectionKey = 'commercial' | 'rental' | 'insurance' | 'claim' | 'finance';

/** Sous-rubriques de la fiche bien lues par chaque dossier. */
export const DOSSIER_ADDITIONAL_SECTIONS: Readonly<Record<DossierCode, readonly AdditionalInfoSectionKey[]>> = Object.freeze({
  CIL: [],
  // « Valeur retenue », frais d'acquisition, charges et taxes (section financière, RULE-002).
  DOSSIER_COMPLET: ['finance'],
  VENTE: ['commercial'],
  LOCATION: ['rental'],
  ASSURANCE_SOUSCRIPTION: ['insurance'],
  ASSURANCE_SINISTRE: ['claim'],
});
