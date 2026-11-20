/**
 * Carte #806 (volet B §7, §8) — harnais NAVIGATEUR (Chromium réel) du test
 * `l116cb-operations-navigateur.test.ts` : monte les VRAIS composants —
 * la fiche d'une opération (`ReferenceEventPageContent`), le tiroir d'un
 * document avec ses opérations (`DocumentOperationsPanel`, fenêtre de retrait,
 * choix empilé) et la liste des opérations (`ReferenceEventListContent`).
 * Les données sont fixes ; les gestes sont notés dans `window.__806Gestes`.
 * Construit à la volée par esbuild ; jamais importé par l'application.
 */
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { GroupingPicker } from '@/components/agenda/AgendaGroupingPanel';
import { DocumentOperationRemoveDialog, DocumentOperationsPanel } from '@/components/documents/DocumentOperations';
import { ReferenceEventListContent } from '@/components/reference-events/ReferenceEventList';
import { ReferenceEventPageContent } from '@/components/reference-events/ReferenceEventPageContent';
import {
  OPERATION_LIST_PAGE_SIZE, compareOperationListItems, operationListHaystack, operationListMatches, paginateOperationList,
  type OperationListItem, type OperationListPage, type OperationListQuery,
} from '@/lib/reference-events/operation-list';
import { OPERATION_LINK_LABELS, type DocumentOperationRef } from '@/lib/reference-events/operation-links';
import type { ReferenceEventPageView } from '@/services/business-operations/graph/reference-event-page';

declare global {
  interface Window {
    __806Gestes: string[];
    __806Liens: string[];
    __806Monter: (vue: 'fiche' | 'document' | 'liste') => void;
  }
}
window.__806Gestes = [];
window.__806Liens = [];
const note = (g: string) => { window.__806Gestes.push(g); };

const LONG = 'Rapport d’expertise contradictoire du dégât des eaux de la cuisine et de la salle de bain du premier étage — version définitive signée par les deux parties';

const FICHE: ReferenceEventPageView = {
  id: 42, redirectedFrom: null, version: 3, title: `Sinistre — ${LONG}`, ownLabel: LONG, typeCode: 'CLAIM', typeLabel: 'Sinistre', provider: 'Plâtrerie Morel et fils',
  dates: [{ role: 'REALIZED', date: '2025-04-02' }], undated: false, declarations: [],
  assets: [{ id: 7, name: 'Maison de Lyon' }], equipments: [{ id: 9, name: 'Chaudière', assetId: 7, assetName: 'Maison de Lyon' }],
  rooms: [{ id: 31, name: 'Cuisine', assetId: 7, assetName: 'Maison de Lyon' }], suppliers: [{ id: 5, name: 'Plâtrerie Morel et fils' }], coverages: [],
  documents: [
    { fileId: 11, title: LONG, date: '2025-04-03', directEvents: [{ id: 21, title: 'Passage de l’expert' }] },
    { fileId: 12, title: 'Facture du plafond', date: '2025-05-12', sharedWith: [{ operationId: 43, label: 'Intervention — Réparation du plafond' }] },
  ],
  eventDocuments: [{ fileId: 13, title: 'Photo du plafond', date: '2025-04-10', agendaItems: [{ id: 21, title: 'Passage de l’expert' }] }],
  relatedDocuments: [{ fileId: 14, title: 'Police d’assurance habitation', date: '2024-01-02', operationId: 44, operationLabel: 'Contrat — Assurance habitation' }],
  agendaItems: [{ id: 21, title: 'Passage de l’expert', date: '2025-04-10', shared: false }],
  relations: [{ operationId: 44, label: 'Contrat — Assurance habitation', nature: 'ASSOCIATED', direction: 'UNDIRECTED' }],
  amounts: [
    { kind: 'REALIZED_COST', count: 2, eurCents: 185000, unconverted: 1 },
    { kind: 'FORECAST_COST', count: 1, eurCents: 210000, unconverted: 0 },
    { kind: 'INDEMNITY', count: 1, eurCents: 150000, unconverted: 0 },
  ],
  factSources: [{ field: 'REALIZED', origin: 'DOCUMENT', fileId: 11, title: 'Déclaration de sinistre' }],
  conflicts: [{
    field: 'REALIZED', retained: '2025-04-02', pending: true,
    values: [
      { value: '2025-04-02', sources: [{ fileId: 11, title: 'Déclaration de sinistre' }] },
      { value: '2025-04-05', sources: [{ fileId: 12, title: 'Facture du plafond' }] },
    ],
  }],
  summary: { netCents: 35000, unconvertedCount: 1, documentCount: 2, agendaItemCount: 1, supplierNames: ['Plâtrerie Morel et fils'], period: { from: '2025-04-02', to: '2025-05-12' } },
  notes: null,
};

