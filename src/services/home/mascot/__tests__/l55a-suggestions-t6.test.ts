/**
 * Lot 55A — ticket « T6 / T2 — Cohérence des suggestions IA et correction des
 * cartes d'échéance » : tests unitaires, T6 SIMULÉ (aucun appel réseau).
 *
 *  L55A-01  constat reproduit : le catalogue déterministe proposait « Que dois-je
 *           traiter en priorité ? » sous « Aucun sujet à traiter en priorité
 *           aujourd'hui » — la mascotte ne le lit plus ;
 *  L55A-02  les questions viennent du MÊME appel T6 que la bulle, avec le message
 *           affiché, l'état du compte, les biens et les échéances (contexte) ;
 *  L55A-03  validation STRUCTURELLE seulement (nombre, longueur, forme, doublons
 *           exacts, référence de bien) — aucun filtre par mots-clés ;
 *  L55A-04  cohérence après actualisation : le contexte fait partie de la clé de
 *           cache ; les textes restent figés (R8), les questions se renouvellent ;
 *  L55A-05  IA indisponible / sortie invalide / prompt BO antérieur : aucune question ;
 *  L55A-06  configuration IA pilotable : emplacement FACULTATIF, prompt du dépôt
 *           (R12), version BO sans emplacement → aucune question ;
 *  L55A-07  cartes : intitulé métier, « bien · date complète », une seule action
 *           « Voir », mêmes cibles ; autres cartes du composant corrigées ;
 *  L55A-08  responsive : la sous-ligne n'est plus tronquée (mobile et desktop).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { decisionAction, fonde, masterV3 } from './fixtures/t6-suggestions-v3';

const unsafe = vi.fn(async (_sql: string, _p?: unknown[]): Promise<unknown[]> => []);
vi.mock('@/db', () => ({ pgClient: { unsafe: (s: string, p: unknown[]) => unsafe(s, p) } }));
let configText: string | null = null;
vi.mock('@/services/ai/config/config-resolver', () => ({
  resolveOperationConfig: async () => ({ promptArchitecture: 'master', masterPromptText: configText, configVersionId: 3 }),
}));

const R = await import('../t6-runner');
const S = await import('../t6-suggestions');
const { buildCandidates } = await import('../signals');
const { selectSubjects, buildSecondaries, withSuggestedQuestions } = await import('../selector');
const { buildPresentation } = await import('../presentation');
const { buildT6Input } = await import('../t6-contract');
const { composeSpeech, homeItems, homeSuggestions, tileFor, NOTHING_PRIORITY, actionTiles, subjectBlocks } = await import('../bubble');
const { suggestionsForRoute } = await import('@/services/verebona-assistant/registries/capability-registry');
const { renderMasterPrompt, isOptionalMasterVariable } = await import('@/services/ai/prompts/prompt-loader');
type Raw = import('../signals').MascotRawData;
type Row = import('../signals').MascotAgendaRow;

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const TODAY = '2026-10-14';
const cupra: Row = {
  id: 11, title: 'Prochain contrôle technique — CUPRA LEON E-HYBRID180', date: '2028-04-18', forecast: false,
  requiresQualification: false, assetId: 1, assetName: 'Cupra', assetCategory: 'VEHICULE', assetSubtype: 'Voiture', dateRole: 'DEADLINE',
};
const raw = (over: Partial<Raw> = {}): Raw => ({
  accountId: 7, today: TODAY,
  processing: { uploads: [], analyses: [], exports: [] },
  onboarding: { activeAssets: [{ id: 1, name: 'Cupra' }], activeAssetCount: 1, documentCount: 2 },
  toProcess: [], agenda: [cupra], acknowledgments: [],
  ...over,
} as Raw);

/** Contexte « aucune priorité aujourd'hui, une échéance à venir » (cas du ticket). */
function bundleFor(speech = `${NOTHING_PRIORITY} Le prochain contrôle technique de la Cupra est à prévoir pour le 18 avril 2028.`) {
  return S.buildT6SuggestionContext({
    speech, attentionToday: false,
    state: { documentsTotal: 2, toProcessPending: 1, deadlinesUpcoming: 1, deadlinesSoon: 0 },
    operations: 0,
    assets: [{ id: 1, name: 'Cupra', documents: 2, deadlines: 0 }, { id: 2, name: 'Maison', documents: 0 }],
    agenda: [cupra],
    labelOf: () => 'Contrôle technique',
    formatDate: () => '18 avril 2028',
  });
}

const execute = vi.fn();
const deps = {
  treatmentAvailable: async () => true,
  promptVersion: async () => 't6_master_v1@file|cfg:3',
  previousBubbles: async () => [] as import('../t6-runner').T6PreviousBubble[],
  execute: (r: unknown) => execute(r),
  displayWaitMs: () => 6_000,
};
const res = (data: unknown) => ({ data, model: 'm', usedFallback: false, fromCache: false, costMicros: 1, traceId: 't' });
const subjects = selectSubjects(buildCandidates(raw()).candidates);
const INPUT = buildT6Input(subjects);
const OUT = (suggestions: unknown) => ({
  schemaVersion: 't6-output-v2',
  messages: INPUT.subjects.map((s) => ({ subjectId: s.subjectId, text: s.fallbackText, highlight: null })),
  suggestions,
});

beforeEach(() => { execute.mockReset(); unsafe.mockReset(); unsafe.mockImplementation(async () => []); R.resetT6Breaker(); configText = null; });

