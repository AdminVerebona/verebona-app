/**
 * Lot 34 — points 3/4 (contrôles de vue de l'agenda sur mobile) et 8
 * (flèche « Retour en haut » sans effet sur mobile).
 *
 * Environnement de test `node` : la mise en page est vérifiée sur les
 * classes (contrat responsive), la remontée sur la logique pure.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  maxScrollTop, scrollAllToTop, scrolledTargets, MAIN_SCROLL_CONTAINER_ID, type DocLike, type ScrollableLike,
} from '@/lib/shell/scroll-to-top';

const lire = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');
const AGENDA = () => lire('src/app/(dashboard)/agenda/page.tsx');

function bloc(src: string, marker: string, until: string): string {
  const i = src.indexOf(marker);
  const j = src.indexOf(until, i);
  expect(i).toBeGreaterThan(-1);
  return src.slice(i, j);
}

describe('Agenda mobile — contrôles de vue (lot 34, points 3/4)', () => {
  const controles = () => bloc(AGENDA(), 'data-agenda-view-controls', '{/* Content */}');

  it('L34-AGENDA-01 — mobile : sélecteur sur sa propre ligne, navigation de période dessous (jamais superposés)', () => {
    const c = controles();
    // Colonne sous md, ligne à partir de md.
    expect(c).toMatch(/className=\{`relative mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between/);
    // La navigation d'année n'est plus positionnée en absolu sur mobile (cause de la superposition).
    expect(c).not.toMatch(/className="absolute left-1\/2/);
    expect(c).toMatch(/lg:absolute lg:left-1\/2 lg:-translate-x-1\/2/);
    // Navigation centrée sur mobile, pour le mois comme pour l'année.
    expect(c.match(/data-agenda-period-nav className="flex items-center justify-center gap-2/g)).toHaveLength(2);
  });

  it('L34-AGENDA-02 — sélecteur pleine largeur sur mobile, trois parts égales, libellés jamais tronqués', () => {
    const c = controles();
    expect(c).toContain('className="flex w-full overflow-hidden rounded-md border md:w-auto"');
    const src = AGENDA();
    const tab = /const VIEW_TAB = '([^']+)'/.exec(src)?.[1] ?? '';
    for (const cls of ['flex-1', 'min-w-0', 'whitespace-nowrap', 'justify-center', 'md:flex-none', 'md:px-3']) {
      expect(tab.split(' ')).toContain(cls);
    }
    for (const libelle of ['Liste', 'Mensuel', 'Annuel']) expect(c).toContain(`/> ${libelle}`);
    expect(c.match(/className=\{`\$\{VIEW_TAB\}/g)).toHaveLength(3);
    // 320 px : 288 px utiles ÷ 3 ≈ 96 px par bouton, « Mensuel » (icône + texte + px-2) ≈ 92 px.
    expect(tab).toContain('px-2');
  });

  it('L34-AGENDA-03 — libellé du mois sans largeur fixe trop courte (« septembre 2026 » ne déborde pas)', () => {
    const c = controles();
    expect(c).not.toContain('w-28 text-center');
    expect(c).toContain('min-w-[9rem] whitespace-nowrap text-center');
    // Flèches non comprimées.
    expect(c.match(/variant="outline" size="sm" className="shrink-0"/g)?.length).toBe(4);
  });

  it('L34-AGENDA-04 — desktop inchangé : une ligne, sélecteur à gauche, navigation à droite / année centrée (lg)', () => {
    const c = controles();
    expect(c).toContain('md:flex-row');
    expect(c).toContain('md:justify-between');
    expect(c).toContain('md:w-auto');
  });

  it('L34-AGENDA-05 — vue Liste : seul le sélecteur, sans navigation de période', () => {
    const c = controles();
    expect(c).toMatch(/\{view === 'calendar' && \(\s*<div data-agenda-period-nav/);
    expect(c).toMatch(/\{view === 'year' && \(\s*<div data-agenda-period-nav/);
    expect(c).not.toMatch(/view === 'list' && \(\s*<div data-agenda-period-nav/);
  });
});

// ── Retour en haut ───────────────────────────────────────────────────────────

function el(scrollTop: number, withScrollTo = true): ScrollableLike & { calls: unknown[] } {
  const e = {
    scrollTop, calls: [] as unknown[],
    ...(withScrollTo ? { scrollTo(o: { top: number }) { e.calls.push(o); e.scrollTop = o.top; } } : {}),
  };
  return e;
}

function doc(main: ScrollableLike | null, root: ScrollableLike, autres: ScrollableLike[] = []): DocLike {
  return {
    scrollingElement: root, documentElement: root,
    getElementById: (id) => (id === MAIN_SCROLL_CONTAINER_ID ? main : null),
    querySelectorAll: () => (main ? [main, ...autres] : autres),
  };
}

describe('Retour en haut (lot 34, point 8)', () => {
  it('L34-HAUT-01 — défile le conteneur de la coquille, pas seulement window', () => {
    const main = el(1200);
    const root = el(0);
    const win = { scrollTo: vi.fn() };
    expect(scrollAllToTop(doc(main, root), win)).toBe(1);
    expect(main.scrollTop).toBe(0);
    expect(main.calls).toEqual([{ top: 0, behavior: 'smooth' }]);
    expect(win.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
  });

  it('L34-HAUT-02 — conteneur propre d’une page et anciens WebKit (sans scrollTo) : affectation directe', () => {
    const main = el(400);
    const liste = el(900, false);
    scrollAllToTop(doc(main, el(0), [liste]), null, false);
    expect(main.calls).toEqual([{ top: 0, behavior: 'auto' }]);
    expect(liste.scrollTop).toBe(0);
  });

  it('L34-HAUT-03 — visibilité : plus grand défilement, conteneurs compris ; dédoublonné', () => {
    const main = el(450);
    const d = doc(main, el(0));
    expect(maxScrollTop(d, 0)).toBe(450);
    expect(scrolledTargets(d)).toEqual([main]);
    expect(maxScrollTop(doc(null, el(0)), 320)).toBe(320);
  });

  it('L34-HAUT-04 — le bouton n’est plus recouvert par la barre basse (bandeau traversant, flèche au-dessus)', () => {
    const nav = lire('src/components/mobile/bottom-navigation.tsx');
    expect(nav).toMatch(/data-mobile-bottom-nav className="pointer-events-none fixed inset-x-0 bottom-0 z-50/);
    // Le « + » et la barre restent cliquables.
    expect(nav.match(/className="pointer-events-auto /g)).toHaveLength(2);
    const btn = lire('src/components/ScrollToTop.tsx');
    expect(btn).toContain('"fixed z-[60] touch-manipulation"');
    expect(btn).not.toContain('"fixed z-40"');
    expect(btn).toContain('bottom-[calc(max(20px,env(safe-area-inset-bottom))+96px)]');
    expect(btn).toContain('md:right-6 md:bottom-6');
    expect(btn).toContain('scrollAllToTop(document, window, !reduce)');
    expect(btn).toContain('type="button"');
  });

  it('L34-HAUT-05 — un seul composant, monté par la coquille : toutes les pages qui l’affichent', () => {
    expect(lire('src/components/ClientShell.tsx')).toContain('<ScrollToTop />');
    expect(lire('src/components/DashboardLayout.tsx')).toContain(`id="${MAIN_SCROLL_CONTAINER_ID}"`);
  });
});