function Fiche() {
  return (
    <main style={{ padding: 16 }} data-testid="page-fiche">
      <ReferenceEventPageContent
        fiche={FICHE}
        openers={{
          openDocument: (id) => note(`document:${id}`), openAgendaItem: (id) => note(`evenement:${id}`), openEquipment: (id) => note(`equipement:${id}`),
          openRoom: (id) => note(`piece:${id}`), onPeriodsSaved: () => undefined,
        }}
        actions={{
          correct: () => note('corriger'), remove: () => note('supprimer'), linkAgenda: () => note('rattacher-evenement'),
          unlinkAgenda: (id) => note(`detacher-evenement:${id}`), linkDocument: () => note('rattacher-document'),
          unlinkDocument: (id) => note(`retirer-document:${id}`), moveDocument: (id) => note(`deplacer-document:${id}`),
          linkSupplier: () => note('relier-fournisseur'), unlinkSupplier: (id) => note(`retirer-fournisseur:${id}`),
          associate: () => note('associer'), dissociate: (id) => note(`dissocier:${id}`), split: () => note('scinder'), editNotes: () => note('notes'),
        }}
      />
    </main>
  );
}

const OPERATIONS: DocumentOperationRef[] = Array.from({ length: 12 }, (_, i) => ({
  id: i + 1, label: i === 0 ? `Sinistre — ${LONG}` : `Intervention — Lot de travaux ${String(i + 1).padStart(2, '0')}`, directAgendaItemIds: [],
}));

function TiroirDocument() {
  const [ops, setOps] = React.useState(OPERATIONS);
  const [aRetirer, setARetirer] = React.useState<DocumentOperationRef | null>(null);
  const [choix, setChoix] = React.useState(false);
  return (
    <Sheet open onOpenChange={() => undefined}>
      <SheetContent className="w-full sm:max-w-[520px] overflow-y-auto p-0 flex flex-col" data-testid="tiroir-document">
        <div className="relative px-7 pt-10 pb-8 border-b"><SheetTitle className="text-2xl font-extrabold leading-tight pr-6">Facture commune</SheetTitle></div>
        <div className="flex-1 px-7 py-6 space-y-6">
          <DocumentOperationsPanel operations={ops} onRemove={(o) => setARetirer(o)} onAttach={() => setChoix(true)} />
        </div>
        <DocumentOperationRemoveDialog
          operation={aRetirer} onCancel={() => { setARetirer(null); note('retrait-annule'); }}
          onConfirm={(o) => { setARetirer(null); setOps((l) => l.filter((x) => x.id !== o.id)); note(`retirer:${o.id}`); }}
        />
        <GroupingPicker
          open={choix} title={OPERATION_LINK_LABELS.pickerTitle} searchLabel={OPERATION_LINK_LABELS.pickerSearch} description={OPERATION_LINK_LABELS.pickerHint}
          note={OPERATION_LINK_LABELS.pickerHint}
          load={async (q) => [
            { id: 31, title: 'Contrat — Assurance habitation', meta: null },
            { id: 32, title: 'Intervention — Réfection de la toiture', meta: '02/04/2025' },
          ].filter((c) => c.title.toLowerCase().includes(q.toLowerCase()))}
          onClose={() => setChoix(false)}
          onPick={(c) => { setChoix(false); setOps((l) => [...l, { id: c.id, label: c.title, directAgendaItemIds: [] }]); note(`rattacher:${c.id}`); }}
        />
      </SheetContent>
    </Sheet>
  );
}

