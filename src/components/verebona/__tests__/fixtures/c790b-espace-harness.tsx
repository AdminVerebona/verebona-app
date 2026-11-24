/**
 * Carte #790 (relance du 21/11/2026) — harnais NAVIGATEUR (Chromium réel) du test
 * `c790b-reponse-en-blocs-navigateur.test.ts` : monte le VRAI espace de réponse de l'Assistant
 * (`VerebonaSpaceProvider`, champ et panneau ordinateur, pilule et espace plein écran mobile, `SpaceBody`,
 * `AnswerBlocks`) avec le VRAI client (`useVerebona`). Seules les réponses du serveur sont servies par le test.
 * Construit à la volée par esbuild ; jamais importé par l'application.
 */
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { VerebonaSpaceProvider } from '@/components/verebona/space/VerebonaSpaceProvider';
import { VerebonaDesktopPanel, VerebonaHeaderField, VerebonaMobileField, VerebonaMobileSpace } from '@/components/verebona/space/VerebonaField';

let root: Root | null = null;
const w = window as unknown as { __790Monter: (mobile: boolean) => void };
w.__790Monter = (mobile) => {
  root?.unmount();
  root = createRoot(document.getElementById('root')!);
  flushSync(() => {
    root!.render(
      <VerebonaSpaceProvider>
        {mobile ? (
          <div className="flex items-center gap-2 px-3 py-2">
            <VerebonaMobileField />
            <VerebonaMobileSpace />
          </div>
        ) : (
          <div className="relative min-h-screen w-full">
            <VerebonaHeaderField />
            <VerebonaDesktopPanel />
          </div>
        )}
      </VerebonaSpaceProvider>,
    );
  });
};
