/**
 * Lot 35 — L35-1 : « Besoin d'aide » sur mobile sans les exemples.
 *
 * La feuille mobile n'affichait que la recherche, « Ouvrir le Centre d'aide »
 * et « Revoir le guide de bienvenue » : la lecture du catalogue directement
 * depuis le navigateur (site public, CORS limité à une origine, délai 5 s)
 * échouait dans l'application mobile. Les accès rapides passent désormais
 * par la route de l'application, avec la même source (catalogue du site),
 * la même logique contextuelle (ordre selon la page) et le même composant
 * sur ordinateur et sur mobile.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  HELP_SHORTCUT_IDS, loadHelpShortcuts, resetHelpCatalogCache, shortcutIdsForRoute, type HelpCatalog,
} from '@/lib/help-center/catalog';

const lire = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');

const entry = (id: string) => ({
  id, title: `Titre ${id}`, slug: id.toLowerCase(), path: `/aide/${id.toLowerCase()}`,
  category: 'c', categoryName: 'C', status: 'published' as const, published: true, offers: [],
});
const catalog: HelpCatalog = {
  schema: 'verebona-help-catalog-v1', version: 'v1', environment: 'production',
  articles: HELP_SHORTCUT_IDS.map(entry), redirects: {},
};
const json = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response;

beforeEach(() => resetHelpCatalogCache());
afterEach(() => { vi.unstubAllGlobals(); resetHelpCatalogCache(); });

describe('L35-1 — logique contextuelle (même fonction ordinateur / mobile)', () => {
  it('L35-1 — l’article de la page passe en tête, les six IDs restent, sans doublon', () => {
    expect(shortcutIdsForRoute('/agenda')[0]).toBe('AID-AGENDA-006');
    expect(shortcutIdsForRoute('/mon-compte/notifications')[0]).toBe('AID-NOTIF-003');
    expect(shortcutIdsForRoute('/accueil/a-traiter')[0]).toBe('AID-TODO-001');
    expect(shortcutIdsForRoute('/documents/12')[0]).toBe('AID-DOC-001');
    expect(shortcutIdsForRoute('/assets/4?x=1').slice(0, 2)).toEqual(['AID-ASSET-001', 'AID-DOC-001']);
    expect(shortcutIdsForRoute('/mon-compte/offres')[0]).toBe('AID-BILL-001');
    for (const r of ['/agenda', '/assets/4', '/accueil', null]) {
      expect([...shortcutIdsForRoute(r)].sort()).toEqual([...HELP_SHORTCUT_IDS].sort());
    }
  });

  it('L35-1 — page sans article dédié : ordre du CDC (§13)', () => {
    expect(shortcutIdsForRoute('/accueil')).toEqual([...HELP_SHORTCUT_IDS]);
    expect(shortcutIdsForRoute(undefined)).toEqual([...HELP_SHORTCUT_IDS]);
  });
});

describe('L35-1 — lecture par la route de l’application', () => {
  it('L35-1 — le navigateur lit /api/help/shortcuts (même origine) avec la page courante', async () => {
    const f = vi.fn(async () => json({ available: true, shortcuts: [{ id: 'AID-AGENDA-006', title: 'T', path: '/aide/t' }] }));
    const s = await loadHelpShortcuts('/agenda', f as unknown as typeof fetch);
    expect(f).toHaveBeenCalledWith('/api/help/shortcuts?route=%2Fagenda', { credentials: 'same-origin' });
    expect(s).toEqual([{ id: 'AID-AGENDA-006', title: 'T', path: '/aide/t' }]);
  });

  it('L35-1 — route indisponible : repli sur la lecture directe du catalogue (double lecture)', async () => {
    const appel = vi.fn(async () => { throw new Error('réseau'); });
    vi.stubGlobal('fetch', vi.fn(async () => json(catalog)));
    const s = await loadHelpShortcuts('/agenda', appel as unknown as typeof fetch);
    expect(s[0].id).toBe('AID-AGENDA-006');
    expect(s).toHaveLength(6);
  });

  it('L35-1 — tout indisponible : aucun raccourci, jamais de lien incertain', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(null, false)));
    expect(await loadHelpShortcuts('/agenda', vi.fn(async () => json({}, false)) as unknown as typeof fetch)).toEqual([]);
  });

  it('L35-1 — GET /api/help/shortcuts résout côté serveur, dans l’ordre de la page ; un ID non publié reste masqué', async () => {
    const c = { ...catalog, articles: catalog.articles.map((a) => (a.id === 'AID-BILL-001' ? { ...a, published: false } : a)) };
    vi.stubGlobal('fetch', vi.fn(async () => json(c)));
    const { GET } = await import('@/app/api/help/shortcuts/route');
    const { NextRequest } = await import('next/server');
    const res = await GET(new NextRequest('http://app.test/api/help/shortcuts?route=/mon-compte/notifications'));
    const body = await res.json() as { available: boolean; shortcuts: Array<{ id: string }> };
    expect(body.available).toBe(true);
    expect(body.shortcuts[0].id).toBe('AID-NOTIF-003');
    expect(body.shortcuts.map((s) => s.id)).not.toContain('AID-BILL-001');
    expect(body.shortcuts).toHaveLength(5);
  });

  it('L35-1 — catalogue illisible : available=false, aucun raccourci', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    const { GET } = await import('@/app/api/help/shortcuts/route');
    const { NextRequest } = await import('next/server');
    const res = await GET(new NextRequest('http://app.test/api/help/shortcuts?route=//evil'));
    expect(await res.json()).toEqual({ available: false, shortcuts: [] });
  });
});

describe('L35-1 — un seul composant pour ordinateur et mobile', () => {
  it('L35-1 — HelpModal charge les exemples par loadHelpShortcuts(pathname), plus par la lecture directe', () => {
    const src = lire('src/components/help/HelpModal.tsx');
    expect(src).toContain('loadHelpShortcuts(pathname)');
    expect(src).not.toContain('fetchHelpCatalog()');
    expect(src).toContain('Accès rapides');
  });

  it('L35-1 — la coquille monte UNE modale, ouverte par le menu desktop et par le panneau mobile', () => {
    const layout = lire('src/components/DashboardLayout.tsx');
    expect(layout.match(/<HelpModal /g)).toHaveLength(1);
    expect(layout.match(/onOpenHelp=\{\(\) => setHelpModalOpen\(true\)\}/g)?.length).toBeGreaterThanOrEqual(3);
  });
});