const TYPES = [{ code: 'INTERVENTION', label: 'Intervention' }, { code: 'CONTRACT', label: 'Contrat' }, { code: 'CLAIM', label: 'Sinistre' }];
const ITEMS: OperationListItem[] = Array.from({ length: 60 }, (_, i): OperationListItem => {
  const n = i + 1;
  const type = n % 10 === 0 ? TYPES[2] : n % 4 === 0 ? TYPES[1] : TYPES[0];
  return {
    id: n, title: n === 1 ? `Sinistre — ${LONG}` : `${type.label} — Lot ${String(n).padStart(2, '0')}`,
    typeCode: n === 7 ? null : type.code, typeLabel: n === 7 ? null : type.label, date: n % 9 === 0 ? null : `2025-${String((n % 12) + 1).padStart(2, '0')}-10`,
    assets: n % 5 === 0 ? [] : [{ id: 7, name: 'Maison de Lyon' }], rooms: n % 6 === 0 ? ['Cuisine'] : [], equipments: n % 8 === 0 ? ['Chaudière'] : [],
    suppliers: n % 3 === 0 ? ['Plâtrerie Morel et fils'] : [], provider: null, documentCount: n % 7, agendaItemCount: n % 3,
    contracts: n === 10 ? [{ id: 4, label: 'Contrat — Assurance habitation' }] : [], netCents: n % 11 === 0 ? null : n * 1000, unconvertedCount: n === 2 ? 1 : 0,
  };
});

function Liste() {
  const [query, setQuery] = React.useState<OperationListQuery>({ q: '', type: null, assetId: null, state: 'ALL', sort: 'DATE_DESC', page: 1, pageSize: OPERATION_LIST_PAGE_SIZE });
  const retenues = ITEMS
    .filter((i) => (query.type === null ? true : query.type === 'NONE' ? i.typeCode === null : i.typeCode === query.type))
    .filter((i) => (query.assetId === null ? true : i.assets.some((a) => a.id === query.assetId)))
    .filter((i) => (query.state === 'DATED' ? i.date !== null : query.state === 'UNDATED' ? i.date === null : query.state === 'NO_DOCUMENT' ? i.documentCount === 0 : true))
    .filter((i) => operationListMatches(operationListHaystack(i), query.q))
    .sort(compareOperationListItems(query.sort));
  const p = paginateOperationList(retenues, query.page, query.pageSize);
  const data: OperationListPage = {
    items: p.items, total: retenues.length, totalAll: ITEMS.length, page: p.page, pageSize: query.pageSize, pages: p.pages, query: { ...query, page: p.page },
    types: TYPES, assets: [{ id: 7, name: 'Maison de Lyon' }],
  };
  return (
    <main style={{ padding: 16 }} data-testid="page-liste">
      <ReferenceEventListContent data={data} onQuery={(patch) => { note(`demande:${JSON.stringify(patch)}`); setQuery((q) => ({ ...q, ...patch })); }} />
    </main>
  );
}

let root: Root | null = null;
window.__806Monter = (vue) => {
  root?.unmount();
  window.__806Gestes = [];
  window.__806Liens = [];
  root = createRoot(document.getElementById('root')!);
  flushSync(() => { root!.render(vue === 'fiche' ? <Fiche /> : vue === 'document' ? <TiroirDocument /> : <Liste />); });
};
