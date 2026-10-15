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
const { composeSpeech, homeItems, homeSuggestions, tileFor, NOTHING_PRIORITY } = await import('../bubble');
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
      { question: 'Quelles sont mes prochaines échéances ?', assetRef: null },
      { question: 'Quels documents concernent ma Cupra ?', assetRef: 'A1' },
    ])));
    const o = await R.formulateWithT6({ accountId: 7, input: INPUT, contextHash: 'h', mode: 'pregen', suggestions: b }, deps);
    expect(execute).toHaveBeenCalledTimes(1);
    const req = execute.mock.calls[0][0];
    expect(req.operationCode).toBe('t6_formulate');
    const ctx = JSON.parse(req.promptVariables.SUGGESTION_CONTEXT);
    expect(ctx.bubble.speech).toContain(NOTHING_PRIORITY);
    expect(ctx).toMatchObject({
      bubble: { attentionToday: false },
      account: { hasDocuments: true, hasPendingToProcess: true, hasUpcomingDeadlines: true, hasDeadlinesNext30Days: false },
      assets: [{ ref: 'A1', name: 'Cupra', hasDocuments: true }, { ref: 'A2', name: 'Maison', hasDocuments: false }],
      nextDeadlines: [{ label: 'Contrôle technique', assetRef: 'A1', dateLabel: '18 avril 2028', dateNature: 'confirmée' }],
    });
    // Jamais d'identifiant de base transmis à T6 (références opaques).
    expect(req.promptVariables.SUGGESTION_CONTEXT).not.toMatch(/"id"|assetId/);
    expect(o.status).toBe('generated');
    expect(o.suggestions).toEqual([
      { question: 'Quelles sont mes prochaines échéances ?', assetId: null, assetRef: null },
      { question: 'Quels documents concernent ma Cupra ?', assetId: 1, assetRef: 'A1' },
    ]);
    // Cache : questions écrites avec la bulle (migration 0395).
    const ecriture = unsafe.mock.calls.find((c) => String(c[0]).includes('INSERT INTO home_mascot_cache'));
    expect(String(ecriture?.[0])).toMatch(/suggestions/);
  });

  it('sans priorité NI sujet : T6 appelé pour les questions seules (messages vides acceptés)', async () => {
    const b = bundleFor(NOTHING_PRIORITY);
    const vide = buildT6Input([]);
    execute.mockResolvedValue(res({ schemaVersion: 't6-output-v2', messages: [], suggestions: [{ question: 'Quelles sont mes prochaines échéances ?', assetRef: null }] }));
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
  const ids = new Map([['A1', 1]]);
  it('nombre (3 au plus), longueur, forme interrogative, une ligne, ni emoji ni tutoiement, doublons exacts', () => {
    const v = S.validateT6Suggestions([
      { question: 'Quels documents concernent ma Cupra ?', assetRef: 'A1' },
      { question: '  quels documents  concernent ma cupra ?  ', assetRef: 'A1' }, // doublon exact (casse, espaces)
      { question: 'Quoi ?' },
      { question: 'Quelles sont mes prochaines échéances' }, // pas une question
      { question: 'Que dois-tu faire ?' }, // tutoiement
      { question: 'Quelle est ma prochaine échéance ? 🚗' },
      { question: 'Ligne 1 ?\nLigne 2 ?' },
      { question: `${'x'.repeat(120)} ?` },
      { question: 'Comment préparer cette échéance ?', assetRef: 'A9' }, // référence inconnue : abandonnée
      { question: 'Comment préparer cette échéance ?', assetRef: null },
      'Quels documents me seront utiles ?',
      { question: 'Quelles opérations ai-je enregistrées ?' },
    ], ids);
    expect(v.map((x) => x.question)).toEqual([
      'Quels documents concernent ma Cupra ?', 'Comment préparer cette échéance ?', 'Quels documents me seront utiles ?',
    ]);
    expect(S.validateT6Suggestions(null, ids)).toEqual([]);
    expect(S.validateT6Suggestions({ question: 'x ?' }, ids)).toEqual([]);
  });

  it('aucun filtre par mots-clés : la pertinence appartient à T6 (une question « priorité » reste structurellement valable)', () => {
    expect(S.validateT6Suggestions([{ question: 'Que dois-je traiter en priorité ?' }], ids)).toHaveLength(1);
  });

  it('une liste mal formée ne fait jamais tomber la bulle (textes T6 conservés)', async () => {
    execute.mockResolvedValue(res(OUT('pas une liste')));
    const o = await R.formulateWithT6({ accountId: 7, input: INPUT, contextHash: 'h', mode: 'pregen', suggestions: bundleFor() }, deps);
    expect(o.status).toBe('generated');
    expect(o.messages).toHaveLength(INPUT.subjects.length);
    expect(o.suggestions).toEqual([]);
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
    unsafe.mockImplementation(async (sql: string) => (String(sql).startsWith('SELECT messages, suggestions')
      ? [{ messages: OUT([]).messages, suggestions: [{ question: 'Quels documents concernent ma Cupra ?', assetRef: 'A1' }, { question: 'Et la maison ?', assetRef: 'A7' }] }]
      : []));
    const o = await R.formulateWithT6({ accountId: 7, input: INPUT, contextHash: 'h', mode: 'display', suggestions: bundleFor() }, deps);
    expect(o.status).toBe('cache_hit');
    expect(execute).not.toHaveBeenCalled();
    expect(o.suggestions).toEqual([{ question: 'Quels documents concernent ma Cupra ?', assetId: 1, assetRef: 'A1' }]);
  });

  it('même bulle, contexte du compte changé : textes FIGÉS (R8), un appel pour renouveler les questions', async () => {
    const prev = [{ input: INPUT, output: OUT([]) }];
    execute.mockResolvedValue(res({ ...OUT([{ question: 'Quelles sont mes prochaines échéances ?' }]), messages: INPUT.subjects.map((s) => ({ subjectId: s.subjectId, text: `Reformulation : ${s.fallbackText}`, highlight: null })) }));
    const o = await R.formulateWithT6({ accountId: 7, input: INPUT, contextHash: 'h', mode: 'pregen', suggestions: bundleFor() }, { ...deps, previousBubbles: async () => prev });
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
      // Lot 60 : emplacement R13, facultatif lui aussi (absent d'une version antérieure).
      .replace(/\nCandidats d’interpellation à évaluer : \{\{INTERPELLATION_CONTEXT\}\}\n/, '\n');
    expect(renderMasterPrompt(ancien, { masterPromptCode: 't6_master_v1', task: 'FORMULATE', allowedTasks: ['FORMULATE'], variables: { INPUT_JSON: '{}', SUGGESTION_CONTEXT: '{"a":1}' } }))
      .not.toContain('{"a":1}');
  });

  it('version BO active sans l’emplacement → aucune question ; fichier du dépôt ou nouvelle version → questions', async () => {
    configText = 'Tu es T6. MODE = {{MODE}}\nValeurs autorisées : FORMULATE\nEntrée structurée : {{INPUT_JSON}}';
    expect(await R.t6SuggestionsAvailable()).toBe(false);
    configText = null;
    expect(await R.t6SuggestionsAvailable()).toBe(true);
    configText = 'MODE = {{MODE}} {{INPUT_JSON}} {{SUGGESTION_CONTEXT}}';
    expect(await R.t6SuggestionsAvailable()).toBe(true);
  });
});

