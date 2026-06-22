/**
 * Service de manifest canonique pour les exports
 * Détermine quels documents et sections inclure selon le type d'export
 */

import type { AssetSnapshot, DocumentRef } from './export-snapshot.service';

export type ExportType =
  | 'CIL_REGLEMENTAIRE'
  | 'DOSSIER_VENTE'
  | 'DOSSIER_COMPLET'
  | 'ASSURANCE_ESTIMATION'
  | 'ASSURANCE_INDEMNISATION'
  | 'EXPORT_BRUT';

export type ExportOutput = 'PDF' | 'ZIP';

export interface ManifestSection {
  key: string;
  label: string;
  include: boolean;
}

export interface ExportManifest {
  normativeRubrics?: unknown[];
  missingRubricCount?: number;
  exportType: ExportType;
  variant: string | null;
  sections: ManifestSection[];
  includedDocuments: DocumentRef[];    // all non-web-link documents for this export
  includedWebLinks: DocumentRef[];     // web links (EXPORT_BRUT only)
  includedPhotos: boolean;
  includedEquipments: boolean;
  requestedOutputs: ExportOutput[];
  generatedAt: string;
  assetName: string;
  assetId: number;
  // Unqualified docs (no retainedFunctionCode) — signaled in drawer
  unqualifiedDocCount: number;
}

// Legacy code aliases: a document stored with an old/legacy code can satisfy a canonical rubric.
const RUBRIC_ALIASES: Partial<Record<string, string[]>> = {
  PLAN_CADASTRAL:   ['EXTRAIT_CADASTRAL', 'CADASTRE'],
  DPE:              ['PEB'],
  AMIANTE:          ['DIAGNOSTIC'],
  PLOMB:            ['DIAGNOSTIC'],
  GAZ:              ['DIAGNOSTIC'],
  ELECTRICITE:      ['DIAGNOSTIC'],
  ASSAINISSEMENT:   ['DIAGNOSTIC'],
  ACTE_TRANSACTION: ['TAXE_FONCIERE', 'TITRE_PROPRIETE', 'CONTRAT_ACHAT'],
};

// Codes pour chaque usage
const DOC_FUNCTION_CODES_BY_EXPORT: Record<ExportType, string[] | 'ALL'> = {
  CIL_REGLEMENTAIRE: 'ALL',
  DOSSIER_VENTE: [
    'ACTE_TRANSACTION', 'PERMIS_CONSTRUIRE', 'DPE', 'AUDIT_ENERGETIQUE',
    'AMIANTE', 'PLOMB', 'TERMITES', 'GAZ', 'ELECTRICITE', 'ASSAINISSEMENT', 'ERNMT',
    'SURFACE_CARREZ', 'EXPERTISE', 'GARANTIE', 'RAPPORT_ENTRETIEN', 'FACTURE',
    'PLAN_CONSTRUCTION', 'LABEL_CERTIFICATION', 'RE2020',
    'EQUIPEMENT_CHAUFFAGE', 'EQUIPEMENT_ECS', 'EQUIPEMENT_VENTILATION',
    'ISOLATION_TOITURE', 'ISOLATION_MURS', 'ISOLATION_VITRAGE', 'ISOLATION_PLANCHERS',
  ],
  ASSURANCE_ESTIMATION: [
    'ACTE_TRANSACTION', 'EXPERTISE', 'DPE', 'FACTURE',
    'AMIANTE', 'PLOMB', 'GAZ', 'ELECTRICITE',
    'PLAN_CONSTRUCTION', 'SURFACE_CARREZ',
  ],
  ASSURANCE_INDEMNISATION: [
    'ACTE_TRANSACTION', 'CONSTAT_SINISTRE', 'EXPERTISE', 'ATTESTATION_ASSURANCE',
    'RAPPORT_ENTRETIEN', 'FACTURE', 'DEVIS',
    'EQUIPEMENT_CHAUFFAGE', 'EQUIPEMENT_ECS', 'EQUIPEMENT_VENTILATION',
  ],
  DOSSIER_COMPLET: 'ALL',
  EXPORT_BRUT: 'ALL',
};

// ─── Sections ────────────────────────────────────────────────────────────────

