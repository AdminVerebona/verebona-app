/**
 * Lot 97C — recherche locale réactive (Documents et Agenda, pages générales
 * et onglets des biens). Tests unitaires : paramètres, saisie différée,
 * réponses dans le désordre, URL / historique / onglets, « Voir tous » de la
 * recherche générale, compteurs, cloisonnement du stockage de session, et
 * gardes de structure (un seul champ commun, quatre écrans, aucun appel IA).
 *
 * Le comportement serveur (exhaustivité, périmètre, filtres, pagination,
 * comptes) est vérifié sur PostgreSQL : `l97c-recherche-locale.e2e.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  LOCAL_SEARCH_DEBOUNCE_MS,
  LOCAL_SEARCH_LABELS,
  createLatestGuard,
  createLocalSearchInput,
  localSearchHref,
  localSearchNoResult,
  localSearchStatus,
  normalizeLocalQuery,
  readLocalQuery,
  searchForTab,
  searchWithLocalQuery,
} from '../local-search';
import { buildFeedQuery, parseFeedParams } from '@/lib/documents/document-feed';
import { countLabel } from '@/components/documents/v2/documents-view';
import { seeAllLinks, toLiveResults, LIVE_MAX_RESULTS } from '@/lib/verebona/live-search';
import { clearPrivateSessionStorage, PRIVATE_SESSION_PREFIXES } from '@/lib/session/private-session-storage';
import { snapshotStorageKey } from '@/components/documents/v2/list-restore';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

describe('paramètres de recherche', () => {
  it('saisie normalisée : espaces superflus retirés, longueur bornée, vide sans restriction', () => {
    expect(normalizeLocalQuery('  Homiris   facture ')).toBe('Homiris facture');
    expect(normalizeLocalQuery(null)).toBe('');
    expect(normalizeLocalQuery('x'.repeat(500))).toHaveLength(200);
    expect(readLocalQuery(new URLSearchParams('q=%20fen%C3%AAtre%20'))).toBe('fenêtre');
    expect(readLocalQuery(null)).toBe('');
  });

  it('libellés validés (§3.1)', () => {
    expect(LOCAL_SEARCH_LABELS.document).toBe('Rechercher dans les documents…');
    expect(LOCAL_SEARCH_LABELS.agenda).toBe('Rechercher dans l’agenda…');
  });

  it('nombre réel de résultats et message « aucun résultat » distinct', () => {
    expect(localSearchStatus('document', 12)).toBe('12 documents trouvés');
    expect(localSearchStatus('document', 1)).toBe('1 document trouvé');
    expect(localSearchStatus('agenda', 0)).toBe('Aucun élément trouvé');
    expect(localSearchNoResult('document', 'Homiris', false)).toBe('Aucun document ne correspond à « Homiris ».');
    expect(localSearchNoResult('agenda', 'fenetre', true)).toBe('Aucun élément ne correspond à « fenetre » avec ces filtres.');
  });

  it('compteur de la barre d’outils : « trouvés » pendant une recherche, « sur N » avec un filtre', () => {
    expect(countLabel(12, 12, false, 'mes-documents', true)).toBe('12 documents trouvés');
    expect(countLabel(4, 12, true, 'fiche-bien', true)).toBe('4 documents sur 12 trouvés');
    // Sans recherche : libellés historiques inchangés.
    expect(countLabel(3, 3, false, 'fiche-bien')).toBe('3 documents rattachés à ce bien');
    expect(countLabel(3, 19, true, 'mes-documents')).toBe('3 documents sur 19');
  });
});

describe('API documents : `q` dans la requête et dans la clé de pagination', () => {
  const base = { assetIds: [14], sort: 'added' as const, direction: 'desc' as const, grouped: false, filters: { biens: [], rubrics: [], types: ['SUBSCRIPTION_INVOICE'] }, ids: null };

  it('relue à l’identique par la route ; vide → absente', () => {
    const qs = buildFeedQuery({ ...base, q: '  Homiris ' });
    expect(new URLSearchParams(qs).get('q')).toBe('Homiris');
    const relu = parseFeedParams(new URLSearchParams(qs));
    expect(relu.q).toBe('Homiris');
    expect(relu.filters.types).toEqual(['SUBSCRIPTION_INVOICE']);
    expect(relu.assetIds).toEqual([14]);
    expect(parseFeedParams(new URLSearchParams('q=%20%20')).q).toBeUndefined();
    expect(new URLSearchParams(buildFeedQuery({ ...base, q: '' })).has('q')).toBe(false);
  });

  it('toute modification de la recherche change la clé (curseur invalidé, premier lot rechargé)', () => {
    const a = buildFeedQuery({ ...base, q: 'homi' });
    const b = buildFeedQuery({ ...base, q: 'homiris' });
    expect(a).not.toBe(b);
    expect(buildFeedQuery({ ...base, q: 'homiris ' })).toBe(b);
  });

  it('une recherche n’est jamais limitée par un ancien `?resultats=` (ids écartés de la requête)', () => {
    const qs = new URLSearchParams(buildFeedQuery({ ...base, ids: [3, 4], q: 'Homiris' }));
    expect(qs.has('ids')).toBe(false);
    expect(new URLSearchParams(buildFeedQuery({ ...base, ids: [3, 4] })).get('ids')).toBe('3,4');
  });
});

describe('saisie différée (Q2-A) et réponses dans le désordre', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('300 ms sans frappe : UNE seule recherche pour une frappe rapide (nombre de requêtes mesuré)', () => {
    expect(LOCAL_SEARCH_DEBOUNCE_MS).toBe(300);
    const envoyees: string[] = [];
    const champ = createLocalSearchInput((q) => envoyees.push(q));
    let saisie = '';
    for (const c of 'homiris') { saisie += c; champ.type(saisie); vi.advanceTimersByTime(80); }
    expect(envoyees).toEqual([]);
    vi.advanceTimersByTime(LOCAL_SEARCH_DEBOUNCE_MS);
    expect(envoyees).toEqual(['homiris']);
  });

  it('pause au milieu : deux recherches, dans l’ordre ; même texte : aucune nouvelle requête', () => {
    const envoyees: string[] = [];
    const champ = createLocalSearchInput((q) => envoyees.push(q));
    champ.type('hom'); vi.advanceTimersByTime(300);
    champ.type('homiris'); vi.advanceTimersByTime(299);
    expect(envoyees).toEqual(['hom']);
    vi.advanceTimersByTime(1);
    expect(envoyees).toEqual(['hom', 'homiris']);
    champ.type('homiris '); vi.advanceTimersByTime(300);
    expect(envoyees).toEqual(['hom', 'homiris']);
  });

  it('Entrée : immédiate, le délai en cours est annulé ; effacement immédiat ; démontage sans envoi tardif', () => {
    const envoyees: string[] = [];
    const champ = createLocalSearchInput((q) => envoyees.push(q), { initial: 'fenetre' });
    champ.type('entretien');
    champ.submit('entretien');
    expect(envoyees).toEqual(['entretien']);
    vi.advanceTimersByTime(1000);
    expect(envoyees).toEqual(['entretien']);
    champ.clear();
    expect(envoyees).toEqual(['entretien', '']);
    champ.type('x'); champ.dispose(); vi.advanceTimersByTime(1000);
    expect(envoyees).toEqual(['entretien', '']);
  });

  it('valeur reçue de l’URL (retour arrière) : devient la référence sans annuler la frappe en cours', () => {
    const envoyees: string[] = [];
    const champ = createLocalSearchInput((q) => envoyees.push(q));
    champ.sync('homiris');
    champ.submit('homiris');
    expect(envoyees).toEqual([]);
    champ.type('hom');
    champ.sync('fenetre');
    vi.advanceTimersByTime(300);
    expect(envoyees).toEqual(['hom']);
  });

  it('seule la dernière recherche est affichée : une réponse plus ancienne est ignorée', () => {
    const garde = createLatestGuard();
    const a = garde.next();
    const b = garde.next();
    expect(garde.isLatest(a)).toBe(false);
    expect(garde.isLatest(b)).toBe(true);
  });
});

describe('URL, historique et onglets (§7)', () => {
  it('pages générales : `q` ajouté ou retiré, autres filtres conservés', () => {
    expect(searchWithLocalQuery('?period=upcoming&assetIds=3', 'entretien')).toBe('?period=upcoming&assetIds=3&q=entretien');
    expect(searchWithLocalQuery('?period=upcoming&q=entretien', '')).toBe('?period=upcoming');
    expect(searchWithLocalQuery('', '')).toBe('');
  });

  it('Mes documents : une nouvelle recherche retire l’ancien `?resultats=` de l’assistant', () => {
    expect(searchWithLocalQuery('?resultats=1,2', 'Homiris', { dropResults: true })).toBe('?q=Homiris');
    expect(searchWithLocalQuery('?resultats=1,2', '', { dropResults: true })).toBe('?resultats=1%2C2');
  });

  it('Agenda (Q3-B) : une recherche nouvelle ou modifiée passe en vue Liste ; la vue choisie ensuite est gardée', () => {
    expect(searchWithLocalQuery('?view=calendar&month=2031-03', 'entretien', { switchToList: true })).toBe('?view=list&month=2031-03&q=entretien');
    // Recherche inchangée (validation répétée) : la vue mensuelle choisie reste.
    expect(searchWithLocalQuery('?view=calendar&q=entretien', 'entretien', { switchToList: true })).toBe('?view=calendar&q=entretien');
    expect(searchWithLocalQuery('?view=calendar&q=entretien', '', { switchToList: true })).toBe('?view=calendar');
  });

  it('onglets d’un bien : `tab` conservé, la recherche n’est jamais propagée à un autre onglet', () => {
    expect(searchForTab('?tab=documents&q=fenetre', 'agenda')).toBe('?tab=agenda');
    expect(searchForTab('?tab=agenda&q=entretien', 'agenda')).toBe('?tab=agenda&q=entretien');
    expect(searchForTab('', 'documents')).toBe('?tab=documents');
  });

  it('les écrans mettent l’URL à jour sans nouvelle entrée d’historique par saisie (replaceState)', () => {
    for (const f of [
      'src/components/documents/v2/DocumentsByRubric.tsx',
      'src/app/(dashboard)/agenda/page.tsx',
      'src/components/assets/AssetAgendaTab.tsx',
    ]) {
      const src = read(f);
      const bloc = src.slice(src.indexOf('const changerRecherche'), src.indexOf('const changerRecherche') + 900);
      // Lot 100E (A8) : « Mon agenda » passe par `agendaSearchParams` (période suspendue), qui appelle `searchWithLocalQuery`.
      expect(bloc).toMatch(/window\.history\.replaceState\(null, '', `\$\{pathname\}\$\{(searchWithLocalQuery\(search, next|suite\})/);
      expect(bloc).toContain('searchWithLocalQuery(');
      expect(bloc).not.toMatch(/pushState|router\.push/);
    }
    const fiche = read('src/app/(dashboard)/assets/[id]/page.tsx');
    expect(fiche).toMatch(/window\.history\.pushState\(\{\}, '', `\$\{pathname\}\$\{searchForTab\(search, tab\)\}\$\{hash\}`\)/);
  });
});

describe('recherche générale : « Voir tous » avec la recherche préremplie (§7.3)', () => {
  it('liens vers les écrans complets, le critère et jamais les identifiants des suggestions', () => {
    expect(localSearchHref('document', 'Homiris')).toBe('/documents?q=Homiris');
    expect(localSearchHref('agenda', 'contrôle technique')).toBe('/agenda?q=contr%C3%B4le+technique&view=list');
    const rows = [
      { id: 'doc-1', category: 'Document', label: 'Facture Homiris', href: '/documents?doc=1' },
      { id: 'agenda-2', category: 'Agenda', label: 'Entretien', href: '/agenda?echeance=2' },
    ];
    expect(seeAllLinks('Homiris', rows)).toEqual([
      { id: 'voir-documents', label: 'Voir tous les documents', href: '/documents?q=Homiris' },
      { id: 'voir-agenda', label: 'Voir tous les éléments d’agenda', href: '/agenda?q=Homiris&view=list' },
    ]);
    expect(seeAllLinks('Homiris', [rows[0]])).toHaveLength(1);
    expect(seeAllLinks('H', rows)).toEqual([]);
    expect(seeAllLinks('Homiris', [])).toEqual([]);
    // Les suggestions elles-mêmes restent plafonnées (inchangées).
    expect(toLiveResults('mes', Array.from({ length: 20 }, (_, i) => ({ id: `d${i}`, category: 'Document', label: `D${i}`, href: '/documents' })))).toHaveLength(LIVE_MAX_RESULTS);
  });

  it('`?resultats=` et les actions de l’assistant restent servis tels quels', () => {
    const vue = read('src/components/documents/v2/DocumentsByRubric.tsx');
    expect(vue).toMatch(/if \(!assetId && !recherche\) setResultIds\(parseSearchResults\(params\.get\('resultats'\)\)\)/);
    expect(read('src/services/verebona-assistant/core/search-token.ts')).toMatch(/q\.set\('resultats', documentIds\.join\(','\)\)/);
  });
});

describe('changement de compte (AC17) : rien de la consultation précédente n’est repris', () => {
  it('les instantanés de liste (titres, recherche dans la clé) sont effacés ; le reste du stockage est gardé', () => {
    const data = new Map<string, string>([
      [snapshotStorageKey('mes-documents'), '{}'],
      [snapshotStorageKey('bien-14'), '{}'],
      ['verebona-theme', 'dark'],
    ]);
    const storage = {
      get length() { return data.size; },
      key: (i: number) => [...data.keys()][i] ?? null,
      removeItem: (k: string) => { data.delete(k); },
    };
    expect(snapshotStorageKey('x').startsWith(PRIVATE_SESSION_PREFIXES[0])).toBe(true);
    expect(clearPrivateSessionStorage(storage)).toBe(2);
    expect([...data.keys()]).toEqual(['verebona-theme']);
    expect(clearPrivateSessionStorage(null)).toBe(0);
  });

  it('effacement branché sur la fin de session et sur le changement d’espace', () => {
    expect(read('src/lib/api-client.ts')).toMatch(/purgeLocalSession[\s\S]*?clearPrivateSessionStorage\(\);/);
    expect(read('src/components/account/AccountSwitcher.tsx')).toMatch(/clearPrivateSessionStorage\(\);\s+window\.location\.assign\(target\)/);
  });
});

describe('structure : un champ commun, quatre écrans, un moteur, aucun appel IA', () => {
  const CHAMP = read('src/components/search/LocalSearchField.tsx');
  const ECRANS: Array<[string, string]> = [
    ['src/components/documents/v2/DocumentsByRubric.tsx', 'document'], // Mes documents + onglet Documents d'un bien
    ['src/app/(dashboard)/agenda/page.tsx', 'agenda'],
    ['src/components/assets/AssetAgendaTab.tsx', 'agenda'],
  ];

  it('le même composant est monté par chaque écran ; l’onglet Documents réutilise l’écran « Mes documents »', () => {
    for (const [f, kind] of ECRANS) {
      const src = read(f);
      expect(src).toMatch(/import \{ LocalSearchField \} from '@\/components\/search\/LocalSearchField'/);
      expect(src.match(/<LocalSearchField/g)).toHaveLength(1);
      expect(src).toMatch(new RegExp(`<LocalSearchField\\s+kind="${kind}"`));
    }
    expect(read('src/components/assets/AssetDocumentsTab.tsx')).toMatch(/<DocumentsByRubric assetId=\{assetId\}/);
  });

  it('champ accessible : rôle search, étiquette, état annoncé, effacement nommé, Entrée et Échap', () => {
    expect(CHAMP).toMatch(/role="search"/);
    expect(CHAMP).toMatch(/type="search"/);
    expect(CHAMP).toMatch(/aria-label=\{libelle\}/);
    expect(CHAMP).toMatch(/aria-describedby=\{statusId\}/);
    expect(CHAMP).toMatch(/role="status" aria-live="polite"/);
    expect(CHAMP).toMatch(/aria-label="Effacer la recherche"/);
    expect(CHAMP).toMatch(/onSubmit=\{\(e\) => \{ e\.preventDefault\(\); inputRef\.current\?\.submit\(draft\); \}\}/);
    expect(CHAMP).toMatch(/e\.key === 'Escape'/);
    // Mobile : 16 px (pas de zoom iOS), cible tactile 44 px ; charte : jetons CSS.
    expect(CHAMP).toMatch(/text-base/);
    expect(CHAMP).toMatch(/h-11 w-11/);
    expect(CHAMP).toMatch(/var\(--field-bg\)/);
  });

  it('le champ reste affiché même sans élément (jamais conditionné à la liste)', () => {
    const agenda = read('src/app/(dashboard)/agenda/page.tsx');
    expect(agenda).toMatch(/\{\/\* Lot 97C : recherche locale — toujours accessible[^]*?\*\/\}\s+<LocalSearchField/);
    expect(agenda).toMatch(/activeFiltersCount === 0 && !q && view === 'list'/);
    expect(read('src/components/assets/AssetAgendaTab.tsx')).toMatch(/activeFilters: activeFiltersCount \+ \(q \? 1 : 0\)/);
  });

  it('aucun second moteur : les listes passent par `matchingIdsForList` (moteur de la barre de recherche), sans plafond', () => {
    const gs = read('src/services/search/global-search.service.ts');
    expect(gs).toMatch(/export async function matchingIdsForList[\s\S]*?runSearchPipeline\(q, candidats, GLOBAL_SEARCH_POLICY\)/);
    expect(gs).toMatch(/opts\.exhaustive \? '' : `ORDER BY af\.created_at DESC, af\.id DESC\s+LIMIT \$\{CANDIDATS_MAX\}`/);
    expect(read('src/services/documents/rubric-query.service.ts')).toMatch(/matchingIdsForList\(accountId, recherche, 'document'\)/);
    expect(read('src/services/agenda/AgendaQueryService.ts')).toMatch(/matchingIdsForList\(accountId, recherche, 'agenda_item'\)/);
    // Appliquée AVANT pagination et compteurs : le même périmètre sert le lot et les compteurs.
    expect(read('src/services/documents/rubric-query.service.ts')).toMatch(/const scope = scopeConditions\(query, searchIds\);/);
  });

  it('aucun appel IA ni prompt : modules de la recherche locale sans dépendance aux traitements IA', () => {
    for (const f of [
      'src/lib/search/local-search.ts',
      'src/components/search/LocalSearchField.tsx',
      'src/lib/search/match-engine.ts',
    ]) {
      const src = read(f);
      expect(src).not.toMatch(/from '@\/services\/ai\//);
      expect(src).not.toMatch(/orchestrator|runAssistant|\/api\/verebona\/(ask|chat)|fetch\(/);
    }
    const gs = read('src/services/search/global-search.service.ts');
    expect(gs).not.toMatch(/from '@\/services\/ai\//);
    expect(gs).not.toMatch(/runAssistant|assistant-orchestrator/);
  });
});
