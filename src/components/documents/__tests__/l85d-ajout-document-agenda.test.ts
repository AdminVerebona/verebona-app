/**
 * Lot 85D — « Ajouter un document » : desktop ET mobile, lien Agenda (AC01).
 *
 *   L85D-UI01  desktop : même fenêtre qu'avant (titre, modes, zone de dépôt) — aucun champ « événement » visible
 *   L85D-UI02  mobile : même fenêtre qu'avant (libellés courts, pleine largeur, à droite) — idem
 *   L85D-UI03  ouverte depuis un élément d'agenda : rendu identique (aucun changement visible)
 *   L85D-UI04  câblage : le lien passe par `/api/documents/:id/agenda-liens` (client partagé), plus jamais par `/api/events`
 *   L85D-UI05  client de lien : un appel par document, dans l'ordre ; échecs silencieux ; sans élément, aucun appel
 *   L85D-UI06  tiroir d'un élément d'agenda (desktop et mobile, même composant) : modifier, statut, confirmation,
 *              suppression passent par la garde d'écriture ; un 403 de droits n'ajoute pas d'erreur par-dessus
 */
import * as React from 'react';
import { createElement as h } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

(globalThis as { React?: typeof React }).React = React;

const etat = vi.hoisted(() => ({ mobile: false, bloque: false, get: vi.fn(async (_url: string) => ({})) }));

// Composant de base 81F : rendu en ligne (les portails ne s'affichent pas côté serveur).
vi.mock('@/components/ui/sheet', () => {
  const pass = ({ children }: { children?: React.ReactNode }) => h('div', null, children);
  return {
    Sheet: ({ open, children }: { open: boolean; children?: React.ReactNode }) => (open ? h('div', { 'data-testid': 'sheet' }, children) : null),
    SheetContent: ({ children, style, side }: { children?: React.ReactNode; style?: Record<string, unknown>; side?: string }) =>
      h('section', { 'data-side': side, 'data-width': String(style?.width ?? '') }, children),
    SheetHeader: pass, SheetDescription: pass,
    SheetTitle: ({ children }: { children?: React.ReactNode }) => h('h2', null, children),
  };
});
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => etat.mobile }));
vi.mock('@/hooks/useFeatureFlags', () => ({ useFeatureFlags: () => ({ isPremium: false }) }));
vi.mock('@/contexts/WriteGuardContext', () => ({
  useWriteGuard: () => ({ garder: (a: () => void) => { if (!etat.bloque) a(); }, estBloque: () => etat.bloque, signalerRefus: () => {} }),
}));
vi.mock('@/hooks/useFileDepot', () => ({ useFileDepot: () => ({ elements: [] }) }));
vi.mock('@/components/upload-notice-banner', () => ({ UploadNoticeBanner: () => null }));
vi.mock('@/components/documents/FusionSuggestionModal', () => ({ FusionSuggestionModal: () => null }));
vi.mock('@/components/documents/UploadQueuePanel', () => ({ UploadQueuePanel: () => null, UploadResumeSection: () => null, reprendreDepot: () => {} }));
vi.mock('@/lib/api-client', () => ({ apiClient: { get: etat.get, post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() } }));

