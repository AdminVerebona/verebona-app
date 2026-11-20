/**
 * Carte #806 §6 — harnais NAVIGATEUR (Chromium réel) du test
 * `l116cb-timeline-navigateur.test.ts` : monte la VRAIE liste de la Timeline
 * (`AssetTimelineList`) avec un jeu d'entrées tel que la lecture le sert
 * (date de présentation décroissante, sans date en dernier). Construit à la
 * volée par esbuild ; jamais importé par l'application.
 */
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { AssetTimelineList, type AssetTimelineState, type TimelineOpenRequest } from '@/components/assets/timeline/AssetTimeline';
import type { TimelineEntry } from '@/services/agenda/timeline/model';

const compteurs = { events: 0, documents: 1, assets: 1, rooms: 0, equipments: 0 };
const ENTREES: TimelineEntry[] = [
  { kind: 'item', itemType: 'agenda', id: '30', title: 'Contrôle technique périodique du véhicule principal de la famille', effectiveDate: '2025-06-01' },
  {
    kind: 'group', itemType: 'operation', id: 'op-7', operationId: 7, title: 'Travaux de toiture — remplacement complet de la couverture et de la zinguerie',
    effectiveDate: '2024-03-12', dateBasis: 'FIRST_QUOTE',
    members: [{ itemType: 'agenda', id: '31', title: 'Visite du couvreur', effectiveDate: '2024-04-02' }, { itemType: 'agenda', id: '32', title: 'Rappel à planifier', effectiveDate: null }],
    counters: { ...compteurs, events: 2 },
  },
  { kind: 'group', itemType: 'operation', id: 'op-8', operationId: 8, title: 'Révision de la chaudière', effectiveDate: '2023-11-20', dateBasis: 'REALIZED', members: [], counters: compteurs },
  { kind: 'item', itemType: 'agenda', id: '10', title: 'Ramonage', effectiveDate: '2023-01-15' },
  { kind: 'group', itemType: 'operation', id: 'op-9', operationId: 9, title: 'Sinistre dégât des eaux', effectiveDate: null, dateBasis: null, members: [], counters: compteurs },
  { kind: 'item', itemType: 'agenda', id: '20', title: 'Entretien à prévoir', effectiveDate: null },
];

declare global {
  interface Window { __l116cbMonter: (o: { variant: 'desktop' | 'mobile' }) => void; __l116cbOuvertures: TimelineOpenRequest[] }
}

function Liste({ variant }: { variant: 'desktop' | 'mobile' }) {
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(new Set());
  const state: AssetTimelineState = { mode: 'grouped', entries: ENTREES, nextCursor: null, rest: 0, loading: false, error: false, expanded };
  const actions = {
    setMode: () => undefined, loadMore: () => undefined,
    toggle: (id: string) => setExpanded((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; }),
  };
  return (
    <div data-testid="timeline" className={variant === 'mobile' ? 'p-4' : 'p-6 max-w-[360px]'}>
      <AssetTimelineList state={state} actions={actions} variant={variant} onOpenItem={(r) => { window.__l116cbOuvertures.push(r); }} />
    </div>
  );
}

window.__l116cbOuvertures = [];
window.__l116cbMonter = ({ variant }) => {
  const root = createRoot(document.getElementById('root')!);
  flushSync(() => root.render(<Liste variant={variant} />));
};
