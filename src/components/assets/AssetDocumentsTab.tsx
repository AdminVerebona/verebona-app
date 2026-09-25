"use client"

/**
 * Onglet « Documents » d'un bien — même présentation que « Mes documents ».
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN SEUL COMPOSANT POUR LES DEUX ÉCRANS
 *
 * L'onglet affichait les documents du bien en vrac (liste plate paginée),
 * pendant que « Mes documents » les regroupait par Rubrique avec leur Type.
 * Il réutilise désormais `DocumentsByRubric`, restreint au bien : mêmes
 * Rubriques, mêmes Types, mêmes cartes et vignettes, même tiroir document,
 * mêmes filtres — seul le périmètre change (§4.1 du CDC V2 : « mêmes
 * composants, seul le contexte change »).
 *
 * Les exports de dossiers (revente, CIL, dossier complet…) restent dans
 * l'onglet « Exports » du bien.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { DocumentsByRubric } from '@/components/documents/v2/DocumentsByRubric';

interface Props {
  assetId: number;
  assetName: string;
  /** Conservés pour la compatibilité d'appel ; le regroupement ne s'en sert pas. */
  assetCategory?: string;
  assetTypeId?: number;
  assetTypeSubcategoryId?: number;
  planType?: 'freemium' | 'premium';
}

export function AssetDocumentsTab({ assetId, assetName }: Props) {
  return <DocumentsByRubric assetId={assetId} assetName={assetName} />;
}
