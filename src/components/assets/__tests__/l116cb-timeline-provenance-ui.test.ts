/**
 * Carte #806 §6 (lot 116C, seconde partie) — Timeline du bien : provenance des
 * dates DÉDUITES et zone « sans date » (rendu serveur du composant réel,
 * variantes ordinateur ET mobile).
 *
 *   L116CB-UI1  opération dont le repère est une date déduite : le fondement est dit devant la date (texte de la fiche)
 *   L116CB-UI2  opération dont le repère est une date propre : aucune mention ajoutée
 *   L116CB-UI3  événement SANS date : mention « Sans date », jamais une date ; l'ordre reçu du serveur n'est pas retrié
 *   L116CB-UI4  libellés : une seule règle, celle de la fiche (`PRESENTATION_BASIS_LABELS`)
 */
import * as React from 'react';
import { createElement as h } from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PRESENTATION_BASIS_LABELS, PRESENTATION_DATE_BASES } from '@/lib/reference-events/presentation-date';
import { TIMELINE_UNDATED_LABEL, timelineDateBasisLabel } from '@/services/agenda/timeline/labels';
import type { TimelineEntry, TimelineGroupDateBasis } from '@/services/agenda/timeline/model';

(globalThis as { React?: typeof React }).React = React;
const { AssetTimelineList } = await import('../timeline/AssetTimeline');
type State = Parameters<typeof AssetTimelineList>[0]['state'];

const element = (id: string, date: string | null, title: string): TimelineEntry => ({ kind: 'item', itemType: 'agenda', id, title, effectiveDate: date });
const operation = (n: number, date: string | null, basis: TimelineGroupDateBasis | null, title: string): TimelineEntry => ({
  kind: 'group', itemType: 'operation', id: `op-${n}`, operationId: n, title, effectiveDate: date, dateBasis: basis,
  members: [], counters: { events: 0, documents: 1, assets: 1, rooms: 0, equipments: 0 },
});
const etat = (entries: TimelineEntry[]): State => ({ mode: 'grouped', entries, nextCursor: null, rest: 0, loading: false, error: false, expanded: new Set() });
const actions = { setMode: () => undefined, loadMore: () => undefined, toggle: () => undefined };
const rendre = (entries: TimelineEntry[], variant: 'desktop' | 'mobile') =>
  renderToStaticMarkup(h(AssetTimelineList, { state: etat(entries), actions, variant, onOpenItem: () => undefined }));

/** Lignes de premier niveau, dans l'ordre du document. */
const ordre = (html: string): string[] => [...html.matchAll(/data-timeline-item="([^"]+)"/g)].map((m) => m[1]);

describe('L116CB-UI — Timeline : provenance des dates et zone « sans date » (#806 §6)', () => {
  for (const variant of ['desktop', 'mobile'] as const) {
    it(`L116CB-UI1 (${variant}) — date déduite : le fondement précède la date`, () => {
      const html = rendre([
        operation(1, '2024-03-12', 'FIRST_QUOTE', 'Travaux de toiture'),
        operation(2, '2023-01-01', 'FIRST_COVERAGE', 'Assurance habitation'),
        operation(3, '2022-11-12', 'FIRST_ORDER', 'Achat Polisport'),
      ], variant);
      expect(html).toMatch(/data-timeline-date-basis=""[^>]*>Premier devis · 12 mars 2024</);
      expect(html).toMatch(/Première couverture connue · 1 janv\. 2023</);
      expect(html).toMatch(/Date de commande · 12 nov\. 2022</);
    });

    it(`L116CB-UI2 (${variant}) — date propre : aucune mention de provenance`, () => {
      const html = rendre([operation(1, '2024-03-12', 'REALIZED', 'Révision'), operation(2, '2024-02-01', 'START', 'Contrat'), operation(3, '2024-01-05', 'PLANNED', 'Ramonage')], variant);
      expect(html).not.toContain('data-timeline-date-basis');
      expect(html).not.toContain(' · 12 mars 2024');
      expect(html).toContain('12 mars 2024');
    });

    it(`L116CB-UI3 (${variant}) — sans date : mention explicite, aucune date, ordre du serveur conservé`, () => {
      const html = rendre([
        element('30', '2025-06-01', 'Contrôle technique'),
        operation(7, '2024-03-12', 'REALIZED', 'Révision'),
        element('10', '2023-01-15', 'Ramonage'),
        operation(9, null, null, 'Sinistre sans date'),
        element('20', null, 'Entretien à prévoir'),
      ], variant);
      // L'ordre affiché est celui rendu par la lecture (date de présentation décroissante, sans date en dernier) : le
      // composant ne retrie rien, ni par opération ni autrement.
      expect(ordre(html)).toEqual(['30', 'op-7', '10', 'op-9', '20']);
      const sansDate = [...html.matchAll(/data-timeline-undated="[^"]*">([^<]*)</g)].map((m) => m[1]);
      expect(sansDate).toEqual([TIMELINE_UNDATED_LABEL, TIMELINE_UNDATED_LABEL]);
      // La ligne de l'événement sans date ne porte aucune date fabriquée.
      const ligne = html.slice(html.indexOf('data-timeline-item="20"'));
      expect(ligne).not.toMatch(/\d{4}/);
    });
  }

  it('L116CB-UI4 — une seule règle de libellé : celle de la fiche', () => {
    for (const b of PRESENTATION_DATE_BASES) expect(timelineDateBasisLabel(b)).toBe(PRESENTATION_BASIS_LABELS[b]);
    expect(timelineDateBasisLabel(null)).toBeNull();
    expect(timelineDateBasisLabel(undefined)).toBeNull();
    expect(timelineDateBasisLabel('REALIZED')).toBeNull();
  });
});
