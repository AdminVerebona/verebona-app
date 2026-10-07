/**
 * Lot 32, point 8 — exemples « Par exemple » du champ « Demander à Verebona ».
 *
 *  · AC8.1 : aucun exemple ne dit « ce bien » / « sa fiche » (sans référent hors fiche) ;
 *  · AC8.2 : sur une fiche, les exemples NOMMENT le bien (élision comprise) ;
 *  · AC8.3 : hors fiche, exemples généraux ou nommant un vrai bien du compte ;
 *  · AC8.4 : sans contexte serveur, aucun exemple dépendant des données ;
 *    un exemple dépendant des données n'est proposé que si la donnée existe ;
 *  · AC8.5 : un nom ambigu (doublon, inclusion) n'est jamais cité ;
 *  · AC8.6 : source unique — desktop, mobile, mascotte et API lisent `suggestionsForRoute`.
 * (Réponse réelle de chaque exemple : `src/test/e2e/scenarios/l32e-exemples-et-export.e2e.ts`.)
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) } }));

const {
  SUGGESTIONS, ACCOUNT_STATE_SUGGESTIONS, suggestionsForRoute, isAssetNameSuggestable, deBien,
} = await import('../capability-registry');
const { pickSuggestionAssets, assetIdFromRoute } = await import('../../core/account-state');

const vide = { toProcessPending: 0, deadlinesSoon: 0, documentsInAnalysis: 0, documentsFailed: 0, exportsReady: 0, documentsUnlinked: 0 };
const ROUTES = ['/', '/accueil', '/accueil/a-traiter', '/assets', '/assets/42', '/assets/42/documents', '/documents', '/agenda', '/mon-compte', '/aide', '/inconnue'];

describe('AC8.1 — jamais « ce bien » ni « sa fiche »', () => {
  it('aucun libellé du catalogue ne désigne un bien sans le nommer', () => {
    for (const s of [...SUGGESTIONS, ...ACCOUNT_STATE_SUGGESTIONS]) {
      expect(s.label, s.id).not.toMatch(/\bce bien\b|\bsa fiche\b|\bcette fiche\b|\bce document\b/i);
    }
  });
  it('aucune suggestion rendue, sur aucune page et dans aucun contexte, ne dit « ce bien »', () => {
    const ctx = { state: { ...vide, toProcessPending: 2, documentsUnlinked: 1, exportsReady: 1 }, pageAsset: { name: 'Cupra', documents: 3 }, accountAsset: { name: 'Polo', documents: 1 } };
    for (const r of ROUTES) {
      for (const c of [undefined, null, ctx, { state: vide }]) {
        for (const s of suggestionsForRoute(r, c)) expect(s.label, `${r} ${s.id}`).not.toMatch(/ce bien|sa fiche|\{/);
      }
    }
  });
});

describe('AC8.2 — fiche d’un bien : le bien est nommé', () => {
  it('« Quels sont les documents de Cupra ? », « Quelles sont les prochaines échéances de Cupra ? »', () => {
    const l = suggestionsForRoute('/assets/42', { state: vide, pageAsset: { name: 'Cupra', documents: 2 } }).map((s) => s.label);
    expect(l.slice(0, 3)).toEqual([
      'Quels sont les documents de Cupra ?',
      'Quelles sont les prochaines échéances de Cupra ?',
      'Comment compléter la fiche d’un bien ?',
    ]);
  });
  it('sous-onglet de la fiche (/assets/42/documents) : même règle', () => {
    expect(suggestionsForRoute('/assets/42/documents', { pageAsset: { name: 'Cupra', documents: 1 } })[0].label).toBe('Quels sont les documents de Cupra ?');
  });
  it('élision devant une voyelle', () => {
    expect(deBien('Appartement d’Annecy')).toBe('d’Appartement d’Annecy');
    expect(deBien('Écurie')).toBe('d’Écurie');
    expect(deBien('Peugeot 3008')).toBe('de Peugeot 3008');
    expect(suggestionsForRoute('/assets/7', { pageAsset: { name: 'Appartement d’Annecy', documents: 0 } })[0].label)
      .toBe('Quelles sont les prochaines échéances d’Appartement d’Annecy ?');
  });
  it('bien sans document : pas de question sur ses documents (réponse vide), échéances et aide à la place', () => {
    const l = suggestionsForRoute('/assets/42', { pageAsset: { name: 'Cupra', documents: 0 } }).map((s) => s.id);
    expect(l).not.toContain('asset_docs');
    expect(l.slice(0, 3)).toEqual(['asset_deadlines', 'asset_complete', 'asset_add_doc']);
  });
  it('bien non nommable (inconnu, archivé, ambigu) : aucun exemple nommé, jamais « ce bien »', () => {
    const l = suggestionsForRoute('/assets/42', { state: vide, pageAsset: null });
    expect(l.map((s) => s.id)).not.toContain('asset_docs');
    expect(l.map((s) => s.id)).not.toContain('asset_deadlines');
    expect(l.length).toBeGreaterThanOrEqual(3);
  });
});

describe('AC8.3 — hors fiche : général, ou un vrai bien du compte', () => {
  it('aucun exemple de fiche hors de /assets/:id', () => {
    for (const r of ROUTES.filter((x) => !/^\/assets\/\d+/.test(x))) {
      const ids = suggestionsForRoute(r, { state: vide, pageAsset: { name: 'Cupra', documents: 3 }, accountAsset: { name: 'Polo', documents: 2 } }).map((s) => s.id);
      expect(ids.some((x) => x.startsWith('asset_')), r).toBe(false);
    }
  });
  it('accueil, documents, biens : le bien du compte est nommé (documents seulement s’il en a)', () => {
    const ctx = { state: vide, accountAsset: { name: 'Polo', documents: 2 } };
    expect(suggestionsForRoute('/accueil', ctx).map((s) => s.label)).toContain('Quels sont les documents de Polo ?');
    expect(suggestionsForRoute('/documents', ctx).map((s) => s.label)).toContain('Quels sont les documents de Polo ?');
    expect(suggestionsForRoute('/assets', ctx).map((s) => s.label)).toContain('Quelles sont les prochaines échéances de Polo ?');
    expect(suggestionsForRoute('/accueil', { state: vide, accountAsset: { name: 'Polo', documents: 0 } }).map((s) => s.label))
      .not.toContain('Quels sont les documents de Polo ?');
  });
});

describe('AC8.4 — exemples dépendant des données', () => {
  it('sans contexte serveur (rendu client) : aucun exemple dépendant des données ni gabarit', () => {
    for (const r of ROUTES) {
      for (const s of suggestionsForRoute(r)) {
        const e = [...SUGGESTIONS, ...ACCOUNT_STATE_SUGGESTIONS].find((x) => x.id === s.id)!;
        expect(e.when, `${r} ${s.id}`).toBeUndefined();
        expect(e.asset, `${r} ${s.id}`).toBeUndefined();
      }
    }
  });
  it('« Que dois-je traiter en priorité ? » seulement s’il y a des éléments à traiter', () => {
    expect(suggestionsForRoute('/accueil/a-traiter', { state: vide }).map((s) => s.id)).not.toContain('todo_priority');
    expect(suggestionsForRoute('/accueil', { state: vide }).map((s) => s.label)).not.toContain('Que dois-je traiter en priorité ?');
    expect(suggestionsForRoute('/accueil/a-traiter', { state: { ...vide, toProcessPending: 1 } })[0].id).toBe('todo_priority');
  });
  it('« Quels documents ne sont rattachés à aucun bien ? » seulement s’il y en a', () => {
    expect(suggestionsForRoute('/documents', { state: vide }).map((s) => s.id)).not.toContain('docs_unlinked');
    expect(suggestionsForRoute('/documents', { state: { ...vide, documentsUnlinked: 3 } })[0].id).toBe('docs_unlinked');
  });
  it('3 à 4 exemples, sans doublon, sur chaque page', () => {
    for (const r of ROUTES) {
      for (const c of [undefined, { state: vide }, { state: { ...vide, toProcessPending: 1, deadlinesSoon: 1, documentsFailed: 1, exportsReady: 1 }, accountAsset: { name: 'Polo', documents: 1 } }]) {
        const l = suggestionsForRoute(r, c).map((s) => s.label);
        expect(l.length, r).toBeGreaterThanOrEqual(3);
        expect(l.length, r).toBeLessThanOrEqual(4);
        expect(new Set(l).size, r).toBe(l.length);
      }
    }
  });
});

describe('AC8.5 — noms citables sans ambiguïté', () => {
  it('nom unique : citable ; doublon, inclusion, trop long ou caractères spéciaux : non', () => {
    expect(isAssetNameSuggestable('Cupra', ['Polo', 'Maison Lyon'])).toBe(true);
    expect(isAssetNameSuggestable('Cupra', ['cupra'])).toBe(false);
    expect(isAssetNameSuggestable('Cupra', ['Cupra Born'])).toBe(false);
    expect(isAssetNameSuggestable('Cupra Born', ['Cupra'])).toBe(false);
    expect(isAssetNameSuggestable('Élan', ['elan'])).toBe(false);
    expect(isAssetNameSuggestable('x'.repeat(41), [])).toBe(false);
    expect(isAssetNameSuggestable('Maison <script>', [])).toBe(false);
    expect(isAssetNameSuggestable('Peugeot 3008', [])).toBe(true);
    expect(isAssetNameSuggestable('Appartement d’Annecy', [])).toBe(true);
    expect(isAssetNameSuggestable('', [])).toBe(false);
  });
  it('choix des biens : fiche → ce bien s’il est nommable ; hors fiche → le plus récent nommable, avec documents de préférence', () => {
    const biens = [
      { id: 1, name: 'Cupra', documents: 2 },
      { id: 2, name: 'Cupra Born', documents: 0 },
      { id: 3, name: 'Polo', documents: 0 },
      { id: 4, name: 'Maison Lyon', documents: 5 },
    ];
    expect(pickSuggestionAssets(biens, 1)).toEqual({ pageAsset: null, accountAsset: null });
    expect(pickSuggestionAssets(biens, 4)).toEqual({ pageAsset: { name: 'Maison Lyon', documents: 5 }, accountAsset: null });
    expect(pickSuggestionAssets(biens, 99)).toEqual({ pageAsset: null, accountAsset: null });
    expect(pickSuggestionAssets(biens, null).accountAsset).toEqual({ name: 'Maison Lyon', documents: 5 });
    expect(pickSuggestionAssets([biens[2]], null).accountAsset).toEqual({ name: 'Polo', documents: 0 });
    expect(pickSuggestionAssets([], null).accountAsset).toBeNull();
  });
  it('identifiant de fiche lu dans la route', () => {
    expect(assetIdFromRoute('/assets/42')).toBe(42);
    expect(assetIdFromRoute('/assets/42/documents?x=1')).toBe(42);
    expect(assetIdFromRoute('/assets')).toBeNull();
    expect(assetIdFromRoute('/assets/abc')).toBeNull();
    expect(assetIdFromRoute(null)).toBeNull();
  });
});

describe('AC8.6 — source unique des exemples', () => {
  const ROOT = join(__dirname, '../../../../..');
  const lire = (p: string) => readFileSync(join(ROOT, p), 'utf8');
  it('desktop et mobile rendent la même liste (`api.suggestions`), servie par le catalogue', () => {
    const content = lire('src/components/verebona/space/SpaceContent.tsx');
    expect(content).toMatch(/api\.suggestions\.map/);
    const provider = lire('src/components/verebona/space/VerebonaSpaceProvider.tsx');
    expect(provider).toMatch(/suggestionsForRoute\(pageContext\.route\)/);
    expect(provider).toMatch(/\/api\/verebona\/suggestions\?route=/);
    expect(lire('src/app/api/verebona/suggestions/route.ts')).toMatch(/suggestionsForRoute\(q\.data\.route, ctx\)/);
  });
  it('aucun libellé du catalogue n’est recopié ailleurs dans l’interface', () => {
    const labels = SUGGESTIONS.filter((s) => !s.asset).map((s) => s.label);
    const fichiers: string[] = [];
    const parcourir = (d: string) => {
      for (const f of readdirSync(join(ROOT, d))) {
        const p = `${d}/${f}`;
        if (f === '__tests__' || f === 'node_modules') continue;
        if (statSync(join(ROOT, p)).isDirectory()) parcourir(p);
        else if (/\.tsx$/.test(f)) fichiers.push(p);
      }
    };
    parcourir('src/components');
    parcourir('src/app');
    for (const f of fichiers) {
      const t = lire(f);
      for (const l of ['Quels sont les documents', 'Quelles sont les prochaines échéances', 'Comment poser une question à Verebona ?']) {
        expect(t.includes(l), `${f} : « ${l} »`).toBe(false);
      }
    }
    expect(labels.length).toBeGreaterThan(10);
  });
});
