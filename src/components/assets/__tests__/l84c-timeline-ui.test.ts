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
  ({ itemType: 'agenda' as const, id, title, effectiveDate: date, isDone: false, isOverdue: false, toConfirm: false, effectiveStatus: 'a_venir' as const });
// Règle remplacée (carte #744, lot C) : un groupe est un ÉVÉNEMENT DE RÉFÉRENCE (identité `op-<n>`), plus un élément « principal ».
const groupe: TimelineEntry = {
  kind: 'group', itemType: 'operation', id: 'op-11', operationId: 11, title: 'Dégât des eaux', effectiveDate: '2026-03-12', dateBasis: 'REALIZED',
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
    expect(html).toContain('data-timeline-group="op-11"');
    expect(html).toContain('Dégât des eaux');
    expect(html).toContain('2 événements liés · 5 documents · 1 bien · 1 pièce');
    expect(html).not.toContain('0 équipement');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="timeline-desktop-groupe-op-11"');
    expect(html).toContain('Afficher les 2 éléments liés');
    expect(html).not.toContain('Visite expert');
    expect(html).toContain('data-timeline-mode="grouped"');
  });

  it('L84C-UI3 — groupe déplié : éléments liés listés et ouvrables', () => {
    const html = rendre(etat({ expanded: new Set(['op-11']) }));
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('id="timeline-desktop-groupe-op-11"');
    expect(html).toContain('Masquer les 2 éléments liés');
    expect(html.indexOf('Réparation plafond')).toBeLessThan(html.indexOf('Visite expert'));
    expect(html).toContain('data-timeline-item="21"');
    expect(html).toContain('data-timeline-item="22"');
  });

  it('L84C-UI4 — mobile : même rendu, cibles tactiles agrandies, titres non tronqués', () => {
    const mob = rendre(etat({ expanded: new Set(['op-11']) }), 'mobile');
    expect(mob).toContain('aria-controls="timeline-mobile-groupe-op-11"');
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
      expect(s).not.toMatch(/searchParams\.set\(['"]mode/);
    }
    expect(src).not.toMatch(/router\.(push|replace)/);
    // Règle précisée (carte #744, travaux D) : la vue d'ensemble navigue UNE fois — vers la page entière de
    // l'événement de référence ; jamais pour écrire le mode dans l'adresse.
    expect(fiche.match(/router\.(push|replace)\([^)]*\)?/g)).toEqual(['router.push(referenceEventHref(req.operationId)']);
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
    // Règle remplacée (carte #744, lot C) : la ligne du groupe demande la fiche de l'événement de référence lui-même.
    expect(src).toContain("onOpenItem({ itemId: entry.id, context: 'group', operationId: entry.operationId })");
    expect(src).toContain("onOpenItem({ itemId: entry.id, context: 'reference', operationId: r.operationId })");
    expect(fiche).toContain("if ((req.context === 'group' || req.context === 'reference') && req.operationId != null) {");
    // Règle remplacée (carte #744, travaux D — AC27, AC41) : la fiche est une PAGE ENTIÈRE, plus un panneau latéral.
    expect(fiche).toContain('router.push(referenceEventHref(req.operationId));');
    expect(fiche).not.toContain('ReferenceEventSheet');
    expect(src).toContain("onOpenItem({ itemId: m.id, context: 'member', groupItemId: entry.id })");
    expect(src).toContain("onOpenItem({ itemId: entry.id, context: 'item' })");
    expect(src).not.toMatch(/Drawer|Sheet/);
  });

  it('L114O-C-UI1 — #744 : opération sans élément d’agenda et sans date — ligne explicite, aucun chevron, aucune date', () => {
    const seul: TimelineEntry = {
      kind: 'group', itemType: 'operation', id: 'op-12', operationId: 12, title: 'Intervention — Remplacement de la chaudière', effectiveDate: null, dateBasis: null,
      members: [], counters: { events: 0, documents: 0, assets: 1, rooms: 0, equipments: 0 },
    };
    for (const v of ['desktop', 'mobile'] as const) {
      const html = rendre(etat({ entries: [seul] }), v);
      expect(html, v).toContain('data-timeline-group="op-12"');
      expect(html, v).toContain('Intervention — Remplacement de la chaudière');
      expect(html, v).toMatch(/data-timeline-undated[^>]*>Sans date</);
      expect(html, v).not.toContain('aria-expanded');
      expect(html, v).not.toContain('éléments liés');
      expect(html, v).not.toContain('élément lié');
      expect(html, v).not.toMatch(/\d{4}/);
    }
    // Règle remplacée (carte #806) : un élément d'agenda sans date ne restait plus sans aucune mention (« rendu d'avant ») —
    // il porte désormais la mention explicite « Sans date », comme une opération sans date, et toujours aucune date.
    const sansDate = rendre(etat({ entries: [{ kind: 'item', ...item('13', null, 'Entretien à prévoir') }] }));
    expect(sansDate).toMatch(/data-timeline-undated[^>]*>Sans date</);
    expect(sansDate).not.toMatch(/\d{4}/);
  });

  it('L114O-C-UI2 — #744 : mode détaillé — élément partagé rendu UNE fois, un lien par opération (texte existant)', async () => {
    const partage: TimelineEntry = {
      kind: 'item', ...item('21', '2026-03-21', 'Visite expert'),
      operations: [{ operationId: 11, label: 'Sinistre — Dégât des eaux' }, { operationId: 15, label: 'Intervention — Réparation plafond' }],
    };
    for (const v of ['desktop', 'mobile'] as const) {
      const html = rendre(etat({ mode: 'detailed', entries: [partage, { kind: 'item', ...item('10', '2026-05-02', 'Contrôle chaudière'), operations: [] }] }), v);
      expect(html.match(/data-timeline-item="21"/g), v).toHaveLength(1);
      expect(html, v).toContain('data-timeline-reference="11"');
      expect(html, v).toContain('data-timeline-reference="15"');
      expect(html, v).toContain('Voir l’opération : Sinistre — Dégât des eaux');
      expect(html, v).toContain('Voir l’opération : Intervention — Réparation plafond');
      expect(html.match(/data-timeline-references=/g), v).toHaveLength(1);
      // Règle remplacée (carte #806, décision du PO du 17/11/2026) : la garde interdisait « Opération » ; à l’écran on dit désormais « opération », et c’est « événement de référence » qui est interdit.
      expect(html, v).not.toMatch(/[ée]v[éeè]nements?\s+de\s+r[ée]f[ée]rence/i);
    }
    // Texte repris à l'identique du lien existant (lot 113X) et de l'Agenda.
    const { TIMELINE_REFERENCE_EVENT_LINK, TIMELINE_UNDATED_LABEL } = await import('@/services/agenda/timeline/labels');
    expect(lire('components/documents/ReferenceEventSheet.tsx')).toContain(`export const REFERENCE_EVENT_OPEN_LABEL = "${TIMELINE_REFERENCE_EVENT_LINK}";`);
    expect(lire('components/agenda/AgendaGroupingPanel.tsx')).toContain(`: "${TIMELINE_UNDATED_LABEL}");`);
  });

  it('L84C-UI8 — aucun mot « Opération » visible', () => {
    const html = [rendre(etat({ expanded: new Set(['op-11']), nextCursor: 'x', rest: 2 })), rendre(etat(), 'mobile'),
      renderToStaticMarkup(h(TimelineModeSwitch, { mode: 'detailed', onChange: () => undefined }))].join('');
    // Règle remplacée (carte #806, décision du PO du 17/11/2026) : la garde interdisait « Opération » ; à l’écran on dit désormais « opération », et c’est « événement de référence » qui est interdit.
    expect(html).not.toMatch(/[ée]v[éeè]nements?\s+de\s+r[ée]f[ée]rence/i);
  });
});
