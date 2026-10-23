"use client";

/**
 * Page historique `/documents/<id>` — lot 80A.
 *
 * Elle lisait `GET /api/documents/<id>`, route qui n'a JAMAIS existé (seul PUT
 * est servi) : chaque ouverture finissait sur « Erreur lors du chargement du
 * document » et un renvoi vers « Mes documents » (bug « Justificatif » du TCO,
 * retour PO du 22/10/2026 ; même défaut pour le lien profond de la
 * notification « document analysé »). La vue de référence d'un document est
 * son TIROIR (`src/lib/drawers.ts`) : la page redirige vers « Mes documents »
 * avec le lien profond du tiroir, qui revalide le document dans le compte de
 * la session (document supprimé ou d'un autre compte : rien ne s'ouvre).
 */
import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Skeleton } from '@/components/ui/skeleton';
import { drawerHref } from '@/lib/drawers';

/** Destination d'un identifiant de la page historique (pure ; non exportée : fichier de page Next). */
function legacyDocumentTarget(raw: unknown): string {
  const v = Array.isArray(raw) ? raw[0] : raw;
  const id = typeof v === 'string' && /^\d{1,10}$/.test(v) ? Number(v) : NaN;
  return Number.isSafeInteger(id) && id > 0 ? drawerHref({ kind: 'document', id }, '/documents') : '/documents';
}

export default function DocumentDetailPage() {
  const params = useParams();
  const router = useRouter();
  const cible = legacyDocumentTarget(params?.id);

  useEffect(() => {
    router.replace(cible);
  }, [cible, router]);

  return (
    <div className="space-y-4 p-4" aria-busy="true">
      <h1 className="vb-app-title sr-only">Ouverture du document</h1>
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}
