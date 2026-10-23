/**
 * Lot 84C — Timeline du bien : interface desktop ET mobile (CDC v5 §13,
 * AC22–AC26 ; charte Sérénité ; P1 : jamais le mot « Opération »).
 *
 *   L84C-UI1  bascule « Regroupée » / « Détaillée » : « Regroupée » active par défaut (AC22)
 *   L84C-UI2  groupe replié : principal, compteurs distincts, bouton de dépliage accessible (AC26)
 *   L84C-UI3  groupe déplié : éléments liés listés, chacun ouvrable
 *   L84C-UI4  desktop ET mobile rendus par le même composant (variantes)
 *   L84C-UI5  « Afficher plus » (curseur) et état vide
 *   L84C-UI6  mode jamais mémorisé : aucun stockage, aucune adresse, défaut « grouped » (AC24)
 *   L84C-UI7  point d'appel unique des tiroirs : tiroirs EXISTANTS, contexte transmis (84B)
 *   L84C-UI8  aucun mot « Opération » visible
 */
import * as React from 'react';
import { createElement as h } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TimelineEntry } from '@/services/agenda/timeline/model';

(globalThis as { React?: typeof React }).React = React;
const { AssetTimelineList, TimelineModeSwitch } = await import('../timeline/AssetTimeline');
type State = Parameters<typeof AssetTimelineList>[0]['state'];

const lire = (p: string) => readFileSync(resolve(__dirname, '..', '..', '..', p), 'utf8').replace(/\r\n?/g, '\n');
const item = (id: string, date: string | null, title = `Élément ${id}`) =>
  ({ itemType: 'agenda' as const, id, title, effectiveDate: date, isDone: false, isOverdue: false, toConfirm: false });
const groupe: TimelineEntry = {
  kind: 'group', ...item('11', '2026-03-12', 'Dégât des eaux'),
  members: [item('22', '2026-04-18', 'Réparation plafond'), item('21', '2026-03-21', 'Visite expert')],
  counters: { events: 2, documents: 5, assets: 1, rooms: 1, equipments: 0 },
};
const etat = (p: Partial<State> = {}): State => ({
  mode: 'grouped', entries: [{ kind: 'item', ...item('10', '2026-05-02', 'Contrôle chaudière') }, groupe],
  nextCursor: null, rest: 0, loading: false, error: false, expanded: new Set(), ...p,
});
const actions = { setMode: () => undefined, loadMore: () => undefined, toggle: () => undefined };
const rendre = (state: State, variant: 'desktop' | 'mobile' = 'desktop') =>
  renderToStaticMarkup(h(AssetTimelineList, { state, actions, variant, onOpenItem: () => undefined }));

