/**
 * Lot 111R — Timeline du bien (desktop ET mobile, même composant) : mention
 * d'état issue du statut effectif CANONIQUE reçu du serveur ; rafraîchissement
 * sur les événements qui changent une preuve.
 *
 *   L111R-UI1  « réalisé », « statut à confirmer », « date échue » ; rien pour « à venir »
 *   L111R-UI2  groupe et éléments liés (mode Regroupée), desktop et mobile
 *   L111R-UI3  abonnement : agenda-mutated, document-deleted, analyse terminée ; regroupé ; désinscription
 *   L111R-UI4  vues abonnées : fiche du bien (Timeline), onglet Agenda du bien, Mon agenda ; tiroir équipement
 */
import * as React from 'react';
import { createElement as h } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TimelineEntry, TimelineItemView } from '@/services/agenda/timeline/model';
import type { EffectiveStatus } from '@/services/agenda/AgendaDomainService';

(globalThis as { React?: typeof React }).React = React;
const { AssetTimelineList } = await import('../timeline/AssetTimeline');
type State = Parameters<typeof AssetTimelineList>[0]['state'];

const lire = (p: string) => readFileSync(resolve(__dirname, '..', '..', '..', p), 'utf8');
const item = (id: string, title: string, s: EffectiveStatus): TimelineItemView => ({
  itemType: 'agenda', id, title, effectiveDate: '2026-04-04', effectiveStatus: s,
  isDone: s === 'realise', isOverdue: s === 'en_retard', toConfirm: s === 'a_confirmer',
});
const groupe: TimelineEntry = {
  kind: 'group', ...item('11', 'Achat — Draisienne', 'realise'),
  members: [item('21', 'Garantie', 'a_confirmer'), item('22', 'Révision', 'en_retard')],
  counters: { events: 2, documents: 1, assets: 1, rooms: 0, equipments: 0 },
};
const etat = (p: Partial<State> = {}): State => ({
  mode: 'grouped', entries: [{ kind: 'item', ...item('10', 'Contrôle', 'a_venir') }, groupe],
  nextCursor: null, rest: 0, loading: false, error: false, expanded: new Set(['11']), ...p,
});
const actions = { setMode: () => undefined, loadMore: () => undefined, toggle: () => undefined };
const rendre = (state: State, variant: 'desktop' | 'mobile') =>
  renderToStaticMarkup(h(AssetTimelineList, { state, actions, variant, onOpenItem: () => undefined }));
/** Fragment HTML de la ligne d'un élément (jusqu'à la ligne suivante). */
const ligne = (html: string, id: string) => {
  const i = html.indexOf(`data-timeline-item="${id}"`);
  const j = html.indexOf('data-timeline-item="', i + 1);
  return html.slice(i, j < 0 ? undefined : j);
};

describe('L111R-UI — Timeline : statut effectif affiché', () => {
  it('L111R-UI1/UI2 — desktop et mobile : groupe et membres, libellés partagés', () => {
    for (const v of ['desktop', 'mobile'] as const) {
      const html = rendre(etat(), v);
      expect(ligne(html, '11'), v).toContain(' · réalisé');
      expect(ligne(html, '11'), v).toContain('data-timeline-status="realise"');
      expect(ligne(html, '11'), v).not.toContain('statut à confirmer');
      expect(ligne(html, '21'), v).toContain(' · statut à confirmer');
      expect(ligne(html, '22'), v).toContain(' · date échue');
      expect(ligne(html, '10'), v).not.toMatch(/ · (réalisé|date échue|statut à confirmer)/);
      expect(html, v).not.toMatch(/Opération/);
    }
  });

  it('L111R-UI1 — réponse antérieure sans statut effectif : repli sur les indicateurs', () => {
    const ancien = { ...item('30', 'Ancien', 'a_confirmer') } as Partial<TimelineItemView>;
    delete ancien.effectiveStatus;
    const html = rendre(etat({ entries: [{ kind: 'item', ...(ancien as TimelineItemView) }] }), 'desktop');
    expect(html).toContain(' · statut à confirmer');
  });
});

describe('L111R-UI3/UI4 — rafraîchissement après changement de statut ou de preuve', () => {
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
    // Tiroir équipement : « Réalisé » aussi sur preuve (statut effectif).
    expect(lire('components/assets/EquipmentDrawer.tsx')).toContain("item.manualStatus === 'realise' || item.effectiveStatus === 'realise'");
  });
});