describe('L55A-07 — cartes d’échéance : intitulé métier, bien · date complète, une seule action « Voir »', () => {
  const presentationOf = (r: Raw) => {
    const c = buildCandidates(r);
    const s = selectSubjects(c.candidates);
    return buildPresentation({ subjects: s, secondaries: buildSecondaries(c, s, []), degraded: false, messages: null, today: TODAY });
  };

  it('DATE-NEXT : « Contrôle technique » / « Cupra · 18 avril 2028 » / « Voir → », même cible (tiroir échéance)', () => {
    const items = homeItems(presentationOf(raw()), false);
    expect(items[0]).toMatchObject({ kind: 'subject', title: 'Contrôle technique', sub: 'Cupra · 18 avril 2028', cta: 'Voir' });
    expect(items[0].title).not.toMatch(/^Voir/);
    expect(items[0].kind === 'subject' && items[0].tile.paragraph.actions[0].target).toEqual({ kind: 'drawer', drawer: 'echeance', id: 11, mode: 'view' });
  });

  it('date prévisionnelle : toujours « estimée » ; événement planifié : date seule, jamais « à prévoir »', () => {
    expect(homeItems(presentationOf(raw({ agenda: [{ ...cupra, forecast: true }] })), false)[0].sub).toBe('Cupra · 18 avril 2028 (estimée)');
    expect(homeItems(presentationOf(raw({ agenda: [{ ...cupra, title: 'Rendez-vous garage', dateRole: 'SCHEDULED_EVENT' }] })), false)[0])
      .toMatchObject({ title: 'Rendez-vous garage', sub: 'Cupra · 18 avril 2028' });
  });

  it('DATE-NEXT-2 et autres cartes du même composant : aucun titre « Voir … » (document, export)', () => {
    const deux = homeItems(presentationOf(raw({ agenda: [cupra, { ...cupra, id: 12, title: 'Assurance', assetId: 2, assetName: 'Maison', assetCategory: 'IMMOBILIER', assetSubtype: 'Maison' }] })), false);
    expect(deux[0]).toMatchObject({ title: 'Contrôle technique et assurance', sub: 'Cupra et Maison · 18 avril 2028', cta: 'Voir' });
    const doc = homeItems(presentationOf(raw({ agenda: [], processing: { uploads: [], analyses: [{ id: 5, title: 'Facture garage', at: '2026-10-14T08:00:00Z' }], exports: [] } } as never)), false);
    expect(doc[0]).toMatchObject({ title: 'Facture garage', sub: 'En analyse', cta: 'Voir' });
    const exp = homeItems(presentationOf(raw({ agenda: [], processing: { uploads: [], analyses: [], exports: [{ id: 3, exportType: 'ASSET_SHEET', assetId: 1, assetName: 'Cupra', at: '2026-10-14T08:00:00Z' }] } } as never)), false);
    expect(exp[0]).toMatchObject({ title: 'Fiche du bien', sub: 'Cupra · En préparation', cta: 'Voir' });
    for (const it of [...deux, ...doc, ...exp]) expect(it.title).not.toMatch(/^Voir\b/);
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