describe('L84C-UI — Timeline du bien', () => {
  it('L84C-UI1 — bascule : « Regroupée » active, « Détaillée » disponible', () => {
    const html = renderToStaticMarkup(h(TimelineModeSwitch, { mode: 'grouped', onChange: () => undefined }));
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Affichage de la Timeline"');
    expect(html).toMatch(/aria-pressed="true"[^>]*>Regroupée</);
    expect(html).toMatch(/aria-pressed="false"[^>]*>Détaillée</);
    // Charte Sérénité : segment actif en pétrole plein.
    expect(html).toContain('bg-[color:var(--accent)] text-[color:var(--on-accent)]');
  });

  it('L84C-UI2 — groupe replié : principal, compteurs distincts, bouton accessible ; éléments liés absents de la liste', () => {
    const html = rendre(etat());
    expect(html).toContain('data-timeline-group="11"');
    expect(html).toContain('Dégât des eaux');
    expect(html).toContain('2 événements liés · 5 documents · 1 bien · 1 pièce');
    expect(html).not.toContain('0 équipement');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="timeline-desktop-groupe-11"');
    expect(html).toContain('Afficher les 2 éléments liés');
    expect(html).not.toContain('Visite expert');
    expect(html).toContain('data-timeline-mode="grouped"');
  });

  it('L84C-UI3 — groupe déplié : éléments liés listés et ouvrables', () => {
    const html = rendre(etat({ expanded: new Set(['11']) }));
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('id="timeline-desktop-groupe-11"');
    expect(html).toContain('Masquer les 2 éléments liés');
    expect(html.indexOf('Réparation plafond')).toBeLessThan(html.indexOf('Visite expert'));
    expect(html).toContain('data-timeline-item="21"');
    expect(html).toContain('data-timeline-item="22"');
  });

  it('L84C-UI4 — mobile : même rendu, cibles tactiles agrandies, titres non tronqués', () => {
    const mob = rendre(etat({ expanded: new Set(['11']) }), 'mobile');
    expect(mob).toContain('aria-controls="timeline-mobile-groupe-11"');
    expect(mob).toContain('2 événements liés · 5 documents · 1 bien · 1 pièce');
    expect(mob).toContain('min-h-[32px]');
    expect(mob).not.toContain('truncate');
    expect(rendre(etat())).toContain('truncate');
    const fiche = lire('components/assets/AssetOverviewTab.tsx');
    expect(fiche).toContain('variant="desktop"');
    expect(fiche).toContain('variant="mobile"');
    expect(fiche.match(/<TimelineModeSwitch /g)).toHaveLength(2);
    expect(fiche).toContain('<Card className="lg:hidden">');
    expect(fiche).toContain('hidden lg:flex flex-col w-60');
  });

  it('L84C-UI5 — « Afficher plus » avec le reste ; état vide', () => {
    expect(rendre(etat({ nextCursor: 'abc', rest: 7 }))).toContain('Afficher plus (7)');
    expect(rendre(etat())).not.toContain('Afficher plus');
    expect(rendre(etat({ entries: [] }))).toContain('Aucune entrée');
  });

  it('L84C-UI6 — mode non mémorisé : état de visite seulement, « grouped » à chaque ouverture', () => {
    const src = lire('components/assets/timeline/AssetTimeline.tsx');
    const fiche = lire('components/assets/AssetOverviewTab.tsx');
    for (const s of [src, fiche]) {
      expect(s).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
      expect(s).not.toMatch(/searchParams\.set\(['"]mode|router\.(push|replace)/);
    }
    expect(src).toContain("useState<AssetTimelineState>(() => fromPage('grouped'");
    expect(src).toContain("useRef<TimelineMode>('grouped')");
    // La vue d'ensemble est demandée sans mode : défaut serveur « regroupée ».
    expect(fiche).toContain('apiClient.get<OverviewData>(`/api/assets/${assetId}/overview`');
  });

  it('L84C-UI7 — tiroirs : point d\'appel unique, tiroir Agenda EXISTANT, contexte transmis', () => {
    const fiche = lire('components/assets/AssetOverviewTab.tsx');
    expect(fiche).toContain('const openTimelineItem = useCallback(async (req: TimelineOpenRequest)');
    expect(fiche.match(/onOpenItem=\{openTimelineItem\}/g)).toHaveLength(2);
    expect(fiche).toContain("import('@/components/agenda/AgendaItemDrawer')");
    const src = lire('components/assets/timeline/AssetTimeline.tsx');
    expect(src).toContain("onOpenItem({ itemId: entry.id, context: 'group' })");
    expect(src).toContain("onOpenItem({ itemId: m.id, context: 'member', groupItemId: entry.id })");
    expect(src).toContain("onOpenItem({ itemId: entry.id, context: 'item' })");
    expect(src).not.toMatch(/Drawer|Sheet/);
  });

  it('L84C-UI8 — aucun mot « Opération » visible', () => {
    const html = [rendre(etat({ expanded: new Set(['11']), nextCursor: 'x', rest: 2 })), rendre(etat(), 'mobile'),
      renderToStaticMarkup(h(TimelineModeSwitch, { mode: 'detailed', onChange: () => undefined }))].join('');
    expect(html).not.toMatch(/op[ée]ration/i);
  });
});
