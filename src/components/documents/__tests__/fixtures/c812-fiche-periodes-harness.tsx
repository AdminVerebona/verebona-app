/**
 * Carte #812 (reprise après la recette KO du 21/11/2026) — harnais NAVIGATEUR (Chromium réel) du test
 * `c812-fiche-periodes-navigateur.test.ts` : monte les VRAIS composants de période de la fiche (tiroir)
 * d'un document — le hook `useDocumentPeriods` (qui lit `GET /api/documents/:id/periodes` par le client
 * d'API de l'application), le bloc de la période principale (`DocumentBusinessPeriodField`) et le détail
 * (`DocumentPeriodsDetail`) — dans le même ordre que le tiroir : « Date du document », période, détail.
 * La réponse de l'API est servie par le test (interception réseau). Construit à la volée par esbuild ;
 * jamais importé par l'application.
 */
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { DocumentBusinessPeriodField, DocumentPeriodsDetail, useDocumentPeriods } from '@/components/documents/BusinessPeriods';

declare global {
  interface Window {
    __812Monter: (documentId: number) => void;
    __812Fermer: () => void;
  }
}

function Fiche({ documentId }: { documentId: number }) {
  const periods = useDocumentPeriods(documentId);
  return (
    <div data-testid="fiche-document" className="space-y-3 p-4 text-sm">
      <div className="flex items-center justify-between" data-testid="fiche-date-document">
        <span className="text-muted-foreground">Date du document</span>
        <span className="font-medium">17 novembre 2026</span>
      </div>
      <DocumentBusinessPeriodField documentId={documentId} periods={periods} />
      <DocumentPeriodsDetail documentId={documentId} periods={periods} />
    </div>
  );
}

let racine: Root | null = null;
window.__812Monter = (documentId) => {
  racine ??= createRoot(document.getElementById('root')!);
  // Chaque ouverture du tiroir est un nouveau montage (clé nouvelle) : aucune valeur gardée d'une ouverture à l'autre.
  flushSync(() => racine!.render(<Fiche key={`${documentId}-${Date.now()}`} documentId={documentId} />));
};
window.__812Fermer = () => { flushSync(() => racine?.render(null)); };
