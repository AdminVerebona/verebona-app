/**
 * Lot 86D — ticket P1 « Documents / Agenda » §2 : gestion bidirectionnelle,
 * desktop ET mobile (même composants), rendu réel des composants.
 *
 *   L86D-UI01  élément seul / rattaché / ensemble sans référence : « Documents de cet élément » — ouvrir, détacher, relier
 *   L86D-UI02  événement de référence : par document, « Détacher de cet élément » (lien) ET « Retirer de l’ensemble »
 *   L86D-UI03  gestes nommés, cibles 44 px sur mobile (32 px desktop), aucun mot « Opération » / « principal »
 *   L86D-UI04  câblage : tiroir de l’élément (liste propre en modification seulement, relecture après geste),
 *              tiroir du document (détacher par élément, garde d’écriture, synchronisation `agenda-mutated`)
 */
import * as React from 'react';
import { createElement as h } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgendaGroupingView, GroupingAction } from '@/lib/agenda/grouping-view';

(globalThis as { React?: typeof React }).React = React;
const { AgendaGroupingPanel } = await import('../AgendaGroupingPanel');

const lire = (p: string) => readFileSync(resolve(__dirname, '..', '..', '..', p), 'utf8').replace(/\r\n?/g, '\n');
const rien = () => undefined;
const rendre = (view: AgendaGroupingView, onAction: (a: GroupingAction, t?: number) => void = rien) => renderToStaticMarkup(h(AgendaGroupingPanel, {
  view, onAction, onPick: rien, onCreateStep: rien, onRelease: rien, onOpenMain: rien, onOpenDocument: rien,
}));
const docs = [
  { id: 10, title: 'Rapport d’expertise', documentDate: '2026-03-22', link: 'DIRECT' as const },
  { id: 11, title: 'Devis', documentDate: null, link: 'GROUP' as const },
];

describe('L86D-UI01 — « Documents de cet élément », quel que soit son rôle', () => {
  const vues: Array<[string, AgendaGroupingView]> = [
    ['seul', { itemId: 9, role: 'NONE', main: null, mainWithdrawn: false, ensemble: null, counts: null, linkedDocuments: docs }],
    ['rattache', { itemId: 2, role: 'MEMBER', mainWithdrawn: false, ensemble: null, main: { id: 1, title: 'Dégât des eaux', startDate: '2026-03-12' },
      counts: { items: 2, documents: 5, assets: 1, rooms: 0, equipments: 0 }, linkedDocuments: docs }],
    ['ensemble-sans-reference', { itemId: 3, role: 'MEMBER', main: null, mainWithdrawn: true, counts: null,
      ensemble: { items: [], documents: [], assets: [], rooms: [], equipments: [] }, linkedDocuments: docs }],
  ];
  for (const [role, vue] of vues) {
    it(`${role} : liste, ouvrir (carte), détacher chaque document, relier un document`, () => {
      const html = rendre(vue);
      expect(html).toContain(`data-role="${role}"`);
      expect(html).toContain('Documents de cet élément (2)');
      for (const d of docs) {
        expect(html).toContain(`data-testid="regroupement-document-element-${d.id}"`);
        expect(html).toContain(`aria-label="Détacher « ${d.title} » de cet élément"`);
        expect(html).toContain(`data-testid="regroupement-detacher-document-${d.id}"`);
      }
      expect(html).toContain('data-testid="regroupement-relier-documents"');
      // Détacher n'est jamais « retirer de l'ensemble » ici (le document y reste).
      expect(html).not.toContain('de l’ensemble"');
    });
  }
  it('aucun document : message vide, toujours « Relier un document »', () => {
    const html = rendre({ itemId: 9, role: 'NONE', main: null, mainWithdrawn: false, ensemble: null, counts: null, linkedDocuments: [] });
    expect(html).toContain('Documents de cet élément');
    expect(html).toContain('Aucun document.');
    expect(html).toContain('Relier un document');
  });
});

describe('L86D-UI02 — événement de référence : détacher (lien) et retirer (ensemble) distingués', () => {
  const html = rendre({
    itemId: 1, role: 'MAIN', main: null, mainWithdrawn: false, counts: null, linkedDocuments: [docs[0]],
    ensemble: { items: [], documents: [...docs, { id: 12, title: 'Facture', documentDate: null, link: null }], assets: [], rooms: [], equipments: [] },
  });
  it('document relié à l’événement : deux gestes ; document seulement membre de l’ensemble : retirer seulement', () => {
    for (const t of ['Rapport d’expertise', 'Devis']) {
      expect(html).toContain(`aria-label="Détacher « ${t} » de cet élément"`);
      expect(html).toContain(`aria-label="Retirer « ${t} » de l’ensemble"`);
    }
    expect(html).not.toContain('aria-label="Détacher « Facture » de cet élément"');
    expect(html).toContain('aria-label="Retirer « Facture » de l’ensemble"');
    // Pas de second bloc « Documents de cet élément » : la catégorie de l'ensemble les présente.
    expect(html).not.toContain('data-testid="regroupement-documents-element"');
  });
});

describe('L86D-UI03 — accessibilité, mobile, vocabulaire', () => {
  const html = rendre({ itemId: 9, role: 'NONE', main: null, mainWithdrawn: false, ensemble: null, counts: null, linkedDocuments: docs });
  it('bouton « Détacher » : vrai bouton nommé, 44 px sur mobile, 32 px desktop', () => {
    const b = html.match(/<button[^>]*data-testid="regroupement-detacher-document-10"[^>]*>/)?.[0] ?? '';
    expect(b).toContain('type="button"');
    expect(b).toContain('aria-label="Détacher « Rapport d’expertise » de cet élément"');
    expect(b).toContain('size-11 sm:size-8');
  });
  it('aucun « Opération » ni « principal » visible', () => {
    expect(html.replace(/<[^>]+>/g, ' ')).not.toMatch(/opération|principal/i);
  });
});

describe('L86D-UI04 — câblage des deux tiroirs (même composant desktop / mobile)', () => {
  it('tiroir de l’élément : la liste propre ne double plus le regroupement en consultation ; relecture après geste', () => {
    const src = lire('components/agenda/AgendaItemDrawer.tsx');
    expect(src).toContain('item.fileLinks.length > 0 && mode === "edit"');
    expect(src).toContain('onChanged={refreshItem}');
    const sec = lire('components/agenda/AgendaGroupingSection.tsx');
    expect(sec).toContain('window.dispatchEvent(new CustomEvent("agenda-mutated"))');
    expect(sec).toContain('window.addEventListener("agenda-mutated", h)');
    expect(sec).toContain('action === "detacher-document" ? L.detachedToast');
  });
  it('tiroir du document : détacher par élément (DELETE), garde d’écriture, relecture sur `agenda-mutated`', () => {
    const src = lire('components/assets/DocumentDrawer.tsx');
    expect(src).toContain('apiClient.delete(`/api/documents/${doc.id}/agenda-liens?itemId=${itemId}`)');
    expect(src).toContain('onClick={() => garder(() => { void detacherAgenda(item.id); })}');
    expect(src).toContain('aria-label={GROUPING_LABELS.detachItemFromDocument(item.title)}');
    expect(src).toContain("window.addEventListener('agenda-mutated', h)");
    expect(src).toContain('size-11 sm:size-8');
    // Ajouter / ouvrir : inchangés (84B, 85D).
    expect(src).toContain('data-testid="document-relier-agenda"');
    expect(src).toContain('onOpen={() => { void openLinkedAgendaItem(item.id); }}');
  });
});
