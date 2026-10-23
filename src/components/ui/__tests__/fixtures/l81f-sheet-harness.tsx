/**
 * Lot 81F — harnais NAVIGATEUR (Chromium réel) du test
 * `l81f-tiroirs-zones-sures-navigateur.test.ts` : monte le VRAI composant de
 * base des tiroirs (`@/components/ui/sheet`) et des fenêtres
 * (`@/components/ui/dialog`) avec un contenu calqué sur le tiroir document de
 * la capture du PO (icône + titre long sur deux lignes + pastille, aperçu,
 * barre d'actions en pied). Une fausse barre d'état iOS (heure, réseau,
 * batterie) est posée AU-DESSUS de la page, comme le fait iOS en
 * `black-translucent` / Capacitor `overlaysWebView` : elle intercepte les
 * touchers, donc un bouton placé dessous n'est pas cliquable.
 * Construit à la volée par esbuild ; jamais importé par l'application.
 */
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { FileText } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

const TITRE = "Justificatif d'entretien Volkswagen Polo - 5 Automobile Stuttgart GmbH _ 5 novembre 2018";

type Kind = 'document' | 'auto-defilant' | 'en-tete-libre' | 'dialog';
export interface MountOptions { statusBar?: number }

function BarreEtat({ hauteur }: { hauteur: number }) {
  if (!hauteur) return null;
  return (
    <div
      data-testid="barre-etat"
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, height: hauteur, zIndex: 2147483647,
        display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between',
        padding: '0 28px 10px', font: '600 16px system-ui', color: '#000', pointerEvents: 'auto',
        background: 'rgba(255,255,255,0)',
      }}
    >
      <span>19:11</span><span>▂▄▆ 5G ▮</span>
    </div>
  );
}

function Corps() {
  return (
    <>
      <div className="px-5 pb-4"><div style={{ height: 300, background: '#ddd', borderRadius: 12 }} /></div>
      {Array.from({ length: 14 }, (_, i) => (
        <p key={i} className="px-5 py-2 text-sm">Ligne d&apos;information {i + 1}</p>
      ))}
    </>
  );
}

function Pied() {
  return (
    <div data-testid="pied" className="flex-shrink-0 border-t px-5 py-3 flex gap-2">
      <button type="button" className="h-11 flex-1 rounded-[12px] border">Ouvrir</button>
      <button type="button" className="h-11 flex-1 rounded-[12px] border">Supprimer</button>
    </div>
  );
}

function Tiroir({ kind, onClose }: { kind: Kind; onClose: () => void }) {
  const [open, setOpen] = React.useState(true);
  const change = (v: boolean) => { setOpen(v); if (!v) onClose(); };
  if (kind === 'dialog') {
    return (
      <Dialog open={open} onOpenChange={change}>
        <DialogContent>
          <DialogHeader><DialogTitle data-testid="titre">{TITRE}</DialogTitle></DialogHeader>
          <div style={{ height: 1400 }}>Contenu très long</div>
        </DialogContent>
      </Dialog>
    );
  }
  if (kind === 'auto-defilant') {
    // Comme AgendaItemDrawer / CreateAgendaItemDrawer : le panneau défile lui-même.
    return (
      <Sheet open={open} onOpenChange={change}>
        <SheetContent className="w-full sm:max-w-[520px] overflow-y-auto p-0 flex flex-col">
          <div className="relative px-7 pt-10 pb-8 border-b">
            <SheetTitle data-testid="titre" className="text-2xl font-extrabold leading-tight pr-6">{TITRE}</SheetTitle>
          </div>
          <Corps /><Corps />
        </SheetContent>
      </Sheet>
    );
  }
  if (kind === 'en-tete-libre') {
    // Comme TransferExportDrawer : en-tête maison (pas de SheetHeader), px-6.
    return (
      <Sheet open={open} onOpenChange={change}>
        <SheetContent side="right" className="flex w-full flex-col p-0 sm:max-w-lg">
          <div className="flex items-center gap-3 border-b px-6 py-5">
            <div className="min-w-0 flex-1"><SheetTitle data-testid="titre">{TITRE}</SheetTitle></div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto"><Corps /></div>
        </SheetContent>
      </Sheet>
    );
  }
  // Tiroir document (DocumentDrawer) : en-tête SheetHeader, corps défilant, pied.
  return (
    <Sheet open={open} onOpenChange={change}>
      <SheetContent
        className="w-full sm:max-w-lg flex flex-col p-0"
        onEscapeKeyDown={(e) => { if ((window as unknown as { __bloque?: boolean }).__bloque) e.preventDefault(); }}
      >
        <SheetHeader className="px-5 pt-5 pb-3">
          <div className="flex items-start gap-3 pr-8">
            <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5"><FileText className="w-4 h-4" /></div>
            <div className="flex-1 min-w-0">
              <SheetTitle data-testid="titre" className="leading-tight line-clamp-2 text-left">{TITRE}</SheetTitle>
              <span className="mt-1.5 inline-block rounded-full border px-2 text-xs">Rapport d&apos;entretien</span>
            </div>
          </div>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto"><Corps /></div>
        <Pied />
      </SheetContent>
    </Sheet>
  );
}

let root: Root | null = null;
declare global {
  interface Window {
    __mountTiroir: (kind: Kind, opts?: MountOptions) => void;
    __fermetures: number;
  }
}
window.__fermetures = 0;
window.__mountTiroir = (kind, opts = {}) => {
  root?.unmount();
  root = createRoot(document.getElementById('root')!);
  flushSync(() => {
    root!.render(
      <>
        <main style={{ padding: 16 }}><h1>Page Polo</h1></main>
        <Tiroir kind={kind} onClose={() => { window.__fermetures += 1; }} />
        <BarreEtat hauteur={opts.statusBar ?? 0} />
      </>,
    );
  });
};