function buildSections(exportType: ExportType, snapshot: AssetSnapshot, customSections?: string[], category?: string): ManifestSection[] {
  const all: ManifestSection[] = [
    { key: 'identity', label: 'Identité du bien', include: true },
    { key: 'characteristics', label: 'Caractéristiques techniques', include: true },
    { key: 'financial', label: 'Valeur & informations financières', include: true },
    { key: 'maintenance', label: 'Historique d\'entretien', include: true },
    { key: 'documents', label: 'Documents associés', include: true },
    { key: 'photos', label: 'Photos', include: snapshot.photos.length > 0 },
    { key: 'equipments', label: 'Équipements', include: snapshot.equipments.length > 0 },
    { key: 'rooms', label: 'Pièces / sous-structures', include: snapshot.substructures.length > 0 },
    { key: 'insurance', label: 'Assurance', include: true },
  ];

  switch (exportType) {
    case 'DOSSIER_VENTE': {
      const isImmo = category === 'IMMOBILIER';
      return all.map(s => ({
        ...s,
        include: ['identity', 'characteristics', 'financial', 'maintenance', 'documents', 'photos', ...(isImmo ? ['equipments', 'rooms'] : [])].includes(s.key),
      }));
    }

    case 'ASSURANCE_ESTIMATION':
      return all.map(s => ({
        ...s,
        include: ['identity', 'characteristics', 'financial', 'documents', 'photos'].includes(s.key),
      }));

    case 'ASSURANCE_INDEMNISATION':
      return all.map(s => ({
        ...s,
        include: ['identity', 'characteristics', 'financial', 'maintenance', 'documents', 'photos'].includes(s.key),
      }));

    case 'DOSSIER_COMPLET': {
      const isImmobilier = category === 'IMMOBILIER';
      return all.map(s => ({
        ...s,
        include: ['identity', 'characteristics', 'financial', 'maintenance', 'documents', 'photos', 'insurance', ...(isImmobilier ? ['equipments', 'rooms'] : [])].includes(s.key),
      }));
    }

    case 'EXPORT_BRUT':
      return all.map(s => ({ ...s, include: true }));

    default:
      return all;
  }
}

// ─── Sélection des documents ─────────────────────────────────────────────────

function selectDocuments(
  exportType: ExportType,
  snapshot: AssetSnapshot,
  customDocIds?: number[],
): { included: DocumentRef[]; unqualifiedCount: number } {
  // Séparation web links / fichiers réels
  const realDocs = snapshot.documents.filter(d => !d.isWebLink);
  const rule = DOC_FUNCTION_CODES_BY_EXPORT[exportType];

  let included: DocumentRef[];
  let unqualifiedCount = 0;

  if (rule === 'ALL') {
    included = realDocs;
  } else if (customDocIds && customDocIds.length > 0) {
    included = realDocs.filter(d => customDocIds.includes(d.id));
  } else {
    // Build expanded set: canonical codes + all their alias values
    const expandedCodes = new Set<string>(rule);
    for (const [canonical, aliases] of Object.entries(RUBRIC_ALIASES)) {
      if (expandedCodes.has(canonical)) {
        for (const alias of aliases ?? []) expandedCodes.add(alias);
      }
    }
    // Match on retainedFunctionCode OR documentType (aliases included)
    const isQualified = (d: DocumentRef) => {
      const rfc = d.retainedFunctionCode ?? '';
      const dt  = d.documentType ?? '';
      return (rfc && expandedCodes.has(rfc)) || (dt && expandedCodes.has(dt));
    };
    const qualified = realDocs.filter(isQualified);
    unqualifiedCount = realDocs.filter(d => !isQualified(d)).length;
    included = qualified;
  }

  return { included, unqualifiedCount };
}

// ─── API principale ───────────────────────────────────────────────────────────

export interface BuildManifestOptions {
  requestedOutputs?: ExportOutput[];
  variant?: string;
  customSections?: string[];
  customDocIds?: number[];
  includePhotos?: boolean;     // override par usage
  includeEquipments?: boolean;
}

export function buildExportManifest(
  exportType: ExportType,
  snapshot: AssetSnapshot,
  options: BuildManifestOptions = {},
): ExportManifest {
  // Guard: DOSSIER_VENTE only for IMMOBILIER or VEHICULE
  if (exportType === 'DOSSIER_VENTE' && !['IMMOBILIER', 'VEHICULE'].includes(snapshot.category)) {
    throw new Error(`Export type DOSSIER_VENTE is only available for IMMOBILIER or VEHICULE assets (got: ${snapshot.category})`);
  }

  const sections = buildSections(exportType, snapshot, options.customSections, snapshot.category);
  const { included: includedDocuments, unqualifiedCount } = selectDocuments(exportType, snapshot, options.customDocIds);

  // Web links: uniquement pour EXPORT_BRUT
  const includedWebLinks = exportType === 'EXPORT_BRUT'
    ? snapshot.documents.filter(d => d.isWebLink)
    : [];

  // Photos: incluses par défaut pour la plupart des usages
  const photosDefault = exportType !== 'EXPORT_BRUT';
  const includedPhotos = options.includePhotos ?? photosDefault;

  // Équipements mobiliers
  const includedEquipments = options.includeEquipments ?? true;

  const requestedOutputs: ExportOutput[] = options.requestedOutputs ?? ['PDF'];

  return {
    exportType,
    variant: options.variant ?? null,
    sections,
    includedDocuments,
    includedWebLinks,
    includedPhotos,
    includedEquipments,
    requestedOutputs,
    generatedAt: new Date().toISOString(),
    assetName: snapshot.name,
    assetId: snapshot.id,
    unqualifiedDocCount: unqualifiedCount,
  };
}

// ─── Labels ──────────────────────────────────────────────────────────────────

export const EXPORT_TYPE_LABELS: Record<ExportType, string> = {
  CIL_REGLEMENTAIRE: 'CIL',
  DOSSIER_VENTE: 'Dossier de vente',
  DOSSIER_COMPLET: 'Dossier complet du bien',
  ASSURANCE_ESTIMATION: 'Assurance — Estimation',
  ASSURANCE_INDEMNISATION: 'Assurance — Indemnisation',
  EXPORT_BRUT: 'Export données brutes',
};