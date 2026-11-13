/**
 * Lot 108J — suggestions partagées (accueil et « Demander à Verebona »).
 *
 *   U01-U02  diagnostic : causes démontrées de l'absence des suggestions ;
 *   U03      étapes du guide (usages constatés) et compte vide ;
 *   U04      sélection : trois au plus, répartition libre, sujets uniques,
 *            version stable, Duo ;
 *   U05      clic : remplacement sans IA, retour ultérieur ;
 *   U06      rotation déterministe entre visites, univers des Ressources ;
 *   U07      répondabilité : chaque question du guide est retrouvée dans le
 *            corpus de référence (Centre d'aide, Ressources) ;
 *   U08      « Autre suggestion » absent partout ; MAX = 3 ; « À traiter » inchangé ;
 *   U09      référence de suggestion : contexte filtré, revalidation serveur ;
 *   U10      corpus Ressources : validation, présentation à la recherche,
 *            fusion avec le Centre d'aide, lien « Lire la Ressource » ;
 *   U11      T6 ne reçoit plus aucun contexte de suggestions (bulle seule).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseHelpCorpus } from '@/services/verebona-assistant/core/help-corpus.service';
import { asHelpSearchCorpus, parseResourcesCorpus } from '@/services/verebona-assistant/core/resources-corpus.service';
import { mergeHelpAndResources, SECONDARY_CORPUS_WEIGHT } from '@/services/verebona-assistant/core/help-search.port';
import { suggestionsForRoute } from '@/services/verebona-assistant/registries/capability-registry';
import { keepDisplayedPresentation } from '@/services/home/mascot/bubble';
import { MAX_HOME_SUGGESTIONS } from '@/services/home/mascot/types';
import { MAX_TODO_ITEMS } from '@/services/home/mascot/todo-items';
import { sanitizePageContext } from '@/services/verebona-assistant/core/page-context';
import { isResourcePath, resourcePageUrl, openResourceFromLink } from '@/lib/help-center/open';
import { GUIDE_STOCK, SAFE_FALLBACK_GUIDE_IDS, guideStageOf, type UsageSignals } from '../stock';
import { guideAnswerability } from '../answerability';
import { orderGuide, selectSharedSuggestions, selectionSeedOf, type AccountCandidate, type GuideCandidate } from '../select';
import { accountCandidatesOf, guideCandidatesOf } from '../service';
import { fallbackSuggestions, replaceConsumed } from '@/lib/suggestions/shared-suggestions';

const ROOT = process.cwd();
const FIX = join(ROOT, 'src/test/e2e/fixtures');
const help = parseHelpCorpus(JSON.parse(readFileSync(join(FIX, 'help-corpus-t2.snapshot.json'), 'utf8')))!;
const resRaw = parseResourcesCorpus(JSON.parse(readFileSync(join(FIX, 'ressources-corpus-t2.snapshot.json'), 'utf8')))!;
const resources = asHelpSearchCorpus(resRaw);
const corpora = { help, resources };

const USAGE = (o: Partial<UsageSignals> = {}): UsageSignals => ({
  assetsTotal: 0, documentsTotal: 0, documentsAnalyzed: 0, userDocuments: 0, userQuestions: 0, deadlinesUpcoming: 0, exportsTotal: 0, ...o,
});
const NOW = new Date('2026-11-03T10:00:00Z');
const select = (p: { stage: ReturnType<typeof guideStageOf>; account?: AccountCandidate[]; guide: GuideCandidate[]; consulted?: Set<string>; seed?: number; bucket?: number; fingerprint?: string }) =>
  selectSharedSuggestions({ account: [], consulted: new Set(), seed: 1, bucket: 1, fingerprint: 'f', max: MAX_HOME_SUGGESTIONS, now: NOW, ...p });

describe('L108J-U01 — cause démontrée : aucune question de repli pour un compte non vide (liste « de la page » calculée sans contexte)', () => {
  it('l’ancienne liste de l’accueil (navigateur, sans contexte serveur) était TOUJOURS vide', () => {
    expect(suggestionsForRoute('/accueil')).toEqual([]);
  });
});

describe('L108J-U02 — cause démontrée : une suggestion arrivée après l’affichage n’était jamais montrée pendant la visite', () => {
  it('même empreinte de contexte : le client garde l’ancienne présentation, même si la nouvelle porte des suggestions', () => {
    const base = { contextHash: 'h', presentationRevision: 1, paragraphs: [], secondaries: [] } as never;
    const avecSuggestions = { contextHash: 'h', presentationRevision: 1, paragraphs: [], secondaries: [{ id: 'q' }] } as never;
    expect(keepDisplayedPresentation(base, avecSuggestions)).toBe(true);
  });
});

describe('L108J-U03 — guide progressif : usages constatés, jamais l’ancienneté ni un clic', () => {
  it('étapes : vide → prise en main ; premier document analysé → progression ; usage établi → découverte', () => {
    expect(guideStageOf(USAGE())).toBe('START');
    expect(guideStageOf(USAGE({ assetsTotal: 1, documentsTotal: 1 }))).toBe('START');
    expect(guideStageOf(USAGE({ assetsTotal: 1, documentsTotal: 2, documentsAnalyzed: 1 }))).toBe('PROGRESS');
    expect(guideStageOf(USAGE({ assetsTotal: 2, documentsTotal: 9, documentsAnalyzed: 7 }))).toBe('ESTABLISHED');
  });

  it('compte vide : trois questions de bienvenue répondables par le Centre d’aide, aucune question personnelle', () => {
    const u = USAGE();
    const { candidates } = guideCandidatesOf('START', u, corpora);
    const s = select({ stage: 'START', account: accountCandidatesOf({ state: null }), guide: candidates });
    expect(s.items).toHaveLength(3);
    expect(s.items.every((x) => x.objective === 'GUIDE' && x.corpus === 'HELP' && x.target == null)).toBe(true);
    expect(s.items.map((x) => x.label)).toContain('Comment ajouter un bien ?');
  });

  it('« Comment ajouter un document ? » disparaît pour un utilisateur qui en a déposé beaucoup (Duo : par membre)', () => {
    const ids = (u: UsageSignals) => guideCandidatesOf(guideStageOf(u), u, corpora).candidates.map((c) => c.entry.id);
    expect(ids(USAGE({ assetsTotal: 1, documentsTotal: 2, documentsAnalyzed: 1, userDocuments: 1 }))).toContain('guide_add_document');
    expect(ids(USAGE({ assetsTotal: 1, documentsTotal: 8, documentsAnalyzed: 2, userDocuments: 8 }))).not.toContain('guide_add_document');
    // Second membre du même compte, sans dépôt : le guide le lui propose encore.
    expect(ids(USAGE({ assetsTotal: 1, documentsTotal: 8, documentsAnalyzed: 2, userDocuments: 0 }))).toContain('guide_add_document');
  });

  it('usages illisibles : repli éditorial sûr (trois questions de prise en main, aucune donnée)', () => {
    const { candidates } = guideCandidatesOf('START', null, corpora);
    expect(candidates.map((c) => c.entry.id).sort()).toEqual([...SAFE_FALLBACK_GUIDE_IDS].sort());
    expect(fallbackSuggestions().map((x) => x.id)).toEqual([...SAFE_FALLBACK_GUIDE_IDS]);
  });
});

// Lot 111L : les candidates « Exploiter » de ce jeu étaient des listes (« Quels
// sont les documents de Cupra ? », « Quels documents ne sont rattachés à aucun
// bien ? ») — elles n'atteignent plus la sélection (critère d'utilité,
// `utility.ts`). Ce test porte sur l'ALGORITHME de sélection (répartition,
// sujets, version) : il reçoit désormais des candidates de forme concrète.
const PERSO: AccountCandidate[] = [
  { catalogId: 'exemple_cout_entretien', label: 'Combien m’a coûté l’entretien de Cupra ?', objective: 'EXPLOIT', priority: 1, canonicalIntent: 'ACCOUNT_SEARCH_DOCUMENT', topic: 'maintenance-cost', assetId: 7 },
  { catalogId: 'assets_deadlines', label: 'Quelles sont les prochaines échéances de Cupra ?', objective: 'ANTICIPATE', priority: 1, canonicalIntent: 'ACCOUNT_SEARCH_AGENDA', topic: 'deadlines', assetId: 7 },
  { catalogId: 'home_next_deadline', label: 'Quelle est ma prochaine échéance ?', objective: 'ANTICIPATE', priority: 2, canonicalIntent: 'ACCOUNT_SEARCH_AGENDA', topic: 'deadlines' },
  { catalogId: 'exemple_franchise', label: 'Quelle franchise est prévue par mon assurance ?', objective: 'EXPLOIT', priority: 2, canonicalIntent: 'ACCOUNT_SEARCH_DOCUMENT', topic: 'insurance' },
];

describe('L108J-U04 — sélection : trois, répartition libre, sujets uniques, version stable', () => {
  const u = USAGE({ assetsTotal: 2, documentsTotal: 9, documentsAnalyzed: 7, userDocuments: 5, userQuestions: 4, deadlinesUpcoming: 2 });
  const guide = guideCandidatesOf('ESTABLISHED', u, corpora).candidates;

  it('compte riche : 2 questions personnelles (A et B) + 1 question de découverte ; jamais deux questions d’échéances', () => {
    const s = select({ stage: 'ESTABLISHED', account: PERSO, guide });
    expect(s.items).toHaveLength(3);
    expect(s.items.map((x) => x.objective)).toEqual(['EXPLOIT', 'ANTICIPATE', 'GUIDE']);
    expect(s.items.filter((x) => x.topic === 'deadlines')).toHaveLength(1);
    expect(s.items[2].corpus).toBe('RESOURCES');
    expect(s.items[0].target).toEqual({ assetId: 7 });
    expect(new Set(s.items.map((x) => x.id)).size).toBe(3);
  });

  it('sans échéance : deux questions « Exploiter » et une « Découvrir » (aucun quota par catégorie)', () => {
    const s = select({ stage: 'ESTABLISHED', account: PERSO.filter((x) => x.objective === 'EXPLOIT'), guide });
    expect(s.items.map((x) => x.objective)).toEqual(['EXPLOIT', 'EXPLOIT', 'GUIDE']);
  });

  it('aucun fait personnel fiable : le guide remplit les trois places', () => {
    const s = select({ stage: 'ESTABLISHED', guide });
    expect(s.items.every((x) => x.objective === 'GUIDE')).toBe(true);
    expect(s.items).toHaveLength(3);
  });

  it('version : identique pour les mêmes entrées ; change avec les faits (empreinte) ou la période de rotation', () => {
    const a = select({ stage: 'ESTABLISHED', account: PERSO, guide });
    expect(select({ stage: 'ESTABLISHED', account: PERSO, guide }).version).toBe(a.version);
    expect(select({ stage: 'ESTABLISHED', account: PERSO, guide, fingerprint: 'g' }).version).not.toBe(a.version);
    expect(select({ stage: 'ESTABLISHED', account: PERSO, guide, bucket: 2 }).version).not.toBe(a.version);
  });

  it('Duo : questions personnelles du compte identiques pour les deux membres ; guide propre à chacun', () => {
    const m1 = select({ stage: 'ESTABLISHED', account: PERSO, guide, seed: selectionSeedOf(10, 1) });
    const m2 = select({ stage: 'ESTABLISHED', account: PERSO, guide, seed: selectionSeedOf(10, 2) });
    expect(m1.items.slice(0, 2).map((x) => x.id)).toEqual(m2.items.slice(0, 2).map((x) => x.id));
    expect(selectionSeedOf(10, 1)).not.toBe(selectionSeedOf(10, 2));
  });
});

describe('L108J-U05 — clic : remplacement par une suggestion déjà disponible, sans IA ; retour possible plus tard', () => {
  const u = USAGE({ assetsTotal: 1, documentsTotal: 3, documentsAnalyzed: 2, userDocuments: 3, userQuestions: 0 });
  const guide = guideCandidatesOf('PROGRESS', u, corpora).candidates;

  it('client : la cliquée laisse sa place au même rang ; elle part en fin de réserve ; sans réserve, rien ne disparaît', () => {
    const s = select({ stage: 'PROGRESS', guide });
    const pub = (x: { id: string; label: string }) => ({ id: x.id, label: x.label, objective: 'GUIDE' as const, source: 'HELP_CENTER' as const });
    const etat = { items: s.items.map(pub), reserve: s.reserve.map(pub) };
    const r = replaceConsumed(etat, etat.items[1].id);
    expect(r.items[1].id).toBe(etat.reserve[0].id);
    expect(r.items.map((x) => x.id)).not.toContain(etat.items[1].id);
    expect(r.reserve.at(-1)!.id).toBe(etat.items[1].id);
    expect(replaceConsumed({ items: etat.items, reserve: [] }, etat.items[0].id).items).toEqual(etat.items);
  });

  it('serveur : une suggestion consultée n’est pas réaffichée tout de suite ; s’il ne reste rien d’autre, elle revient', () => {
    const s = select({ stage: 'PROGRESS', guide });
    const sans = select({ stage: 'PROGRESS', guide, consulted: new Set([s.items[0].id]) });
    expect(sans.items.map((x) => x.id)).not.toContain(s.items[0].id);
    expect(sans.reserve.map((x) => x.id)).toContain(s.items[0].id);
    const tout = select({ stage: 'PROGRESS', guide, consulted: new Set(guide.map((g) => g.entry.id)) });
    expect(tout.items).toHaveLength(Math.min(3, guide.length));
  });
});

describe('L108J-U06 — rotation déterministe entre visites (aucun appel IA)', () => {
  const u = USAGE({ assetsTotal: 2, documentsTotal: 9, documentsAnalyzed: 7, userDocuments: 5, userQuestions: 4 });
  const guide = guideCandidatesOf('ESTABLISHED', u, corpora).candidates;

  it('même période : même ordre ; période suivante : une autre question peut être proposée', () => {
    const ordre = (b: number) => orderGuide(guide, 'ESTABLISHED', 3, b).map((g) => g.entry.id);
    expect(ordre(5)).toEqual(ordre(5));
    expect(new Set([0, 1, 2, 3].map((b) => ordre(b)[0])).size).toBeGreaterThan(1);
  });

  it('usage établi : les Ressources alternent logement, véhicules, objets — trois univers parmi les trois premières', () => {
    const premiers = orderGuide(guide, 'ESTABLISHED', 0, 0).slice(0, 3).map((g) => g.entry.universe);
    expect(new Set(premiers)).toEqual(new Set(['HOUSING', 'VEHICLE', 'EQUIPMENT']));
  });
});

describe('L108J-U07 — chaque question du guide est réellement répondable par le corpus de référence', () => {
  it.each(GUIDE_STOCK.map((e) => [e.id, e]))('%s : article publié ET retrouvé par la recherche de l’assistant', (_id, e) => {
    expect(guideAnswerability(e, corpora)).toBe('VERIFIED');
  });

  it('article retiré des Ressources : la question n’est PAS proposée ; Ressources indisponibles : non plus', () => {
    const e = GUIDE_STOCK.find((x) => x.corpus === 'RESOURCES')!;
    const sans = asHelpSearchCorpus({ ...resRaw, version: 'v-retrait', articles: resRaw.articles.filter((a) => a.id !== e.articleId) });
    expect(guideAnswerability(e, { help, resources: sans })).toBe('NOT_ANSWERABLE');
    expect(guideAnswerability(e, { help, resources: null })).toBe('NOT_ANSWERABLE');
  });

  it('Centre d’aide indisponible : les questions de prise en main restent proposées (tracées « non vérifiées ») — jamais d’écran vide', () => {
    const { candidates } = guideCandidatesOf('START', USAGE(), { help: null, resources });
    expect(candidates.length).toBeGreaterThanOrEqual(3);
    expect(candidates.every((c) => c.answerability === 'UNVERIFIED')).toBe(true);
  });
});

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === '__tests__' || n === 'node_modules' ? [] : sources(p);
    return /\.(tsx?)$/.test(n) && !/\.(test|e2e)\.tsx?$/.test(n) ? [p] : [];
  });
}

describe('L108J-U08 — « Autre suggestion » supprimé ; trois suggestions ; « À traiter » inchangé', () => {
  it('ni bouton, ni libellé, ni route « Autre suggestion » dans l’application', () => {
    // Libellé affiché, info-bulle, attribut de test ou route : aucun (les commentaires d'historique ne comptent pas).
    const fautifs = sources(join(ROOT, 'src')).filter((f) => /["'`]Autre suggestion["'`]|suggestions\/skip|data-suggestion-skip/.test(readFileSync(f, 'utf8')));
    expect(fautifs).toEqual([]);
  });

  it('MAX_HOME_SUGGESTIONS = 3 ; les deux sujets prioritaires « À traiter » restent une règle distincte', () => {
    expect(MAX_HOME_SUGGESTIONS).toBe(3);
    expect(MAX_TODO_ITEMS).toBe(2);
  });

  it('rendu (lot 110C : une rangée, accueil large seulement) : zone tactile ≥ 44 px, retour à la ligne, jetons de la charte seulement', () => {
    const src = readFileSync(join(ROOT, 'src/components/suggestions/SharedSuggestionList.tsx'), 'utf8');
    expect(src).toContain('min-h-[44px]');
    expect(src).toContain('w-full');
    expect(src).toContain('break-words');
    expect(src).not.toMatch(/#[0-9a-f]{3,6}\b|overflow-x-auto|snap-x/i);
    expect(src).not.toMatch(/Opération/);
  });

  it('accueil et « Demander à Verebona » lisent la MÊME source (un seul magasin)', () => {
    const home = readFileSync(join(ROOT, 'src/components/home/MascotSpeaks.tsx'), 'utf8');
    const t2 = readFileSync(join(ROOT, 'src/components/verebona/space/VerebonaSpaceProvider.tsx'), 'utf8');
    for (const s of [home, t2]) expect(s).toContain('useSharedSuggestions');
    expect(t2).not.toContain('/api/verebona/suggestions');
    expect(home).not.toContain('homeSuggestionSlots');
  });
});

describe('L108J-U09 — référence de suggestion : jamais un droit, toujours revalidée', () => {
  it('contexte de page : identifiant et version au format attendu seulement', () => {
    expect(sanitizePageContext({ suggestionId: 'guide_add_asset', suggestionVersion: 'a1b2c3d4e5f60718' })).toEqual({ suggestionId: 'guide_add_asset', suggestionVersion: 'a1b2c3d4e5f60718' });
    expect(sanitizePageContext({ suggestionId: 'x; DROP', suggestionVersion: 'zz' })).toBeUndefined();
  });

  it('la route de l’assistant revalide la suggestion côté serveur et en tire intention et bien', () => {
    const r = readFileSync(join(ROOT, 'src/app/api/verebona/messages/route.ts'), 'utf8');
    expect(r).toContain('resolveSuggestionForMessage');
    expect(r).toMatch(/delete pageContext\.suggestionId/);
    const o = readFileSync(join(ROOT, 'src/services/verebona-assistant/core/assistant-orchestrator.service.ts'), 'utf8');
    expect(o).toContain('input.suggestion?.forceIntent');
  });
});

describe('L108J-U10 — Ressources dans T2 : corpus publié, fusion, lien vers l’article précis', () => {
  it('validation : seuls les articles publiés, aux identifiants et chemins valides', () => {
    const c = parseResourcesCorpus({ ...resRaw, articles: [...resRaw.articles, { ...resRaw.articles[0], id: 'Z99', status: 'review' }, { ...resRaw.articles[0], id: 'Z98', path: '/aide/x' }] })!;
    expect(c.articles.map((a) => a.id)).toEqual(resRaw.articles.map((a) => a.id));
    expect(parseResourcesCorpus({ schema: 'autre', articles: [] })).toBeNull();
  });

  it('présentation à la recherche : identifiant RES-<ID>, chemin /ressources/<slug>, date de validation, aucune note d’offre', () => {
    const a = resources.articles.find((x) => x.id === 'RES-L01')!;
    expect(a.path).toMatch(/^\/ressources\//);
    expect(a.validatedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(a.offers).toHaveLength(3);
  });

  it('fusion : corpus préféré à plein poids, l’autre réduit ; l’un indisponible → l’autre seul', () => {
    const src = (id: string, score: number) => ({ id, type: 'help_entry' as const, title: id, content: '', relevanceScore: score, stage: 'fulltext' as const, query: 'q', queryHits: 1 });
    const r = (s: ReturnType<typeof src>[]) => ({ corpusAvailable: true, corpusVersion: 'v', sources: s, candidateCount: s.length, rejected: { lowCoverage: 0, contextExcluded: 0 } });
    const m = mergeHelpAndResources(r([src('help_AID__a', 0.6)]), r([src('help_RES-L01__b', 0.6)]), 'RESOURCES', 4);
    expect(m.sources[0].id).toBe('help_RES-L01__b');
    expect(m.sources[1].relevanceScore).toBeCloseTo(0.6 * SECONDARY_CORPUS_WEIGHT);
    expect(mergeHelpAndResources(null, r([src('help_RES-L01__b', 0.6)]), 'HELP', 4).sources).toHaveLength(1);
  });

  it('lien : /ressources/<slug> ouvert sur le site public (nouvel onglet), jamais vers /aide', () => {
    expect(isResourcePath('/ressources/documents-apres-travaux-logement')).toBe(true);
    expect(isResourcePath('/aide/ajouter-un-document')).toBe(false);
    expect(resourcePageUrl('/ressources/documents-apres-travaux-logement')).toMatch(/\/ressources\/documents-apres-travaux-logement$/);
    expect(resourcePageUrl('/aide/x')).toMatch(/\/ressources$/);
    expect(openResourceFromLink(null, '/aide?page=/aide/x')).toBe(false);
    const ar = readFileSync(join(ROOT, 'src/services/verebona-assistant/core/action-resolver.service.ts'), 'utf8');
    expect(ar).toContain('Lire la Ressource');
  });
});

describe('L108J-U11 — T6 garde la bulle ; aucun appel IA de génération de suggestions', () => {
  it('la mascotte ne transmet plus de contexte de questions ni d’invitations à T6', () => {
    const m = readFileSync(join(ROOT, 'src/services/home/mascot/mascot.service.ts'), 'utf8');
    expect(m).not.toMatch(/loadT6SuggestionContext|discoveryContextOf|rotateDiscovery|readSuggestionSkips/);
    // Lot 113AO : seuls les sujets à formuler partent à T6 (`kinds` du sous-ensemble), toujours sans contexte de questions.
    expect(m).toMatch(/formulateWithT6\(\{ accountId, input, contextHash, mode, kinds: plan\.formulate\.map\(\(i\) => kinds\[i\]\) \}\)/);
  });

  it('le service des suggestions n’importe aucune passerelle IA', () => {
    for (const f of ['service.ts', 'select.ts', 'stock.ts', 'answerability.ts', 'consultations.ts']) {
      expect(readFileSync(join(ROOT, 'src/services/suggestions/shared', f), 'utf8'), f).not.toMatch(/ai\/gateway|callAi|generateMaster|formulateWithT6/);
    }
  });
});
