/**
 * Lot 75H — Agenda annuel (en-tête de mois → vue mensuelle) et cartes
 * cliquables dans les tiroirs.
 *
 * Environnement `node`, sans DOM : rendu serveur (`renderToStaticMarkup`)
 * pour le balisage et l'accessibilité ; composants SANS hook (EntityCard,
 * MonthCardHeader) appelés comme des fonctions pour déclencher leur
 * `onClick` (clic) ; le clavier repose sur l'élément natif (lien `<a href>` :
 * Entrée ; bouton `type="button"` : Entrée / Espace), vérifié sur le
 * balisage. Le câblage des écrans est lu dans les sources.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import React, { createElement as h, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

(globalThis as { React?: typeof React }).React = React;

const drawers = await import('@/lib/drawers');
const { EntityCard, entityCardHref, handleEntityCardClick, ENTITY_CARD_KIND_LABELS } = await import('@/components/drawers/EntityCard');
const { MonthCardHeader, YearView, yearMonthKey, monthLongLabel } = await import('@/components/agenda/AgendaPeriodViews');

const lire = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');

// ── Fenêtre minimale (événements) ─────────────────────────────────────────
type Win = EventTarget & { location: { pathname: string; href: string } };
let events: { type: string; detail: unknown }[] = [];
const g = globalThis as unknown as { window?: Win };
beforeEach(() => {
  events = [];
  const w = new EventTarget() as Win;
  w.location = { pathname: '/assets/5', href: 'http://localhost/assets/5' };
  for (const t of [drawers.OPEN_ENTITY_DRAWER, drawers.OPEN_DOCUMENT_DRAWER]) {
    w.addEventListener(t, (e) => events.push({ type: t, detail: (e as CustomEvent).detail }));
  }
  g.window = w;
});
afterEach(() => { delete g.window; });

const fakeClick = (over: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean; button: number }> = {}) => {
  const e = { preventDefault: vi.fn(), ...over };
  return e;
};

/** Premier élément (profondeur d'abord) satisfaisant `pred` dans un arbre d'éléments. */
function find(node: ReactNode, pred: (el: ReactElement<Record<string, unknown>>) => boolean): ReactElement<Record<string, unknown>> | null {
  if (Array.isArray(node)) {
    for (const n of node) { const r = find(n, pred); if (r) return r; }
    return null;
  }
  if (!isValidElement(node)) return null;
  const el = node as ReactElement<Record<string, unknown>>;
  if (pred(el)) return el;
  return find(el.props.children as ReactNode, pred);
}

// ══════════════════════════════════════════════════════════════════════════
// Point 1 — Agenda, vue annuelle
// ══════════════════════════════════════════════════════════════════════════