describe('L55A-01 — constat : la question du catalogue contredisait la bulle', () => {
  it('rouge avant correctif : « À traiter » sans priorité → bulle « Aucun sujet… », catalogue « Que dois-je traiter en priorité ? »', () => {
    // Le catalogue déterministe (ancienne source des questions de la mascotte).
    const catalogue = suggestionsForRoute('/accueil', { state: { toProcessPending: 1, deadlinesSoon: 0, documentsInAnalysis: 0, documentsFailed: 0, exportsReady: 0, actionsDueToday: 0, deadlinesUpcoming: 1 } });
    expect(catalogue.map((x) => x.label)).toContain('Que dois-je traiter en priorité ?');
    const c = buildCandidates(raw());
    const s = selectSubjects(c.candidates);
    const p = buildPresentation({ subjects: s, secondaries: buildSecondaries(c, s, catalogue), degraded: false, messages: null, today: TODAY, todo: { total: 1, items: [] } });
    expect(composeSpeech({ presentation: p, empty: false }).text.startsWith(NOTHING_PRIORITY)).toBe(true);
    expect(homeSuggestions(p, false, []).map((x) => x.label)).toContain('Que dois-je traiter en priorité ?');
  });

  it('corrigé : la mascotte ne lit plus le catalogue (aucun moteur de règles parallèle, aucune liste imposée)', () => {
    const svc = read('src/services/home/mascot/mascot.service.ts');
    expect(svc).not.toMatch(/suggestionsForRoute|homeCatalogQuestions/);
    expect(svc).toMatch(/buildSecondaries\(candidates, subjects, \[\]\)/);
    // Code seul (commentaires retirés).
    const mod = read('src/services/home/mascot/t6-suggestions.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // Aucun libellé de question codé, aucun mot du message T6 recherché.
    expect(mod).not.toMatch(/Que dois-je|Quelles sont mes|priorit[ée] ?\?|\.includes\('priorit/);
  });
});

describe('L55A-02 — questions produites par l’appel T6 existant, avec le contexte du message affiché', () => {
  it('un seul appel t6_formulate : bulle + questions ; contexte = message affiché, compte, biens, échéances', async () => {
    const b = bundleFor();
    execute.mockResolvedValue(res(OUT([
      fonde(b, 'Quelles sont mes prochaines échéances ?', ['ACC.DEADLINES']),
      fonde(b, 'Quels documents concernent ma Cupra ?', ['A1', 'A1.DOCS'], { assetRef: 'A1' }),
    ])));
    const o = await R.formulateWithT6({ accountId: 7, input: INPUT, contextHash: 'h', mode: 'pregen', suggestions: b }, deps);
    expect(execute).toHaveBeenCalledTimes(1);
    const req = execute.mock.calls[0][0];
    expect(req.operationCode).toBe('t6_formulate');
    const ctx = JSON.parse(req.promptVariables.SUGGESTION_CONTEXT);
    expect(ctx.bubble.speech).toContain(NOTHING_PRIORITY);
    expect(ctx).toMatchObject({
      schemaVersion: 't6-suggestions-v3',
      bubble: { attentionToday: false },
      account: { hasDocuments: true, hasPendingToProcess: true, hasUpcomingDeadlines: true, hasDeadlinesNext30Days: false },
      assets: [{ ref: 'A1', name: 'Cupra', hasDocuments: true, documentsRef: 'A1.DOCS' }, { ref: 'A2', name: 'Maison', hasDocuments: false, documentsRef: null }],
      nextDeadlines: [{ ref: 'D1', label: 'Contrôle technique', assetRef: 'A1', dateLabel: '18 avril 2028', dateNature: 'confirmée', evaluation: { status: 'NOT_EVALUATED' } }],
    });
    // Jamais d'identifiant de base transmis à T6 (références opaques).
    expect(req.promptVariables.SUGGESTION_CONTEXT).not.toMatch(/"id"|assetId|agenda:|fact:/);
    expect(o.status).toBe('generated');
    expect(o.suggestions).toMatchObject([
      { question: 'Quelles sont mes prochaines échéances ?', assetId: null, assetRef: null, subject: 'DEADLINES', purpose: 'CONSULT' },
      { question: 'Quels documents concernent ma Cupra ?', assetId: 1, assetRef: 'A1', subject: 'ASSET' },
    ]);
    // Cache : questions écrites avec la bulle (migration 0395), contrat et fondements (0756).
    const ecriture = unsafe.mock.calls.find((c) => String(c[0]).includes('INSERT INTO home_mascot_cache'));
    expect(String(ecriture?.[0])).toMatch(/suggestions, suggestion_contract, trace_id/);
    expect(ecriture?.[1]?.[8]).toBe('t6-suggestions-v3');
    expect(JSON.parse(String(ecriture?.[1]?.[7]))[1]).toMatchObject({ groundRefs: ['A1', 'A1.DOCS'], grounds: [{ ref: 'A1', key: 'asset:1' }, { ref: 'A1.DOCS', key: 'asset:1:documents' }] });
  });

  it('sans priorité NI sujet : T6 appelé pour les questions seules (messages vides acceptés)', async () => {
    const b = bundleFor(NOTHING_PRIORITY);
    const vide = buildT6Input([]);
    execute.mockResolvedValue(res({ schemaVersion: 't6-output-v2', messages: [], suggestions: [fonde(b, 'Quelles sont mes prochaines échéances ?', ['ACC.DEADLINES'])] }));
    const o = await R.formulateWithT6({ accountId: 7, input: vide, contextHash: 'h0', mode: 'pregen', suggestions: b }, deps);
    expect(o).toMatchObject({ status: 'generated', messages: [] });
    expect(o.suggestions?.map((x) => x.question)).toEqual(['Quelles sont mes prochaines échéances ?']);
  });

  it('cliquées : envoyées à T2 comme aujourd’hui (question, bien revalidé côté serveur)', () => {
    const sec = S.suggestionSecondaries([{ question: 'Quels documents concernent ma Cupra ?', assetId: 1 }]);
    expect(sec[0]).toMatchObject({ kind: 'question', action: { target: { kind: 'ask', question: 'Quels documents concernent ma Cupra ?', context: { assetId: 1 } } } });
    const c = buildCandidates(raw());
    const s = selectSubjects(c.candidates);
    const p = buildPresentation({ subjects: s, secondaries: withSuggestedQuestions(buildSecondaries(c, s, []), s, sec), degraded: false, messages: null, today: TODAY });
    expect(homeSuggestions(p, false, [])).toEqual([{ label: 'Quels documents concernent ma Cupra ?', context: sec[0].action.target.kind === 'ask' ? sec[0].action.target.context : undefined, secondary: sec[0] }]);
  });
});

describe('L55A-03 — validation technique seulement', () => {
  const b = bundleFor();
  const ok = (q: string, refs = ['ACC.DOCUMENTS'], o: Parameters<typeof fonde>[3] = {}) => fonde(b, q, refs, o);
  const val = (items: unknown[]) => S.validateT6Suggestions(items, b.assetIds, b).map((x) => x.question);
  it('nombre (3 au plus), longueur, forme interrogative, une ligne, ni emoji ni tutoiement, doublons exacts', () => {
    // Doublon exact (casse, espaces) : un seul exemplaire.
    expect(val([ok('Quels documents concernent ma Cupra ?', ['A1', 'A1.DOCS'], { assetRef: 'A1' }), ok('  quels documents  concernent ma cupra ?  ', ['A1', 'A1.DOCS'], { assetRef: 'A1' })]))
      .toEqual(['Quels documents concernent ma Cupra ?']);
    for (const mauvais of [
      ok('Quoi ?'), ok('Quelles sont mes prochaines échéances'), ok('Que dois-tu faire ?'), ok('Quelle est ma prochaine échéance ? 🚗'),
      ok('Ligne 1 ?\nLigne 2 ?'), ok(`${'x'.repeat(120)} ?`),
      ok('Quels documents concernent ce bien ?', ['A1'], { assetRef: 'A9' }), // référence inconnue : abandonnée
      'Quels documents me seront utiles ?', // texte seul : hors contrat
    ]) expect(val([mauvais])).toEqual([]);
    expect(val([ok('Quels documents me seront utiles ?'), ok('Quelles opérations ai-je enregistrées ?', ['ACC.DEADLINES'], { subject: 'DEADLINES' })]))
      .toEqual(['Quels documents me seront utiles ?', 'Quelles opérations ai-je enregistrées ?']);
    expect(S.validateT6Suggestions(null, b.assetIds, b)).toEqual([]);
    expect(S.validateT6Suggestions({ question: 'x ?' }, b.assetIds, b)).toEqual([]);
  });

  it('aucun filtre par mots-clés : la pertinence appartient à T6 (une question « priorité » reste structurellement valable)', () => {
    expect(val([ok('Que dois-je traiter en priorité ?', ['ACC.TO_PROCESS'])])).toHaveLength(1);
  });

  it('une liste mal formée ne fait jamais tomber la bulle (textes T6 conservés)', async () => {
    execute.mockResolvedValue(res(OUT('pas une liste')));
    const o = await R.formulateWithT6({ accountId: 7, input: INPUT, contextHash: 'h', mode: 'pregen', suggestions: bundleFor() }, deps);
    expect(o.status).toBe('generated');
    expect(o.messages).toHaveLength(INPUT.subjects.length);
    expect(o.suggestions).toEqual([]);
    expect(o.suggestionValidation?.rejected).toEqual([expect.objectContaining({ reason: 'malformed_list' })]);
  });
});

describe('L55A-04 — cohérence après actualisation du contexte, cache', () => {
  it('le contexte des questions fait partie de la clé (et seulement s’il est fourni)', () => {
    const a = bundleFor().context;
    const b = bundleFor('Un sujet mérite votre attention aujourd’hui : x.').context;
    const k = (s?: unknown) => R.t6CacheKey({ accountId: 7, input: INPUT, promptVersion: 'v', outputSchema: 't6-output-v2', suggestionContext: s });
    expect(k(a)).not.toBe(k(b));
    expect(k(a)).toBe(k(bundleFor().context));
    expect(k(undefined)).toBe(R.t6CacheKey({ accountId: 7, input: INPUT, promptVersion: 'v', outputSchema: 't6-output-v2' }));
  });

  it('cache : bulle et questions servies ensemble, références revalidées contre le contexte courant', async () => {
    const b = bundleFor();
    const bonne = S.validateT6Suggestions([fonde(b, 'Quels documents concernent ma Cupra ?', ['A1', 'A1.DOCS'], { assetRef: 'A1' })], b.assetIds, b)[0];
    unsafe.mockImplementation(async (sql: string) => (String(sql).includes('SELECT c.messages, c.suggestions')
      ? [{ messages: OUT([]).messages, suggestion_contract: 't6-suggestions-v3', trace_id: 'tr1',
        suggestions: [S.storedSuggestionOf(bonne), { ...S.storedSuggestionOf(bonne), question: 'Et la maison ?', assetRef: 'A7' }] }]
      : []));
    const o = await R.formulateWithT6({ accountId: 7, input: INPUT, contextHash: 'h', mode: 'display', suggestions: b }, deps);
    expect(o.status).toBe('cache_hit');
    expect(execute).not.toHaveBeenCalled();
    expect(o.suggestions).toMatchObject([{ question: 'Quels documents concernent ma Cupra ?', assetId: 1, assetRef: 'A1' }]);
    // Lot 87C : question devenue injustifiée retirée, entrée invalidée (supprimée et tracée).
    expect(o.suggestionsInvalidated).toBe(1);
    expect(unsafe.mock.calls.some(([q]) => /DELETE FROM home_mascot_cache WHERE account_id = \$1 AND cache_key = ANY/.test(q))).toBe(true);
  });

  it('même bulle, contexte du compte changé : textes FIGÉS (R8), un appel pour renouveler les questions', async () => {
    const b = bundleFor();
    const prev = [{ input: INPUT, output: OUT([]) }];
    execute.mockResolvedValue(res({ ...OUT([fonde(b, 'Quelles sont mes prochaines échéances ?', ['ACC.DEADLINES'])]), messages: INPUT.subjects.map((s) => ({ subjectId: s.subjectId, text: `Reformulation : ${s.fallbackText}`, highlight: null })) }));
    const o = await R.formulateWithT6({ accountId: 7, input: INPUT, contextHash: 'h', mode: 'pregen', suggestions: b }, { ...deps, previousBubbles: async () => prev });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(o.messages?.map((m) => m.text)).toEqual(OUT([]).messages.map((m) => m.text));
    expect(o.suggestions?.map((x) => x.question)).toEqual(['Quelles sont mes prochaines échéances ?']);
  });

  it('sans contexte de questions : comportement historique (réutilisation R8 sans appel, aucune question)', async () => {
    const prev = [{ input: INPUT, output: OUT([]) }];
    const o = await R.formulateWithT6({ accountId: 7, input: INPUT, contextHash: 'h', mode: 'display' }, { ...deps, previousBubbles: async () => prev });
    expect(o).toMatchObject({ status: 'cache_hit', adjustments: ['r8_reused'] });
    expect(o.suggestions).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('L55A-05 — IA indisponible : accueil fonctionnel, aucune question', () => {
  it('erreur fournisseur, T6 désactivé, sortie invalide, affichage immédiat : suggestions nulles', async () => {
    execute.mockRejectedValue(new Error('503'));
    expect((await R.formulateWithT6({ accountId: 7, input: INPUT, contextHash: 'a', mode: 'pregen', suggestions: bundleFor() }, deps)).suggestions ?? null).toBeNull();
    expect((await R.formulateWithT6({ accountId: 7, input: INPUT, contextHash: 'b', mode: 'pregen', suggestions: bundleFor() }, { ...deps, treatmentAvailable: async () => false })).suggestions ?? null).toBeNull();
    execute.mockReset();
    execute.mockResolvedValue(res({ schemaVersion: 't6-output-v1', messages: [], suggestions: [{ question: 'Quelles sont mes prochaines échéances ?' }] }));
    expect((await R.formulateWithT6({ accountId: 7, input: INPUT, contextHash: 'c', mode: 'pregen', suggestions: bundleFor('autre') }, deps)).suggestions ?? null).toBeNull();
    const imm = await R.formulateWithT6({ accountId: 7, input: INPUT, contextHash: 'd', mode: 'display', suggestions: bundleFor('encore') }, { ...deps, displayWaitMs: () => 0 });
    expect(imm.status).toBe('fallback');
    expect(imm.suggestions ?? null).toBeNull();
  });

  it('aucune question → « Ou demandez-moi » vide (jamais le catalogue en repli)', () => {
    const c = buildCandidates(raw());
    const s = selectSubjects(c.candidates);
    const p = buildPresentation({ subjects: s, secondaries: withSuggestedQuestions(buildSecondaries(c, s, []), s, S.suggestionSecondaries([])), degraded: false, messages: null, today: TODAY });
    expect(homeSuggestions(p, false, [])).toEqual([]);
  });
});

describe('L55A-06 — configuration IA pilotable par le BO', () => {
  it('prompt du dépôt : emplacement {{SUGGESTION_CONTEXT}} et règle R12 ; variable FACULTATIVE', () => {
    const master = read('src/services/ai/prompts/mascot/t6_master_v1.txt');
    expect(master).toContain('{{SUGGESTION_CONTEXT}}');
    expect(master).toContain('R12 — Questions suggérées.');
    expect(master).toContain('Aucune priorité aujourd’hui ne veut pas dire aucun sujet à venir');
    expect(isOptionalMasterVariable('t6_master_v1', 'SUGGESTION_CONTEXT')).toBe(true);
    // Une version BO antérieure (sans l'emplacement) reste rendable : la variable est ignorée.
    const ancien = master.replace(/\nContexte des questions suggérées : \{\{SUGGESTION_CONTEXT\}\}\n/, '\n')
      // Lot 60 / 61 : emplacement des candidats (EVALUATE), facultatif lui aussi.
      .replace(/\nCandidats à évaluer : \{\{INTERPELLATION_CONTEXT\}\}\n/, '\n');
    expect(renderMasterPrompt(ancien, { masterPromptCode: 't6_master_v1', task: 'FORMULATE', allowedTasks: ['FORMULATE'], variables: { INPUT_JSON: '{}', SUGGESTION_CONTEXT: '{"a":1}' } }))
      .not.toContain('{"a":1}');
  });

  it('lot 87C (AC10) — version BO ou fichier du dépôt sans le contrat des questions fondées → aucune question ; version qui le porte → questions', async () => {
    configText = 'Tu es T6. MODE = {{MODE}}\nValeurs autorisées : FORMULATE\nEntrée structurée : {{INPUT_JSON}}';
    expect(await R.t6SuggestionGroundsAvailable()).toBe(false);
    configText = 'MODE = {{MODE}} {{INPUT_JSON}} {{SUGGESTION_CONTEXT}}';
    expect(await R.t6SuggestionGroundsAvailable()).toBe(false);
    // Fichier du dépôt examiné comme une version BO : R12 v2 seulement, pas le contrat v3.
    configText = null;
    expect(await R.t6SuggestionGroundsAvailable()).toBe(S.promptSupportsSuggestionGrounds(read('src/services/ai/prompts/mascot/t6_master_v1.txt')));
    expect(await R.t6SuggestionGroundsAvailable()).toBe(false);
    configText = masterV3(read('src/services/ai/prompts/mascot/t6_master_v1.txt'));
    expect(await R.t6SuggestionGroundsAvailable()).toBe(true);
  });
});

// Lot 68 : les métadonnées de tuile restent calculées côté serveur (nature,
// intitulé de la fenêtre de rappel) ; l'accueil n'affiche plus de carte qui
// répète le message — un bloc par sujet, action « Voir ».
describe('L55A-07 — cartes d’échéance : intitulé métier, bien · date complète, une seule action « Voir »', () => {
  const presentationOf = (r: Raw) => {
    const c = buildCandidates(r);
    const s = selectSubjects(c.candidates);
    return buildPresentation({ subjects: s, secondaries: buildSecondaries(c, s, []), degraded: false, messages: null, today: TODAY });
  };

  it('DATE-NEXT : « Contrôle technique » / « Cupra · 18 avril 2028 » / « Voir → », même cible (tiroir échéance)', () => {
    const p = presentationOf(raw());
    const [t] = actionTiles(p);
    expect(t).toMatchObject({ label: 'Contrôle technique', sub: 'Cupra · 18 avril 2028' });
    expect(t.label).not.toMatch(/^Voir/);
    const [b] = subjectBlocks(p);
    expect(b.actions.map((a) => a.label)).toEqual(['Voir']);
    expect(b.actions[0].action.target).toEqual({ kind: 'drawer', drawer: 'echeance', id: 11, mode: 'view' });
    expect(homeItems(p, false).some((x) => x.kind === 'subject')).toBe(false);
  });

  it('date prévisionnelle : toujours « estimée » ; événement planifié : date seule, jamais « à prévoir »', () => {
    expect(actionTiles(presentationOf(raw({ agenda: [{ ...cupra, forecast: true }] })))[0].sub).toBe('Cupra · 18 avril 2028 (estimée)');
    expect(actionTiles(presentationOf(raw({ agenda: [{ ...cupra, title: 'Rendez-vous garage', dateRole: 'SCHEDULED_EVENT' }] })))[0])
      .toMatchObject({ label: 'Rendez-vous garage', sub: 'Cupra · 18 avril 2028' });
  });

  it('deux échéances le même jour (lot 61 : deux cartes, plus de DATE-NEXT-2) et autres cartes : aucun titre « Voir … » (document, export)', () => {
    const deux = actionTiles(presentationOf(raw({ agenda: [cupra, { ...cupra, id: 12, title: 'Assurance', assetId: 2, assetName: 'Maison', assetCategory: 'IMMOBILIER', assetSubtype: 'Maison' }] })));
    expect(deux.every((x) => !/ et /.test(x.label))).toBe(true);
    const doc = actionTiles(presentationOf(raw({ agenda: [], processing: { uploads: [], analyses: [{ id: 5, title: 'Facture garage', at: '2026-10-14T08:00:00Z' }], exports: [] } } as never)));
    expect(doc[0]).toMatchObject({ label: 'Facture garage', sub: 'En analyse' });
    const exp = actionTiles(presentationOf(raw({ agenda: [], processing: { uploads: [], analyses: [], exports: [{ id: 3, exportType: 'ASSET_SHEET', assetId: 1, assetName: 'Cupra', at: '2026-10-14T08:00:00Z' }] } } as never)));
    expect(exp[0]).toMatchObject({ label: 'Fiche du bien', sub: 'Cupra · En préparation' });
    for (const it of [...deux, ...doc, ...exp]) expect(it.label).not.toMatch(/^Voir\b/);
  });

  it('aucun appel IA pour la mise en page : tuile calculée à partir des données structurées', () => {
    const s = selectSubjects(buildCandidates(raw()).candidates)[0];
    expect(s.tileTitle).toBe('Contrôle technique');
    expect(tileFor(s, TODAY)).toMatchObject({ label: 'Contrôle technique', assetName: 'Cupra', status: '18 avril 2028' });
    // Jamais transmis à T6 (contrat d'entrée inchangé).
    expect(JSON.stringify(buildT6Input([s]))).not.toContain('tileTitle');
  });
});

describe('L55A-08 — responsive : sous-ligne lisible, sans troncature (mobile et desktop)', () => {
  it('ItemButton : plus de `truncate` sur la sous-ligne, retour à la ligne autorisé', () => {
    const t = read('src/components/home/MascotSpeaks.tsx');
    const sub = t.split('\n').find((l) => l.includes('data-item-sub')) ?? '';
    expect(sub).not.toMatch(/\btruncate\b/);
    expect(sub).toMatch(/break-words/);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Lot 87C — ticket P1 « T6 — fiabiliser la pertinence, le fondement et la
// répondabilité des questions suggérées » (AC01 à AC14, unitaires ; preuves
// sur PostgreSQL 16 : l55a-suggestions.e2e.ts, l72a-t6-residuels.e2e.ts).
// Homiris n'est qu'un exemple de non-régression : aucune règle propre.
// ══════════════════════════════════════════════════════════════════════════

describe('L87C — contrat des questions fondées (AC01 à AC14)', () => {
  const homiris: Row = { id: 21, title: 'Fin de contrat Homiris', date: '2026-12-31', forecast: false, requiresQualification: false, assetId: 3, assetName: 'Maison', dateRole: 'DEADLINE' };
  const ct: Row = { ...cupra, id: 22, date: '2027-02-10' };
  const assurance: Row = { id: 23, title: 'Assurance habitation', date: '2026-11-20', forecast: false, requiresQualification: false, assetId: 3, assetName: 'Maison' };
  const PREAVIS = { fileId: 501, factKey: 'notice_period', label: 'Préavis de résiliation', value: '2 mois avant l’échéance', status: 'PROVEN' as const };
  type G = import('../t6-suggestions').T6DeadlineGroundsInput;
  const contexte = (grounds: Map<number, G> = new Map(), o: Partial<import('../t6-suggestions').SuggestionSourceData> = {}) => S.buildT6SuggestionContext({
    speech: 'La fin de contrat Homiris approche : elle est fixée au 31 décembre 2026.', attentionToday: true,
    state: { documentsTotal: 3, toProcessPending: 1, deadlinesUpcoming: 3, deadlinesSoon: 1 }, operations: 1,
    assets: [{ id: 1, name: 'Cupra', documents: 1 }, { id: 3, name: 'Maison', documents: 2 }],
    agenda: [homiris, ct], excluded: [assurance], signaledIds: new Set([21]), today: TODAY,
    labelOf: (r) => (r.id === 22 ? 'Contrôle technique' : r.title), formatDate: (d) => d, grounds, ...o,
  });
  const verdict = (b: ReturnType<typeof contexte>, items: unknown[]) => S.validateT6SuggestionsDetailed(items, b.assetIds, b);
  const raisons = (b: ReturnType<typeof contexte>, items: unknown[]) => verdict(b, items).rejected.map((r) => r.reason);
  const PREPARER = 'Comment préparer la fin de contrat Homiris ?';
  const sansPreuve = new Map<number, G>([[21, { decision: decisionAction('Vérifier les conditions de fin de contrat', false, { reasonCode: 'NOTICE_PERIOD_RUNNING' }) }]]);

  it('L87C-AC01 — échéance signalée sans information suffisante : aucune suggestion PREPARE (signaled seul n’autorise rien)', () => {
    const b = contexte(sansPreuve);
    expect(b.context.nextDeadlines[0]).toMatchObject({ ref: 'D1', signaled: true, identifiedAction: { ref: 'D1.ACTION', basis: 'NOT_ESTABLISHED' }, facts: [], description: null });
    expect(raisons(b, [fonde(b, PREPARER, ['D1', 'D1.ACTION'], { purpose: 'PREPARE' })])).toEqual(['prepare_without_concrete_ground']);
    expect(raisons(b, [fonde(b, PREPARER, ['D1'], { purpose: 'PREPARE' })])).toEqual(['prepare_without_identified_action']);
    expect(raisons(b, [fonde(b, PREPARER, ['D1', 'D1.ACTION'], { purpose: 'PREPARE', decision: { relevant: true, answerable: true, preparationUseful: false } })]))
      .toEqual(['prepare_usefulness_not_established']);
    // Échéance signalée SANS décision d'action (non évaluée) : jamais « préparer » par le seul signalement.
    const nu = contexte();
    expect(nu.context.nextDeadlines[0]).toMatchObject({ signaled: true, evaluation: { status: 'NOT_EVALUATED' }, identifiedAction: null });
    expect(raisons(nu, [fonde(nu, PREPARER, ['D1'], { purpose: 'PREPARE' })])).toEqual(['prepare_without_identified_action']);
    // Jamais de conversion automatique PREPARE → CONSULT : rien n'est publié.
    expect(verdict(b, [fonde(b, PREPARER, ['D1', 'D1.ACTION'], { purpose: 'PREPARE' })]).accepted).toEqual([]);
  });

  it('L87C-AC02 — préparation concrète étayée par des informations fiables : PREPARE possible après validation', () => {
    const avecFait = contexte(new Map([[21, { ...sansPreuve.get(21)!, facts: [PREAVIS] }]]));
    expect(avecFait.context.nextDeadlines[0].facts).toEqual([{ ref: 'D1.F1', nature: 'DOCUMENT_FACT', label: 'Préavis de résiliation', value: '2 mois avant l’échéance', status: 'PROVEN' }]);
    const v = verdict(avecFait, [fonde(avecFait, PREPARER, ['D1', 'D1.ACTION', 'D1.F1'], { purpose: 'PREPARE' })]);
    expect(v.rejected).toEqual([]);
    expect(v.accepted[0]).toMatchObject({ purpose: 'PREPARE', deadlineRef: 'D1', subject: 'DEADLINE', informationNature: ['DEADLINE_DATA', 'IDENTIFIED_ACTION', 'DOCUMENT_FACT'] });
    // Démarche ÉTABLIE par une preuve concrète encore disponible : suffisante.
    const etablie = contexte(new Map([[21, { decision: decisionAction('Envoyer la résiliation avant le 31 octobre', true) }]]));
    expect(verdict(etablie, [fonde(etablie, PREPARER, ['D1', 'D1.ACTION'], { purpose: 'PREPARE' })]).accepted).toHaveLength(1);
    // Fait INCERTAIN seul : jamais un fondement concret.
    const incertain = contexte(new Map([[21, { ...sansPreuve.get(21)!, facts: [{ ...PREAVIS, status: 'UNCERTAIN' as const }] }]]));
    expect(incertain.context.nextDeadlines[0].facts[0].nature).toBe('UNCERTAIN_FACT');
    expect(raisons(incertain, [fonde(incertain, PREPARER, ['D1', 'D1.ACTION', 'D1.F1'], { purpose: 'PREPARE' })])).toEqual(['prepare_without_concrete_ground']);
  });

  it('L87C-AC03 — échéance connue sans démarche : consultation pertinente possible, pas de préparation artificielle', () => {
    // Rappel informatif signalé (SHOW_NOW / INFORMATION, aucune démarche).
    const info = contexte(new Map([[21, { decision: { decision: 'SHOW_NOW', category: 'INFORMATION', reasonCode: 'INFORMATIVE_REMINDER', uncertainties: [], action: null, actionEstablished: false }, facts: [PREAVIS] }]]));
    expect(info.context.nextDeadlines[0]).toMatchObject({ evaluation: { status: 'EVALUATED', category: 'INFORMATION' }, identifiedAction: null });
    expect(raisons(info, [fonde(info, PREPARER, ['D1', 'D1.F1'], { purpose: 'PREPARE' })])).toEqual(['prepare_without_identified_action']);
    expect(verdict(info, [fonde(info, 'Quand se termine la fin de contrat Homiris ?', ['D1'])]).accepted).toHaveLength(1);
    // Échéance non signalée : consultation oui, préparation non.
    const b = contexte();
    expect(verdict(b, [fonde(b, 'Quand est prévu le contrôle technique ?', ['D2'])]).accepted).toHaveLength(1);
    expect(raisons(b, [fonde(b, 'Que préparer pour le contrôle technique ?', ['D2'], { purpose: 'PREPARE' })])).toEqual(['prepare_not_signaled']);
    expect(raisons(b, [fonde(b, 'Faut-il anticiper le contrôle technique ?', ['D2'])])).toEqual(['consult_incites_unsignaled']);
  });

  it('L87C-AC04 — référence absente, inaccessible ou incohérente : suggestion rejetée et motif tracé', () => {
    const b = contexte(new Map([[21, { facts: [PREAVIS] }]]));
    const v = verdict(b, [
      fonde(b, 'Quand se termine la fin de contrat Homiris ?', [], { deadlineRef: 'D1' }),
      fonde(b, 'Quand se termine la fin de contrat Homiris ?', ['D1', 'D1.F9']),
      fonde(b, 'Quand se termine la fin de contrat Homiris ?', ['D1', 'D2']),
    ]);
    expect(v.rejected.map((r) => [r.index, r.reason])).toEqual([[0, 'contract_missing_grounds'], [1, 'unknown_ground_ref'], [2, 'ground_subject_mismatch']]);
    expect(raisons(b, [fonde(b, 'Quand se termine la fin de contrat Homiris ?', ['D1'], { informationNature: ['DOCUMENT_FACT'] })])).toEqual(['nature_not_grounded']);
    expect(raisons(b, [fonde(b, 'Quels documents ai-je pour mes opérations ?', ['ACC.TO_PROCESS'], { subject: 'OPERATIONS' })])).toEqual(['subject_not_grounded']);
    expect(raisons(b, [fonde(b, 'Quand se termine la fin de contrat Homiris ?', ['D1'], { decision: { relevant: true, answerable: false } })])).toEqual(['declared_not_answerable']);
    expect(raisons(b, [fonde(b, 'Quand se termine la fin de contrat Homiris ?', ['D1'], { decision: null })])).toEqual(['contract_missing_decision']);
    // Motifs structurés dans la trace (références seulement, jamais le texte).
    const rapport = S.t6SuggestionReportOf(v, true);
    expect(rapport).toMatchObject({ contract: 't6-suggestions-v3', produced: 3, accepted: 0, rejected: 3, reasons: { contract_missing_grounds: 1, unknown_ground_ref: 1, ground_subject_mismatch: 1 } });
    expect(JSON.stringify(rapport)).not.toMatch(/Homiris|Préavis/);
  });

  it('L87C-AC05 — trois suggestions dont deux invalides : une seule affichée, sans remplacement', () => {
    const b = contexte();
    const v = verdict(b, [
      fonde(b, PREPARER, ['D1'], { purpose: 'PREPARE' }),
      fonde(b, 'Quels documents concernent ma Cupra ?', ['A1', 'A1.DOCS'], { assetRef: 'A1' }),
      fonde(b, 'Quand est prévue la vidange ?', ['D2']),
      fonde(b, 'Quelles sont mes prochaines échéances ?', ['ACC.DEADLINES']), // 4e : jamais un remplaçant
    ]);
    expect(v.accepted.map((x) => x.question)).toEqual(['Quels documents concernent ma Cupra ?']);
    expect(v.rejected.map((r) => [r.index, r.reason])).toEqual([[0, 'prepare_without_identified_action'], [2, 'label_not_cited'], [3, 'over_limit']]);
  });

  it('L87C-AC06 — aucune suggestion pertinente : zéro suggestion, interface fonctionnelle, génération réussie', async () => {
    const b = contexte();
    execute.mockResolvedValue(res(OUT([])));
    const o = await R.formulateWithT6({ accountId: 7, input: INPUT, contextHash: 'z', mode: 'pregen', suggestions: b }, deps);
    expect(o).toMatchObject({ status: 'generated', suggestions: [] });
    expect(R.t6SuggestionTraceOf(o, { requested: true, promptSupported: true })).toMatchObject({ produced: 0, accepted: 0, rejected: 0 });
    // Toutes rejetées : aucune question, toujours « generated » (pas une anomalie), aucun complément.
    execute.mockResolvedValue(res(OUT([fonde(b, PREPARER, ['D1'], { purpose: 'PREPARE' })])));
    const t = await R.formulateWithT6({ accountId: 7, input: INPUT, contextHash: 'z2', mode: 'pregen', suggestions: b }, deps);
    expect(t).toMatchObject({ status: 'generated', suggestions: [] });
    const c = buildCandidates(raw());
    const s = selectSubjects(c.candidates);
    const p = buildPresentation({ subjects: s, secondaries: withSuggestedQuestions(buildSecondaries(c, s, []), s, S.suggestionSecondaries(t.suggestions ?? [])), degraded: false, messages: t.messages, today: TODAY });
    expect(homeSuggestions(p, false, [])).toEqual([]);
    expect(p.paragraphs.length).toBeGreaterThan(0);
  });

  it('L87C-AC07 — source modifiée sans changement des compteurs : clé de cache nouvelle et suggestion conservée invalidée', () => {
    const avant = contexte(new Map([[21, { ...sansPreuve.get(21)!, facts: [PREAVIS] }]]));
    const apres = contexte(new Map([[21, { ...sansPreuve.get(21)!, facts: [{ ...PREAVIS, value: '3 mois avant l’échéance' }] }]]));
    // Mêmes compteurs, mêmes biens, mêmes échéances : seul le fait a changé.
    expect(apres.context.account).toEqual(avant.context.account);
    expect(apres.groundsDigest).not.toBe(avant.groundsDigest);
    const cle = (b: typeof avant) => R.t6CacheKey({ accountId: 7, input: INPUT, promptVersion: 'v', outputSchema: 't6-output-v2', suggestionContext: b.context, suggestionContract: b.contract, suggestionGrounds: b.groundsDigest });
    expect(cle(apres)).not.toBe(cle(avant));
    // Contexte identique : même clé (aucune régénération inutile).
    expect(cle(contexte(new Map([[21, { ...sansPreuve.get(21)!, facts: [PREAVIS] }]])))).toBe(cle(avant));
    const q = verdict(avant, [fonde(avant, PREPARER, ['D1', 'D1.ACTION', 'D1.F1'], { purpose: 'PREPARE' })]).accepted[0];
    const relu = S.validateT6SuggestionsDetailed([S.storedSuggestionOf(q)], apres.assetIds, apres, { stored: true });
    expect(relu.rejected.map((r) => r.reason)).toEqual(['ground_changed']);
    // Fondement disparu (fait retiré) : la référence n'existe plus.
    const sansFait = contexte(sansPreuve);
    expect(S.validateT6SuggestionsDetailed([S.storedSuggestionOf(q)], sansFait.assetIds, sansFait, { stored: true }).rejected[0].reason).toBe('unknown_ground_ref');
    expect(S.storedGroundsViolation(q.grounds, new Map())).toBe('ground_unavailable');
  });

  it('L87C-AC08 — échéance écartée, reportée ou refusée : aucune réintroduction par suggestion', () => {
    const b = contexte();
    expect(JSON.stringify(b.context)).not.toMatch(/Assurance/);
    expect(raisons(b, [fonde(b, 'Comment renouveler l’assurance habitation ?', ['ACC.DEADLINES'])])).toEqual(['excluded_deadline_cited']);
    expect(raisons(b, [fonde(b, 'Quand se termine l’assurance habitation ?', ['D1'])])).toEqual(['label_not_cited']);
    // Devenue écartée après la génération : la référence n'est plus admise à la relecture.
    const q = verdict(b, [fonde(b, 'Quand est prévu le contrôle technique ?', ['D2'])]).accepted[0];
    const apres = contexte(new Map(), { agenda: [homiris], excluded: [assurance, ct] });
    expect(S.validateT6SuggestionsDetailed([S.storedSuggestionOf(q)], apres.assetIds, apres, { stored: true }).accepted).toEqual([]);
  });

  it('L87C-AC09 — cache ancien incompatible : non servi, renouvellement conforme', async () => {
    const b = contexte();
    unsafe.mockImplementation(async (sql: string) => (String(sql).includes('SELECT c.messages, c.suggestions')
      ? [{ messages: OUT([]).messages, suggestion_contract: null, trace_id: null, suggestions: [{ question: 'Quand est prévu le contrôle technique ?', assetRef: null, deadlineRef: 'D2', purpose: 'CONSULT' }] }]
      : []));
    execute.mockResolvedValue(res(OUT([fonde(b, 'Quand est prévu le contrôle technique ?', ['D2'])])));
    const o = await R.formulateWithT6({ accountId: 7, input: INPUT, contextHash: 'old', mode: 'pregen', suggestions: b }, deps);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(o.status).toBe('generated');
    expect(o.suggestions).toMatchObject([{ question: 'Quand est prévu le contrôle technique ?', subject: 'DEADLINE', groundRefs: ['D2'] }]);
    // La clé intègre la version du contrat : une entrée antérieure n'est même plus adressée.
    const k = (contract?: string) => R.t6CacheKey({ accountId: 7, input: INPUT, promptVersion: 'v', outputSchema: 't6-output-v2', suggestionContext: b.context, suggestionContract: contract, suggestionGrounds: b.groundsDigest });
    expect(k('t6-suggestions-v3')).not.toBe(k('t6-suggestions-v2'));
  });

  it('L87C-AC10 — prompt sans le nouveau contrat : aucune suggestion non vérifiable publiée', async () => {
    const b = contexte();
    // Avec le contrat : question fondée acceptée. Sans fondements (prompt antérieur) : rejet systématique, motif dédié.
    expect(raisons(b, [fonde(b, 'Quand est prévu le contrôle technique ?', ['D2'])])).toEqual([]);
    const v = S.validateT6SuggestionsDetailed([fonde(b, 'Quand est prévu le contrôle technique ?', ['D2'])], b.assetIds, { ...b, grounds: undefined, contract: undefined });
    expect(v.rejected.map((r) => r.reason)).toEqual(['contract_unsupported']);
    // Sortie au format R12 v2 (sans fondements) : jamais acceptée.
    expect(raisons(b, [{ question: 'Quand est prévu le contrôle technique ?', assetRef: null, deadlineRef: 'D2', purpose: 'CONSULT' }])).toEqual(['contract_missing_subject']);
    // Mascotte : sans contrat, aucun contexte transmis (questions nulles) et trace « prompt non compatible ».
    const svc = read('src/services/home/mascot/mascot.service.ts');
    expect(svc).toMatch(/const questionsP = t6SuggestionGroundsAvailable\(\)/);
    expect(R.t6SuggestionTraceOf({ status: 'generated', messages: [], promptVersion: 'v' }, { requested: false, promptSupported: false })).toMatchObject({ promptSupported: false, contract: null, accepted: 0 });
  });

  it('L87C-AC11 — références appartenant à un autre compte : rejet systématique', () => {
    const autre = S.buildT6SuggestionContext({
      speech: '', attentionToday: false, state: { documentsTotal: 1 }, operations: 0, assets: [{ id: 99, name: 'Villa', documents: 1 }],
      agenda: [{ ...homiris, id: 990, assetId: 99 }, { ...ct, id: 991 }, { ...ct, id: 992, title: 'Ramonage' }], signaledIds: new Set([990]), labelOf: (r) => r.title, formatDate: (d) => d,
      grounds: new Map([[990, { facts: [PREAVIS, PREAVIS, PREAVIS] }]]),
    });
    const b = contexte();
    // Références opaques par compte : celles de l'autre compte n'existent pas ici.
    expect(raisons(b, [fonde(b, 'Quand se termine la fin de contrat Homiris ?', ['D1', 'D1.F3'])])).toEqual(['unknown_ground_ref']);
    expect(raisons(b, [fonde(b, 'Quand est prévu le ramonage ?', ['D3'], { deadlineRef: 'D3', informationNature: ['DEADLINE_DATA'] })])).toEqual(['unknown_deadline_ref']);
    expect(autre.grounds!.get('D1')!.key).toBe('agenda:990');
    // Fondements conservés d'un autre compte : clés inconnues du contexte courant.
    const etranger = { question: 'Quand se termine la fin de contrat Homiris ?', subject: 'DEADLINE', purpose: 'CONSULT', assetRef: null, deadlineRef: 'D1',
      decision: { relevant: true, answerable: true, preparationUseful: null }, groundRefs: ['D1'], informationNature: ['DEADLINE_DATA'],
      grounds: [{ ref: 'D1', key: 'agenda:990', version: autre.grounds!.get('D1')!.version, nature: 'DEADLINE_DATA' }] };
    expect(S.validateT6SuggestionsDetailed([etranger], b.assetIds, b, { stored: true }).rejected[0].reason).toBe('ground_unavailable');
  });

  it('L87C-AC12 — suggestions correctement fondées (contrats, documents, équipements, opérations, échéances) : aucun rejet abusif', () => {
    const b = contexte(new Map([[21, { facts: [PREAVIS], documents: [{ fileId: 501, title: 'Contrat de télésurveillance' }], description: 'Contrat annuel reconduit tacitement.' }]]));
    const v = verdict(b, [
      fonde(b, 'Que prévoit le contrat pour la fin de contrat Homiris ?', ['D1', 'D1.F1', 'D1.DOC1']),
      fonde(b, 'Quels documents concernent ma Cupra ?', ['A1', 'A1.DOCS'], { assetRef: 'A1' }),
      fonde(b, 'Quelles opérations ai-je enregistrées ?', ['ACC.OPERATIONS']),
    ]);
    expect(v.rejected).toEqual([]);
    expect(v.accepted).toHaveLength(3);
    const w = verdict(b, [
      fonde(b, 'Que me reste-t-il à traiter ?', ['ACC.TO_PROCESS']),
      fonde(b, 'Quelles sont mes prochaines échéances ?', ['ACC.DEADLINES', 'D1', 'D2'], { deadlineRef: null, subject: 'DEADLINES' }),
      fonde(b, 'Quand est prévu le contrôle technique de la Cupra ?', ['D2', 'A1'], { assetRef: 'A1' }),
    ]);
    expect(w.rejected).toEqual([]);
    expect(w.accepted.map((x) => x.subject)).toEqual(['TO_PROCESS', 'DEADLINES', 'DEADLINE']);
  });

  it('L87C-AC13 — contrôle de cohérence : même règle, retrait et invalidation des questions devenues injustifiées', async () => {
    const { t6SuggestionEntryDiagnosis, t6SuggestionsCheck } = await import('@/services/coherence/registry/checks/t6-suggestions');
    const { COHERENCE_REGISTRY } = await import('@/services/coherence/registry');
    const { COVERAGE_INVENTORY } = await import('@/services/coherence/registry/coverage');
    const G = await import('../t6-suggestion-grounds');
    const b = contexte(new Map([[21, { ...sansPreuve.get(21)!, facts: [PREAVIS] }]]));
    const q = verdict(b, [fonde(b, PREPARER, ['D1', 'D1.ACTION', 'D1.F1'], { purpose: 'PREPARE' })]).accepted[0];
    const entree = { contract: 't6-suggestions-v3', suggestions: [S.storedSuggestionOf(q)] };
    const deps2 = { contract: 't6-suggestions-v3', groundsOf: (x: unknown) => G.storedGroundsOfEntry(x).perSuggestion, violation: S.storedGroundsViolation };
    const courantes = new Map([...b.grounds!.values()].map((g) => [g.key, g.version]));
    expect(t6SuggestionEntryDiagnosis(entree, courantes, deps2)).toBeNull();
    const modifie = new Map(courantes); modifie.set('fact:501:notice_period', 'autre');
    expect(t6SuggestionEntryDiagnosis(entree, modifie, deps2)).toEqual({ reasons: { ground_changed: 1 }, removed: 1 });
    const disparu = new Map(courantes); disparu.delete('agenda:21');
    expect(t6SuggestionEntryDiagnosis(entree, disparu, deps2)).toEqual({ reasons: { ground_unavailable: 1 }, removed: 1 });
    expect(t6SuggestionEntryDiagnosis({ ...entree, contract: null }, null, deps2)).toEqual({ reasons: { contract_outdated: 1 }, removed: 1 });
    // Registre : en fin de liste (position relative), actif, réparation déléguée, aucune donnée métier.
    const ids = COHERENCE_REGISTRY.map((c) => c.id);
    expect(ids.indexOf('COH-T6-SUGGESTIONS')).toBeGreaterThan(ids.indexOf('COH-TCO-ECONOMIC-DATES'));
    expect(t6SuggestionsCheck).toMatchObject({ status: 'ACTIVE', domain: 't6' });
    expect(typeof t6SuggestionsCheck.repair).toBe('function');
    expect(t6SuggestionsCheck.forbiddenRepairs.join(' ')).toMatch(/donnée métier/);
    expect(COVERAGE_INVENTORY.find((e) => e.domain === 't6')?.checks).toContain('COH-T6-SUGGESTIONS');
  });

  it('L87C-AC14 — génération partiellement valide : rejets distinctement tracés (journal T6, rapport, BO)', async () => {
    const b = contexte();
    unsafe.mockImplementation(async (sql: string) => (String(sql).includes("column_name = 'suggestion_report'") ? [{ '?column?': 1 }] : []));
    R.resetT6SuggestionReportProbe();
    execute.mockResolvedValue(res(OUT([
      fonde(b, PREPARER, ['D1'], { purpose: 'PREPARE' }),
      fonde(b, 'Quand est prévu le contrôle technique ?', ['D2']),
      fonde(b, 'Quand est prévue la vidange ?', ['D2']),
    ])));
    const o = await R.formulateWithT6({ accountId: 7, input: INPUT, contextHash: 'p', mode: 'pregen', suggestions: b }, deps);
    expect(o.status).toBe('generated');
    const rapport = R.t6SuggestionTraceOf(o, { requested: true, promptSupported: true })!;
    expect(rapport).toMatchObject({ produced: 3, accepted: 1, rejected: 2, reasons: { prepare_without_identified_action: 1, label_not_cited: 1 } });
    expect(rapport.rejections.map((r) => [r.index, r.reason, r.purpose])).toEqual([[0, 'prepare_without_identified_action', 'PREPARE'], [2, 'label_not_cited', 'CONSULT']]);
    expect(rapport.acceptedGrounds).toEqual([{ subject: 'DEADLINE', purpose: 'CONSULT', groundRefs: ['D2'], keys: ['agenda:22'] }]);
    await R.logT6({ accountId: 7, contextHash: 'p', mode: 'pregen', outcome: o, input: INPUT, suggestionContext: b.context, suggestionReport: rapport });
    const ins = unsafe.mock.calls.find(([q]) => /INSERT INTO home_mascot_generations/.test(q))!;
    expect(String(ins[0])).toMatch(/suggestion_report/);
    expect(JSON.parse(String(ins[1]![13]))).toMatchObject({ contract: 't6-suggestions-v3', accepted: 1, rejected: 2 });
    // BO « Exécutions & logs » : une génération réussie affiche ses rejets (résultat natif).
    const { qualifyT6Formulate } = await import('@/services/ai/business-execution/mapping');
    const qual = qualifyT6Formulate({ traceId: 't', status: 'generated', mode: 'pregen', error: null, createdAt: new Date(0), suggestionReport: rapport as never });
    expect(qual.outcome).toBe('SUCCEEDED');
    expect(qual.native.result).toMatch(/1 acceptée\(s\), 2 rejetée\(s\) \[label_not_cited, prepare_without_identified_action\]/);
    // Rapport d'exécution T6 : ligne « questions » distincte, jamais masquée par la formulation.
    const { t6FormulateEntries } = await import('../t6-interpellation.service');
    const lignes = t6FormulateEntries({ promptVersion: 'v', contract: 't6-output-v2', transmitted: [], displayed: [], source: 't6', status: 'generated', presentation: null,
      suggestions: { supported: true, contract: 't6-suggestions-v3', source: 'generated', produced: 3, accepted: 1, rejected: 2, invalidated: 0, reasons: rapport.reasons } });
    expect(lignes[1]).toMatchObject({ fieldKey: 'suggestions', recordStatus: 'PARTIAL', reasonCode: 'label_not_cited,prepare_without_identified_action' });
  });
});
