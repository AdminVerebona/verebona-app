/**
 * Carte Trello #806, volet B §7 et §8 — nature des liens documentaires et faits qualifiés de la fiche d'une
 * opération ; tiroir du document. Tests purs et rendus côté serveur (même composant ordinateur et mobile).
 *
 *   L116CB-U01  textes nouveaux : « opération », jamais « événement de référence » ; aucun état, aucun mot de pipeline
 *   L116CB-U02  un document n'est listé qu'UNE fois (membre > événement > opération associée) ; sous-titre d'un membre
 *   L116CB-U03  fiche rendue : quatre natures distinctes, gestes seulement sur les membres, phrase d'aide
 *   L116CB-U04  fiche rendue : type, pièces, montants par nature (jamais additionnés entre natures), source de chaque
 *               fait, valeurs différentes, liens vers l'Agenda, « À traiter » et les documents ; aucun titre coupé
 *   L116CB-U05  montants par nature : devises non converties comptées à part, ordre stable, aucune ligne inventée
 *   L116CB-U06  tiroir du document : toutes les opérations, « Retirer » et « Rattacher » nommés, cibles de 44 px,
 *               consultation seule sans bouton ; charte (jetons de couleur seulement)
 */
import * as React from 'react';
import { createElement as h } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { OPERATION_FACT_LABELS, OPERATION_NAV_ROUTES, operationAmountsOf, operationFactValueText } from '../operation-facts';
import { OPERATION_LINK_LABELS, dedupeOperationDocuments, memberDocumentSubtitle } from '../operation-links';
import type { ReferenceEventPageView } from '@/services/business-operations/graph/reference-event-page';
import { TEXTES_806 } from './textes-806';

(globalThis as { React?: typeof React }).React = React;
const { ReferenceEventPageContent } = await import('@/components/reference-events/ReferenceEventPageContent');
const { DocumentOperationsPanel } = await import('@/components/documents/DocumentOperations');

const lire = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n?/g, '\n');
const visible = (s: string) => s.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*|import )/.test(l)).map((l) => l.replace(/\{\/\*.*?\*\/\}/g, '')).join('\n');

const fiche = (over: Partial<ReferenceEventPageView> = {}): ReferenceEventPageView => ({
  id: 42, redirectedFrom: null, version: 3, title: 'Sinistre — Dégât des eaux', ownLabel: 'Dégât des eaux', typeCode: 'CLAIM', typeLabel: 'Sinistre', provider: 'Plomberie Durand',
  dates: [{ role: 'REALIZED', date: '2025-04-02' }], undated: false, declarations: [],
  assets: [{ id: 7, name: 'Maison de Lyon' }], equipments: [], suppliers: [], coverages: [],
  rooms: [{ id: 31, name: 'Cuisine', assetId: 7, assetName: 'Maison de Lyon' }],
  documents: [
    { fileId: 11, title: 'Déclaration de sinistre', date: '2025-04-03', directEvents: [{ id: 21, title: 'Passage de l’expert' }] },
    { fileId: 12, title: 'Facture du plafond', date: '2025-05-12', sharedWith: [{ operationId: 43, label: 'Intervention — Réparation du plafond' }] },
  ],
  eventDocuments: [{ fileId: 13, title: 'Photo du plafond', date: '2025-04-10', agendaItems: [{ id: 21, title: 'Passage de l’expert' }] }],
  relatedDocuments: [{ fileId: 14, title: 'Police d’assurance', date: '2024-01-02', operationId: 44, operationLabel: 'Contrat — Assurance habitation' }],
  agendaItems: [{ id: 21, title: 'Passage de l’expert', date: '2025-04-10', shared: false }],
  relations: [{ operationId: 44, label: 'Contrat — Assurance habitation', nature: 'ASSOCIATED', direction: 'UNDIRECTED' }],
  amounts: [
    { kind: 'REALIZED_COST', count: 2, eurCents: 185000, unconverted: 1 },
    { kind: 'FORECAST_COST', count: 1, eurCents: 210000, unconverted: 0 },
    { kind: 'INDEMNITY', count: 1, eurCents: 150000, unconverted: 0 },
  ],
  factSources: [
    { field: 'REALIZED', origin: 'DOCUMENT', fileId: 11, title: 'Déclaration de sinistre' },
    { field: 'PROVIDER', origin: 'USER', fileId: null, title: null },
  ],
  conflicts: [{
    field: 'REALIZED', retained: '2025-04-02', pending: true,
    values: [
      { value: '2025-04-02', sources: [{ fileId: 11, title: 'Déclaration de sinistre' }] },
      { value: '2025-04-05', sources: [{ fileId: 12, title: 'Facture du plafond' }] },
    ],
  }],
  ...over,
});
const openers = { openDocument: () => undefined, openAgendaItem: () => undefined, openEquipment: () => undefined, openRoom: () => undefined, onPeriodsSaved: () => undefined };
const rien = () => undefined;
const actions = {
  correct: rien, remove: rien, linkAgenda: rien, unlinkAgenda: rien, linkDocument: rien, unlinkDocument: rien, moveDocument: rien,
  linkSupplier: rien, unlinkSupplier: rien, associate: rien, dissociate: rien,
};
const rendre = (f: ReferenceEventPageView, gestes = false) => renderToStaticMarkup(h(ReferenceEventPageContent, { fiche: f, openers, ...(gestes ? { actions } : {}) }));

