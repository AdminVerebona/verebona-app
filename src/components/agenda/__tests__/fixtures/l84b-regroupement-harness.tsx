/**
 * Lot 84B — harnais NAVIGATEUR (Chromium réel) du test
 * `l84b-regroupement-navigateur.test.ts` : monte le tiroir d'un événement de
 * référence (même conteneur que AgendaItemDrawer : composant de base 81F)
 * avec le VRAI panneau de regroupement, et le VRAI tiroir de choix empilé.
 * Une fausse barre d'état iOS intercepte les touchers en haut d'écran.
 * Construit à la volée par esbuild ; jamais importé par l'application.
 */
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { AgendaGroupingPanel, GroupingPicker } from '@/components/agenda/AgendaGroupingPanel';
import { GROUPING_LABELS, type AgendaGroupingView, type GroupingCandidateKind } from '@/lib/agenda/grouping-view';

const VUE: AgendaGroupingView = {
  itemId: 1, role: 'MAIN', main: null, mainWithdrawn: false, counts: null,
  linkedDocuments: [{ id: 10, title: 'Rapport d’expertise dégât des eaux cuisine et salle de bain — version définitive signée', documentDate: '2026-03-22', link: 'DIRECT' }],
  ensemble: {
    items: [{ id: 2, title: 'Visite expert de la compagnie d’assurance habitation — cabinet régional', startDate: '2026-03-21', isMain: false }],
    documents: [
      { id: 10, title: 'Rapport d’expertise dégât des eaux cuisine et salle de bain — version définitive signée', documentDate: '2026-03-22', link: 'DIRECT' },
      { id: 11, title: 'Devis réparation plafond', documentDate: null, link: 'GROUP' },
    ],
    assets: [{ id: 5, name: 'Maison de Vannes' }], rooms: [{ id: 7, name: 'Cuisine', assetId: 5 }], equipments: [],
  },
};

/** Lot 86D : élément RATTACHÉ (tiroir léger) avec ses propres documents — détachement individuel. */
const VUE_MEMBRE: AgendaGroupingView = {
  itemId: 2, role: 'MEMBER', mainWithdrawn: false, ensemble: null,
  main: { id: 1, title: 'Dégât des eaux', startDate: '2026-03-12' },
  counts: { items: 2, documents: 3, assets: 1, rooms: 1, equipments: 0 },
  linkedDocuments: [
    { id: 10, title: 'Rapport d’expertise dégât des eaux cuisine et salle de bain — version définitive signée', documentDate: '2026-03-22', link: 'DIRECT' },
    { id: 12, title: 'Facture plombier', documentDate: null, link: 'DIRECT' },
  ],
};

function BarreEtat({ hauteur }: { hauteur: number }) {
  if (!hauteur) return null;
  return <div data-testid="barre-etat" style={{ position: 'fixed', top: 0, left: 0, right: 0, height: hauteur, zIndex: 2147483647 }} />;
}

function Tiroir({ vue }: { vue: AgendaGroupingView }) {
  const [open, setOpen] = React.useState(true);
  const [choix, setChoix] = React.useState<GroupingCandidateKind | null>(null);
  return (
    <Sheet open={open} onOpenChange={(v) => { setOpen(v); if (!v) window.__l84bFermetures.tiroir += 1; }}>
      <SheetContent className="w-full sm:max-w-[520px] overflow-y-auto p-0 flex flex-col" data-testid="tiroir-evenement">
        <div className="relative px-7 pt-10 pb-8 border-b">
          <SheetTitle data-testid="titre" className="text-2xl font-extrabold leading-tight pr-6">Dégât des eaux</SheetTitle>
        </div>
        <div className="flex-1 px-7 py-6 space-y-6">
          <AgendaGroupingPanel
            view={vue}
            onAction={(a, t) => { window.__l84bGestes.push(`${a}:${t ?? ''}`); }}
            onPick={(k) => setChoix(k)}
            onCreateStep={() => undefined}
            onRelease={() => { window.__l84bGestes.push('retirer-reference'); }}
            onOpenMain={() => undefined}
          />
        </div>
        <GroupingPicker
          open={choix !== null}
          title={choix ? GROUPING_LABELS.add[choix] : ''}
          load={async (q) => [
            { id: 31, title: 'Facture plombier', meta: '2026-03-30' },
            { id: 32, title: 'Courrier d’indemnisation', meta: null },
          ].filter((c) => c.title.toLowerCase().includes(q.toLowerCase()))}
          onClose={() => { setChoix(null); window.__l84bFermetures.choix += 1; }}
          onPick={(c) => { setChoix(null); window.__l84bGestes.push(`choisi:${c.id}`); }}
        />
      </SheetContent>
    </Sheet>
  );
}

let root: Root | null = null;
declare global {
  interface Window {
    __l84bMonter: (opts?: { statusBar?: number; vue?: 'reference' | 'membre' }) => void;
    __l84bFermetures: { tiroir: number; choix: number };
    __l84bGestes: string[];
  }
}
window.__l84bFermetures = { tiroir: 0, choix: 0 };
window.__l84bGestes = [];
window.__l84bMonter = (opts = {}) => {
  root?.unmount();
  window.__l84bFermetures = { tiroir: 0, choix: 0 };
  window.__l84bGestes = [];
  root = createRoot(document.getElementById('root')!);
  flushSync(() => {
    root!.render(
      <>
        <main style={{ padding: 16 }}><h1>Agenda</h1></main>
        <Tiroir vue={opts.vue === 'membre' ? VUE_MEMBRE : VUE} />
        <BarreEtat hauteur={opts.statusBar ?? 0} />
      </>,
    );
  });
};
