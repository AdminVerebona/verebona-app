/**
 * Architecture branchée ou nettoyée — audit assistant « dérive d'architecture »,
 * CDC §15.11–15.14, §17.1, §17.6, §17.11, §18.4, §21.2, §21.7, §28.8, §30.3.
 *
 * Ce qui était présent mais jamais appelé est soit BRANCHÉ (trace des appels,
 * validateur, contrôle de démarrage), soit SUPPRIMÉ (lot 16b-2 : prompts par
 * intention concaténés et registre des prompts historiques aussi)
 * (disjoncteur en mémoire, constructeur de prompt, registre de modèles,
 * providers, bus d'événements, composer par outils).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync } from 'fs';
import { join } from 'path';

const h = vi.hoisted(() => ({
  sql: [] as Array<{ q: string; p: unknown[] }>,
  execute: vi.fn(),
}));

vi.mock('@/db', () => ({
  pgClient: {
    unsafe: vi.fn(async (q: string, p: unknown[] = []) => {
      h.sql.push({ q, p });
      if (/SUM\(estimated_cost_micros\)/.test(q)) return [{ total: (globalThis as { __cout?: number }).__cout ?? 0 }];
      return [];
    }),
  },
  db: {},
  ensureMigrations: vi.fn(async () => {}),
  ensureUnaccent: vi.fn(async () => {}),
}));
vi.mock('@/services/ai/gateway/ai-gateway', () => ({ AiGateway: { execute: h.execute } }));

const { assertConfigAtStartup, loadAssistantConfig } = await import('../../config/assistant-config');
const { assertAssistantStartup } = await import('../../index');
const { AI_OPERATIONS } = await import('@/services/ai/registry/operations');
const { createAiCallBudget, executeWithinBudget } = await import('../ai-call-budget');
const { validateGeneratedAnswer, looksFrench, countSentences } = await import('../response-validator.service');
const { evaluateBudget, checkMonthlyBudget, setBudgetAlertWriterForTests } = await import('../budget.service');

const ROOT = join(process.cwd(), 'src/services');

beforeEach(() => {
  h.sql.length = 0;
  h.execute.mockReset();
});

describe('code mort supprimé (il laissait croire à des garanties absentes)', () => {
  it.each([
    'verebona-assistant/core/gemini-router.service.ts',
    'verebona-assistant/core/prompt-builder.service.ts',
    // `registries/model-registry.ts` et `events/business-events.ts` sont
    // revenus BRANCHÉS (alias configurés §15.11, événements §25.7) : couverts
    // par `registre-modeles-alertes.test.ts` et `evenements-metier.test.ts`.
    'verebona-assistant/registries/pricing-catalog.ts',
    'verebona-assistant/providers/index.ts',
    'verebona-assistant/cache/invalidation.ts',
    'verebona-assistant/prompts/system.ts',
    'ai/assistant/answer-composer.service.ts',
    'ai/assistant/tool-planner.service.ts',
    // Lot 16b-2 : consignes par intention concaténées et registre des
    // prompts historiques — le master T2 est le seul prompt de l'assistant.
    'verebona-assistant/prompts/intent-tasks.ts',
    'verebona-assistant/prompts/rights-layer.ts',
    'verebona-assistant/registries/prompt-registry.ts',
    'verebona-assistant/canonical/mode.ts',
  ])('%s n’existe plus', (f) => {
    expect(existsSync(join(ROOT, f))).toBe(false);
  });
});

describe('contrôle de démarrage (§15.14) sur les modèles RÉELLEMENT appelés', () => {
  const cfg = loadAssistantConfig();
  const ops = (over: Record<string, { primaryModel: string; fallbackModels: string[] }> = {}) => ({
    t2_understand: { primaryModel: 'gemini-3.5-flash-lite', fallbackModels: ['gemini-3.1-flash-lite'] },
    t2_revalidate: { primaryModel: 'gemini-3.5-flash-lite', fallbackModels: ['gemini-3.1-flash-lite'] },
    t2_answer: { primaryModel: 'gemini-3.5-flash-lite', fallbackModels: ['gemini-3.1-flash-lite'] },
    ...over,
  });

  it('la configuration livrée passe', () => {
    expect(() => assertAssistantStartup()).not.toThrow();
    expect(AI_OPERATIONS.t2_answer).toBeTruthy();
    expect(AI_OPERATIONS.generate_answer).toBeUndefined();
  });
  it('refuse un alias « latest »', () => {
    expect(() => assertConfigAtStartup(cfg, ops({ t2_answer: { primaryModel: 'gemini-flash-latest', fallbackModels: [] } }))).toThrow(/latest/);
  });
  it('refuse un modèle Pro dans le chemin utilisateur', () => {
    expect(() => assertConfigAtStartup(cfg, ops({ t2_answer: { primaryModel: 'gemini-2.5-pro', fallbackModels: [] } }))).toThrow(/Pro/);
  });
  it('refuse une escalade identique au modèle par défaut', () => {
    expect(() => assertConfigAtStartup(cfg, ops({ t2_understand: { primaryModel: 'm', fallbackModels: ['m'] } }))).toThrow(/escalade/);
  });
  it('refuse une opération absente, plus de 2 appels, la recherche web', () => {
    expect(() => assertConfigAtStartup(cfg, {})).toThrow(/absente/);
    expect(() => assertConfigAtStartup({ ...cfg, maxAiCallsPerRequest: 3 }, ops())).toThrow(/> 2/);
    expect(() => assertConfigAtStartup({ ...cfg, webGroundingEnabled: true }, ops())).toThrow(/web/);
  });
});

describe('trace des appels modèle dans verebona_ai_runs (§28.8)', () => {
  const REQ = { useCaseCode: 'INTELLIGENT_ASSISTANT' as const, operationCode: 't2_answer', accountId: 7, userId: 3, promptVariables: { QUESTION: 'x' }, outputSchema: {} as never };
  const TRACE = { requestId: 'req-1', routeReason: 'test', promptId: 't2_master', promptVersion: 't2_master_v1' };

  it('succès : une ligne avec alias, modèle réel, prompt, catalogues, empreinte — pas le texte', async () => {
    h.execute.mockResolvedValue({ data: {}, model: 'gemini-3.5-flash-lite', usedFallback: false, inputTokens: 100, outputTokens: 20, costMicros: 42, durationMs: 300, fromCache: false, promptVersion: 'v3', provider: 'g', traceId: 't' });
    await executeWithinBudget(createAiCallBudget(2), REQ, TRACE);
    await new Promise((r) => setTimeout(r, 0));
    const ins = h.sql.find((x) => /INSERT INTO verebona_ai_runs/.test(x.q));
    expect(ins).toBeTruthy();
    const p = ins!.p;
    expect(p[0]).toBe('req-1');
    expect(p[3]).toBe('assistant-default:t2_answer');
    expect(p[4]).toBe('gemini-3.5-flash-lite');
    expect(p[6]).toBe('t2_master');
    expect(p[7]).toBe('t2_master_v1');
    expect(String(p[8])).toMatch(/^[0-9a-f]{64}$/);
    expect(p).toContain('intent-catalog-v1.0');
    expect(p).toContain('action-catalog-v1.2');
    expect(p[14]).toBe(42);
    expect(JSON.stringify(p)).not.toContain('"QUESTION"');
  });

  it('repli : alias d’escalade ; échec : statut error et code', async () => {
    h.execute.mockResolvedValueOnce({ data: {}, model: 'gemini-3.1-flash-lite', usedFallback: true, inputTokens: 1, outputTokens: 1, costMicros: 1, durationMs: 1, fromCache: false, promptVersion: 'v', provider: 'g', traceId: 't' });
    await executeWithinBudget(createAiCallBudget(2), REQ, TRACE);
    h.execute.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'ALL_MODELS_FAILED' }));
    await expect(executeWithinBudget(createAiCallBudget(2), REQ, TRACE)).rejects.toBeTruthy();
    await new Promise((r) => setTimeout(r, 0));
    const lignes = h.sql.filter((x) => /INSERT INTO verebona_ai_runs/.test(x.q)).map((x) => x.p);
    expect(lignes[0][3]).toBe('assistant-escalation:t2_answer');
    expect(lignes[1][18]).toBe('error');
  });

  it('repli désactivé (VEREBONA_ASSISTANT_AI_FALLBACK_ENABLED=false) : une seule tentative', async () => {
    vi.stubEnv('VEREBONA_ASSISTANT_AI_FALLBACK_ENABLED', 'false');
    const { resetAssistantConfigForTests } = await import('../../config/assistant-config');
    resetAssistantConfigForTests();
    h.execute.mockResolvedValue({ data: {}, model: 'm', usedFallback: false, inputTokens: 0, outputTokens: 0, costMicros: 0, durationMs: 0, fromCache: false, promptVersion: 'v', provider: 'g', traceId: 't' });
    await executeWithinBudget(createAiCallBudget(2), REQ);
    expect(h.execute.mock.calls[0][0].maxModelAttempts).toBe(1);
    vi.unstubAllEnvs();
    resetAssistantConfigForTests();
  });
});

describe('validateur de réponse (§18.4, §21.2, §21.7)', () => {
  const claims = (textes: string[]) => textes.map((t, i) => ({ claimKey: `c${i}`, text: t, sourceIds: ['doc_1'], derivation: 'direct' as const }));

  it('langue : une réponse en anglais est écartée (repli)', () => {
    expect(looksFrench('The warranty of your bike is valid for two years from the date of purchase.')).toBe(false);
    expect(looksFrench('La garantie de votre vélo court deux ans à partir de la date d’achat.')).toBe(true);
    const en = 'The warranty of your bike is valid for two years from the date of purchase.';
    expect(validateGeneratedAnswer({ answer: en, claims: claims([en]), supportLevel: 'supported' }, 'ACCOUNT_SUMMARY')).toBeNull();
  });

  it('longueur : coupe à 4 phrases, les citations coupées sortent, étayage « partial »', () => {
    const t = ['Phrase un.', 'Phrase deux.', 'Phrase trois.', 'Phrase quatre.', 'Phrase cinq.'];
    const v = validateGeneratedAnswer({ answer: t.join(' '), claims: claims(t), supportLevel: 'supported' }, 'ACCOUNT_SUMMARY')!;
    expect(countSentences(v.answer)).toBe(4);
    expect(v.claims).toHaveLength(4);
    expect(v.supportLevel).toBe('partial');
    expect(v.violations).toContain('TOO_MANY_SENTENCES');
  });

  it('chronologie et comparaison (listes) ne sont pas coupées à 4 phrases', () => {
    const t = ['Le 01/01/2020 achat.', 'Le 02/02/2021 entretien.', 'Le 03/03/2022 réparation.', 'Le 04/04/2023 contrôle.', 'Le 05/05/2024 vente.'];
    const v = validateGeneratedAnswer({ answer: t.join(' '), claims: claims(t), supportLevel: 'supported' }, 'ACCOUNT_TIMELINE')!;
    expect(v.claims).toHaveLength(5);
  });

  it('les étapes numérotées ne comptent pas dans la limite', () => {
    expect(countSentences('Voici la procédure.\n1. Ouvrez Documents.\n2. Cliquez sur Ajouter.\n3. Choisissez le fichier.')).toBe(1);
  });
});

describe('plafond budgétaire mensuel (§6.6, §31.3)', () => {
  it('évaluation : plafond 0 = illimité ; alerte à 80 % ; blocage au plafond', () => {
    expect(evaluateBudget(10_000_000, 0, 0.8).allowed).toBe(true);
    expect(evaluateBudget(1_500_000, 2_000_000, 0.8)).toMatchObject({ allowed: true, alert: false });
    expect(evaluateBudget(1_700_000, 2_000_000, 0.8)).toMatchObject({ allowed: true, alert: true });
    expect(evaluateBudget(2_000_000, 2_000_000, 0.8)).toMatchObject({ allowed: false, alert: true });
  });

  it('lit la somme du mois du compte dans verebona_ai_runs ; plafond atteint → alerte ai_alerts', async () => {
    (globalThis as { __cout?: number }).__cout = 2_500_000;
    const raise = vi.fn(async () => true);
    setBudgetAlertWriterForTests(raise);
    const s = await checkMonthlyBudget(7);
    expect(s.allowed).toBe(false);
    expect(raise).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'budget', code: 'assistant_monthly_budget_reached', accountId: 7, severity: 'critical',
    }));
    const q = h.sql.find((x) => /SUM\(estimated_cost_micros\)/.test(x.q))!;
    expect(q.p[0]).toBe(7);
    (globalThis as { __cout?: number }).__cout = 0;
    setBudgetAlertWriterForTests(null);
  });
});
