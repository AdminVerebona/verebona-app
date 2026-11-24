/**
 * Carte #830 — harnais NAVIGATEUR (Chromium réel) du test `c830-fiche-document-doublons-navigateur.test.ts` :
 * monte le VRAI tiroir du document (`components/assets/DocumentDrawer.tsx`, celui de tous les chemins
 * d'ouverture : Documents, bien, opération, Agenda, notification — ordinateur et mobile), avec sa vraie rubrique
 * « Opérations » et son vrai client d'API. Seules les réponses du serveur sont servies par le test (interception
 * réseau). Construit à la volée par esbuild ; jamais importé par l'application.
 */
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { DocumentDrawer, type DocumentDrawerItem } from '@/components/assets/DocumentDrawer';

declare global {
  interface Window {
    __830Monter: (doc: DocumentDrawerItem) => void;
    __830Fermer: () => void;
    __830Liens: string[];
    /** Textes interdits apparus dans la page à un moment quelconque depuis le montage (même un instant). */
    __830Vus: string[];
    __830Surveiller: (motifs: string[]) => void;
  }
}
window.__830Liens = [];
window.__830Vus = [];

let observateur: MutationObserver | null = null;
window.__830Surveiller = (motifs) => {
  observateur?.disconnect();
  window.__830Vus = [];
  const voir = () => {
    const t = document.body.innerText;
    for (const m of motifs) if (t.includes(m) && !window.__830Vus.includes(m)) window.__830Vus.push(m);
  };
  observateur = new MutationObserver(voir);
  observateur.observe(document.body, { childList: true, subtree: true, characterData: true });
};

function Tiroir({ doc }: { doc: DocumentDrawerItem }) {
  const [ouvert, setOuvert] = React.useState(true);
  return <DocumentDrawer open={ouvert} onOpenChange={setOuvert} document={doc} onRefresh={() => {}} />;
}

let racine: Root | null = null;
window.__830Monter = (doc) => {
  racine ??= createRoot(document.getElementById('root')!);
  // Chaque ouverture est un nouveau montage : rien n'est gardé d'une ouverture à l'autre.
  flushSync(() => racine!.render(<Tiroir key={`${doc.id}-${Date.now()}`} doc={doc} />));
};
window.__830Fermer = () => { flushSync(() => racine?.render(null)); };
