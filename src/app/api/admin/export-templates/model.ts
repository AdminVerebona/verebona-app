/**
 * Modèles d'export du back-office = les six dossiers V12 du code.
 *
 * Nom, description et familles viennent du catalogue (catalog.ts) ; seul
 * l'état actif / inactif est administré (dossier-availability.ts). Aucun
 * numéro de version, aucun contenu éditable, aucune statistique (Dashboard).
 */
import {
  DOSSIER_DESCRIPTIONS, DOSSIER_FAMILIES, DOSSIER_LABELS, EXPORT_FAMILY_LABELS, isDossierCode, normalizeExportCode,
  type DossierCode,
} from '@/services/exports/catalog';
import type { DossierAvailabilityRow } from '@/services/exports/dossier-availability';

export interface AdminExportModel {
  code: DossierCode;
  label: string;
  description: string;
  /** Familles de biens concernées (libellés). */
  families: string[];
  isActive: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** Paramètre d'URL → code de dossier V12 (ancien code accepté), sinon null. */
export function toDossierParam(raw: string | undefined): DossierCode | null {
  const code = normalizeExportCode(raw ? decodeURIComponent(raw) : raw);
  return isDossierCode(code) ? code : null;
}

export function toAdminExportModel(row: DossierAvailabilityRow): AdminExportModel {
  return {
    code: row.code,
    label: DOSSIER_LABELS[row.code],
    description: DOSSIER_DESCRIPTIONS[row.code],
    families: DOSSIER_FAMILIES[row.code].map((f) => EXPORT_FAMILY_LABELS[f]),
    isActive: row.isActive,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  };
}
