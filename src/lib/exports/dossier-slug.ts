/**
 * Segment d'URL de la page de préparation d'un dossier
 * (`/assets/{id}/exports/{slug}`) : code V12 en minuscules, tirets.
 */
import { DOSSIER_CODES, type DossierCode } from '@/services/exports/catalog';

export const dossierSlug = (code: DossierCode): string => code.toLowerCase().replace(/_/g, '-');

export function dossierFromSlug(slug: string | null | undefined): DossierCode | null {
  const s = String(slug ?? '').trim().toLowerCase();
  return DOSSIER_CODES.find((c) => dossierSlug(c) === s) ?? null;
}

/** Page de préparation d'un dossier. */
export const preparationPath = (assetId: number, code: DossierCode): string => `/assets/${assetId}/exports/${dossierSlug(code)}`;
