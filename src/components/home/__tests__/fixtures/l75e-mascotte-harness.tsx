/**
 * Lot 75E — harnais NAVIGATEUR (Chromium réel) du test
 * `l75e-mascotte-navigateur.test.ts` : monte le VRAI `MascotSpeaks` avec le
 * VRAI hook `useMascotPresentation` (lecture `fetch('/api/home/mascot')`,
 * interceptée par le test). Seuls la navigation Next, l'espace Verebona et
 * la garde d'écriture sont remplacés (modules `l75e-stubs`), comme dans le
 * rendu serveur du lot 71F. Construit à la volée par esbuild ; jamais
 * importé par l'application.
 */
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { MascotSpeaks } from '@/components/home/MascotSpeaks';
import { purgeMascotPresentationMemory } from '@/components/home/useMascotPresentation';

let root: Root | null = null;
/** Points d'entrée du harnais (sans déclaration globale : `__mount` est typé par le harnais du lot 58A). */
const w = window as unknown as { __mount: () => void; __unmount: () => void; __navigations: string[] };
w.__navigations = w.__navigations ?? [];
w.__mount = () => {
  root?.unmount();
  purgeMascotPresentationMemory();
  root = createRoot(document.getElementById('root')!);
  flushSync(() => {
    root!.render(
      <MascotSpeaks greetingName="Fabien" empty={false} onCreateAsset={() => {}} onUploadDocument={() => { w.__navigations.push('upload'); }} pageSuggestions={[]} />,
    );
  });
};
w.__unmount = () => { root?.unmount(); root = null; };
