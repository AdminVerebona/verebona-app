/**
 * CDC 15 lot 15 (volet Z) — master T2 : contrat §24, branche ANSWER dans
 * `generation.adapter`, support vérifiable (T2-31), chronologie structurée
 * (T2-35), règles de longueur uniques (T2-36), branche UNDERSTAND fournie à
 * la classification.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { fakeProvider } from '@/test/setup';

vi.mock('@/db', () => ({
  pgClient: { unsafe: vi.fn(async () => { throw new Error('aucune base en test'); }) },
  db: { insert: () => ({ values: async () => undefined }) },
  ensureMigrations: vi.fn(async () => {}),
  ensureUnaccent: vi.fn(async () => {}),
}));
vi.mock('@/services/ai/telemetry/ai-trace.service', () => ({ recordCallTrace: async () => undefined }));

const { __setConfigForTests } = await import('@/services/ai/config/config-resolver');
const { emptyTreatmentConfig } = await import('@/services/ai/config/config-types');
const { generateAssistantAnswerDetailed } = await import('../generation.adapter');
const { createAiCallBudget } = await import('../ai-call-budget');
const { routeForIntent } = await import('../intent-router.service');
const { validateGeneratedAnswer } = await import('../response-validator.service');
const { answerFormatFor, lengthRuleText } = await import('../../prompts/answer-format');
const { AI_OPERATIONS } = await import('@/services/ai/registry/operations');
const { resolveMasterPrompt, renderMasterPrompt, inspectMasterTemplate } = await import('@/services/ai/prompts/prompt-loader');
const { T2AnswerOutput, T2UnderstandOutput, T2RevalidateOutput } = await import('@/services/ai/assistant/master/t2-contract');
const { t2MasterVariables, t2AnswerLines } = await import('@/services/ai/assistant/master/t2-answer');
const { toT2Understanding, understandWithT2Master } = await import('@/services/ai/assistant/master/t2-understand');
const { toIntentRoute } = await import('../classification.adapter');
type Source = import('../../types/sources').RetrievedSource;
type Input = import('../../types/contracts').AssistantRequestInput;

const MASTER = readFileSync(join(process.cwd(), 'src/services/ai/prompts/assistant/t2_master_v1.txt'), 'utf8');

const master = () => __setConfigForTests({ versionId: 15, entries: [{ ...emptyTreatmentConfig('T2'), promptArchitecture: 'master' }] });
afterEach(() => {
  __setConfigForTests(null);
});

const repond = (...sorties: unknown[]) => {
  let n = 0;
  fakeProvider.onAny(() => {
    const s = sorties[Math.min(n++, sorties.length - 1)];
    return { rawText: typeof s === 'string' ? s : JSON.stringify(s), inputTokens: 10, outputTokens: 5 };
  });
};
const input = (over: Partial<Input> = {}): Input => ({
  accountId: 7, userId: 3, planType: 'PREMIUM', message: 'Retrace l’historique de ma draisienne', clientRequestId: `c-${Math.random()}`,
  locale: 'fr-FR', aiBudget: createAiCallBudget(2), aiReport: { securityEvents: [], events: [] }, ...over,
});
const sources: Source[] = [
  { id: 'agenda_321', type: 'agenda_item', title: 'Achat de la draisienne', content: 'Échéance réalisée le 24/04/2026 : achat de la draisienne.' },
  { id: 'doc_88', type: 'document', title: 'Facture draisienne', content: 'Facture du 24/04/2026, montant 129,90 €.' },
  { id: 'doc_90', type: 'document', title: 'Entretien', content: 'Révision effectuée le 12/09/2026.' },
];

describe('contrat §24 — t2_master_v1', () => {
  it('trois branches MODE, discriminant MODE (pas TASK), variables déclarées au registre', () => {
    const info = inspectMasterTemplate(MASTER);
    expect(info.discriminant).toBe('MODE');
    expect(info.branches).toEqual(['UNDERSTAND', 'ANSWER', 'REVALIDATE']);
    const vars = info.placeholders.filter((p) => p !== 'MODE').sort();
    expect(vars).toEqual([...AI_OPERATIONS.t2_answer.promptVariables!].sort());
    for (const op of ['t2_understand', 't2_answer', 't2_revalidate'] as const) {
      expect(AI_OPERATIONS[op]).toMatchObject({ masterPromptCode: 't2_master_v1', taskField: 'mode', billable: op !== 't2_understand' });
      expect(AI_OPERATIONS[op].defaultMaxOutputTokens).toBe(500);
    }
    // Lot 16b-2 : opérations d'étapes et relais de T2 retirés du registre.
    for (const op of ['understand_request', 'generate_answer', 'generate_answer_canonical', 'revalidate_fact', 'legacy_semantic_search', 'legacy_intelligent_search']) {
      expect(AI_OPERATIONS[op], op).toBeUndefined();
    }
  });

  it('MODE est fixé par le serveur : jamais par l’appelant', async () => {
    const r = await resolveMasterPrompt({ masterPromptCode: 't2_master_v1', task: 'ANSWER', variables: t2MasterVariables('ANSWER', { INTENT: 'ACCOUNT_TIMELINE' }) });
    expect(r.text).toContain('MODE = ANSWER');
    expect(r.text).toContain('Intention : ACCOUNT_TIMELINE');
    expect(() => renderMasterPrompt(MASTER, {
      masterPromptCode: 't2_master_v1', task: 'ANSWER', allowedTasks: ['ANSWER'],
      variables: { ...t2MasterVariables('ANSWER', {}), MODE: 'REVALIDATE' },
    })).toThrow(/fixée par le serveur/);
  });

  it('schémas de sortie : trois formats ANSWER, UNDERSTAND fermé, REVALIDATE texte/visuel', () => {
    expect(T2AnswerOutput.safeParse({ mode: 'ANSWER', format: 'timeline', status: 'answered', events: [{ date: '2026-04-24', text: 'Achat', sourceIds: ['a'] }] }).success).toBe(true);
    expect(T2AnswerOutput.safeParse({ mode: 'ANSWER', format: 'timeline', status: 'answered', events: [{ date: '24/04/2026', text: 'Achat', sourceIds: [] }] }).success).toBe(false);
    expect(T2AnswerOutput.safeParse({ mode: 'ANSWER', format: 'comparison', status: 'answered', criterion: 'km', items: [{ targetId: 'asset:1', label: 'Clio', value: null, sourceIds: [] }] }).success).toBe(true);
    expect(T2UnderstandOutput.safeParse({ mode: 'UNDERSTAND', intent: 'INVENTEE', confidence: 'exact' }).success).toBe(false);
    expect(T2RevalidateOutput.safeParse({ mode: 'REVALIDATE', status: 'confirmed', evidence: { provenance: 'VISUAL_ANALYSIS', visualEvidence: { description: 'chaudière murale' } } }).success).toBe(true);
  });

  it('passerelle : une sortie d’une autre branche est rejetée (validation discriminée par `mode`)', async () => {
    master();
    repond({ mode: 'UNDERSTAND', intent: 'ACCOUNT_TIMELINE', confidence: 'exact' });
    const r = await generateAssistantAnswerDetailed(routeForIntent('ACCOUNT_TIMELINE', 'PREMIUM', 'test'), sources, input({ aiBudget: createAiCallBudget(1) }));
    expect('failed' in r).toBe(true);
  });
});

describe('T2-36 — règle de longueur unique par intention', () => {
  it('registre : défaut 4 phrases, listes bornées en caractères', () => {
    expect(answerFormatFor('ACCOUNT_FACT_ASSET')).toMatchObject({ format: 'claims', maxSentences: 4, maxChars: 1200 });
    expect(answerFormatFor('ACCOUNT_TIMELINE')).toMatchObject({ format: 'timeline', maxSentences: null });
    expect(answerFormatFor('ACCOUNT_COMPARISON')).toMatchObject({ format: 'comparison', maxSentences: null });
    expect(lengthRuleText('ACCOUNT_SUMMARY')).toBe('Tu réponds en 4 phrases maximum.');
  });

  it('plus aucune consigne concaténée par intention (lot 16b-2) : règle du registre seule', () => {
    for (const f of ['intent-tasks', 'account-timeline', 'account-lists-v31', 'account-summary', 'account-comparison', 'product-help', 'rights-layer']) {
      expect(existsSync(join(process.cwd(), `src/services/verebona-assistant/prompts/${f}.ts`)), f).toBe(false);
    }
    expect(lengthRuleText('ACCOUNT_TIMELINE')).not.toMatch(/4 phrases/);
  });

  it('le validateur applique le registre', () => {
    const cinq = 'Un. Deux. Trois. Quatre. Cinq.';
    const claims = [{ claimKey: 'c1', text: 'Cinq.', sourceIds: ['a'], derivation: 'direct' as const }];
    expect(validateGeneratedAnswer({ answer: cinq, claims, supportLevel: 'supported' }, 'ACCOUNT_FACT_ASSET')).toBeNull();
    expect(validateGeneratedAnswer({ answer: cinq, claims, supportLevel: 'supported' }, 'ACCOUNT_TIMELINE')?.answer).toBe(cinq);
  });
});

describe('branche ANSWER (master) dans generation.adapter', () => {
  it('chronologie : events[] structurés, une ligne par événement, INTENT = code seul', async () => {
    master();
    repond({
      mode: 'ANSWER', format: 'timeline', status: 'answered',
      events: [
        { date: '2026-04-24', text: 'Achat de la draisienne', sourceIds: ['agenda_321', 'doc_88'] },
        { date: '2026-09-12', text: 'Révision effectuée', sourceIds: ['doc_90'] },
      ],
    });
    const r = await generateAssistantAnswerDetailed(routeForIntent('ACCOUNT_TIMELINE', 'PREMIUM', 'test'), sources, input());
    if ('failed' in r) throw new Error(r.reason);
    expect(r.architecture).toBe('master');
    expect(r.events).toEqual([
      { date: '2026-04-24', text: 'Achat de la draisienne', sourceIds: ['agenda_321', 'doc_88'] },
      { date: '2026-09-12', text: 'Révision effectuée', sourceIds: ['doc_90'] },
    ]);
    expect(r.answer).toBe('24/04/2026 — Achat de la draisienne\n12/09/2026 — Révision effectuée');
    expect(r.supportLevel).toBe('supported');
    const prompt = fakeProvider.calls[0].prompt;
    expect(prompt).toContain('MODE = ANSWER');
    expect(prompt).toMatch(/Intention : ACCOUNT_TIMELINE\n/);
    expect(prompt).not.toContain('Consigne propre à cette intention');
    expect(fakeProvider.calls[0].maxOutputTokens).toBeLessThanOrEqual(500);
    // Sources structurées, dans l'ordre fourni (B10).
    expect(prompt.indexOf('"sourceId": "agenda_321"')).toBeLessThan(prompt.indexOf('"sourceId": "doc_90"'));
  });

  it('T2-31 : un événement dont la date n’est pas dans la source citée est retiré, tracé, étayage partiel', async () => {
    master();
    repond({
      mode: 'ANSWER', format: 'timeline', status: 'answered',
      events: [
        { date: '2026-04-24', text: 'Achat de la draisienne', sourceIds: ['doc_88'] },
        { date: '2025-01-03', text: 'Révision effectuée', sourceIds: ['doc_90'] },
      ],
    });
    const i = input();
    const r = await generateAssistantAnswerDetailed(routeForIntent('ACCOUNT_TIMELINE', 'PREMIUM', 'test'), sources, i);
    if ('failed' in r) throw new Error(r.reason);
    expect(r.events?.map((e) => e.date)).toEqual(['2026-04-24']);
    expect(r.supportLevel).toBe('partial');
    expect(r.generationEvents?.some((e) => e.startsWith('CLAIM_UNSUPPORTED:DATA_NOT_IN_SOURCES'))).toBe(true);
  });

  it('comparaison : une valeur absente reste « absente », jamais zéro', async () => {
    master();
    const cmp: Source[] = [
      { id: 'asset_field:1:mileage', type: 'asset_field', title: 'Clio — Kilométrage', content: '48 250 km', meta: { assetId: 1, value: 48250, display: '48 250 km' } },
      { id: 'asset_2', type: 'asset_field', title: 'Zoé', content: 'Véhicule électrique' },
    ];
    repond({
      mode: 'ANSWER', format: 'comparison', status: 'answered', criterion: 'kilométrage',
      items: [
        { targetId: 'asset:1', label: 'Clio', value: '48 250 km', sourceIds: ['asset_field:1:mileage'] },
        { targetId: 'asset:2', label: 'Zoé', value: null, sourceIds: ['asset_2'] },
      ],
    });
    const r = await generateAssistantAnswerDetailed(routeForIntent('ACCOUNT_COMPARISON', 'PREMIUM', 'test'), cmp, input({ message: 'Compare le kilométrage' }));
    if ('failed' in r) throw new Error(r.reason);
    // (le filtre de sortie §18.7 normalise l'espace avant « : »)
    expect(r.answer.split('\n').map((l) => l.replace(/ :/g, ':'))).toEqual(['Critère comparé: kilométrage', '• Clio: 48 250 km', '• Zoé: valeur absente des données']);
    expect(r.events).toBeUndefined();
  });

  it('claims : réparation (≤ 2 appels, CA-07) sans concaténation à INTENT', async () => {
    master();
    repond('{"mode":"ANSWER","format":"claims"}', {
      mode: 'ANSWER', format: 'claims', status: 'answered',
      claims: [{ text: 'La facture du 24/04/2026 s’élève à 129,90 €.', sourceIds: ['doc_88'], factual: true }],
    });
    const i = input({ message: 'Combien a coûté la draisienne ?' });
    const r = await generateAssistantAnswerDetailed(routeForIntent('ACCOUNT_FACT_DOCUMENT', 'PREMIUM', 'test'), sources, i);
    if ('failed' in r) throw new Error(r.reason);
    expect(r.path).toBe('repair');
    expect(fakeProvider.calls).toHaveLength(2);
    expect(fakeProvider.calls[1].prompt).toMatch(/Intention : ACCOUNT_FACT_DOCUMENT\n/);
    expect(fakeProvider.calls[1].prompt).toContain('CORRECTION DEMANDÉE');
    expect(i.aiBudget!.canCall()).toBe(false);
  });
});

describe('master T2 seul (lot 16b-2)', () => {
  it('sans version de configuration : la branche ANSWER du master est appelée (plus d’architecture « steps »)', async () => {
    repond({ mode: 'ANSWER', format: 'claims', status: 'answered', claims: [{ text: 'La facture du 24/04/2026 s’élève à 129,90 €.', sourceIds: ['doc_88'], factual: true }] });
    const r = await generateAssistantAnswerDetailed(routeForIntent('ACCOUNT_FACT_DOCUMENT', 'PREMIUM', 'test'), sources, input({ message: 'Combien a coûté la draisienne ?' }));
    if ('failed' in r) throw new Error(r.reason);
    expect(r.architecture).toBe('master');
    expect(fakeProvider.calls[0].prompt).toContain('MODE = ANSWER');
  });

  it('T2-31 : la phrase non soutenue (150 €) est rejetée et tracée, sans commutateur', async () => {
    repond({
      mode: 'ANSWER', format: 'claims', status: 'answered',
      claims: [
        { text: 'La facture s’élève à 129,90 €.', sourceIds: ['doc_88'], factual: true },
        { text: 'Elle a été réglée 150 €.', sourceIds: ['doc_88'], factual: true },
      ],
    });
    const r = await generateAssistantAnswerDetailed(routeForIntent('ACCOUNT_FACT_DOCUMENT', 'PREMIUM', 'test'), sources, input({ message: 'Combien a coûté la draisienne ?' }));
    if ('failed' in r) throw new Error(r.reason);
    expect(r.claims.map((c) => c.text)).toEqual(['La facture s’élève à 129,90 €.']);
    expect(r.supportLevel).toBe('partial');
    expect(r.generationEvents?.some((e) => e.startsWith('CLAIM_UNSUPPORTED:DATA_NOT_IN_SOURCES'))).toBe(true);
  });
});

describe('branche UNDERSTAND (fournie à la classification, Y)', () => {
  it('contrôles serveur : faits hors FIELD_CATALOG renvoyés en sujets, indices « page: » écartés', () => {
    const r = toT2Understanding({
      mode: 'UNDERSTAND', intent: 'ACCOUNT_FACT_ASSET', confidence: 'exact',
      entityHints: [{ type: 'asset', value: 'ma Clio' }, { type: 'room', value: 'cuisine' }, { type: 'asset', value: 'page:42' }],
      requestedFacts: ['mileage', 'couleurInventee'], requestedTopics: [], filters: {}, reason: 'kilométrage',
    });
    expect(r.requestedFacts).toEqual(['mileage']);
    expect(r.requestedTopics).toEqual(['couleurInventee']);
    expect(r.plan.entityHints).toEqual([{ type: 'asset', value: 'ma Clio' }, { type: 'asset', value: 'cuisine' }]);
    expect(toIntentRoute(r.plan, 'PREMIUM')).toMatchObject({ intent: 'ACCOUNT_FACT_ASSET', accountScope: 'server-enforced' });
  });

  it('appel t2_understand : MODE=UNDERSTAND, catalogue des champs, question masquée', async () => {
    master();
    repond({ mode: 'UNDERSTAND', intent: 'ACCOUNT_FACT_ASSET', confidence: 'probable', entityHints: [], requestedFacts: ['mileage'], requestedTopics: [], filters: {}, reason: 'x' });
    const r = await understandWithT2Master('Quel est le kilométrage de ma Clio ?', input());
    expect(r?.plan.intent).toBe('ACCOUNT_FACT_ASSET');
    expect(r?.requestedFacts).toEqual(['mileage']);
    const prompt = fakeProvider.calls[0].prompt;
    expect(prompt).toContain('MODE = UNDERSTAND');
    expect(prompt).toMatch(/- mileage : /);
  });

  it('sortie ANSWER à une demande UNDERSTAND : rejet, null (repli déterministe)', async () => {
    repond({ mode: 'ANSWER', format: 'claims', status: 'answered', claims: [] });
    expect(await understandWithT2Master('Bonjour ?', input({ aiBudget: createAiCallBudget(1) }))).toBeNull();
  });
});

describe('t2AnswerLines (pur)', () => {
  it('date inconnue dite, jamais devinée', () => {
    const l = t2AnswerLines({ mode: 'ANSWER', format: 'timeline', status: 'answered', events: [{ date: null, text: 'Réparation', sourceIds: ['a'] }] });
    expect(l.lines[0].text).toBe('Date inconnue — Réparation');
    expect(l.separator).toBe('\n');
  });
});
