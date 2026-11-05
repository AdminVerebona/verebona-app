/**
 * Lot 111L — critère d'utilité réelle des suggestions avant publication.
 *
 *   U01  cause : « Quels sont les documents de Maison ? » vient du stock
 *        personnel (home_asset_docs, priorité 1, seule précondition
 *        asset.documents) — constructible et répondable, désormais NON promue ;
 *   U02  même constat pour véhicule / équipement / autre ; reformulations de
 *        façade (#409 et paraphrases) comprises comme des listes ;
 *   U03  questions concrètes (montant, échéance, contrat, garantie…) gardées
 *        seulement avec une preuve de réponse ;
 *   U04  complémentarité : information déjà affichée par la mascotte, action ;
 *   U05  revue du stock : chaque entrée déclare son besoin ; guide éditorial
 *        vérifié ; aucune phrase codée ni appel IA dans la règle ;
 *   U06  moins de trois questions de qualité : le service en rend moins ; le
 *        navigateur ne complète pas ; la rangée 110C et T2 le supportent ;
 *   U07  invalidation au déploiement : version de stock / règle.
 * Corpus qualitatif (CA07) : `CORPUS_REJETE` et `CORPUS_ACCEPTE` ci-dessous.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as React from 'react';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseHelpCorpus } from '@/services/verebona-assistant/core/help-corpus.service';
import { asHelpSearchCorpus, parseResourcesCorpus } from '@/services/verebona-assistant/core/resources-corpus.service';
import {
  EMPTY_ACCOUNT_STATE, renderSuggestionEntry, type AccountSuggestionState, type SuggestionContext,
} from '@/services/verebona-assistant/registries/capability-registry';
import type { VerebonaIntent } from '@/services/verebona-assistant/types/intents';
import { MAX_HOME_SUGGESTIONS } from '@/services/home/mascot/types';
import { SharedSuggestionList } from '@/components/suggestions/SharedSuggestionList';
import { ensureSharedSuggestions, resetSharedSuggestions, sharedSuggestionsSnapshot } from '@/lib/suggestions/shared-suggestions';
import { ACCOUNT_STOCK, GUIDE_STOCK, type UsageSignals } from '../stock';
import { RESOURCE_QUESTION_CATALOG_VERSION } from '../resource-questions';
import { selectSharedSuggestions } from '../select';
import { STOCK_VERSION, accountCandidatesOf, guideCandidatesOf, reviewAccountCandidates } from '../service';
import { SUGGESTION_UTILITY_RULE_VERSION, qualifySuggestion, understoodNeedOf } from '../utility';

(globalThis as { React?: typeof React }).React = React;

const ROOT = process.cwd();
const FIX = join(ROOT, 'src/test/e2e/fixtures');
const help = parseHelpCorpus(JSON.parse(readFileSync(join(FIX, 'help-corpus-t2.snapshot.json'), 'utf8')))!;
const resRaw = parseResourcesCorpus(JSON.parse(readFileSync(join(FIX, 'ressources-corpus-t2.snapshot.json'), 'utf8')))!;
const corpora = { help, resources: asHelpSearchCorpus(resRaw) };
const NOW = new Date('2026-11-05T10:00:00Z');

const etat = (o: Partial<AccountSuggestionState> = {}): AccountSuggestionState => ({ ...EMPTY_ACCOUNT_STATE, assetsTotal: 1, documentsTotal: 1, ...o });
/** Compte avec UN bien nommé et ses compteurs (lus côté serveur en production). */
const ctxAvec = (name: string, bien: { documents: number; deadlines?: number }, o: Partial<AccountSuggestionState> = {}): SuggestionContext => ({
  state: etat(o), pageAsset: null, accountAsset: { id: 7, name, documents: bien.documents, deadlines: bien.deadlines ?? 0 },
});
const USAGE = (o: Partial<UsageSignals> = {}): UsageSignals => ({
  assetsTotal: 0, documentsTotal: 0, documentsAnalyzed: 0, userDocuments: 0, userQuestions: 0, deadlinesUpcoming: 0, exportsTotal: 0, ...o,
});
const labels = (ctx: SuggestionContext) => accountCandidatesOf(ctx).map((x) => x.label);

