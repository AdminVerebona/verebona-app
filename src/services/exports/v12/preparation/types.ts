/**
 * Contrats de l'API de préparation (CDC V12 §17.1) :
 *   POST /api/assets/{id}/exports/prepare   → `PreparationDto`
 *   POST /api/assets/{id}/exports/estimate  → `EstimateDto`
 * La génération reste `POST /api/assets/{id}/exports` avec `choices` (§17.2).
 *
 * Types PURS, partagés serveur et client.
 */

import type { DossierCode, AdditionalInfoSectionKey, ExportFamily } from '@/services/exports/catalog';
import type { PrepMessage } from './messages';
import type { PrepItemType } from './sections';

export type ItemMode = 'PDF' | 'ZIP';
export type OutputFormat = 'PDF' | 'ZIP';

/**
 * Compatibilité d'une pièce (§2.1) : `integrable` (PDF, JPG, PNG, WebP),
 * `zip_only` (Word, Excel, HEIC… — bascule automatique en ZIP, DEC-005),
 * `missing` (fichier absent du stockage), `too_large` (au-delà de la limite,
 * non sélectionnable). `protected` / `corrupted` / `unreadable` ne sont
 * connus qu'à la génération (partielle, ALT-004).
 */
export type Compatibility = 'integrable' | 'zip_only' | 'missing' | 'too_large';

export interface PrepItem {
  /** `document:12`, `photo:3`, `event:7`, `agenda:9`. */
  key: string;
  sourceType: 'document' | 'photo' | 'event' | 'agenda';
  sourceId: number;
  type: PrepItemType;
  label: string;
  /** Type de pièce (« Facture », « DPE »…) ou nature d'événement. */
  typeLabel: string | null;
  /** Provenance (PREP-ITE-003, infobulle PREP-ITE-013). */
  source: string;
  date: string | null;
  /** Format (« PDF », « DOCX »…) ; null pour un événement. */
  format: string | null;
  sizeBytes: number | null;
  compatibility: Compatibility | null;
  sensitive: boolean;
  /** Modes autorisés : [PDF, ZIP], [ZIP] (non intégrable) ou [] (événement, fichier inutilisable). */
  allowedModes: ItemMode[];
  selectable: boolean;
  /** Pré-sélection du CDC (§6.2, §24) — « restaurer la recommandation ». */
  recommended: boolean;
  recommendedMode: ItemMode | null;
  /** État initial (pré-sélection, ou choix repris avec `includeCurrentSelections`). */
  selected: boolean;
  mode: ItemMode | null;
  /** Fichier (aperçu miniature, « voir le document ») : `/api/files/{fileId}/view`. */
  fileId: number | null;
  /** Précision affichée (bloc CIL « B8 », prestataire, statut « Prévu »…). */
  detail: string | null;
  /** Message d'erreur de l'élément (PREP-ITE-012). */
  error: string | null;
}

/**
 * Ligne saisie dans les informations complémentaires qui alimente une section
 * (dommage, action, échange, point fort, protection, élément assuré, charge).
 * `linked` : pièces et photos liées (`document:12`, `photo:3`) — elles ne sont
 * citées dans le PDF que si elles sont retenues dans le dossier.
 */
export interface PrepRow {
  id: string;
  label: string;
  detail: string | null;
  linked: string[];
}

export interface PrepSection {
  id: string;
  label: string;
  description: string;
  required: boolean;
  /** Section décochable (clé des choix §17.2). */
  toggleable: boolean;
  enabled: boolean;
  defaultEnabled: boolean;
  /** Badge « Recommandé » (PREP-NAV-003) : section active par défaut. */
  recommended: boolean;
  itemType: PrepItemType | null;
  items: PrepItem[];
  infoSections: AdditionalInfoSectionKey[];
  cil: boolean;
  /** Contenu décrit par les informations complémentaires : renseigné ou non. */
  fedBy: string | null;
  fedFilled: boolean | null;
  /** Lignes structurées qui alimentent la section (comptées, avec leurs pièces liées). */
  rows: PrepRow[];
  /** Contient un élément sensible (PREP-NAV-004). */
  hasSensitive: boolean;
}

export interface EstimateAlert {
  code: string;
  type: 'warning' | 'blocking';
  message: string;
}

export interface EstimateDto {
  /** ZIP si au moins une pièce retenue est en mode ZIP (ZIP-001). */
  outputFormat: OutputFormat;
  estimatedPages: number;
  /** Taille estimée du fichier livré (PDF, ou PDF + pièces ZIP). */
  estimatedBytes: number;
  pdfItems: number;
  zipItems: number;
  pdfDocuments: number;
  zipDocuments: number;
  pdfPhotos: number;
  zipPhotos: number;
  events: number;
  blocking: EstimateAlert[];
  warnings: EstimateAlert[];
  /** Pièces retirées si l'utilisateur confirme « PDF seul » (ALT-002). */
  zipOnlyItems: Array<{ key: string; label: string }>;
  /** Pièces cochées mais indisponibles : exclues (MSG-PREP-005). */
  unavailable: Array<{ key: string; label: string; reason: Compatibility }>;
  longGeneration: boolean;
}

export interface CilBlockDto {
  id: string;
  label: string;
  status: 'complete' | 'missing' | 'invalid' | 'unknown' | 'not_applicable';
  blocking: boolean;
  /** Bloc qui empêche la génération (B1, B3, B8 à compléter). */
  blocksGeneration: boolean;
  missingItems: Array<{ id: string; label: string; actionLabel: string; target: { type: string; filter?: string } }>;
  /** Le bloc peut être marqué non applicable (§20 : B3 à B7, B9). */
  canMarkNotApplicable: boolean;
}

export interface PreparationDto {
  assetId: number;
  exportType: DossierCode;
  status: 'ready_pristine';
  dossier: { code: DossierCode; label: string; shortLabel: string; description: string; templateVersion: string };
  asset: { id: number; name: string; family: ExportFamily; familyLabel: string; categoryLabel: string | null };
  /** PREP-ELIGIBILITY : prêt, partiellement disponible (à compléter) ou indisponible. */
  eligibility: { status: 'ready' | 'partial' | 'unavailable'; message: string | null };
  lastGeneration: { publicId: string; status: string; createdAt: string; authorName: string | null } | null;
  sections: PrepSection[];
  /** Plafond de photos pré-cochées (§6.2). */
  photoCap: number;
  additionalInfo: { sections: AdditionalInfoSectionKey[]; updatedAt: string | null };
  cil: { globalStatus: 'ready' | 'action_required'; percentage: number; blocks: CilBlockDto[] } | null;
  estimate: EstimateDto;
  actions: { canGeneratePdf: boolean; canGenerateZip: boolean };
  messages: PrepMessage[];
  thresholds: { docsWarning: number; docsBlocking: number; bytesWarning: number; bytesBlocking: number; pagesBlocking: number; photosBlocking: number };
  /** ALT-001 : aucun élément à proposer. */
  empty: boolean;
}

/** Réponse de `POST …/exports/estimate`. */
export interface EstimateResponse {
  estimate: EstimateDto;
  actions: { canGeneratePdf: boolean; canGenerateZip: boolean };
  messages: PrepMessage[];
}
