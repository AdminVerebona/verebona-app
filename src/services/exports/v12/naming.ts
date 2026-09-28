/**
 * Noms des fichiers livrés (CDC §14.2, ZIP-002/007) :
 *   /pdf/Verebona_[TypeDossier]_[NomBien]_[YYYY-MM-DD].pdf
 * Convention retenue (ZIP-007) : tirets dans les segments, soulignés entre
 * segments, sans accent ni caractère spécial — comme les maquettes
 * (« Verebona_CIL_Appartement-Lyon-2e_2026-09-28.zip »).
 */

import type { DossierCode } from '@/services/exports/catalog';

const TYPE_SEGMENT: Record<DossierCode, string> = {
  CIL: 'CIL',
  DOSSIER_COMPLET: 'Dossier-complet',
  VENTE: 'Kit-de-vente',
  LOCATION: 'Mise-en-location',
  ASSURANCE_SOUSCRIPTION: 'Assurance-souscription',
  ASSURANCE_SINISTRE: 'Assurance-sinistre',
};

/** Segment de nom de fichier : sans accents, espaces et ponctuation → tirets. */
export function fileSegment(v: string, max = 60): string {
  const s = v
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[ᵉᵈ]/g, 'e')
    .replace(/œ/g, 'oe').replace(/Œ/g, 'OE').replace(/æ/g, 'ae')
    .replace(/[’']/g, '-')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return s || 'bien';
}

/** Nom de base « Verebona_CIL_Appartement-Lyon-2e_2026-09-28 ». `date` : `YYYY-MM-DD`. */
export function deliverableBaseName(code: DossierCode, assetName: string, date: string): string {
  return `Verebona_${TYPE_SEGMENT[code]}_${fileSegment(assetName)}_${date}`;
}