describe('L116CB-U01 — textes nouveaux de la carte #806 (volet B)', () => {
  it('disent « opération », jamais « événement de référence » ; aucun état, aucune progression', () => {
    const fonctions = [
      OPERATION_LINK_LABELS.sharedWith(['A']), OPERATION_LINK_LABELS.sharedWith(['A', 'B']), OPERATION_LINK_LABELS.directToEvents(['E']),
      OPERATION_LINK_LABELS.directToEvents(['E', 'F']), OPERATION_LINK_LABELS.related('C'), OPERATION_LINK_LABELS.open('C'), OPERATION_LINK_LABELS.removeAria('C'),
      OPERATION_FACT_LABELS.amountUnconverted(1), OPERATION_FACT_LABELS.amountUnconverted(3), OPERATION_FACT_LABELS.sourceDocument('D'), OPERATION_FACT_LABELS.openSource('D'),
    ];
    for (const t of [...TEXTES_806, ...fonctions]) {
      expect(t, t).not.toMatch(/événement de référence|élément de référence|Statut|En cours|Envisagé|Annulé|pipeline|progression/i);
      expect(t.length, t).toBeGreaterThan(0);
    }
    expect([...TEXTES_806, ...fonctions].filter((t) => /opération/.test(t)).length).toBeGreaterThan(10);
    // Retirer dit ce qui reste ; associer n'est jamais dit « fusionner ».
    expect(OPERATION_LINK_LABELS.removeBody).toMatch(/Seul ce lien est retiré/);
    expect(OPERATION_LINK_LABELS.removeBody).toMatch(/ses autres opérations et ses liens directs/);
    expect(JSON.stringify(TEXTES_806)).not.toMatch(/fusionn|Déplacer/i);
  });
  it('écrans voisins : adresses existantes', () => {
    expect(OPERATION_NAV_ROUTES).toEqual({ operations: '/agenda/evenements-reference', agenda: '/agenda', toProcess: '/accueil/a-traiter', documents: '/documents' });
    expect(lire('src/components/shell/AppSidebar.tsx')).toContain("href: '/accueil/a-traiter'");
  });
});

describe('L116CB-U02 — un document n’est listé qu’une fois', () => {
  it('membre, sinon lié à un événement, sinon porté par l’opération associée', () => {
    const r = dedupeOperationDocuments(
      [{ fileId: 1 }, { fileId: 2 }], [{ fileId: 2 }, { fileId: 3 }, { fileId: 3 }], [{ fileId: 1 }, { fileId: 3 }, { fileId: 4 }],
    );
    expect(r.members.map((d) => d.fileId)).toEqual([1, 2]);
    expect(r.events.map((d) => d.fileId)).toEqual([3]);
    expect(r.related.map((d) => d.fileId)).toEqual([4]);
  });
  it('sous-titre d’un justificatif : appartenance, partage, lien direct', () => {
    expect(memberDocumentSubtitle(undefined, undefined)).toBe('Appartient à cette opération');
    expect(memberDocumentSubtitle([{ operationId: 2, label: 'Intervention — Toiture' }], [])).toBe('Appartient à cette opération · Justificatif partagé avec l’opération « Intervention — Toiture »');
    expect(memberDocumentSubtitle([{ operationId: 2, label: 'A' }, { operationId: 3, label: 'B' }], [{ title: 'Visite' }]))
      .toBe('Appartient à cette opération · Justificatif partagé avec 2 autres opérations · Lié directement à l’événement « Visite »');
  });
});

