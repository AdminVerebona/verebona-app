/**
 * APP-PERF-05 — formulaires et panneaux lourds réellement différés.
 *
 * Mesure (build de production, chunks initiaux de /accueil) : avant
 * correction, `UnifiedDocumentDialog`, `AssetFormDialog` et
 * `CreateAgendaItemDrawer` y figuraient via l'import direct du panneau
 * « Ajouter ». Ces tests verrouillent le câblage qui les en sort.
 */
import * as React from 'react';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';

(globalThis as { React?: typeof React }).React = React;

const charges = vi.hoisted(() => ({ document: 0, bien: 0, agenda: 0 }));
vi.mock('@/components/documents/unified-document-dialog', () => {
  charges.document += 1;
  return { UnifiedDocumentDialog: () => null };
});
vi.mock('@/components/AssetFormDialog', () => {
  charges.bien += 1;
  return { AssetFormDialog: () => null };
});
vi.mock('@/components/agenda/CreateAgendaItemDrawer', () => {
  charges.agenda += 1;
  return { CreateAgendaItemDrawer: () => null };
});
vi.mock('@/hooks/useSession', () => ({ useSession: () => ({ user: { id: 1 } }) }));

const { MobileActionsSheet } = await import('../mobile-actions-sheet');
const { loadDocumentDialog, preloadAddForm, AddFormLoading } = await import('../add-forms');

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const sansCommentaires = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('T-01 : rien n’est chargé tant qu’aucun formulaire n’est utilisé', () => {
  it('panneau fermé : aucun rendu, aucun formulaire importé', () => {
    const html = renderToStaticMarkup(h(MobileActionsSheet, { open: false, onOpenChange: () => {} }));
    expect(html).toBe('');
    expect(charges).toEqual({ document: 0, bien: 0, agenda: 0 });
  });

  it('panneau ouvert : les actions, toujours sans formulaire importé', () => {
    const html = renderToStaticMarkup(h(MobileActionsSheet, { open: true, onOpenChange: () => {} }));
    expect(html).toContain('Ajouter un document');
    expect(html).toContain('Ajouter un bien');
    expect(charges).toEqual({ document: 0, bien: 0, agenda: 0 });
  });

  it('le panneau n’importe plus les formulaires directement', () => {
    const src = sansCommentaires(read('src/components/mobile/mobile-actions-sheet.tsx'));
    expect(src).not.toMatch(/from '@\/components\/documents\/unified-document-dialog'/);
    expect(src).not.toMatch(/from '@\/components\/AssetFormDialog'/);
    expect(src).not.toMatch(/from '@\/components\/agenda\/CreateAgendaItemDrawer'/);
    // Préchargement sur intention, pas à l'ouverture.
    expect(src).toMatch(/onPointerEnter=\{\(\) => preloadAddForm\(action\.id\)\}/);
    expect(src).toMatch(/onFocus=\{\(\) => preloadAddForm\(action\.id\)\}/);
  });
});

describe('T-02 : chargement à froid puis à chaud', () => {
  it('préchargement et ouverture partagent le même import (pas de double demande)', async () => {
    expect(loadDocumentDialog()).toBe(loadDocumentDialog());
    preloadAddForm('file');
    await loadDocumentDialog();
    expect(charges.document).toBe(1);
  });

  it('état de chargement local et accessible', () => {
    const html = renderToStaticMarkup(h(AddFormLoading));
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('Ouverture du formulaire');
  });
});

describe('T-03 / CA-03 : la garde d’écriture passe AVANT tout chargement de formulaire', () => {
  it('refus avant saisie : la garde précède le sélecteur et le montage', () => {
    const src = sansCommentaires(read('src/components/mobile/mobile-actions-sheet.tsx'));
    const garde = src.indexOf("if (action === 'file' && refuserEcriture('documents')) return;");
    const precharge = src.indexOf("preloadAddForm('file');");
    expect(garde).toBeGreaterThan(-1);
    expect(precharge).toBeGreaterThan(garde);
    expect(src).toMatch(/if \(action === 'agenda' && refuserEcriture\(\)\) return;/);
  });
});

describe('montage effectif dans la coquille', () => {
  const layout = sansCommentaires(read('src/components/DashboardLayout.tsx'));
  const nav = sansCommentaires(read('src/components/mobile/bottom-navigation.tsx'));
  const accueil = sansCommentaires(read('src/app/(dashboard)/accueil/page.tsx'));

  it('panneau « Ajouter » et aide montés à leur première ouverture', () => {
    expect(layout).toMatch(/\{addSheetMounted && <MobileActionsSheet/);
    expect(layout).toMatch(/\{helpMounted && <HelpModal/);
    expect(nav).toMatch(/\{sheetMounted && <MobileActionsSheet/);
  });

  it('guide de bienvenue monté seulement s’il doit s’afficher (ou relance manuelle)', () => {
    expect(layout).toMatch(/\(welcomeNeed === 'show' \|\| onboardingForceOpen\) && \(\s*<WelcomeOnboardingModal/);
    expect(layout).not.toContain("/api/assets?limit=20");
  });

  it('les déclencheurs globaux restent écoutés (tiroirs, aide, relance du guide)', () => {
    expect(layout).toContain('<GlobalDrawerHost />');
    expect(layout).toContain("window.addEventListener('open-document-drawer'");
    expect(layout).toContain("window.addEventListener('onboarding:relaunch'");
  });

  it('l’accueil réutilise les mêmes chunks et le même préchargement', () => {
    expect(accueil).toMatch(/from '@\/components\/mobile\/add-forms'/);
    expect(accueil).not.toMatch(/import\('@\/components\/documents\/unified-document-dialog'\)/);
  });
});
