/**
 * Lot 53b — point 11 : le « + » ouvre un petit menu accroché au bouton
 * (plus de panneau latéral plein écran) ; « Ajouter un document » ouvre le
 * tiroir d'ajout (dépôt, sélection multiple) au lieu de l'explorateur à choix
 * unique. Desktop (menu latéral) et mobile (barre basse).
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as React from 'react';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

(globalThis as { React?: typeof React }).React = React;
vi.mock('@/components/documents/unified-document-dialog', () => ({ UnifiedDocumentDialog: () => null }));
vi.mock('@/components/AssetFormDialog', () => ({ AssetFormDialog: () => null }));
vi.mock('@/components/agenda/CreateAgendaItemDrawer', () => ({ CreateAgendaItemDrawer: () => null }));
vi.mock('@/hooks/useSession', () => ({ useSession: () => ({ user: { id: 1 } }) }));

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const sansCommentaires = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const { MobileActionsSheet, addMenuPosition, ADD_MENU_WIDTH } = await import('../mobile-actions-sheet');

describe('L53B-11 — menu « Ajouter »', () => {
  it('L53B-11-01 — rendu : menu ARIA à 3 actions, sans panneau latéral ni voile', () => {
    const html = renderToStaticMarkup(h(MobileActionsSheet, { open: true, onOpenChange: () => {}, allViewports: true }));
    expect(html).toContain('role="menu"');
    expect(html.match(/role="menuitem"/g)?.length).toBe(3);
    for (const l of ['Ajouter un document', 'Ajouter à l&#x27;agenda', 'Ajouter un bien']) expect(html).toContain(l);
    expect(html).not.toContain('inset-y-0 right-0');
    expect(html).not.toContain('bg-black/60');
    expect(html).not.toContain('backdrop-blur');
  });

  it('L53B-11-02 — fermé : rien n’est rendu', () => {
    const html = renderToStaticMarkup(h(MobileActionsSheet, { open: false, onOpenChange: () => {} }));
    expect(html).not.toContain('role="menu"');
  });

  it('L53B-11-03 — mobile : au-dessus du « + », centré, dans l’écran', () => {
    const plus = { top: 760, bottom: 818, left: 166, right: 224, width: 58 };
    const p = addMenuPosition(plus, 390, 844);
    expect(p.origin).toBe('bottom');
    expect(p.bottom).toBe(844 - 760 + 10);
    expect(p.top).toBeUndefined();
    const w = Math.min(ADD_MENU_WIDTH, 390 - 32);
    expect(p.left).toBeGreaterThanOrEqual(16);
    expect(p.left + w).toBeLessThanOrEqual(390 - 16);
    expect(Math.abs(p.left + w / 2 - 195)).toBeLessThanOrEqual(1);
  });

  it('L53B-11-04 — ordinateur : sous « + Ajouter » déplié, à droite du bouton replié', () => {
    const deplie = addMenuPosition({ top: 64, bottom: 104, left: 10, right: 230, width: 220 }, 1440, 900);
    expect(deplie).toMatchObject({ origin: 'top', top: 110, left: 16 });
    const replie = addMenuPosition({ top: 64, bottom: 104, left: 10, right: 50, width: 40 }, 1440, 900);
    expect(replie).toMatchObject({ origin: 'left', top: 64, left: 58 });
  });

  it('L53B-11-05 — « Ajouter un document » ouvre le tiroir, jamais l’explorateur', () => {
    const src = sansCommentaires(read('src/components/mobile/mobile-actions-sheet.tsx'));
    expect(src).not.toMatch(/document\.createElement\('input'\)/);
    expect(src).not.toMatch(/input\.click\(\)/);
    expect(src).not.toMatch(/initialFiles=/);
    expect(src).toMatch(/selectedAction === 'file' && \(\s*<LazyUnifiedDocumentDialog/);
    // Le tiroir propose la sélection multiple au contrat de dépôt.
    expect(read('src/components/documents/unified-document-dialog.tsx')).toMatch(/multiple\s+accept=\{ACCEPT_DEPOT\}/);
  });

  it('L53B-11-06 — clavier : flèches, Début/Fin, Échap (retour au bouton), Tab ferme', () => {
    const src = sansCommentaires(read('src/components/mobile/mobile-actions-sheet.tsx'));
    for (const k of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Escape', 'Tab']) expect(src).toContain(`'${k}'`);
    expect(src).toMatch(/retourFocus\.current\?\.focus/);
  });

  it('L53B-11-07 — garde d’écriture toujours avant l’ouverture du tiroir', () => {
    const src = sansCommentaires(read('src/components/mobile/mobile-actions-sheet.tsx'));
    const garde = src.indexOf("if (action === 'file' && refuserEcriture('documents')) return;");
    expect(garde).toBeGreaterThan(-1);
    expect(src.indexOf('setSelectedAction(action);')).toBeGreaterThan(garde);
  });

  it('L53B-11-08 — les deux « + » accrochent le menu à leur bouton', () => {
    const nav = sansCommentaires(read('src/components/mobile/bottom-navigation.tsx'));
    expect(nav).toMatch(/setAnchor\(e\.currentTarget\.getBoundingClientRect\(\)\)/);
    expect(nav).toMatch(/anchor=\{anchor\}/);
    expect(nav).toContain('aria-haspopup="menu"');
    const layout = sansCommentaires(read('src/components/DashboardLayout.tsx'));
    expect(layout).toMatch(/setAddAnchor\(e\.currentTarget\.getBoundingClientRect\(\)\)/);
    expect(layout).toMatch(/allViewports anchor=\{addAnchor\}/);
  });
});
