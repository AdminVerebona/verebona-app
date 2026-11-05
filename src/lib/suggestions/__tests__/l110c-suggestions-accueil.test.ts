/**
 * Lot 110C — suggestions retirées de l'accueil mobile, rangée unique sur
 * l'accueil large, conservées dans « Demander à Verebona » (T2).
 *
 *  L110C-U01  règle d'emplacement : app native → aucune ; < 768 px → aucune ;
 *             ≥ 768 px (navigateur, PWA d'ordinateur) → rangée ;
 *  L110C-U02  magasin : sans surface active (accueil mobile, T2 fermé), un
 *             événement de données ne relit PAS ; la liste est marquée
 *             périmée et relue à la prochaine activation ;
 *  L110C-U03  accueil : lecture seulement quand la rangée existe ; zone non
 *             rendue sur mobile ; rendu serveur réservé en CSS ≥ 768 px ;
 *  L110C-U04  T2 : suggestions conservées sur tous les supports (même
 *             source, lecture à l'ouverture, variante mobile rendue) ;
 *  L110C-U05  rangée : au plus trois cartes, jetons de la charte, ≥ 44 px,
 *             retour à la ligne, aucun défilement horizontal ;
 *  L110C-U06  périmètre : ni sélection, ni service serveur, ni « À traiter »
 *             (2 priorités) modifiés.
 * Le contrôle réseau réel (aucune requête depuis l'accueil mobile) est dans
 * `src/components/home/__tests__/l110c-suggestions-accueil-navigateur.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as React from 'react';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HOME_SUGGESTIONS_MIN_WIDTH_PX, HOME_SUGGESTIONS_WIDE_QUERY, homeSuggestionsPlacement,
} from '@/lib/suggestions/home-placement';
import {
  activeSharedSuggestionSurfaces, ensureSharedSuggestions, resetSharedSuggestions, scheduleSharedSuggestionsRefresh,
} from '@/lib/suggestions/shared-suggestions';
import { SharedSuggestionList } from '@/components/suggestions/SharedSuggestionList';
import { MAX_HOME_SUGGESTIONS } from '@/services/home/mascot/types';
import { MAX_TODO_ITEMS } from '@/services/home/mascot/todo-items';

// Composants compilés en JSX classique sous vitest (comme l36a).
(globalThis as { React?: typeof React }).React = React;

const ROOT = join(__dirname, '../../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const sansCommentaires = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('L110C-U01 — règle d’emplacement', () => {
  it('app iOS / Android : aucune zone, quelle que soit la largeur', () => {
    expect(homeSuggestionsPlacement({ native: true, wide: true })).toBe('none');
    expect(homeSuggestionsPlacement({ native: true, wide: false })).toBe('none');
  });
  it('navigateur ou PWA : point de rupture md (768 px) de la charte', () => {
    expect(HOME_SUGGESTIONS_MIN_WIDTH_PX).toBe(768);
    expect(HOME_SUGGESTIONS_WIDE_QUERY).toBe('(min-width: 768px)');
    expect(homeSuggestionsPlacement({ native: false, wide: false })).toBe('none');
    expect(homeSuggestionsPlacement({ native: false, wide: true })).toBe('row');
  });
  it('détection native partagée (isNativeApp), jamais une liste d’agents utilisateurs maison', () => {
    const src = read('src/lib/suggestions/home-placement.ts');
    expect(src).toContain("import { isNativeApp } from '@/lib/native/bridge'");
    expect(src).toMatch(/useSyncExternalStore\(subscribe, snapshot, \(\) => 'unknown'\)/);
  });
});

describe('L110C-U02 — magasin partagé : aucune lecture sans surface active', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); resetSharedSuggestions(); });

  it('événement de données sans surface : pas de relecture, liste périmée relue à la prochaine activation', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ version: 'v1', items: [{ id: 'a', label: 'A ?', objective: 'GUIDE', source: 'HELP_CENTER' }], reserve: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
    resetSharedSuggestions();
    expect(activeSharedSuggestionSurfaces()).toBe(0);
    await ensureSharedSuggestions();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Fraîche : aucune relecture.
    await ensureSharedSuggestions();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Un document est ajouté alors qu'aucune surface n'affiche les suggestions.
    scheduleSharedSuggestionsRefresh(10);
    await vi.advanceTimersByTimeAsync(50);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Ouverture suivante d'une surface : relecture (rien de perdu).
    await ensureSharedSuggestions();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('une surface active compte ; inactive, elle ne lit rien', () => {
    const src = sansCommentaires(read('src/lib/suggestions/shared-suggestions.ts'));
    expect(src).toMatch(/if \(!active\) return;\s*activeSurfaces \+= 1;\s*void ensureSharedSuggestions\(\);\s*return \(\) => \{ activeSurfaces -= 1; \};/);
    expect(src).toMatch(/if \(activeSurfaces > 0\) void ensureSharedSuggestions\(true\);/);
  });
});

describe('L110C-U03 — accueil : zone et lecture seulement sur format large', () => {
  const src = read('src/components/home/MascotSpeaks.tsx');
  it('lecture et télémétrie « affiché » seulement quand la rangée existe', () => {
    expect(src).toContain("const placement = useHomeSuggestionsPlacement();");
    expect(src).toContain("useSharedSuggestions({ track: true, active: placement === 'row' })");
  });
  it('mobile : zone NON rendue (ni place réservée) ; mascotte sur deux rangées seulement', () => {
    expect(src).toMatch(/\{placement !== 'none' && \(\s*<div className="col-span-2 hidden min-w-0 md:col-span-1 md:col-start-2 md:mt-1 md:block" data-home-suggestions-zone>/);
    expect(src).toContain("placement === 'none' ? 'md:row-span-2' : 'md:row-span-3'");
    expect(src).toContain("items={placement === 'row' ? shared.items : []}");
  });
  it('rendu serveur (emplacement inconnu) : rangée d’attente visible seulement ≥ 768 px, aucune suggestion', async () => {
    vi.resetModules();
    vi.doMock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }), usePathname: () => '/accueil' }));
    vi.doMock('@/components/verebona/space/VerebonaSpaceProvider', () => ({ useVerebonaSpace: () => null }));
    vi.doMock('@/contexts/WriteGuardContext', () => ({ useWriteGuard: () => ({ garder: (f: () => void) => f() }) }));
    vi.doMock('@/components/home/useMascotPresentation', () => ({ useMascotPresentation: () => ({ presentation: null, failed: false, refresh: () => {}, trackClick: () => {} }) }));
    const { MascotSpeaks } = await import('@/components/home/MascotSpeaks');
    const s = renderToStaticMarkup(h(MascotSpeaks, { greetingName: 'Geo', empty: false, onCreateAsset: () => {}, onUploadDocument: () => {} }));
    expect(s).toMatch(/class="col-span-2 hidden min-w-0 [^"]*md:block" data-home-suggestions-zone/);
    expect(s).toContain('data-home-suggestions-loading');
    expect(s).not.toContain('aria-label="Questions suggérées"');
    vi.doUnmock('next/navigation');
    vi.doUnmock('@/components/verebona/space/VerebonaSpaceProvider');
    vi.doUnmock('@/contexts/WriteGuardContext');
    vi.doUnmock('@/components/home/useMascotPresentation');
  });
  it('clic : même déclenchement réel de T2 (intention + contexte, #657)', () => {
    expect(src).toMatch(/const ctx = shared\.pick\(s\);\s*void space\?\.ask\(s\.label, ctx\);/);
  });
});

describe('L110C-U04 — « Demander à Verebona » garde ses suggestions sur tous les supports', () => {
  it('même source, lecture à l’ouverture, variante mobile rendue', () => {
    const provider = read('src/components/verebona/space/VerebonaSpaceProvider.tsx');
    expect(provider).toContain('useSharedSuggestions({ active: isOpen })');
    expect(provider).not.toMatch(/useHomeSuggestionsPlacement|isNativeApp\(\)[\s\S]{0,80}suggestions/);
    const content = read('src/components/verebona/space/SpaceContent.tsx');
    const initial = content.slice(content.indexOf('function InitialState('), content.indexOf('Échanges regroupés'));
    expect(initial).toContain('api.suggestions.map');
    expect(initial).toContain("mobile ? 'min-h-11");
    expect(initial).not.toMatch(/!mobile && api\.suggestions\.map/);
  });
});

describe('L110C-U05 — rangée de l’accueil large', () => {
  const items = [1, 2, 3, 4].map((i) => ({ id: `s${i}`, label: `Question ${i} assez longue pour passer à la ligne ?`, objective: 'GUIDE' as const, source: 'HELP_CENTER' as const }));
  it('au plus trois cartes sur une grille de trois colonnes', () => {
    const s = renderToStaticMarkup(h(SharedSuggestionList, { items, onAsk: () => {} }));
    expect(MAX_HOME_SUGGESTIONS).toBe(3);
    expect(s.match(/<button type="button"/g)).toHaveLength(3);
    expect(s).toContain('grid-cols-3');
    expect(s).toContain('data-layout="row"');
    expect(s).not.toContain('Question 4');
  });
  it('chargement : une rangée réservée de trois emplacements', () => {
    const s = renderToStaticMarkup(h(SharedSuggestionList, { items: [], loading: true, onAsk: () => {} }));
    expect(s).toContain('data-home-suggestions-loading');
    expect(s.match(/animate-pulse/g)).toHaveLength(3);
    expect(s).toContain('grid-cols-3');
  });
  it('charte : jetons seulement, cible ≥ 44 px, texte qui passe à la ligne, ni défilement ni empilement', () => {
    const src = read('src/components/suggestions/SharedSuggestionList.tsx');
    expect(src).toContain('min-h-[44px]');
    expect(src).toContain('break-words');
    expect(src).not.toMatch(/#[0-9a-f]{3,6}\b|overflow-x-auto|snap-x|flex-col|truncate|line-clamp/i);
    expect(src).not.toMatch(/(?:bg|text|border)-(?:white|black|gray|slate|zinc|neutral|stone|red|blue|green)-?/);
    // Secondaire : bord discret et texte secondaire.
    expect(src).toContain('border-[color:var(--border-subtle)]');
    expect(src).toContain('text-[color:var(--text-secondary)]');
  });
});

describe('L110C-U06 — périmètre : rien d’autre ne change', () => {
  it('trois suggestions ≠ deux priorités « À traiter »', () => {
    expect(MAX_HOME_SUGGESTIONS).toBe(3);
    expect(MAX_TODO_ITEMS).toBe(2);
  });
  it('la route et le service des suggestions ignorent le support (aucun vidage côté serveur)', () => {
    for (const f of ['src/app/api/suggestions/route.ts', 'src/services/suggestions/shared/service.ts', 'src/services/suggestions/shared/select.ts']) {
      expect(sansCommentaires(read(f)), f).not.toMatch(/X-Verebona-Client|isNativeApp|user-agent|mobile/i);
    }
  });
});