describe('L116CB-U03 — fiche : quatre natures distinctes, sans doublon', () => {
  const html = rendre(fiche(), true);
  it('une rubrique, quatre lignes, chacune sa nature', () => {
    expect(html.match(/data-document-nature="MEMBER"/g)).toHaveLength(2);
    expect(html.match(/data-document-nature="EVENT"/g)).toHaveLength(1);
    expect(html.match(/data-document-nature="RELATED"/g)).toHaveLength(1);
    expect(html).toMatch(/Déclaration de sinistre.*Appartient à cette opération · Lié directement à l’événement « Passage de l’expert »/);
    expect(html).toMatch(/Facture du plafond.*Justificatif partagé avec l’opération « Intervention — Réparation du plafond »/);
    expect(html).toMatch(/Photo du plafond.*Lié directement à l’événement « Passage de l’expert »/);
    expect(html).toMatch(/Police d’assurance.*Document de l’opération associée « Contrat — Assurance habitation »/);
    // Le compte de la rubrique est celui des lignes (4), chaque document une seule fois.
    expect(html).toMatch(/data-testid="reference-event-page-documents"[\s\S]*?\(4\)/);
    for (const titre of ['Déclaration de sinistre', 'Facture du plafond', 'Photo du plafond', 'Police d’assurance']) {
      expect(html.split(`aria-label="Ouvrir le document : ${titre}"`).length - 1, titre).toBe(1);
    }
    expect(html).toContain(OPERATION_LINK_LABELS.mixedHint);
  });
  it('« Retirer » seulement sur les justificatifs de l’opération : jamais sur un document lié à un événement ou porté par une autre opération', () => {
    expect(html).toContain('data-testid="reference-event-unlink-document-11"');
    expect(html).toContain('data-testid="reference-event-unlink-document-12"');
    expect(html).not.toContain('data-testid="reference-event-unlink-document-13"');
    expect(html).not.toContain('data-testid="reference-event-unlink-document-14"');
  });
  it('lecture antérieure (rubriques nouvelles absentes) : la fiche se rend comme avant, sans phrase d’aide', () => {
    const { eventDocuments: _e, relatedDocuments: _r, rooms: _p, amounts: _a, factSources: _s, conflicts: _c, typeLabel: _t, ...ancienne } = fiche();
    const h2 = rendre({ ...ancienne, documents: [{ fileId: 11, title: 'Déclaration de sinistre', date: '2025-04-03' }] });
    expect(h2.match(/data-document-nature=/g)).toHaveLength(1);
    expect(h2).not.toContain(OPERATION_LINK_LABELS.mixedHint);
    for (const id of ['rooms', 'amounts', 'conflicts', 'type']) expect(h2, id).not.toContain(`data-testid="reference-event-page-${id}"`);
  });
});