describe('L75H-1 — vue annuelle : l’en-tête d’un mois ouvre la vue mensuelle', () => {
  it('L75H-1a — mois AAAA-MM de la même année, janvier à décembre', () => {
    expect(yearMonthKey(2026, 0)).toBe('2026-01');
    expect(yearMonthKey(2026, 11)).toBe('2026-12');
    expect(monthLongLabel('2026-01')).toBe('janvier 2026');
  });

  it('L75H-1b — rendu : vrai bouton, nom accessible (mois complet + nombre + action), libellé et compteur visibles', () => {
    const html = renderToStaticMarkup(h(MonthCardHeader, {
      monthLabel: 'Janv.', monthKey: '2026-01', count: 4, isCurrentMonth: false, onOpenMonth: () => {},
    }));
    expect(html).toMatch(/^<button type="button"/);
    expect(html).toContain('aria-label="janvier 2026, 4 éléments — afficher la vue mensuelle"');
    expect(html).toContain('data-month-header="2026-01"');
    expect(html).toContain('Janv.');
    expect(html).toContain('>4<');
    expect(html).not.toContain('tabindex="-1"');
  });

  it('L75H-1c — clic : vue mensuelle du mois cliqué', () => {
    const onOpenMonth = vi.fn();
    const el = MonthCardHeader({ monthLabel: 'Mars', monthKey: '2026-03', count: 1, isCurrentMonth: false, onOpenMonth }) as ReactElement<{ onClick: () => void; type: string }>;
    expect(el.type).toBe('button');
    el.props.onClick();
    expect(onOpenMonth).toHaveBeenCalledWith('2026-03');
  });

  it('L75H-1d — clavier : bouton natif (Entrée / Espace), focusable, pas de div à rôle simulé', () => {
    const el = MonthCardHeader({ monthLabel: 'Déc.', monthKey: '2026-12', count: 0, isCurrentMonth: true, onOpenMonth: () => {} }) as ReactElement<Record<string, unknown>>;
    expect(el.type).toBe('button');
    expect(el.props.type).toBe('button');
    expect(el.props.tabIndex).toBeUndefined();
    expect(el.props.role).toBeUndefined();
    expect(el.props['aria-label']).toBe('décembre 2026, aucun élément — afficher la vue mensuelle');
  });

  it('L75H-1e — sans gestionnaire : en-tête simple, comme avant (aucun bouton muet)', () => {
    const html = renderToStaticMarkup(h(MonthCardHeader, { monthLabel: 'Mai', monthKey: '2026-05', count: 1, isCurrentMonth: false }));
    expect(html).toMatch(/^<div/);
    expect(html).not.toContain('<button');
  });

  it('L75H-1f — YearView : douze en-têtes cliquables, tous dans l’année affichée', () => {
    const html = renderToStaticMarkup(h(YearView, { items: [], year: 2027, onItemClick: () => {}, onOpenMonth: () => {} }));
    const keys = [...html.matchAll(/data-month-header="([^"]+)"/g)].map((m) => m[1]);
    expect(keys).toEqual(Array.from({ length: 12 }, (_, i) => `2027-${String(i + 1).padStart(2, '0')}`));
    // Sans onOpenMonth : aucun en-tête cliquable (rétrocompatibilité).
    expect(renderToStaticMarkup(h(YearView, { items: [], year: 2027, onItemClick: () => {} }))).not.toContain('data-month-header');
  });

  it('L75H-1g — « Mon agenda » : vue mensuelle de ce mois dans l’URL, filtres conservés', () => {
    const src = lire('src/app/(dashboard)/agenda/page.tsx');
    expect(src).toContain("onOpenMonth={(m) => updateURL({ view: 'calendar', month: m })}");
    // updateURL repart des paramètres courants (filtres, période, année) : il
    // ne change que `view` et `month`.
    expect(src).toMatch(/const updateURL = [\s\S]{0,120}new URLSearchParams\(searchParams\.toString\(\)\)/);
  });

  it('L75H-1h — onglet Agenda d’un bien (même composant) : mois puis vue mensuelle', () => {
    const src = lire('src/components/assets/AssetAgendaTab.tsx');
    expect(src).toContain("onOpenMonth={(m) => { setMonth(m); setView('calendar'); }}");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Point 2 — Cartes d'entité cliquables dans les tiroirs
// ══════════════════════════════════════════════════════════════════════════

describe('L75H-2 — pile des tiroirs (empilement / retour)', () => {
  type E = { key: string; n?: number };
  it('L75H-2a — une fiche ouverte depuis un tiroir s’empile au-dessus', () => {
    const s = drawers.pushDrawerEntry<E>([{ key: 'equipement:1' }], { key: 'document:9' });
    expect(s.map((e) => e.key)).toEqual(['equipement:1', 'document:9']);
  });
  it('L75H-2b — fermer la fiche du dessus ramène à la précédente', () => {
    const s = drawers.closeDrawerEntry<E>([{ key: 'equipement:1' }, { key: 'document:9' }], 'document:9');
    expect(s.map((e) => e.key)).toEqual(['equipement:1']);
  });
  it('L75H-2c — fiche déjà dans la pile : on y revient (pas de boucle), données rafraîchies', () => {
    const s = drawers.pushDrawerEntry<E>(
      [{ key: 'equipement:1', n: 1 }, { key: 'document:9' }, { key: 'echeance:3' }],
      { key: 'equipement:1', n: 2 },
    );
    expect(s).toEqual([{ key: 'equipement:1', n: 2 }]);
  });
  it('L75H-2d — profondeur bornée', () => {
    let s: E[] = [];
    for (let i = 1; i <= drawers.DRAWER_STACK_MAX + 3; i++) s = drawers.pushDrawerEntry(s, { key: `piece:${i}` });
    expect(s).toHaveLength(drawers.DRAWER_STACK_MAX);
    expect(s.at(-1)!.key).toBe(`piece:${drawers.DRAWER_STACK_MAX + 3}`);
  });
  it('L75H-2e — openDrawer empilé : le document passe par la pile (OPEN_ENTITY_DRAWER) ; sans option, tiroir historique inchangé', () => {
    drawers.openDrawer({ kind: 'document', id: 7 }, { stack: true });
    drawers.openDrawer({ kind: 'document', id: 8 });
    drawers.openDrawer({ kind: 'echeance', id: 3 }, { stack: true });
    expect(events).toEqual([
      { type: drawers.OPEN_ENTITY_DRAWER, detail: { kind: 'document', id: 7 } },
      { type: drawers.OPEN_DOCUMENT_DRAWER, detail: { docId: 8, showAnalysisResults: undefined } },
      { type: drawers.OPEN_ENTITY_DRAWER, detail: { kind: 'echeance', id: 3 } },
    ]);
  });
  it('L75H-2f — GlobalDrawerHost tient une pile et sert aussi le document empilé', () => {
    const src = lire('src/components/drawers/GlobalDrawerHost.tsx');
    expect(src).toContain('pushDrawerEntry(s, entry)');
    expect(src).toContain('closeDrawerEntry(s, entry.key)');
    expect(src).toContain("kind: 'document', id: t.id");
    expect(src).toMatch(/<DocumentDrawer[\s\S]{0,80}open/);
    // Échéance → document : empilé (retour à l'échéance), plus remplacé.
    expect(src).toContain("onOpenDocument={(fileId) => openDrawer({ kind: 'document', id: fileId }, { stack: true })}");
  });
});

describe('L75H-3 — EntityCard : carte d’entité cliquable générique', () => {
  const doc = { kind: 'document' as const, id: 12, title: 'Facture robot', meta: '22 avr. 2024' };

  it('L75H-3a — rendu : lien réel vers la fiche (lien profond sur la page courante), nom accessible complet', () => {
    const html = renderToStaticMarkup(h(EntityCard, doc));
    expect(html).toMatch(/^<a href="\/assets\/5\?tiroir=document%3A12"/);
    expect(html).toContain(`<span class="sr-only">${ENTITY_CARD_KIND_LABELS.document} : </span>`);
    expect(html).toContain('Facture robot');
    expect(html).toContain('22 avr. 2024');
    expect(html).toContain('data-entity-card="document"');
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/); // chevron décoratif
    expect(html).not.toContain('tabindex');
  });

  it('L75H-3b — clic : tiroir de l’entité empilé via openDrawer, sans navigation', () => {
    const el = EntityCard(doc) as ReactElement<{ onClick: (e: unknown) => void; href: string }>;
    expect(el.type).toBe('a');
    const e = fakeClick();
    el.props.onClick(e);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(events).toEqual([{ type: drawers.OPEN_ENTITY_DRAWER, detail: { kind: 'document', id: 12 } }]);
  });

  it('L75H-3c — Ctrl / Cmd / Maj / molette : le lien est suivi (nouvel onglet, même tiroir via ?tiroir=)', () => {
    for (const over of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { button: 1 }]) {
      const e = fakeClick(over);
      expect(handleEntityCardClick(e, { kind: 'echeance', id: 3 })).toBe(false);
      expect(e.preventDefault).not.toHaveBeenCalled();
    }
    expect(events).toEqual([]);
    expect(drawers.drawerFromHref(entityCardHref('echeance', 3))).toEqual({ kind: 'echeance', id: 3 });
  });

  it('L75H-3d — clavier : élément natif <a href> (Entrée déclenche le même onClick), focus de la charte', () => {
    const el = EntityCard({ kind: 'equipement', id: 4, title: 'Chaudière' }) as ReactElement<Record<string, unknown>>;
    expect(el.type).toBe('a');
    expect(el.props.href).toBe('/assets/5?tiroir=equipement%3A4');
    expect(el.props.tabIndex).toBeUndefined();
    expect(el.props.role).toBeUndefined();
    // L'anneau de focus de la charte couvre a[href] (globals.css).
    expect(lire('src/app/globals.css')).toMatch(/:where\(a\[href\], button[\s\S]{0,200}:focus-visible/);
  });

  it('L75H-3e — actions de la carte hors du lien : jamais de bouton dans le lien', () => {
    const onAction = vi.fn();
    const props = {
      kind: 'echeance' as const, id: 3, title: 'Entretien chaudière',
      badges: h('span', null, 'Statut à confirmer'),
      actions: h('button', { type: 'button', onClick: onAction }, 'Confirmer'),
    };
    const html = renderToStaticMarkup(h(EntityCard, props));
    const lien = html.match(/<a [\s\S]*?<\/a>/)![0];
    expect(lien).not.toContain('<button');
    expect(lien).toContain('Statut à confirmer'); // badge (texte) dans la carte
    expect(html.indexOf('<button')).toBeGreaterThan(html.indexOf('</a>'));
    // L'action reste indépendante : son clic n'ouvre aucun tiroir.
    const tree = EntityCard(props);
    const bouton = find(tree, (x) => x.type === 'button')!;
    (bouton.props.onClick as () => void)();
    expect(onAction).toHaveBeenCalledOnce();
    expect(events).toEqual([]);
    // …et le lien, lui, ouvre bien l'échéance.
    const a = find(tree, (x) => x.type === 'a')!;
    (a.props.onClick as (e: unknown) => void)(fakeClick());
    expect(events).toEqual([{ type: drawers.OPEN_ENTITY_DRAWER, detail: { kind: 'echeance', id: 3 } }]);
  });

  it('L75H-3f — ouverture fournie par l’écran (tiroir local) : prioritaire, aucun événement global', () => {
    const onOpen = vi.fn();
    const el = EntityCard({ kind: 'fournisseur', id: 3, title: 'Plombier', onOpen }) as ReactElement<{ onClick: (e: unknown) => void; href: string }>;
    expect(el.props.href).toBe('/fournisseurs/3');
    const e = fakeClick();
    el.props.onClick(e);
    expect(onOpen).toHaveBeenCalledOnce();
    expect(e.preventDefault).toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('L75H-3g — fournisseur / bien sans onOpen : navigation ordinaire vers la page', () => {
    expect(entityCardHref('bien', 9)).toBe('/assets/9');
    const e = fakeClick();
    expect(handleEntityCardClick(e, { kind: 'bien', id: 9 })).toBe(false);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it('L75H-3h — fiche indisponible : carte non interactive', () => {
    const html = renderToStaticMarkup(h(EntityCard, { kind: 'piece', id: 2, title: 'Cuisine', disabled: true }));
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('sr-only');
  });
});

describe('L75H-4 — inventaire des tiroirs : chaque carte d’entité ouvre sa fiche', () => {
  it('L75H-4a — Équipement : Fournisseurs, Documents associés, Agenda associé', () => {
    const src = lire('src/components/assets/EquipmentDrawer.tsx');
    expect(src).toMatch(/<EntityCard\s+key=\{s\.supplierId\}\s+kind="fournisseur"/);
    expect(src).toMatch(/<EntityCard\s+key=\{doc\.id\}\s+kind="document"/);
    expect(src).toMatch(/<EntityCard\s+key=\{item\.id\}\s+kind="echeance"/);
    // Badges d'état conservés (texte, dans la carte).
    expect(src).toContain('badges={<AgendaStatusBadge item={item} />}');
    // Échéance modifiée dans le tiroir empilé → liste relue.
    expect(src).toContain("window.addEventListener('agenda-mutated', reload)");
  });

  it('L75H-4b — Document : éléments agenda (cartes), pièce et équipement (tiroir empilé, statut réel)', () => {
    const src = lire('src/components/assets/DocumentDrawer.tsx');
    expect(src).toMatch(/<EntityCard\s+key=\{item\.id\}\s+kind="echeance"/);
    expect(src).toContain("openDrawer({ kind: 'piece', id: fullData.substructureId! }, { stack: true })");
    expect(src).toContain("openDrawer({ kind: 'equipement', id: fullData.equipmentId! }, { stack: true })");
    expect(src).not.toContain("status: 'EN_SERVICE'");
  });

  it('L75H-4c — Échéance : pièces, équipements et documents toujours ouvrables (tiroir empilé)', () => {
    const src = lire('src/components/agenda/AgendaItemDrawer.tsx');
    expect(src).toContain("openDrawer({ kind: 'piece', id: l.substructureId }, { stack: true })");
    expect(src).toContain("openDrawer({ kind: 'equipement', id: l.equipmentId }, { stack: true })");
    expect(src).toContain("openDrawer({ kind: 'document', id: l.assetFileId }, { stack: true })");
    expect(src).not.toContain("status: 'EN_SERVICE'");
    // Biens : liens vers la page du bien (inchangés).
    expect(src).toContain('href={`/assets/${l.assetId}`}');
  });

  it('L75H-4d — Fournisseur : documents associés en cartes d’entité', () => {
    const src = lire('src/components/suppliers/SupplierDrawer.tsx');
    expect(src).toMatch(/<EntityCard\s+key=\{doc\.documentId\}\s+kind="document"/);
  });
});
