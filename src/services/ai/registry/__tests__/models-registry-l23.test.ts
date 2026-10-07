/**
 * Lot 23 — registre déclaratif des modèles (CDC Assistant §15.12, §15.14) :
 * statut déclaré (inconnu = preview), rollback, prompts compatibles, contrôle
 * de cohérence au démarrage et à l'activation, vue par alias.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) }, db: {}, ensureMigrations: vi.fn(async () => {}) }));

const M = await import('../models');
const { AI_OPERATIONS, listMasterPrompts } = await import('../operations');
const { GEMINI_PUBLIC_CATALOG } = await import('../../gateway/pricing/gemini-public-catalog');
const registre = await import('@/services/verebona-assistant/registries/model-registry');
const { checkModelRegistry, resetModelStartupForTests } = await import('@/services/verebona-assistant/core/model-startup-check');
const { assertModelRegistryCoherence } = await import('../../config/config-version.service');

beforeEach(() => {
  delete process.env.VEREBONA_ASSISTANT_ALLOW_PREVIEW_MODELS;
  resetModelStartupForTests();
});

describe('§15.12 — registre déclaratif cohérent', () => {
  it('tout modèle du référentiel des opérations et du catalogue tarifaire est déclaré', () => {
    const utilises = new Set(Object.values(AI_OPERATIONS).filter((o) => o.provider === 'gemini')
      .flatMap((o) => [o.primaryModel, ...o.fallbackModels]));
    for (const m of [...utilises, ...GEMINI_PUBLIC_CATALOG.map((e) => e.model)]) {
      expect(M.findDeclaredModel(m), m).toBeDefined();
    }
  });

  it('chaque rollback existe, est stable et diffère du modèle', () => {
    for (const m of M.DECLARED_MODELS) {
      expect(m.rollbackModel, m.model).toBeTruthy();
      expect(m.rollbackModel).not.toBe(m.model);
      expect(M.findDeclaredModel(m.rollbackModel)?.status, `${m.model} → ${m.rollbackModel}`).toBe('stable');
    }
    expect(M.checkModelUses(M.DECLARED_MODELS.map((m) => ({ where: 'x', model: m.model }))).filter((i) => i.level === 'error')).toEqual([]);
  });

  it('prompts compatibles : masters existants ; PRO-03 — compatibilité déclarée modèle par modèle, jamais déduite du nom', () => {
    const masters = new Set(listMasterPrompts().map((p) => p.masterPromptCode));
    for (const m of M.DECLARED_MODELS) {
      for (const p of m.compatiblePrompts) expect(masters.has(p), `${m.model} : ${p}`).toBe(true);
    }
    // Lot 32B : un modèle Pro PEUT déclarer t2_master_v1 (aucune exclusion
    // par catégorie) — gemini-2.5-pro le déclare, et reste exclu parce que
    // déprécié (usable-models).
    expect(M.findDeclaredModel('gemini-2.5-pro')?.compatiblePrompts).toContain('t2_master_v1');
    expect(M.findDeclaredModel('gemini-3.1-pro-preview')?.compatiblePrompts).toContain('t2_master_v1');
  });

  it('dates au format AAAA-MM-JJ ; les modèles du catalogue retirés sont dépréciés avec leur date', () => {
    // gemini-2.5-pro : plus de date d'arrêt annoncée, accès limité aux comptes existants.
    expect(M.findDeclaredModel('gemini-2.5-pro')).toMatchObject({ status: 'deprecated', retiresOn: null });
    expect(M.findDeclaredModel('gemini-2.5-pro')?.note).toMatch(/comptes existants/);
    for (const m of M.DECLARED_MODELS) {
      for (const d of [m.activatedOn, m.retiresOn]) if (d) expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    for (const e of GEMINI_PUBLIC_CATALOG.filter((x) => x.retiresOn)) {
      expect(M.findDeclaredModel(e.model)).toMatchObject({ status: 'deprecated', retiresOn: e.retiresOn });
    }
  });

  it('statut preview DÉCLARÉ, repli prudent : inconnu = preview', () => {
    expect(M.isPreviewModel('gemini-3-flash-preview')).toBe(true);
    expect(M.isPreviewModel('gemini-3.5-flash-lite')).toBe(false);
    expect(M.isPreviewModel('gemini-2.5-pro')).toBe(false); // déprécié, pas preview
    expect(M.isPreviewModel('gemini-7-flash')).toBe(true); // inconnu, nom anodin
    expect(M.isPreviewModel(null)).toBe(false);
    expect(registre.isPreviewModel('gemini-7-flash')).toBe(true);
    expect(M.declaredModelStatus('gemini-7-flash')).toBe('unknown');
  });

  it('contrôle de cohérence : prompt incompatible bloquant, déprécié et inconnu signalés', () => {
    const issues = M.checkModelUses([
      { where: 'T6', model: 'gemini-2.5-pro', promptCode: 't6_master_v1' },
      { where: 'T1', model: 'gemini-2.5-pro', promptCode: 't1_master_v1' },
      { where: 'T4', model: 'gemini-9-flash', promptCode: 't4_master_v1' },
    ], '2026-10-05');
    expect(issues.map((i) => `${i.level}:${i.code}:${i.where}`)).toEqual([
      'error:PROMPT_INCOMPATIBLE:T6', 'warning:MODEL_DEPRECATED:T6', 'warning:MODEL_DEPRECATED:T1', 'warning:UNKNOWN_MODEL:T4',
    ]);
    expect(M.coherenceMessage(issues)).toMatch(/gemini-2\.5-pro.*t6_master_v1/);
    expect(issues[1].message).toMatch(/déprécié — remplacement à tester/);
    expect(M.checkModelUses([{ where: 'T1', model: 'gemini-2.5-flash-lite' }], '2026-10-05')[0].message).toMatch(/fin prévue le 2026-10-16/);
  });
});

describe('§15.14 — contrôle de démarrage avec le registre déclaratif', () => {
  const ops = (primary: string, fallback: string[], master = 't2_master_v1') => Object.fromEntries(
    ['t2_understand', 't2_revalidate', 't2_answer'].map((c) => [c, {
      operationCode: c, useCaseCode: 'INTELLIGENT_ASSISTANT', label: '', provider: 'gemini', primaryModel: primary,
      fallbackModels: fallback, timeoutMs: 1, outputSchema: 'X', masterPromptCode: master, promptCode: master,
    }]),
  ) as never;
  const deps = (primary: string, fallback: string[], previewAllowed = false) => ({
    operations: ops(primary, fallback),
    resolve: async () => ({ primaryModel: primary, fallbackModels: fallback }),
    hasPrice: () => true, pricingBlocking: () => true, previewAllowed: () => previewAllowed,
  });

  it('configuration conforme', async () => {
    expect((await checkModelRegistry(deps('gemini-3.5-flash-lite', ['gemini-3.1-flash-lite']))).errors).toEqual([]);
  });

  it('modèle absent du registre : message clair, admis si le flag ou le réglage BO l’autorise', async () => {
    const r = await checkModelRegistry(deps('gemini-7-flash', ['gemini-3.1-flash-lite']));
    expect(r.errors.join()).toMatch(/gemini-7-flash absent du registre des modèles, traité comme preview/);
    expect((await checkModelRegistry(deps('gemini-7-flash', ['gemini-3.1-flash-lite'], true))).ok).toBe(true);
  });

  it('PRO-04 — startup : un modèle Pro n’est plus refusé par catégorie (gemini-2.5-pro : signalé déprécié)', async () => {
    const r = await checkModelRegistry(deps('gemini-3.5-flash-lite', ['gemini-2.5-pro']));
    expect(r.errors.join()).not.toMatch(/Pro/);
    expect(r.errors.join()).not.toMatch(/pas déclaré compatible/);
    expect(r.warnings.join()).toMatch(/gemini-2\.5-pro.*déprécié/);
    // Un Pro preview compatible T2, preview autorisé : accepté au démarrage.
    expect((await checkModelRegistry(deps('gemini-3.5-flash-lite', ['gemini-3.1-pro-preview'], true))).ok).toBe(true);
  });
});

describe('§15.14 — cohérence à l’activation d’une version', () => {
  const version = (entries: Array<[string, string | null, string | null]>) => ({
    entries: entries.map(([treatment, primaryModel, fallback1]) => ({ treatment, primaryModel, fallback1, fallback2: null })),
  }) as never;

  it('PRO-05 — registre : gemini-2.5-pro sur T2 n’est plus incohérent pour son nom (déprécié signalé ; refus porté par usableModelsForTreatment)', async () => {
    const w = await assertModelRegistryCoherence(version([['T2', 'gemini-3.5-flash-lite', 'gemini-2.5-pro']]));
    expect(w.map((i) => i.code)).toEqual(['MODEL_DEPRECATED']);
  });

  it('T2 : même règle preview qu’au démarrage — inconnu ou preview refusé sans autorisation (pas de 503 après activation)', async () => {
    await expect(assertModelRegistryCoherence(version([['T2', 'gemini-7-flash', 'gemini-3.1-flash-lite']]), { previewAllowed: () => false }))
      .rejects.toMatchObject({ code: 'MODEL_REGISTRY_INCOHERENT', message: expect.stringMatching(/T2 : le modèle « gemini-7-flash » est absent du registre/) });
    await expect(assertModelRegistryCoherence(version([['T2', 'gemini-3.5-flash-lite', 'gemini-3-flash-preview']]), { previewAllowed: () => false }))
      .rejects.toMatchObject({ details: [expect.objectContaining({ code: 'PREVIEW_NOT_ALLOWED', model: 'gemini-3-flash-preview' })] });
    // Autorisé (flag ou réglage BO accordé) : accepté, comme au démarrage.
    await expect(assertModelRegistryCoherence(version([['T2', 'gemini-7-flash', 'gemini-3.1-flash-lite']]), { previewAllowed: () => true })).resolves.toBeDefined();
    // Défaut : flag d'environnement, sinon réglage BO (absent en test) → refus.
    await expect(assertModelRegistryCoherence(version([['T2', 'gemini-7-flash', 'gemini-3.1-flash-lite']]))).rejects.toMatchObject({ code: 'MODEL_REGISTRY_INCOHERENT' });
    process.env.VEREBONA_ASSISTANT_ALLOW_PREVIEW_MODELS = 'true';
    await expect(assertModelRegistryCoherence(version([['T2', 'gemini-7-flash', 'gemini-3.1-flash-lite']]))).resolves.toBeDefined();
    // Startup check sur la même version : verdict identique.
    const r = await checkModelRegistry({
      operations: Object.fromEntries(['t2_understand', 't2_revalidate', 't2_answer'].map((c) => [c, { ...AI_OPERATIONS[c] }])) as never,
      resolve: async () => ({ primaryModel: 'gemini-7-flash', fallbackModels: ['gemini-3.1-flash-lite'] }),
      hasPrice: () => true, pricingBlocking: () => false,
    });
    expect(r.ok).toBe(true);
  });

  it('admet la configuration du code ; rend les avertissements (déprécié, inconnu)', async () => {
    const w = await assertModelRegistryCoherence(version([
      ['T1', 'gemini-3.1-flash-lite', 'gemini-2.5-pro'], ['T2', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'],
      ['T5', 'gemini-2.5-pro', 'gemini-3.1-flash-lite'], ['T4', 'gemini-7-flash', null],
    ]));
    expect(w.map((i) => i.code).sort()).toEqual(['MODEL_DEPRECATED', 'MODEL_DEPRECATED', 'UNKNOWN_MODEL']);
  });
});

describe('§15.12 — vue par alias', () => {
  it('porte alias, fournisseur, modèle, statut, dates, capacités, prix, limites, prompts et schémas, rollback', () => {
    const rows = registre.modelRegistryRows(
      { operationCode: 't2_answer', default: 'gemini-3.5-flash-lite', escalation: 'gemini-7-flash' },
      {
        price: (_p, m) => (m === 'gemini-3.5-flash-lite' ? { inputMicros: 0.3, outputMicros: 2.5, sourceReference: 'public-catalog' } : null),
        providerCatalog: new Map([['gemini-7-flash', { inputTokenLimit: 2_000_000, outputTokenLimit: 8192, deprecationDate: '2027-01-01' }]]),
        limits: { maxInputTokens: 12000, maxOutputTokens: 500, timeoutMs: 12000, maxCallsPerMessage: 2 },
      },
    );
    expect(rows[0]).toMatchObject({
      alias: 'assistant-default', provider: 'gemini', model: 'gemini-3.5-flash-lite', status: 'stable', activatedOn: '2026-09-18',
      price: { inputPerMillion: 0.3, outputPerMillion: 2.5 }, rollbackModel: 'gemini-3.1-flash-lite',
      limits: { maxInputTokens: 12000, maxOutputTokens: 500, timeoutMs: 12000, maxCallsPerMessage: 2 },
    });
    expect(rows[0].compatiblePrompts).toContain('t2_master_v1');
    expect(rows[0].compatibleSchemas).toEqual(expect.arrayContaining(['T2AnswerOutput', 'T2UnderstandOutput']));
    expect(rows[1]).toMatchObject({
      alias: 'assistant-escalation', status: 'unknown', price: null, rollbackModel: null,
      contextWindowTokens: 2_000_000, maxOutputTokens: 8192, retiresOn: '2027-01-01',
    });
  });
});

describe('§15.13 — veille de dépréciation étendue aux modèles actifs du registre (T1-T6)', () => {
  it('date de fin déclarée au registre retenue pour un modèle actif hors alias T2', async () => {
    const { measureAssistantAlertMetrics, evaluateAssistantAlertRules } = await import('@/services/verebona-assistant/observability/assistant-alerts');
    const m = await measureAssistantAlertMetrics({
      query: async () => [],
      resolveActiveModels: async () => [{ model: 'gemini-2.5-flash-lite', alias: 'T1, T4' }, { model: 'gemini-2.5-pro', alias: 'T5' }],
    });
    expect(m.deprecations).toEqual([{ model: 'gemini-2.5-flash-lite', alias: 'T1, T4', date: '2026-10-16' }]);
    const v = evaluateAssistantAlertRules(m, new Date('2026-10-05T10:00:00Z'));
    expect(v.find((x) => x.code === 'model_deprecation')?.message).toMatch(/^IA : le modèle gemini-2\.5-flash-lite \(T1, T4\)/);
  });
});
