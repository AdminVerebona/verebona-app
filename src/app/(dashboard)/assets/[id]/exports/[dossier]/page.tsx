"use client"

/**
 * Préparation d'un dossier prêt à l'emploi — page dédiée (CDC V12 §5 :
 * « écran large » sur ordinateur, plein écran sur mobile ; il remplace le
 * tiroir de préparation). Entrée : cartes du catalogue de l'onglet
 * « Exports » de la fiche du bien. Sortie : retour à cet onglet.
 *
 * `/assets/{id}/exports/{dossier}` — `dossier` : code V12 en minuscules
 * (`cil`, `dossier-complet`, `vente`, `location`, `assurance-souscription`,
 * `assurance-sinistre`) ; les anciens codes sont reconnus.
 */

import { useCallback, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useBreadcrumb } from '@/contexts/BreadcrumbContext';
import { ExportPreparationScreen } from '@/components/exports/preparation/ExportPreparationScreen';
import { DOSSIER_LABELS, normalizeExportCode, isDossierCode } from '@/services/exports/catalog';
import { dossierFromSlug } from '@/lib/exports/dossier-slug';

export default function ExportPreparationPage() {
  const params = useParams<{ id: string; dossier: string }>();
  const router = useRouter();
  const { setBreadcrumbs } = useBreadcrumb();
  const assetId = Number.parseInt(params.id, 10);
  const code = dossierFromSlug(params.dossier) ?? normalizeExportCode(params.dossier);

  useEffect(() => {
    setBreadcrumbs([
      { label: 'Mes biens', href: '/assets' },
      { label: 'Fiche du bien', href: `/assets/${assetId}?tab=exports` },
      { label: isDossierCode(code) ? DOSSIER_LABELS[code] : 'Dossier' },
    ]);
  }, [assetId, code, setBreadcrumbs]);

  const close = useCallback((href?: string) => router.push(href ?? `/assets/${assetId}?tab=exports`), [router, assetId]);

  return <ExportPreparationScreen assetId={assetId} exportType={code ?? String(params.dossier)} onClose={close} />;
}
