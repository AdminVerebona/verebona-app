'use client';

/**
 * Lot 109B — bouton « Retour » contextualisé de la fiche fournisseur
 * (« Retour à l'équipement », « Retour au document »…). Même effet que le
 * retour du navigateur ou le geste retour du téléphone quand l'écran de
 * départ est l'entrée précédente ; arrivée directe (lien, favori, onglet
 * neuf) : « Retour aux fournisseurs ». Voir `lib/suppliers/supplier-return.ts`.
 */
import { useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { RETURN_FALLBACK_LABEL, goBackFromSupplier, supplierReturnState } from '@/lib/suppliers/supplier-return';

export function SupplierBackButton({ search, confirmLeave }: {
  /** Recherche de l'adresse de la fiche (porte le jeton `retour`). */
  search: string;
  /** Confirmation des saisies non enregistrées avant de partir. */
  confirmLeave: (leave: () => void) => void;
}) {
  // Lu après le montage : l'instantané vit dans le stockage de session de l'onglet.
  const [label, setLabel] = useState(RETURN_FALLBACK_LABEL);
  useEffect(() => { setLabel(supplierReturnState(search).label); }, [search]);
  return (
    <Button
      variant="ghost"
      size="sm"
      className="-ml-2 h-11 px-2 text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)] md:h-9"
      onClick={() => confirmLeave(() => goBackFromSupplier(search))}
      data-testid="supplier-back"
    >
      <ArrowLeft className="mr-1.5 h-4 w-4" aria-hidden />
      {label}
    </Button>
  );
}