const { UnifiedDocumentDialog } = await import('../unified-document-dialog');
const rendre = (props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(h(UnifiedDocumentDialog, { open: true, onOpenChange: () => {}, ...props } as never));
const lire = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const SANS_EVENEMENT = /[ée]v[ée]nement|categorie|Type d.événement/i;

describe('L85D-UI01 — desktop : fenêtre inchangée', () => {
  it('titre, modes, zone de dépôt, panneau à droite (580 px) ; aucun champ « événement »', () => {
    etat.mobile = false;
    const html = rendre();
    expect(html).toContain('Ajouter un document');
    expect(html).toContain('Importez vos documents ou ajoutez des liens web');
    expect(html).toContain('Importer un fichier');
    expect(html).toContain('Lien web');
    expect(html).toContain('Glissez vos fichiers ici ou cliquez pour parcourir');
    expect(html).toContain('Informations complémentaires');
    expect(html).toContain('data-side="right"');
    expect(html).toContain('data-width="580px"');
    expect(html).not.toMatch(SANS_EVENEMENT);
  });
  it('compte en lecture seule : la fenêtre ne s’affiche pas (garde à l’ouverture, inchangée)', () => {
    etat.mobile = false;
    etat.bloque = true;
    try {
      expect(rendre()).toBe('');
    } finally {
      etat.bloque = false;
    }
  });
});

describe('L85D-UI02 — mobile : fenêtre inchangée', () => {
  it('libellés courts, pleine largeur, à droite ; aucun champ « événement »', () => {
    etat.mobile = true;
    const html = rendre();
    expect(html).toContain('Ajouter un document');
    expect(html).toContain('Renseignez les informations du document');
    expect(html).toContain('>Fichier<');
    expect(html).toContain('>Lien<');
    expect(html).toContain('Toucher pour sélectionner un ou plusieurs fichiers');
    expect(html).toContain('data-side="right"');
    expect(html).toContain('data-width="100vw"');
    expect(html).not.toMatch(SANS_EVENEMENT);
    etat.mobile = false;
  });
});

describe('L85D-UI03 — ouverte depuis un élément d’agenda : aucun changement visible', () => {
  it.each([false, true])('mobile = %s : même rendu avec ou sans élément d’agenda', (mobile) => {
    etat.mobile = mobile;
    expect(rendre({ preselectedAgendaItemId: 42, preselectedAssetId: 7, availableAssets: [{ id: 7, name: 'Maison' }] }))
      .toBe(rendre({ preselectedAssetId: 7, availableAssets: [{ id: 7, name: 'Maison' }] }));
    etat.mobile = false;
  });
});

describe('L85D-UI04 — câblage : liens Agenda (84B), plus de modèle « events »', () => {
  const src = lire('src/components/documents/unified-document-dialog.tsx');
  it('aucun appel aux routes « events » retirées', () => {
    expect(src).not.toMatch(/\/api\/events/);
    expect(src).not.toMatch(/preselectedEventIds|availableEvents|allowEventCreation|allowEventAssociation|createEvent|EVENT_CATEGORIES/);
  });
  it('les documents déposés sont reliés par le client partagé, sur la couche HTTP du dépôt', () => {
    expect(src).toMatch(/linkUploadedDocumentsToAgendaItem\(ctx\.agendaItemId, fileIds, \(url, body\) => fetchDepot\(url, jsonPost\(body\)\)\)/);
    // Fichiers (fin de lot) ET lien web passent par la même association.
    expect(src.match(/await associerEtSignaler\(ctx, /g)).toHaveLength(2);
    // Date du document reprise de l'élément d'agenda (comme l'ancien événement présélectionné).
    expect(src).toMatch(/apiClient\.get<[^>]+>\(`\/api\/agenda\/\$\{agendaItemId\}`\)/);
  });
  it('aucun écran ne passe plus d’option « événement » au dialogue', () => {
    expect(lire('src/components/documents/v2/DocumentsByRubric.tsx')).not.toMatch(/allowEvent/);
  });
});

describe('L85D-UI05 — client de lien Document ↔ Agenda', () => {
  it('un appel par document, dans l’ordre, vers la route du tiroir ; échecs silencieux', async () => {
    const { linkUploadedDocumentsToAgendaItem } = await import('@/lib/agenda/document-agenda-link-client');
    const appels: Array<[string, unknown]> = [];
    const r = await linkUploadedDocumentsToAgendaItem(12, [3, 4, 5], async (url, body) => {
      appels.push([url, body]);
      if (url.includes('/4/')) return { ok: false, status: 409 };
      if (url.includes('/5/')) throw new Error('réseau');
      return { ok: true, status: 200 };
    });
    expect(appels).toEqual([
      ['/api/documents/3/agenda-liens', { itemId: 12 }],
      ['/api/documents/4/agenda-liens', { itemId: 12 }],
      ['/api/documents/5/agenda-liens', { itemId: 12 }],
    ]);
    expect(r).toEqual({ linked: [3], failed: [4, 5] });
  });
  it.each([null, undefined, 0, -3, Number.NaN])('élément %s : aucun appel', async (id) => {
    const { linkUploadedDocumentsToAgendaItem } = await import('@/lib/agenda/document-agenda-link-client');
    const post = vi.fn();
    expect(await linkUploadedDocumentsToAgendaItem(id as never, [1], post)).toEqual({ linked: [], failed: [] });
    expect(post).not.toHaveBeenCalled();
  });
});

describe('L85D-UI06 — tiroir d’un élément d’agenda (desktop et mobile : un seul composant)', () => {
  const src = lire('src/components/agenda/AgendaItemDrawer.tsx');
  it('chaque écriture passe par la garde partagée', () => {
    expect(src).toMatch(/const autorise = \(\) => \{ let ok = false; garder\(\(\) => \{ ok = true; \}\); return ok; \};/);
    expect(src).toMatch(/const handleSave = async \(\) => \{\s*if \(!autorise\(\)\) return;/);
    expect(src).toMatch(/const handleStatusChange = async \(val: string\) => \{\s*if \(!item \|\| !autorise\(\)\) return;/);
    expect(src).toMatch(/const handleConfirmForecast = async \(\) => \{\s*if \(!item \|\| !autorise\(\)\) return;/);
    expect(src).toMatch(/const handleDelete = async \(\) => \{\s*if \(!item \|\| !autorise\(\)\) return;/);
    expect(src).toMatch(/onClick=\{\(\) => \{ if \(autorise\(\)\) setShowDeleteConfirm\(true\); \}\}/);
    expect(src).toMatch(/onClick=\{\(\) => \{ if \(autorise\(\)\) startEdit\(\); \}\}/);
  });
  it('un refus de droits (403) n’ajoute pas de message d’erreur par-dessus la fenêtre habituelle', () => {
    expect(src.match(/if \(err\?\.status !== 403\)/g)?.length).toBeGreaterThanOrEqual(3);
  });
  it('même tiroir sur mobile : aucune variante mobile séparée des écritures d’agenda', () => {
    for (const f of ['src/components/mobile/mobile-actions-sheet.tsx', 'src/components/mobile/add-forms.tsx']) {
      expect(lire(f), f).not.toMatch(/\/api\/agenda\/\$\{[^}]+\}(\/statut)?['"`]/);
    }
  });
});