describe('L116CB-U04 — fiche : type, pièces, montants, sources, valeurs différentes, écrans voisins', () => {
  const html = rendre(fiche());
  it('type nommé ; type non qualifié : rien (jamais « Dépense » par défaut)', () => {
    expect(html).toMatch(/data-testid="reference-event-page-type"[^>]*>Type : <span[^>]*>Sinistre<\/span>/);
    expect(rendre(fiche({ typeCode: null, typeLabel: null }))).not.toContain('data-testid="reference-event-page-type"');
  });
  it('pièces : nommées avec leur bien, ouvrables', () => {
    expect(html).toMatch(/data-testid="reference-event-page-rooms"[\s\S]*?data-reference-event-room="31"[\s\S]*?Cuisine[\s\S]*?Maison de Lyon/);
    expect(rendre(fiche({ rooms: [] }))).not.toContain('data-testid="reference-event-page-rooms"');
  });
  it('montants par nature : chaque nature sa ligne, jamais un total entre natures ; devise non convertie dite', () => {
    expect(html).toMatch(/data-amount-kind="REALIZED_COST"[\s\S]*?Coûts réalisés[\s\S]*?1[\s  ]850,00[\s  ]€[\s\S]*?1 montant dans une autre devise, non converti/);
    expect(html).toMatch(/data-amount-kind="FORECAST_COST"[\s\S]*?2[\s  ]100,00[\s  ]€/);
    expect(html).toMatch(/data-amount-kind="INDEMNITY"[\s\S]*?1[\s  ]500,00[\s  ]€/);
    // 1 850 + 2 100 = 3 950 ; 1 850 − 1 500 = 350 : aucun de ces totaux n'est fabriqué par la rubrique.
    const rubrique = html.slice(html.indexOf('data-testid="reference-event-page-amounts"'), html.indexOf('data-testid="reference-event-page-conflicts"'));
    expect(rubrique).not.toMatch(/3[\s  ]950|350,00/);
    expect(rubrique).toContain(OPERATION_FACT_LABELS.amountsNote);
    expect(rendre(fiche({ amounts: [] }))).not.toContain('data-testid="reference-event-page-amounts"');
  });
  it('source de chaque fait : justificatif ouvrable ou saisie de l’utilisateur', () => {
    expect(html).toMatch(/data-date-role="REALIZED"[\s\S]*?aria-label="Ouvrir le justificatif source : Déclaration de sinistre"[^>]*data-fact-source="REALIZED"[^>]*>Source : Déclaration de sinistre/);
    expect(html).toMatch(/data-testid="reference-event-page-provider"[\s\S]*?data-fact-source="PROVIDER"[^>]*>Source : votre saisie/);
  });
  it('valeurs différentes : les deux valeurs, leurs justificatifs, la valeur affichée désignée', () => {
    const bloc = html.slice(html.indexOf('data-testid="reference-event-page-conflicts"'));
    expect(bloc).toMatch(/Date de réalisation[\s\S]*?02\/04\/2025[\s\S]*?\(valeur affichée\)[\s\S]*?Déclaration de sinistre[\s\S]*?05\/04\/2025[\s\S]*?Facture du plafond/);
    expect(bloc.split('(valeur affichée)').length - 1).toBe(1);
    // Écart à confirmer : la fiche le dit et mène à « À traiter » ; différence déjà qualifiée : consultable, sans renvoi.
    expect(bloc).toMatch(/data-conflict-pending="REALIZED"[\s\S]*?href="\/accueil\/a-traiter"/);
    const qualifie = rendre(fiche({ conflicts: fiche().conflicts!.map((c) => ({ ...c, pending: false })) }));
    expect(qualifie).toContain('data-testid="reference-event-page-conflicts"');
    expect(qualifie).not.toContain('data-conflict-pending');
    expect(operationFactValueText('2025-04-05')).toBe('05/04/2025');
    expect(operationFactValueText('Plomberie Durand')).toBe('Plomberie Durand');
  });
  it('parcours : vrais liens vers l’Agenda, « À traiter » et les documents', () => {
    const nav = html.slice(html.indexOf('data-testid="reference-event-page-nav"'));
    for (const href of ['/agenda/evenements-reference', '/agenda', '/accueil/a-traiter', '/documents']) expect(nav, href).toContain(`href="${href}"`);
  });
  it('aucun intitulé coupé : les lignes passent à la ligne (plus de troncature)', () => {
    const code = visible(lire('src/components/reference-events/ReferenceEventPageContent.tsx'));
    expect(code).not.toMatch(/\btruncate\b|line-clamp/);
    expect(code).toContain('[overflow-wrap:anywhere]');
  });
});

