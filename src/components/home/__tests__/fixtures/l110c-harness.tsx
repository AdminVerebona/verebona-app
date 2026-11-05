/**
 * Lot 110C — harnais NAVIGATEUR (Chromium réel) du test
 * `l110c-suggestions-accueil-navigateur.test.ts` :
 *   · `__mountHome()` : le VRAI `MascotSpeaks` (bulle + rangée de
 *     suggestions, vraie règle d'emplacement, vrai magasin) dans la colonne
 *     de l'accueil ;
 *   · `__mountT2()` : l'état initial RÉEL de « Demander à Verebona »
 *     (`SpaceBody`, variante mobile) alimenté comme par
 *     `VerebonaSpaceProvider` (`useSharedSuggestions({ active: isOpen })`).
 * Construit à la volée par esbuild ; jamais importé par l'application.
 */
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { MascotSpeaks } from '@/components/home/MascotSpeaks';
import { SpaceBody } from '@/components/verebona/space/SpaceContent';
import { purgeMascotPresentationMemory } from '@/components/home/useMascotPresentation';
import { resetSharedSuggestions, useSharedSuggestions, type SharedSuggestionItem } from '@/lib/suggestions/shared-suggestions';
import { T2Ctx, recordAsk } from './l110c-stubs';

let root: Root | null = null;
const w = window as unknown as { __mountHome: () => void; __mountT2: (variant?: 'mobile' | 'desktop') => void };

function remonter(node: React.ReactNode) {
  root?.unmount();
  purgeMascotPresentationMemory();
  resetSharedSuggestions();
  root = createRoot(document.getElementById('root')!);
  flushSync(() => { root!.render(node); });
}

w.__mountHome = () => remonter(
  <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-3.5 px-4 pb-36 pt-2.5 md:gap-9 md:px-6 md:pb-[60px] md:pt-9 lg:px-8">
    <MascotSpeaks greetingName="Fabien" empty={false} onCreateAsset={() => {}} onUploadDocument={() => {}} />
    <section data-home-next aria-label="Mes biens" className="rounded-[14px] border border-[color:var(--border)] bg-[color:var(--bg-card)] p-4">Mes biens</section>
  </div>,
);

function T2Ouvert({ variant }: { variant: 'mobile' | 'desktop' }) {
  // Même lecture que VerebonaSpaceProvider : `useSharedSuggestions({ active: isOpen })`.
  const shared = useSharedSuggestions({ active: true });
  const api = {
    showThread: false, turns: [], live: [], liveLoading: false, activeLive: -1, recent: [],
    v: { hasOlder: false, loadingOlder: false, loadOlder: () => {} },
    suggestions: shared.items,
    askSuggestion: (s: SharedSuggestionItem) => { void recordAsk(s.label, shared.pick(s)); },
    removeRecent: () => {}, resume: () => {},
  };
  const ref = React.useRef<HTMLDivElement | null>(null);
  return (
    <T2Ctx.Provider value={api}>
      <div ref={ref} data-t2-body className="flex flex-col gap-3 px-4 py-3"><SpaceBody variant={variant} scrollRef={ref} /></div>
    </T2Ctx.Provider>
  );
}

w.__mountT2 = (variant = 'mobile') => remonter(<T2Ouvert variant={variant} />);
