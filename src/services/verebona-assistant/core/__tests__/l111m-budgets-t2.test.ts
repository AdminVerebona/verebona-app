/**
 * Lot 111M (ticket « budgets IA », P1 T2) — chemin RÉEL de la passerelle,
 * fournisseur simulé.
 *
 *  L111M-T2-01  valeur BO > 500 transmise (plus de plafond caché), bornée par la
 *               limite DÉCLARÉE du modèle sollicité (trace « adapté »)
 *  L111M-T2-02  modèle de repli aux capacités différentes : plafond adapté au repli
 *  L111M-T2-03  budget d'entrée sur le prompt ACTIF (plus de réserve forfaitaire)
 *  L111M-T2-04  preuve en FIN d'extrait long (> 1 500 caractères) transmise
 *  L111M-T2-05  « information insuffisante » sur contexte réduit : jamais une absence
 *  L111M-T2-06  réponse longue (synthèse) : jamais coupée, repère tracé
 *  L111M-T2-07  métadonnées de génération (plafond transmis, motif d'arrêt) rendues
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
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
const { createAiCallBudget, executeWithinBudget } = await import('../ai-call-budget');
const { routeForIntent } = await import('../intent-router.service');
const { fitToInputBudget } = await import('../context-budget');
const { resolveBudget, __resetBudgetSnapshotsForTests } = await import('@/services/ai/gateway/budget-resolution');
const { getOperation } = await import('@/services/ai/registry/operations');
const { t2MasterVariables } = await import('@/services/ai/assistant/master/t2-answer');
const { asTestContract } = await import('@/services/ai/gateway/output-resolution/runtime-contract');
const { z } = await import('zod');
type Source = import('../../types/sources').RetrievedSource;
type Input = import('../../types/contracts').AssistantRequestInput;

const version = (p: Record<string, unknown>) => __setConfigForTests({ versionId: 111, entries: [{ ...emptyTreatmentConfig('T2'), promptArchitecture: 'master', ...p }] });
afterEach(() => { __setConfigForTests(null); __resetBudgetSnapshotsForTests(); });

const input = (over: Partial<Input> = {}): Input => ({
  accountId: 7, userId: 3, planType: 'PREMIUM', message: 'Quelle est la date de fin de garantie de ma chaudière ?', clientRequestId: `c-${Math.random()}`,
  locale: 'fr-FR', aiBudget: createAiCallBudget(2), aiReport: { securityEvents: [], events: [] }, ...over,
});
const repond = (s: unknown) => fakeProvider.onAny(() => ({ rawText: JSON.stringify(s), inputTokens: 900, outputTokens: 120 }));

describe('L111M-T2-01/02 — plafond de sortie : BO réel, limite du modèle, repli', () => {
  const req = () => ({
    useCaseCode: 'INTELLIGENT_ASSISTANT' as const, operationCode: 't2_answer', accountId: 1,
    promptVariables: t2MasterVariables('ANSWER', { QUESTION: 'q', INTENT: 'ACCOUNT_FACT_ASSET' }),
    outputSchema: asTestContract(z.object({ mode: z.literal('ANSWER') }).passthrough()), idempotencyKey: `k-${Math.random()}`,
  });
  const OK = '{"mode":"ANSWER","format":"claims","status":"answered","claims":[]}';

  it('BO 4 000 : 4 000 transmis (ancien plafond caché : 500)', async () => {
    version({ primaryModel: 'm-a', maxOutputTokens: 4000 });
    fakeProvider.on('m-a', () => ({ rawText: OK, inputTokens: 1, outputTokens: 1 }));
    const r = await executeWithinBudget(undefined, req());
    expect(fakeProvider.calls[0].maxOutputTokens).toBe(4000);
    expect(r.generation).toMatchObject({ maxOutputTokensSent: 4000, maxOutputTokensOrigin: 'treatment' });
  });

  it('BO au-delà de la limite DÉCLARÉE du modèle : adapté à cette limite et tracé (jamais silencieux)', () => {
    const b = resolveBudget({
      operationCode: 't2_answer', op: getOperation('t2_answer'),
      config: { primaryModel: 'gemini-2.5-flash', fallbackModels: ['gemini-2.5-flash-lite'], maxOutputTokens: 200_000, configVersionId: 9 },
    });
    expect(b.output).toMatchObject({ configured: 200_000, modelLimit: 65_536, sent: 65_536, reasoningIncludedInCap: true });
    expect(b.restrictions.map((x) => x.origin)).toEqual(expect.arrayContaining(['bo_treatment', 'model_output_limit', 'model_input_limit']));
    expect(b.input.available).toBeGreaterThan(0);
  });

  it('repli aux capacités différentes : son propre plafond (profil par rang), adapté à SA limite', () => {
    const cfg = {
      primaryModel: 'gemini-2.5-flash', fallbackModels: ['m-inconnu'], maxOutputTokens: 3000, configVersionId: 9,
      operationProfile: { maxOutputTokensByRank: [null, 1200] },
    };
    const principal = resolveBudget({ operationCode: 't2_answer', op: getOperation('t2_answer'), config: cfg, rank: 0 });
    const repli = resolveBudget({ operationCode: 't2_answer', op: getOperation('t2_answer'), config: cfg, rank: 1 });
    expect(principal.output).toMatchObject({ sent: 3000, configuredOrigin: 'treatment' });
    expect(repli.output).toMatchObject({ sent: 1200, configuredOrigin: 'operation_rank', modelLimit: null });
    expect(repli.input.available).toBeNull();
  });
});

describe('L111M-T2-03/04 — budget d’entrée sur le contexte réellement transmis', () => {
  it('enveloppe = prompt maître ACTIF (origine tracée), repli forfaitaire seulement sans texte', () => {
    const src: Source[] = [{ id: 'd1', type: 'document', title: 'T', content: 'x'.repeat(100) }];
    const actif = fitToInputBudget({ sources: src, conversation: '', fixed: 'q', maxInputTokens: 12_000, maxExcerptChars: 4000, promptOverheadTokens: 2_345 });
    expect(actif.events).toContain('CONTEXT:PROMPT_TOKENS:2345:active_prompt');
    const repli = fitToInputBudget({ sources: src, conversation: '', fixed: 'q', maxInputTokens: 12_000, maxExcerptChars: 4000 });
    expect(repli.events).toContain('CONTEXT:PROMPT_TOKENS:3000:fallback');
    expect(actif.reduced).toBe(false);
  });

  it('chemin réel : prompt actif mesuré, plafond d’entrée et origine tracés ; clause en fin d’extrait de 2 500 caractères transmise', async () => {
    version({});
    const clause = 'La garantie prend fin le 31/12/2031.';
    const long = `${'Conditions générales sans rapport avec la question posée. '.repeat(42)}${clause}`;
    expect(long.length).toBeGreaterThan(2_400);
    repond({ mode: 'ANSWER', format: 'claims', status: 'answered', claims: [{ text: clause, sourceIds: ['doc_1'] }] });
    const r = await generateAssistantAnswerDetailed(routeForIntent('ACCOUNT_FACT_ASSET', 'PREMIUM', 'test'),
      [{ id: 'doc_1', type: 'document', title: 'Contrat chaudière', content: long }], input());
    expect(fakeProvider.calls[0].prompt).toContain(clause);
    const ev = 'failed' in r ? r.generationEvents ?? [] : r.generationEvents ?? [];
    expect(ev.some((e) => /^CONTEXT:PROMPT_TOKENS:\d+:active_prompt$/.test(e))).toBe(true);
    expect(ev.some((e) => /^CONTEXT:INPUT_CAP:12000:operation_default$/.test(e))).toBe(true);
  });
});

describe('L111M-T2-05 — jamais d’absence conclue sur une recherche incomplète', () => {
  it('contexte réduit (sources retirées) + « information insuffisante » : repli déterministe, motif tracé', async () => {
    version({});
    const gros: Source[] = Array.from({ length: 8 }, (_, i) => ({ id: `doc_${i}`, type: 'document' as const, title: `Doc ${i}`, content: 'y'.repeat(4000), relevanceScore: 1 - i / 10 }));
    process.env.VEREBONA_ASSISTANT_MAX_INPUT_TOKENS = '6000';
    const { resetAssistantConfigForTests } = await import('../../config/assistant-config');
    resetAssistantConfigForTests();
    try {
      repond({ mode: 'ANSWER', format: 'claims', status: 'insufficient_data', claims: [{ text: 'Je ne trouve pas cette information dans vos documents.', sourceIds: [], factual: false }] });
      const r = await generateAssistantAnswerDetailed(routeForIntent('ACCOUNT_FACT_ASSET', 'PREMIUM', 'test'), gros, input());
      expect('failed' in r && r.reason).toBe('INCOMPLETE_CONTEXT');
      expect(r.generationEvents).toEqual(expect.arrayContaining(['CONTEXT:INCOMPLETE_SEARCH_NO_ABSENCE', 'CONTEXT:INPUT_CAP:6000:explicit_override']));
      expect(r.generationEvents?.some((e) => e.startsWith('CONTEXT:SOURCES_DROPPED:'))).toBe(true);
    } finally {
      delete process.env.VEREBONA_ASSISTANT_MAX_INPUT_TOKENS;
      resetAssistantConfigForTests();
    }
  });

  it('contexte complet + « information insuffisante » : absence légitime (réponse conservée)', async () => {
    version({});
    repond({ mode: 'ANSWER', format: 'claims', status: 'insufficient_data', claims: [{ text: 'Je ne trouve pas cette information dans vos documents.', sourceIds: [], factual: false }] });
    const r = await generateAssistantAnswerDetailed(routeForIntent('ACCOUNT_FACT_ASSET', 'PREMIUM', 'test'),
      [{ id: 'doc_1', type: 'document', title: 'Facture', content: 'Facture du 02/03/2026, 120 €.' }], input());
    expect('failed' in r).toBe(false);
    if (!('failed' in r)) expect(r.supportLevel).toBe('insufficient');
  });
});

describe('L111M-T2-06 — synthèse longue jamais coupée', () => {
  it('six affirmations étayées : toutes rendues, étayage intact', async () => {
    version({});
    const srcs: Source[] = Array.from({ length: 6 }, (_, i) => ({ id: `doc_${i}`, type: 'document' as const, title: `Doc ${i}`, content: `Entretien numéro ${i + 1} effectué pour 1${i}0 euros.` }));
    repond({ mode: 'ANSWER', format: 'claims', status: 'answered', claims: srcs.map((s, i) => ({ text: `Entretien numéro ${i + 1} effectué pour 1${i}0 euros.`, sourceIds: [s.id] })) });
    const r = await generateAssistantAnswerDetailed(routeForIntent('ACCOUNT_FACT_ASSET', 'PREMIUM', 'test'), srcs, input());
    if ('failed' in r) throw new Error(r.reason);
    expect(r.claims).toHaveLength(6);
    expect(r.supportLevel).toBe('supported');
    expect(r.generationEvents).toContain('ANSWER:SENTENCES_ABOVE_GUIDANCE');
  });
});
