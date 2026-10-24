/**
 * Lot 84B — CDC v5 O-3 (Agenda et navigation) : tiroirs, desktop ET mobile.
 *
 *   L84B-UI01  tiroir de l'événement de référence : les cinq catégories (AC27), relier / créer / retirer
 *   L84B-UI02  tiroir d'un élément rattaché : léger, contexte global chiffré, accès à l'événement (AC28)
 *   L84B-UI03  élément seul : relier à un élément de l'agenda (AC02) ou à un document (AC01)
 *   L84B-UI04  ensemble sans événement de référence (retrait mémorisé) : autres éléments seulement
 *   L84B-UI05  accessibilité : gestes nommés, cibles 44 px sur mobile, tiroir de choix sur le composant de base 81F
 *   L84B-UI06  câblage : AgendaItemDrawer (même tiroir desktop / mobile) et DocumentDrawer (§14.4)
 */
import * as React from 'react';
import { createElement as h } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgendaGroupingView } from '@/lib/agenda/grouping-view';

(globalThis as { React?: typeof React }).React = React;
const { AgendaGroupingPanel, MAIN_CATEGORIES } = await import('../AgendaGroupingPanel');

const lire = (p: string) => readFileSync(resolve(__dirname, '..', '..', '..', p), 'utf8').replace(/\r\n?/g, '\n');
const rien = () => undefined;
const rendre = (view: AgendaGroupingView) => renderToStaticMarkup(h(AgendaGroupingPanel, {
  view, onAction: rien, onPick: rien, onCreateStep: rien, onRelease: rien, onOpenMain: rien,
}));

const principal: AgendaGroupingView = {
  itemId: 1, role: 'MAIN', linkedDocuments: [], main: null, mainWithdrawn: false, counts: null,
  ensemble: {
    items: [{ id: 2, title: 'Visite expert', startDate: '2026-03-21', isMain: false }, { id: 3, title: 'Réparation plafond', startDate: null, isMain: false }],
    documents: [{ id: 10, title: 'Rapport d’expertise', documentDate: '2026-03-22', link: 'DIRECT' }, { id: 11, title: 'Devis', documentDate: null, link: 'GROUP' }],
    assets: [{ id: 5, name: 'Maison' }],
    rooms: [{ id: 7, name: 'Cuisine', assetId: 5 }],
    equipments: [],
  },
};

describe('L84B-UI01 — tiroir de l’événement de référence (AC27)', () => {
  const html = rendre(principal);
  it('les cinq catégories du CDC §14.2, dans l’ordre, avec leurs éléments', () => {
    expect(MAIN_CATEGORIES).toEqual(['elements', 'documents', 'biens', 'pieces', 'equipements']);
    const ordre = ['Étapes et rendez-vous (2)', 'Documents (2)', 'Biens (1)', 'Pièces (1)', 'Équipements'].map((t) => html.indexOf(t));
    expect(ordre.every((i) => i > 0)).toBe(true);
    expect([...ordre].sort((a, b) => a - b)).toEqual(ordre);
    for (const t of ['Visite expert', 'Réparation plafond', 'Rapport d’expertise', 'Devis', 'Maison', 'Cuisine', 'Aucun équipement.']) expect(html).toContain(t);
    expect(html).toContain('data-role="reference"');
    expect(html).toContain('Événement de référence');
  });
  it('relier pour chaque catégorie, créer une étape, retirer chaque objet, retirer le rôle', () => {
    for (const k of MAIN_CATEGORIES) expect(html).toContain(`data-testid="regroupement-relier-${k}"`);
    expect(html).toContain('data-testid="regroupement-creer-etape"');
    for (const t of ['Visite expert', 'Maison', 'Cuisine']) expect(html).toContain(`aria-label="Retirer « ${t} »"`);
    // Lot 86D : pour un document, « retirer de l’ensemble » est distingué de « détacher de cet événement ».
    expect(html).toContain('aria-label="Retirer « Rapport d’expertise » de l’ensemble"');
    expect(html).toContain('Ne plus en faire l’événement de référence');
  });
  it('lien précis signalé (§7.3), lien seulement par l’ensemble sans pastille', () => {
    const rapport = html.slice(html.indexOf('data-testid="regroupement-documents-10"'), html.indexOf('data-testid="regroupement-documents-11"'));
    expect(rapport).toContain('Lien direct');
    const devis = html.slice(html.indexOf('data-testid="regroupement-documents-11"'), html.indexOf('data-testid="regroupement-categorie-biens"'));
    expect(devis).not.toContain('Lien direct');
  });
});