describe('L116CB-U05 — montants par nature (pur)', () => {
  it('somme par nature, devise sans contre-valeur comptée à part, ordre stable, rien d’inventé', () => {
    const r = operationAmountsOf([
      { kind: 'INDEMNITY', amountMinor: 50000, currency: 'EUR', amountEurCents: 50000 },
      { kind: 'REALIZED_COST', amountMinor: 120000, currency: 'EUR', amountEurCents: null },
      { kind: 'REALIZED_COST', amountMinor: 50000, currency: 'CHF', amountEurCents: null },
      { kind: 'REALIZED_COST', amountMinor: 30000, currency: 'CHF', amountEurCents: 31000 },
      { kind: 'FORECAST_COST', amountMinor: 90000, currency: 'USD', amountEurCents: null },
    ]);
    expect(r).toEqual([
      { kind: 'REALIZED_COST', count: 3, eurCents: 151000, unconverted: 1 },
      { kind: 'FORECAST_COST', count: 1, eurCents: null, unconverted: 1 },
      { kind: 'INDEMNITY', count: 1, eurCents: 50000, unconverted: 0 },
    ]);
    expect(operationAmountsOf([])).toEqual([]);
  });
});

describe('L116CB-U06 — tiroir du document : ses opérations', () => {
  const ops = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, label: `Intervention — Lot ${i + 1}`, directAgendaItemIds: [] }));
  it('toutes les opérations, chacune ouvrable et retirable par un bouton nommé ; « Rattacher à une opération »', () => {
    const html = renderToStaticMarkup(h(DocumentOperationsPanel, { operations: ops, onRemove: rien, onAttach: rien }));
    expect(html.match(/data-testid="document-operation-\d+"/g)).toHaveLength(12);
    expect(html).toContain('Opérations (12)');
    expect(html).toContain('href="/agenda/evenements-reference/12"');
    expect(html).toContain('aria-label="Ouvrir l’opération « Intervention — Lot 12 »"');
    expect(html).toContain('aria-label="Retirer ce document de l’opération « Intervention — Lot 12 »"');
    expect(html).toMatch(/data-testid="document-operation-rattacher"[^>]*>[\s\S]*?Rattacher à une opération/);
    // Cibles tactiles de 44 px sur mobile.
    expect(html).toMatch(/size-11[^"]*sm:size-8/);
    expect(html).toMatch(/min-h-11/);
  });
  it('aucune opération : le tiroir le dit et propose de rattacher ; consultation seule : aucun bouton d’écriture', () => {
    const vide = renderToStaticMarkup(h(DocumentOperationsPanel, { operations: [], onRemove: rien, onAttach: rien }));
    expect(vide).toContain(OPERATION_LINK_LABELS.drawerEmpty);
    expect(vide).toContain('data-testid="document-operation-rattacher"');
    const lecture = renderToStaticMarkup(h(DocumentOperationsPanel, { operations: ops.slice(0, 2) }));
    expect(lecture).not.toMatch(/document-operation-retirer|document-operation-rattacher/);
    expect(renderToStaticMarkup(h(DocumentOperationsPanel, { operations: [] }))).toBe('');
  });
  it('charte Sérénité : jetons de couleur seulement, aucun « Déplacer », aucune écriture hors des routes gardées', () => {
    for (const p of ['src/components/documents/DocumentOperations.tsx', 'src/lib/reference-events/operation-links.ts', 'src/lib/reference-events/operation-facts.ts']) {
      const code = visible(lire(p));
      expect(code, p).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|\b(?:text|bg|border)-(?:red|green|blue|gray|slate|amber|yellow|orange|emerald|zinc|neutral)-\d{2,3}\b/);
      expect(code, p).not.toMatch(/\buppercase\b|Déplacer|événement de référence/);
    }
    const composant = lire('src/components/documents/DocumentOperations.tsx');
    expect(composant).toContain('apiClient.delete<EcritureReponse>(`/api/evenements-reference/${o.id}/documents?fileId=${documentId}`)');
    expect(composant).toContain('apiClient.post<EcritureReponse>(`/api/evenements-reference/${operationId}/documents`, { fileId: documentId })');
    expect(composant).toContain('garder(() => setARetirer(o))');
    // Le tiroir du document signale le lien direct hors opération, et ne coupe plus la liste des opérations à dix.
    expect(lire('src/components/assets/DocumentDrawer.tsx')).toContain('OPERATION_LINK_LABELS.outsideOperation');
    expect(lire('src/services/documents/business-period-surfaces.ts')).not.toMatch(/ORDER BY o\.id LIMIT 10/);
  });
});
