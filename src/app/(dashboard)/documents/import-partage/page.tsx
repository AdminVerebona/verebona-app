import { Suspense } from 'react';
import { ShareImportTracking } from '@/components/native/share-import/ShareImportTracking';

/**
 * Suivi d'un partage natif — lot 110A (« Importer et ouvrir Verebona »).
 * Ouvre le document importé s'il est enregistré (un seul fichier), sinon
 * affiche le suivi fidèle de chaque fichier. Aucun formulaire, aucune
 * confirmation : l'import a été lancé par l'interface de partage.
 */
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Import en cours — Verebona',
};

export default function ShareImportTrackingPage() {
  return (
    <Suspense fallback={null}>
      <ShareImportTracking />
    </Suspense>
  );
}