describe('L84B-UI02 — tiroir d’un élément rattaché : léger (AC28)', () => {
  const html = rendre({
    itemId: 2, role: 'MEMBER', linkedDocuments: [], mainWithdrawn: false, ensemble: null,
    main: { id: 1, title: 'Dégât des eaux', startDate: '2026-03-12' },
    counts: { items: 2, documents: 5, assets: 1, rooms: 1, equipments: 0 },
  });
  it('contexte global + accès à l’événement de référence, jamais tout l’ensemble', () => {
    expect(html).toContain('Fait partie de');
    expect(html).toContain('Dégât des eaux');
    expect(html).toContain('2 étapes · 5 documents · 1 bien · 1 pièce');
    expect(html).toContain('Voir l’ensemble');
    expect(html).toContain('data-testid="regroupement-reference"');
    expect(html).not.toContain('data-testid="regroupement-categorie-');
    expect(html).not.toContain('Retirer «');
  });
  it('gestes propres : en faire l’événement de référence, retirer de l’ensemble', () => {
    expect(html).toContain('En faire l’événement de référence');
    expect(html).toContain('Retirer de cet ensemble');
  });
});

describe('L84B-UI03 / UI04 — élément seul ; ensemble sans événement de référence', () => {
  it('élément seul : relier un élément de l’agenda (AC02) ou un document (AC01)', () => {
    const html = rendre({ itemId: 9, role: 'NONE', linkedDocuments: [], main: null, mainWithdrawn: false, ensemble: null, counts: null });
    expect(html).toContain('Relier un élément de l’agenda');
    expect(html).toContain('Relier un document');
    expect(html).toContain('data-role="seul"');
  });
  it('retrait mémorisé : mention, autres éléments, désignation possible par l’utilisateur', () => {
    const html = rendre({
      itemId: 1, role: 'MEMBER', linkedDocuments: [], main: null, mainWithdrawn: true, counts: null,
      ensemble: { items: [{ id: 2, title: 'Visite expert', startDate: '2026-03-21', isMain: false }], documents: [], assets: [], rooms: [], equipments: [] },
    });
    expect(html).toContain('Aucun événement de référence : vous l’avez retiré.');
    expect(html).toContain('Visite expert');
    expect(html).toContain('En faire l’événement de référence');
  });
});

describe('L84B-UI05 — accessibilité, mobile', () => {
  const src = lire('components/agenda/AgendaGroupingSection.tsx');
  const panneau = lire('components/agenda/AgendaGroupingPanel.tsx');
  it('cibles tactiles 44 px sur mobile (min-h-11 / size-11), 32 px sur desktop', () => {
    expect(rendre(principal)).toMatch(/min-h-11 sm:min-h-8/);
    expect(rendre(principal)).toMatch(/size-11 sm:size-8/);
  });
  it('tiroir de choix : composant de base (zones sûres, « Fermer », retour Android), pleine largeur sur mobile, titre et description', () => {
    expect(panneau).toMatch(/from "@\/components\/ui\/sheet"/);
    expect(panneau).toContain('<SheetContent className="w-full sm:max-w-[440px]');
    expect(panneau).toContain('<SheetTitle>{title}</SheetTitle>');
    expect(panneau).toContain('<SheetDescription className="sr-only">');
    expect(panneau).not.toMatch(/side=["']bottom/);
    expect(panneau).toContain('aria-label={L.search}');
  });
  it('retrait du rôle : confirmation explicite (rien n’est supprimé, jamais rétabli de soi-même)', () => {
    expect(src).toContain('<AlertDialogTitle>{L.releaseTitle}</AlertDialogTitle>');
    expect(src).toContain('void agir("retirer-reference")');
  });
  it('garde d’écriture partagée avant tout geste ; ouverture empilée de l’événement de référence', () => {
    expect(src).toContain('const autorise = () => { let ok = false; garder(() => { ok = true; }); return ok; };');
    expect(src).toContain('openDrawer({ kind: "echeance", id }, { stack: true })');
  });
});

describe('L84B-UI06 — câblage des tiroirs', () => {
  it('AgendaItemDrawer : section en consultation, relecture sans fermeture, même tiroir desktop / mobile', () => {
    const d = lire('components/agenda/AgendaItemDrawer.tsx');
    expect(d).toContain('<AgendaGroupingSection');
    expect(d).toContain('onChanged={refreshItem}');
    expect(d).toContain('className="w-full sm:max-w-[520px]');
    // Lot 86D : en consultation, le regroupement présente les documents de l'élément quel que soit son rôle.
    expect(d).toContain('item.fileLinks.length > 0 && mode === "edit" && groupingRole !== "MAIN"');
  });
  it('DocumentDrawer : événement de référence et lien précis distingués ; lien manuel vers un élément (AC01)', () => {
    const d = lire('components/assets/DocumentDrawer.tsx');
    expect(d).toContain('/api/documents/${doc.id}/agenda-liens');
    expect(d).toContain('GROUPING_LABELS.mainBadge');
    expect(d).toContain('GROUPING_LABELS.directLink');
    expect(d).toContain('data-testid="document-relier-agenda"');
    expect(d).toContain('garder(() => setAgendaPickerOpen(true))');
  });
  it('CreateAgendaItemDrawer : « créer une étape » relie l’élément créé (callback facultatif)', () => {
    const c = lire('components/agenda/CreateAgendaItemDrawer.tsx');
    expect(c).toContain('if (onCreated && typeof created?.item?.id === "number") await onCreated(created.item.id);');
  });
});
