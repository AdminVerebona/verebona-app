/**
 * Lot 108J — harnais NAVIGATEUR (Chromium réel) du test
 * `l108j-suggestions-navigateur.test.ts` : monte le VRAI `MascotSpeaks`
 * (bulle + suggestions partagées, vrai magasin `useSharedSuggestions`) dans
 * la colonne de l'accueil. Construit à la volée par esbuild ; jamais importé
 * par l'application.
 */
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { MascotSpeaks } from '@/components/home/MascotSpeaks';
import { purgeMascotPresentationMemory } from '@/components/home/useMascotPresentation';
import { resetSharedSuggestions } from '@/lib/suggestions/shared-suggestions';

let root: Root | null = null;
const w = window as unknown as { __mount: (empty?: boolean) => void };
w.__mount = (empty = false) => {
  root?.unmount();
  purgeMascotPresentationMemory();
  resetSharedSuggestions();
  root = createRoot(document.getElementById('root')!);
  flushSync(() => {
    root!.render(
      <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-3.5 px-4 pb-36 pt-2.5 md:gap-9 md:px-6 md:pb-[60px] md:pt-9 lg:px-8">
        <MascotSpeaks greetingName="Fabien" empty={empty} onCreateAsset={() => {}} onUploadDocument={() => {}} />
      </div>,
    );
  });
};