describe('L111L-U01 — cause : une facture rattachée suffisait à proposer « Quels sont les documents de Maison ? »', () => {
  it('la question vient du STOCK PERSONNEL (home_asset_docs, priorité 1), pas de T6 ni d’un repli', () => {
    expect(ACCOUNT_STOCK[0]).toMatchObject({ catalogId: 'home_asset_docs', objective: 'EXPLOIT', priority: 1 });
    // Constructible ET répondable : une seule facture suffit à rendre l'entrée du catalogue.
    const ctx = ctxAvec('Maison', { documents: 1 });
    expect(renderSuggestionEntry('home_asset_docs', ctx)?.label).toBe('Quels sont les documents de Maison ?');
    // T6 ne fabrique plus de suggestions (bulle seule) : le service partagé n'importe aucune génération.
    const svc = readFileSync(join(ROOT, 'src/services/suggestions/shared/service.ts'), 'utf8');
    expect(svc).not.toMatch(/formulateWithT6|t6-suggestions'|generateMaster/);
  });

  it('CA01 — compte immobilier avec une facture : la question n’est plus proposée (simple inventaire)', () => {
    const ctx = ctxAvec('Maison', { documents: 1 });
    const r = reviewAccountCandidates(ctx);
    expect(r.accepted.map((x) => x.label)).not.toContain('Quels sont les documents de Maison ?');
    expect(r.rejected).toContainEqual({ id: 'acc_home_asset_docs', decision: 'INVENTORY_DECLARED' });
  });
});

/** CA07 — formulations REJETÉES comme suggestions spontanées (anciennes #409, paraphrases naturelles). */
const CORPUS_REJETE: Array<{ label: string; intent: VerebonaIntent; cible: string | null; cas: string }> = [
  { label: 'Quels sont les documents de Maison ?', intent: 'ACCOUNT_SEARCH_DOCUMENT', cible: 'Maison', cas: 'capture du ticket (immobilier)' },
  { label: 'Quels sont les documents de Cupra ?', intent: 'ACCOUNT_SEARCH_DOCUMENT', cible: 'Cupra', cas: '#409 / lots 32E-34 (véhicule)' },
  { label: 'Quels documents concernent ma Cupra ?', intent: 'ACCOUNT_SEARCH_DOCUMENT', cible: 'Cupra', cas: 'exemple du ticket, lot 55A' },
  { label: 'Montre-moi les documents liés à la Polo', intent: 'ACCOUNT_SEARCH_DOCUMENT', cible: 'Polo', cas: 'paraphrase' },
  { label: 'Quelles factures concernent Maison ?', intent: 'ACCOUNT_SEARCH_DOCUMENT', cible: 'Maison', cas: 'inventaire par type (substitution aussi générique)' },
  { label: 'Liste les fichiers du Lave-linge', intent: 'ACCOUNT_SEARCH_DOCUMENT', cible: 'Lave-linge', cas: 'objet / équipement' },
  { label: 'Quels sont les documents de Maison de famille à Saint-Jean-de-Luz ?', intent: 'ACCOUNT_SEARCH_DOCUMENT', cible: 'Maison de famille à Saint-Jean-de-Luz', cas: 'nom long' },
  { label: 'Quels sont les documents d’Appartement d’Annecy ?', intent: 'ACCOUNT_SEARCH_DOCUMENT', cible: 'Appartement d’Annecy', cas: 'élision' },
  { label: 'Quels documents ne sont rattachés à aucun bien ?', intent: 'ACCOUNT_SEARCH_DOCUMENT', cible: null, cas: 'liste filtrée (filtre « Sans bien »)' },
  { label: 'Quels sont mes documents ?', intent: 'ACCOUNT_SEARCH_DOCUMENT', cible: null, cas: 'inventaire du compte' },
  { label: 'Qu’est-ce que j’ai comme biens ?', intent: 'ACCOUNT_SEARCH_ASSET', cible: null, cas: 'inventaire des biens' },
  { label: 'Quelles informations as-tu sur ma Cupra ?', intent: 'ACCOUNT_SEARCH_ASSET', cible: 'Cupra', cas: 'inventaire des informations' },
];

/** CA07 — formulations concrètes ACCEPTÉES (si la preuve existe). */
const CORPUS_ACCEPTE: Array<{ label: string; intent: VerebonaIntent; cible: string | null }> = [
  { label: 'Combien m’a coûté l’entretien du jardin ?', intent: 'ACCOUNT_SEARCH_DOCUMENT', cible: null },
  { label: 'Quelle franchise est prévue par mon assurance ?', intent: 'ACCOUNT_SEARCH_DOCUMENT', cible: null },
  { label: 'Quand arrive à échéance mon contrôle technique ?', intent: 'ACCOUNT_SEARCH_AGENDA', cible: null },
  { label: 'Quand se termine la garantie de ma Cupra ?', intent: 'ACCOUNT_SEARCH_DOCUMENT', cible: 'Cupra' },
  { label: 'Quel est le kilométrage de ma Cupra ?', intent: 'ACCOUNT_SEARCH_ASSET', cible: 'Cupra' },
  { label: 'Quelle est ma prochaine échéance ?', intent: 'ACCOUNT_SEARCH_AGENDA', cible: null },
  { label: 'Quelles sont les prochaines échéances de Maison ?', intent: 'ACCOUNT_SEARCH_AGENDA', cible: 'Maison' },
  { label: 'Où en est l’analyse de mes documents ?', intent: 'ACCOUNT_FACT_DOCUMENT', cible: null },
];

describe('L111L-U02 — véhicule, équipement, autre ; ni reformulation de façade ni inventaire aussi générique', () => {
  it.each([['Cupra'], ['Lave-linge'], ['Appartement d’Annecy'], ['Maison de famille']])('CA02 — %s avec 1 ou N documents : aucune question d’inventaire', (nom) => {
    for (const documents of [1, 12]) {
      const l = labels(ctxAvec(nom, { documents }, { documentsTotal: documents, documentsUnlinked: 2, exportsReady: 1 }));
      expect(l.some((x) => /documents|exports/.test(x)), `${nom} ${documents}`).toBe(false);
    }
  });

  it.each(CORPUS_REJETE.map((c) => [c.cas, c]))('CA07 rejeté — %s : comprise par T2 comme une simple liste', (_cas, c) => {
    expect(understoodNeedOf({ label: c.label, canonicalIntent: c.intent, targetName: c.cible })).toBe('LISTING');
    // Même déclarée « valeur précise », une liste n'est pas promue (aucune reformulation de façade).
    expect(qualifySuggestion({ need: 'FACT', label: c.label, canonicalIntent: c.intent, targetName: c.cible, proven: true }))
      .toMatchObject({ promotable: false, decision: 'INVENTORY_UNDERSTOOD' });
  });

  it('les questions d’inventaire restent des questions T2 du catalogue (posées librement, elles fonctionnent — L34 inchangé)', () => {
    const ids = ACCOUNT_STOCK.filter((e) => e.need === 'INVENTORY').map((e) => e.catalogId);
    expect(ids.sort()).toEqual(['docs_unlinked', 'home_asset_docs', 'state_exports']);
    for (const id of ids) expect(renderSuggestionEntry(id, ctxAvec('Cupra', { documents: 1 }, { documentsUnlinked: 1, exportsReady: 1 }))).not.toBeNull();
  });
});

describe('L111L-U03 — questions concrètes gardées seulement si la réponse est prouvable', () => {
  it.each(CORPUS_ACCEPTE.map((c) => [c.label, c]))('CA07 accepté — %s : une valeur, un sujet ou une anticipation', (_l, c) => {
    expect(understoodNeedOf({ label: c.label, canonicalIntent: c.intent, targetName: c.cible })).not.toBe('LISTING');
    expect(qualifySuggestion({ need: 'FACT', label: c.label, canonicalIntent: c.intent, targetName: c.cible, proven: true }).promotable).toBe(true);
    // Sans preuve de réponse pour ce compte : jamais promue.
    expect(qualifySuggestion({ need: 'FACT', label: c.label, canonicalIntent: c.intent, targetName: c.cible, proven: false }))
      .toMatchObject({ promotable: false, decision: 'NO_PROOF' });
  });

  it('CA03 — échéance réelle du bien : proposée ; donnée manquante (aucune échéance) : non proposée', () => {
    expect(labels(ctxAvec('Cupra', { documents: 3, deadlines: 1 }, { deadlinesUpcoming: 1 })))
      .toEqual(['Quelles sont les prochaines échéances de Cupra ?', 'Quelle est ma prochaine échéance ?']);
    expect(labels(ctxAvec('Cupra', { documents: 3, deadlines: 0 }, { deadlinesUpcoming: 0 }))).toEqual([]);
    // Échéance d'un autre bien que celui nommé : la question générale reste, jamais celle du bien sans échéance.
    expect(labels(ctxAvec('Cupra', { documents: 3, deadlines: 0 }, { deadlinesUpcoming: 2 }))).toEqual(['Quelle est ma prochaine échéance ?']);
  });

  it('compte vide ou état illisible : aucune question personnelle', () => {
    expect(accountCandidatesOf({ state: EMPTY_ACCOUNT_STATE })).toEqual([]);
    expect(accountCandidatesOf({ state: null })).toEqual([]);
    expect(accountCandidatesOf(null)).toEqual([]);
  });
});

describe('L111L-U04 — complémentarité : ni la mascotte, ni « À traiter », ni trois variantes du même besoin', () => {
  it('documents en analyse : la mascotte l’affiche déjà (« N documents sont en cours d’analyse ») — non proposée', () => {
    const r = reviewAccountCandidates(ctxAvec('Cupra', { documents: 2 }, { documentsInAnalysis: 2 }));
    expect(r.rejected).toContainEqual({ id: 'acc_home_analysis', decision: 'SHOWN_ELSEWHERE' });
    expect(r.accepted.map((x) => x.catalogId)).not.toContain('home_analysis');
  });

  it('ce qui attend une action relève d’« À traiter », quelle que soit la déclaration', () => {
    expect(qualifySuggestion({ need: 'FACT', label: 'Que dois-je traiter en priorité ?', canonicalIntent: 'ACCOUNT_TO_PROCESS', proven: true }))
      .toMatchObject({ promotable: false, decision: 'ACTION_SURFACE' });
  });

  it('deux questions d’échéances : une seule servie (sujet unique)', () => {
    const account = accountCandidatesOf(ctxAvec('Cupra', { documents: 3, deadlines: 1 }, { deadlinesUpcoming: 1 }));
    const s = selectSharedSuggestions({ stage: 'ESTABLISHED', account, guide: [], consulted: new Set(), seed: 1, bucket: 1, max: 3, fingerprint: 'f', now: NOW });
    expect(s.items.filter((x) => x.topic === 'deadlines')).toHaveLength(1);
  });
});

describe('L111L-U05 — revue du stock', () => {
  it('chaque entrée personnelle déclare son besoin ; décision de chacune sur un compte où toutes sont répondables', () => {
    const ctx = ctxAvec('Cupra', { documents: 3, deadlines: 1 }, { deadlinesUpcoming: 1, documentsUnlinked: 1, exportsReady: 1, documentsInAnalysis: 1 });
    const r = reviewAccountCandidates(ctx);
    const decision = Object.fromEntries([...r.rejected.map((x) => [x.id, x.decision]), ...r.accepted.map((x) => [`acc_${x.catalogId}`, 'USEFUL'])]);
    expect(decision).toEqual({
      acc_home_asset_docs: 'INVENTORY_DECLARED',
      acc_docs_unlinked: 'INVENTORY_DECLARED',
      acc_state_exports: 'INVENTORY_DECLARED',
      acc_home_analysis: 'SHOWN_ELSEWHERE',
      acc_assets_deadlines: 'USEFUL',
      acc_home_next_deadline: 'USEFUL',
    });
    for (const e of ACCOUNT_STOCK) expect(['INVENTORY', 'FACT', 'ANTICIPATION', 'ACTION', 'GUIDANCE']).toContain(e.need);
    // Une liste doit dire quel écran y répond déjà.
    for (const e of ACCOUNT_STOCK.filter((x) => x.need === 'INVENTORY')) expect(e.navigation, e.catalogId).toBeTruthy();
  });

  it.each(GUIDE_STOCK.map((e) => [e.id, e]))('guide %s : besoin d’explication, réponse vérifiée par le corpus publié', (_id, e) => {
    expect(understoodNeedOf({ label: e.label, canonicalIntent: e.canonicalIntent })).toBe('GUIDANCE');
    expect(qualifySuggestion({ need: 'GUIDANCE', label: e.label, canonicalIntent: e.canonicalIntent, proven: true }).decision).toBe('USEFUL');
  });

  it('source de la règle : aucune phrase, aucune liste noire, aucun cas de la capture, aucun appel IA', () => {
    const src = readFileSync(join(ROOT, 'src/services/suggestions/shared/utility.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(src).not.toMatch(/Quels sont|documents de|Maison|Cupra|new RegExp|\/\^|\.test\(/);
    expect(src).not.toMatch(/ai\/gateway|callAi|generateMaster|fetch\(/);
  });
});

describe('L111L-U06 — moins de trois questions de qualité : moins de trois, jamais de remplissage', () => {
  afterEach(() => { vi.unstubAllGlobals(); resetSharedSuggestions(); });

  it('sélection canonique : une seule question de qualité → une seule servie', () => {
    const guide = guideCandidatesOf('ESTABLISHED', USAGE({ assetsTotal: 1, documentsTotal: 9, documentsAnalyzed: 9 }), corpora).candidates.slice(0, 1);
    const s = selectSharedSuggestions({ stage: 'ESTABLISHED', account: [], guide, consulted: new Set(), seed: 1, bucket: 1, max: MAX_HOME_SUGGESTIONS, fingerprint: 'f', now: NOW });
    expect(s.items).toHaveLength(1);
    // Ni remplissage, ni réserve fabriquée.
    expect(s.reserve).toEqual([]);
  });

  it('compte riche sans fait utile : le guide vérifié complète ; jamais une question d’inventaire', () => {
    const account = accountCandidatesOf(ctxAvec('Maison', { documents: 12 }, { documentsTotal: 12, documentsUnlinked: 3, exportsReady: 2 }));
    expect(account).toEqual([]);
    const guide = guideCandidatesOf('ESTABLISHED', USAGE({ assetsTotal: 1, documentsTotal: 12, documentsAnalyzed: 9, exportsTotal: 2 }), corpora).candidates;
    const s = selectSharedSuggestions({ stage: 'ESTABLISHED', account, guide, consulted: new Set(), seed: 3, bucket: 9, max: 3, fingerprint: 'f', now: NOW });
    expect(s.items).toHaveLength(3);
    expect(s.items.every((x) => x.objective === 'GUIDE' && x.answerability === 'VERIFIED')).toBe(true);
  });

  it('navigateur : une sélection courte (même vide) est affichée telle quelle — le repli sûr ne sert qu’en cas d’échec', async () => {
    const un = [{ id: 'guide_agenda_sync', label: 'Comment synchroniser mon agenda ?', objective: 'GUIDE', source: 'HELP_CENTER' }];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ version: 'v-un', items: un, reserve: [] }), { status: 200 })));
    resetSharedSuggestions();
    await ensureSharedSuggestions(true);
    expect(sharedSuggestionsSnapshot()).toMatchObject({ status: 'ready', version: 'v-un', items: un });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ version: 'v-vide', items: [], reserve: [] }), { status: 200 })));
    resetSharedSuggestions();
    await ensureSharedSuggestions(true);
    expect(sharedSuggestionsSnapshot()).toMatchObject({ status: 'ready', version: 'v-vide', items: [] });
    // Échec de lecture (rien en mémoire) : repli sûr de prise en main, comme au lot 108J.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('réseau'); }));
    resetSharedSuggestions();
    await ensureSharedSuggestions(true);
    expect(sharedSuggestionsSnapshot().status).toBe('fallback');
    expect(sharedSuggestionsSnapshot().items).toHaveLength(3);
  });

  it('rangée 110C : une ou deux cartes sans emplacement vide ; aucune carte : aucune zone', () => {
    const items = [
      { id: 'acc_home_next_deadline', label: 'Quelle est ma prochaine échéance ?', objective: 'ANTICIPATE' as const, source: 'ACCOUNT_DATA' as const },
      { id: 'guide_agenda_sync', label: 'Comment synchroniser mon agenda ?', objective: 'GUIDE' as const, source: 'HELP_CENTER' as const },
    ];
    const deux = renderToStaticMarkup(h(SharedSuggestionList, { items, onAsk: () => {} }));
    expect(deux.match(/<button type="button"/g)).toHaveLength(2);
    expect(deux).not.toContain('animate-pulse');
    expect(renderToStaticMarkup(h(SharedSuggestionList, { items: [], onAsk: () => {} }))).toBe('');
    // T2 : la rubrique « Par exemple » n'apparaît qu'avec au moins une suggestion.
    expect(readFileSync(join(ROOT, 'src/components/verebona/space/SpaceContent.tsx'), 'utf8')).toMatch(/api\.suggestions\.length > 0 && <span className=\{SECTION_LABEL\}>Par exemple<\/span>/);
  });
});

describe('L111L-U07 — invalidation des sélections obsolètes au déploiement', () => {
  it('la version du stock intègre la règle d’utilité et les besoins déclarés : elle diffère de celle du lot 110', () => {
    const lot110 = createHash('sha256').update(JSON.stringify([
      ACCOUNT_STOCK.map(({ catalogId, objective, priority }) => ({ catalogId, objective, priority })),
      GUIDE_STOCK.map(({ when: _w, ...e }) => e), RESOURCE_QUESTION_CATALOG_VERSION,
    ])).digest('hex').slice(0, 12);
    expect(STOCK_VERSION).not.toBe(lot110);
    expect(SUGGESTION_UTILITY_RULE_VERSION).toBe('suggestion-utility-v1');
    const svc = readFileSync(join(ROOT, 'src/services/suggestions/shared/service.ts'), 'utf8');
    // L'empreinte de chaque sélection (cache serveur, version lue par le navigateur) contient STOCK_VERSION.
    expect(svc).toMatch(/fingerprint = createHash\('sha256'\)\.update\(JSON\.stringify\(\[\s*STOCK_VERSION,/);
  });
});
