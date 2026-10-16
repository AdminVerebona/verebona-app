/**
 * Lot 62 — L62-AIDE : « Besoin d'aide sans les exemples encore
 * (chargement ?) » (iPhone, application installée).
 *
 * Ce qui doit s'afficher : les « Accès rapides » (lot 35, L35-1) — six
 * articles du Centre d'aide (`HELP_SHORTCUT_IDS`), titres lus dans le
 * catalogue publié par le site public, l'article de la page en tête.
 *
 * Pourquoi c'était vide :
 *  · la section n'apparaissait qu'avec une liste NON VIDE ; tant que la
 *    lecture n'aboutissait pas (appel à `/api/help/shortcuts` sans délai) ou
 *    si elle aboutissait à « rien » (catalogue illisible côté serveur, puis
 *    lecture directe refusée), la fenêtre restait vide sans explication ;
 *  · la route n'avait qu'une source (le catalogue) : une panne du site public
 *    vue du serveur suffisait à supprimer les exemples, alors que le serveur
 *    détient le corpus du même site (assistant, dernier valide en base).
 *
 * Le lot 59/60 (ouverture du Centre d'aide en nouvel onglet : open.ts,
 * HelpModal, VerebonaSpaceProvider) n'a pas touché au chargement : vérifié,
 * pas de régression de ce côté (L62-AIDE-09).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HELP_SHORTCUT_IDS, loadHelpShortcuts, loadHelpShortcutsState, resetHelpCatalogCache, type HelpCatalog,
} from '@/lib/help-center/catalog';
import { setHelpCorpusForTests, type HelpCorpus } from '@/services/verebona-assistant/core/help-corpus.service';

vi.mock('next/navigation', () => ({ usePathname: () => '/accueil', useRouter: () => ({ push: () => {} }) }));
(globalThis as { React?: typeof React }).React = React;

const lire = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');
const json = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 503, json: async () => body }) as Response;
const jamais = () => new Promise<Response>(() => {});

const catalog: HelpCatalog = {
  schema: 'verebona-help-catalog-v1', version: 'v1', environment: 'production', redirects: {},
  articles: HELP_SHORTCUT_IDS.map((id) => ({
    id, title: `Titre ${id}`, slug: id.toLowerCase(), path: `/aide/${id.toLowerCase()}`,
    category: 'c', categoryName: 'C', status: 'published' as const, published: true, offers: [],
  })),
};
const corpus = (ids: readonly string[]): HelpCorpus => ({
  schema: 'verebona-help-t2-v1', version: 'c1', environment: 'local',
  articles: ids.map((id) => ({
    id, title: `Corpus ${id}`, path: `/aide/${id.toLowerCase()}`, category: 'c', categoryName: 'C', summary: '',
    offers: [], offersLabel: '', offersNote: null, synonyms: [], sections: [], status: 'published', validatedAt: '2026-01-01',
  })),
});

beforeEach(() => { resetHelpCatalogCache(); setHelpCorpusForTests(null); });
afterEach(() => { vi.unstubAllGlobals(); resetHelpCatalogCache(); setHelpCorpusForTests(null); });

describe('L62-AIDE — chargement borné côté fenêtre', () => {
  it('L62-AIDE-01 — cause : sans borne, une route qui ne répond pas laisse la fenêtre en attente indéfiniment', async () => {
    vi.stubGlobal('fetch', vi.fn(jamais));
    const issue = await Promise.race([
      loadHelpShortcuts('/accueil', vi.fn(jamais) as unknown as typeof fetch).then(() => 'résolu'),
      new Promise((r) => setTimeout(() => r('toujours en attente'), 100)),
    ]);
    expect(issue).toBe('toujours en attente');
  });

  it('L62-AIDE-02 — chargement borné : au-delà du délai, repli « indisponible » (jamais d’attente infinie)', async () => {
    vi.stubGlobal('fetch', vi.fn(jamais));
    const debut = Date.now();
    const s = await loadHelpShortcutsState('/accueil', vi.fn(jamais) as unknown as typeof fetch, 60);
    expect(s).toEqual({ status: 'unavailable' });
    expect(Date.now() - debut).toBeLessThan(1_000);
  });

  it('L62-AIDE-03 — exemples reçus : état « ready », dans l’ordre de la route', async () => {
    const f = vi.fn(async () => json({ available: true, shortcuts: [{ id: 'AID-AGENDA-006', title: 'Synchroniser', path: '/aide/sync' }] }));
    expect(await loadHelpShortcutsState('/agenda', f as unknown as typeof fetch)).toEqual({
      status: 'ready', shortcuts: [{ id: 'AID-AGENDA-006', title: 'Synchroniser', path: '/aide/sync' }],
    });
  });

  it('L62-AIDE-04 — aucune source : « indisponible », jamais une liste vide silencieuse', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(null, false)));
    expect(await loadHelpShortcutsState('/agenda', vi.fn(async () => json({ available: false, shortcuts: [] })) as unknown as typeof fetch))
      .toEqual({ status: 'unavailable' });
  });
});

describe('L62-AIDE — fenêtre « Besoin d’aide ? » (même composant ordinateur et mobile)', () => {
  const rendre = async (state: Parameters<typeof import('@/components/help/HelpModal').HelpShortcutsSection>[0]['state']) => {
    const { HelpShortcutsSection } = await import('@/components/help/HelpModal');
    return renderToStaticMarkup(h(HelpShortcutsSection, { state, onOpen: () => {}, onRetry: () => {} }));
  };

  it('L62-AIDE-05 — chargement : section visible avec un état de chargement annoncé', async () => {
    const html = await rendre({ status: 'loading' });
    expect(html).toContain('Accès rapides');
    expect(html).toContain('data-state="loading"');
    expect(html).toContain('role="status"');
    expect(html).toContain('Chargement des exemples du Centre d’aide');
  });

  it('L62-AIDE-06 — exemples : les titres du Centre d’aide, chacun cliquable', async () => {
    const html = await rendre({ status: 'ready', shortcuts: [{ id: 'A', title: 'Créer un bien', path: '/aide/creer-un-bien' }, { id: 'B', title: 'Ajouter un document', path: '/aide/ajouter-un-document' }] });
    expect(html).toContain('Créer un bien');
    expect(html).toContain('Ajouter un document');
    expect(html.match(/<button/g)).toHaveLength(2);
  });

  it('L62-AIDE-07 — indisponible : message explicite et « Réessayer », jamais une fenêtre vide', async () => {
    const html = await rendre({ status: 'unavailable' });
    expect(html).toContain('Les exemples du Centre d’aide ne sont pas disponibles pour le moment');
    expect(html).toContain('Réessayer');
  });

  it('L62-AIDE-08 — HelpModal affiche TOUJOURS la section (plus de condition « liste non vide »), état initial = chargement', () => {
    const src = lire('src/components/help/HelpModal.tsx');
    expect(src).toContain('<HelpShortcutsSection state={shortcuts}');
    expect(src).not.toContain('shortcuts && shortcuts.length > 0');
    expect(src).toContain("useState<HelpShortcutsState>({ status: 'loading' })");
    expect(src).toContain('loadHelpShortcutsState(pathname)');
  });

  it('L62-AIDE-09 — lot 59/60 : l’ouverture en nouvel onglet est conservée et ne touche pas au chargement', () => {
    const src = lire('src/components/help/HelpModal.tsx');
    expect(src).toContain('openHelpCenter(path)');
    // Lot 63B : plus de mode intégré, `helpPageUrl` ne prend que le chemin.
    expect(lire('src/lib/help-center/open.ts')).toContain("window.open(helpPageUrl(path), '_blank', 'noopener,noreferrer')");
  });
});

describe('L62-AIDE — route /api/help/shortcuts : seconde source (corpus de l’assistant)', () => {
  it('L62-AIDE-10 — catalogue illisible, corpus disponible : exemples tirés du corpus, ordre de la page', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('site injoignable'); }));
    setHelpCorpusForTests(corpus(HELP_SHORTCUT_IDS));
    const { GET } = await import('@/app/api/help/shortcuts/route');
    const { NextRequest } = await import('next/server');
    const res = await GET(new NextRequest('http://app.test/api/help/shortcuts?route=/agenda'));
    const body = await res.json() as { available: boolean; shortcuts: Array<{ id: string; title: string }> };
    expect(res.headers.get('X-Help-Shortcuts-Source')).toBe('corpus');
    expect(body.available).toBe(true);
    expect(body.shortcuts[0]).toEqual({ id: 'AID-AGENDA-006', title: 'Corpus AID-AGENDA-006', path: '/aide/aid-agenda-006' });
    expect(body.shortcuts).toHaveLength(6);
  });

  it('L62-AIDE-11 — corpus : un article absent (non publié) reste masqué, aucun libellé de secours', async () => {
    const { shortcutsFromCorpus } = await import('@/lib/help-center/shortcuts.server');
    const s = shortcutsFromCorpus(corpus(['AID-DOC-001', 'AID-ASSET-001']), HELP_SHORTCUT_IDS);
    expect(s.map((x) => x.id)).toEqual(['AID-ASSET-001', 'AID-DOC-001']);
    expect(shortcutsFromCorpus(null, HELP_SHORTCUT_IDS)).toEqual([]);
  });

  it('L62-AIDE-12 — catalogue lisible : il reste la source (inchangé), en-tête « catalogue »', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(catalog)));
    const { GET } = await import('@/app/api/help/shortcuts/route');
    const { NextRequest } = await import('next/server');
    const res = await GET(new NextRequest('http://app.test/api/help/shortcuts?route=/accueil'));
    expect(res.headers.get('X-Help-Shortcuts-Source')).toBe('catalogue');
    expect(((await res.json()) as { shortcuts: unknown[] }).shortcuts).toHaveLength(6);
  });

  it('L62-AIDE-13 — ni catalogue ni corpus : available=false (la fenêtre affiche son repli explicite)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    const { GET } = await import('@/app/api/help/shortcuts/route');
    const { NextRequest } = await import('next/server');
    const res = await GET(new NextRequest('http://app.test/api/help/shortcuts?route=/accueil'));
    expect(await res.json()).toEqual({ available: false, shortcuts: [] });
    expect(res.headers.get('X-Help-Shortcuts-Source')).toBe('none');
  });

  it('L62-AIDE-14 — le serveur lit le catalogue sur le site que lit l’assistant (HELP_CENTER_URL prime)', async () => {
    vi.stubEnv('HELP_CENTER_URL', 'https://aide.preprod.example');
    try {
      const { serverHelpSiteBase } = await import('@/lib/help-center/shortcuts.server');
      expect(serverHelpSiteBase()).toBe('https://aide.preprod.example');
      const f = vi.fn(async () => json(catalog));
      vi.stubGlobal('fetch', f);
      const { resolveHelpShortcutsOnServer } = await import('@/lib/help-center/shortcuts.server');
      expect((await resolveHelpShortcutsOnServer('/accueil')).source).toBe('catalogue');
      expect(String((f.mock.calls[0] as unknown[])[0])).toBe('https://aide.preprod.example/aide/catalogue.json');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
