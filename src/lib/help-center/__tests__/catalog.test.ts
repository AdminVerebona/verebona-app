/**
 * « Besoin d'aide » résolu depuis le catalogue canonique — CDC Centre d'aide
 * V1 §2.1, §7, §13, ARCH-02, ARCH-03, ARCH-04.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import {
  HELP_SHORTCUT_IDS, parseCatalog, resolveShortcuts, unresolvedShortcuts,
  fetchHelpCatalog, resetHelpCatalogCache, type HelpCatalog,
} from '../catalog';
import { helpPageUrl, integratedHelpHref, isHelpPath, safeReturnPath } from '../open';

const entry = (id: string, over: Partial<HelpCatalog['articles'][number]> = {}) => ({
  id, title: `Titre ${id}`, slug: id.toLowerCase(), path: `/aide/${id.toLowerCase()}`,
  category: 'documents', categoryName: 'Documents', status: 'published' as const, published: true,
  offers: ['standard'], ...over,
});
const catalog = (articles = HELP_SHORTCUT_IDS.map((id) => entry(id))): HelpCatalog => ({
  schema: 'verebona-help-catalog-v1', version: 'v1', environment: 'preprod', articles, redirects: {},
});

describe('les six accès rapides du §13', () => {
  it('sont des IDs canoniques, dans l’ordre du CDC', () => {
    expect([...HELP_SHORTCUT_IDS]).toEqual([
      'AID-ASSET-001', 'AID-DOC-001', 'AID-TODO-001', 'AID-AGENDA-006', 'AID-NOTIF-003', 'AID-BILL-001',
    ]);
  });
});

describe('résolution (ARCH-03, ARCH-04)', () => {
  it('prend titre et chemin dans le catalogue', () => {
    const c = catalog();
    c.articles[0] = entry('AID-ASSET-001', { title: 'Créer un bien — nouveau titre', path: '/aide/creer-un-bien' });
    expect(resolveShortcuts(c)[0]).toEqual({ id: 'AID-ASSET-001', title: 'Créer un bien — nouveau titre', path: '/aide/creer-un-bien' });
  });

  it('conserve l’ordre des IDs de l’application, pas celui du catalogue', () => {
    expect(resolveShortcuts(catalog([...HELP_SHORTCUT_IDS].reverse().map((id) => entry(id)))).map((s) => s.id))
      .toEqual([...HELP_SHORTCUT_IDS]);
  });

  it('masque un ID inconnu ou non publié — jamais de lien cassé (§13)', () => {
    const c = catalog([entry('AID-ASSET-001'), entry('AID-DOC-001', { published: false, status: 'blocked' })]);
    expect(resolveShortcuts(c).map((s) => s.id)).toEqual(['AID-ASSET-001']);
    expect(unresolvedShortcuts(c)).toEqual([
      { id: 'AID-DOC-001', reason: 'non publié' },
      { id: 'AID-TODO-001', reason: 'inconnu' },
      { id: 'AID-AGENDA-006', reason: 'inconnu' },
      { id: 'AID-NOTIF-003', reason: 'inconnu' },
      { id: 'AID-BILL-001', reason: 'inconnu' },
    ]);
  });

  it('n’affiche aucun raccourci sans catalogue', () => {
    expect(resolveShortcuts(null)).toEqual([]);
  });

  it('refuse un catalogue au format inattendu ou un chemin hors du Centre d’aide', () => {
    expect(parseCatalog({ schema: 'autre', articles: [] })).toBeNull();
    expect(parseCatalog({ ...catalog(), articles: [entry('AID-X-001', { path: 'https://ailleurs.example/x' })] })).toBeNull();
    expect(parseCatalog(catalog())).not.toBeNull();
  });
});

describe('lecture du catalogue', () => {
  beforeEach(() => { resetHelpCatalogCache(); vi.restoreAllMocks(); });

  it('lit le site public de l’environnement et met en cache', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(catalog())));
    expect(await fetchHelpCatalog()).not.toBeNull();
    await fetchHelpCatalog();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/aide\/catalogue\.json$/);
  });

  it('ne lève jamais : site indisponible → pas de catalogue', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('réseau'));
    await expect(fetchHelpCatalog()).resolves.toBeNull();
  });
});

describe('ouverture (GAP-09, MOB-01)', () => {
  it('n’ouvre que des chemins du Centre d’aide', () => {
    expect(isHelpPath('/aide/creer-un-bien')).toBe(true);
    expect(isHelpPath('/aide/theme/documents')).toBe(true);
    expect(isHelpPath('/aide?q=agenda%20google')).toBe(true);
    expect(isHelpPath('https://evil.example')).toBe(false);
    expect(isHelpPath('//evil.example/aide')).toBe(false);
    expect(isHelpPath('/aide/../mon-compte')).toBe(false);
    expect(helpPageUrl('javascript:alert(1)', false)).toMatch(/\/aide$/);
  });

  it('ajoute le mode intégré pour la vue de l’application', () => {
    expect(helpPageUrl('/aide/creer-un-bien', true)).toMatch(/\/aide\/creer-un-bien\?integre=app$/);
    expect(helpPageUrl('/aide?q=agenda', true)).toMatch(/\/aide\?q=agenda&integre=app$/);
    expect(integratedHelpHref('/aide/creer-un-bien')).toBe('/aide?page=%2Faide%2Fcreer-un-bien');
  });

  it('fixe le retour à l’ouverture, sur une page de l’application seulement (MOB-03)', () => {
    expect(integratedHelpHref('/aide/creer-un-bien', '/biens/12')).toBe('/aide?page=%2Faide%2Fcreer-un-bien&retour=%2Fbiens%2F12');
    expect(safeReturnPath('/documents?filtre=x')).toBe('/documents?filtre=x');
    for (const bad of [null, '', 'https://evil.example', '//evil.example', '/aide', '/aide?page=x', '/\\evil']) {
      expect(safeReturnPath(bad), String(bad)).toBe('/accueil');
    }
  });
});

describe('aucune rédaction d’aide dans l’application (ARCH-02, GAP-01)', () => {
  const root = process.cwd();

  it('les anciens catalogues éditoriaux ont disparu', () => {
    for (const p of ['src/services/help/help-content.ts', 'src/lib/help-content/articles.ts', 'help/verebona-help-v1.fr-FR.json']) {
      expect(existsSync(join(root, p)), p).toBe(false);
    }
  });

  it('« Besoin d’aide » ne code en dur ni titre ni slug d’article', () => {
    const src = readFileSync(join(root, 'src/components/help/HelpModal.tsx'), 'utf-8');
    expect(src).not.toMatch(/['"`]\/aide\/[a-z0-9-]+['"`]/);
    expect(src).not.toMatch(/Créer un bien|Ajouter un document|Offres et tarifs/);
    expect(src).not.toMatch(/https:\/\/verebona\.(fr|com)/);
  });

  it('aucun fichier de l’application ne réintroduit un tableau d’articles d’aide', () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) { if (n !== 'node_modules' && n !== '__tests__') walk(p); }
        else if (/\.(ts|tsx)$/.test(n)) files.push(p);
      }
    };
    walk(join(root, 'src'));
    const offenders = files.filter((f) => /\bHELP_ARTICLES\b|\bHELP_QUICK_LINKS\b|\b(shortAnswer|detailedAnswer|questionPatterns)\s*:\s*['"`\[]/.test(readFileSync(f, 'utf-8')));
    expect(offenders.map((f) => f.slice(root.length + 1))).toEqual([]);
  });
});
