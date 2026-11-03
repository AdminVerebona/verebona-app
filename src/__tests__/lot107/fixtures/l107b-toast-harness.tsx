/**
 * Lot 107B — harnais NAVIGATEUR (Chromium réel) du test
 * `l107b-toasts-zones-sures-navigateur.test.ts` : monte le VRAI conteneur de
 * toasts de l'application (`AppToaster`) au-dessus d'une coquille calquée sur
 * `DashboardLayout` (mêmes classes : racine, barre haute mobile avec le champ
 * « Demander à Verebona » de 44 px, en-tête de 60 px à partir de 768 px).
 * Construit à la volée par esbuild ; jamais importé par l'application.
 */
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { toast } from 'sonner';
import { AppToaster } from '@/components/AppToaster';

// Classes recopiées de DashboardLayout (le test vérifie qu'elles y figurent).
export const SHELL_ROOT = 'flex h-screen overflow-hidden bg-[color:var(--bg-page)] pl-[var(--vb-safe-left)] pr-[var(--vb-safe-right)] md:pt-[var(--vb-safe-top)] md:pb-[var(--vb-safe-bottom)]';
export const MOBILE_TOPBAR = 'flex flex-shrink-0 items-center gap-2.5 bg-[color:var(--bg-page)] px-3.5 pb-2 pt-[max(8px,var(--vb-safe-top))] md:hidden';
export const DESKTOP_TOPBAR = 'relative z-[33] hidden h-[60px] flex-shrink-0 items-center gap-3.5 border-b border-[color:var(--border-subtle)] bg-[color:var(--bg-page)] px-7 md:flex';

function Shell() {
  return (
    <>
      <div className={SHELL_ROOT}>
        <div className="relative flex min-w-0 flex-1 flex-col">
          <header data-testid="desktop-topbar" className={DESKTOP_TOPBAR}>
            <div data-testid="desktop-field" className="h-[40px] flex-1 rounded-full border border-[color:var(--input)]" />
          </header>
          <div data-testid="mobile-topbar" className={MOBILE_TOPBAR}>
            <button data-testid="mobile-field" type="button" className="flex h-[44px] min-w-0 flex-1 items-center rounded-full border border-[color:var(--input)] bg-[color:var(--bg-card)] pl-2 text-[14px]">
              Demander à Verebona
            </button>
            <span className="h-8 w-8 flex-shrink-0 rounded-full bg-[color:var(--accent)]" />
          </div>
          <main className="flex-1 overflow-y-auto p-4">Contenu</main>
        </div>
      </div>
      <AppToaster />
    </>
  );
}

let root: Root | null = null;

declare global {
  interface Window {
    __mountShell: () => void;
    __toast: (message: string) => void;
  }
}

window.__mountShell = () => {
  const el = document.getElementById('root')!;
  root?.unmount();
  root = createRoot(el);
  flushSync(() => root!.render(<Shell />));
};

window.__toast = (message: string) => { toast.error(message, { duration: 60_000 }); };
