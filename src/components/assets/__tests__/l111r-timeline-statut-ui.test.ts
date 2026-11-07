/**
 * Lot 111R — Timeline du bien (desktop ET mobile, même composant) ;
 * rafraîchissement sur les événements qui changent un document lié.
 *
 * #715 (lot 113P) : plus de statut d'événement — L111R-UI1 / UI2 (« réalisé »,
 * « statut à confirmer », « date échue ») sont REMPLACÉS par l'assertion
 * inverse : aucune mention d'état, aucune couleur d'état, desktop et mobile.
 *
 *   L113P-UI1  aucune mention / couleur d'état (groupe et membres, deux variantes)
 *   L111R-UI3  abonnement : agenda-mutated, document-deleted, analyse terminée ; regroupé ; désinscription
 *   L111R-UI4  vues abonnées : fiche du bien (Timeline), onglet Agenda du bien, Mon agenda
 */
import * as React from 'react';
import { createElement as h } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TimelineEntry, TimelineItemView } from '@/services/agenda/timeline/model';

(globalThis as { React?: typeof React }).React = React;
const { AssetTimelineList } = await import('../timeline/AssetTimeline');
type State = Parameters<typeof AssetTimelineList>[0]['state'];

const lire = (p: string) => readFileSync(resolve(__dirname, '..', '..', '..', p), 'utf8');
const item = (id: string, title: string, date = '2026-04-04'): TimelineItemView => ({
  itemType: 'agenda', id, title, effectiveDate: date,
});
const groupe: TimelineEntry = {
  kind: 'group', ...item('11', 'Achat — Draisienne', '2020-01-02'),
  members: [item('21', 'Garantie', '2021-05-01'), item('22', 'Révision', '2099-01-01')],
  counters: { events: 2, documents: 1, assets: 1, rooms: 0, equipments: 0 },
};
const etat = (p: Partial<State> = {}): State => ({
  mode: 'grouped', entries: [{ kind: 'item', ...item('10', 'Contrôle') }, groupe],
  nextCursor: null, rest: 0, loading: false, error: false, expanded: new Set(['11']), ...p,
});
const actions = { setMode: () => undefined, loadMore: () => undefined, toggle: () => undefined };
const rendre = (state: State, variant: 'desktop' | 'mobile') =>
  renderToStaticMarkup(h(AssetTimelineList, { state, actions, variant, onOpenItem: () => undefined }));

describe('L113P-UI1 — Timeline : aucun statut d’événement (#715)', () => {
  it('desktop et mobile : ni « réalisé », ni « date échue », ni « à confirmer », ni « à venir », ni couleur d’état', () => {
    for (const v of ['desktop', 'mobile'] as const) {
      const html = rendre(etat(), v);
      expect(html, v).not.toMatch(/réalisé|date échue|à confirmer|à venir|annulé|en retard/i);
      expect(html, v).not.toContain('data-timeline-status');
      expect(html, v).not.toMatch(/bg-destructive|--badge-todo/);
      expect(html, v).toContain('Achat — Draisienne');
      expect(html, v).not.toMatch(/Opération/);
    }
  });
});

describe('L111R-UI3/UI4 — rafraîchissement après changement d’un document lié', () => {
  afterEach(() => { vi.useRealTimers(); delete (globalThis as { window?: unknown }).window; });

  it('L111R-UI3 — événements écoutés, regroupés, désinscription', async () => {
    vi.useFakeTimers();
    (globalThis as { window?: unknown }).window = new EventTarget();
    const { subscribeAgendaStatusSources, AGENDA_STATUS_SOURCE_EVENTS } = await import('@/lib/agenda/agenda-status-events');
    expect([...AGENDA_STATUS_SOURCE_EVENTS]).toEqual(['agenda-mutated', 'document-deleted', 'document-analysis-complete']);
    const fn = vi.fn();
    const stop = subscribeAgendaStatusSources(fn);
    for (const e of AGENDA_STATUS_SOURCE_EVENTS) window.dispatchEvent(new Event(e));
    vi.advanceTimersByTime(300);
    expect(fn).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event('document-deleted'));
    vi.advanceTimersByTime(300);
    expect(fn).toHaveBeenCalledTimes(2);
    stop();
    window.dispatchEvent(new Event('agenda-mutated'));
    vi.advanceTimersByTime(300);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('L111R-UI4 — vues abonnées (même composant desktop / mobile)', () => {
    for (const f of ['components/assets/AssetOverviewTab.tsx', 'components/assets/AssetAgendaTab.tsx', 'app/(dashboard)/agenda/page.tsx']) {
      expect(lire(f), f).toContain('subscribeAgendaStatusSources(');
    }
    // #715 : tiroir équipement sans pastille de statut d'événement.
    expect(lire('components/assets/EquipmentDrawer.tsx')).not.toMatch(/effectiveStatus|manualStatus/);
  });
});
