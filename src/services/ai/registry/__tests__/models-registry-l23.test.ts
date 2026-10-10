/**
 * Lot 23 — registre déclaratif des modèles (CDC Assistant §15.12, §15.14) ;
 * lot 35B : registre d'EXCEPTIONS (plus d'allowlist, plus de « inconnu =
 * preview », plus de prompts compatibles déclarés à la main), contrôle de
 * cohérence au démarrage et à l'activation, vue par alias.
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

  it('exceptions documentées : masters existants, raison écrite ; PRO-03 — jamais déduites du nom (Pro non exclu de T2)', () => {
    const masters = new Set(listMasterPrompts().map((p) => p.masterPromptCode));
    for (const m of M.DECLARED_MODELS) {
      for (const p of m.excludedPrompts?.prompts ?? []) expect(masters.has(p), `${m.model} : ${p}`).toBe(true);
      if (m.excludedPrompts) expect(m.excludedPrompts.reason.length).toBeGreaterThan(10);
      expect((m as unknown as Record<string, unknown>).compatiblePrompts, m.model).toBeUndefined();
    }
    expect(M.documentedExclusion('gemini-2.5-pro', 't2_master_v1')).toBeNull();
    expect(M.documentedExclusion('gemini-3.1-pro-preview', 't6_master_v1')).toMatch(/mascotte/);
  });

  it('dates au format AAAA-MM-JJ ; les modèles du catalogue retirés sont dépréciés avec leur date', () => {
    // gemini-2.5-pro : plus de date d'arrêt annoncée, accès limité aux comptes existants.
    expect(M.findDeclaredModel('gemini-2.5-pro')).toMatchObject({ status: 'deprecated', retiresOn: null });
    expect(M.findDeclaredModel('gemini-2.5-pro')?.anomaly).toMatch(/comptes existants/);
    for (const m of M.DECLARED_MODELS) {
      for (const d of [m.activatedOn, m.retiresOn]) if (d) expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    for (const e of GEMINI_PUBLIC_CATALOG.filter((x) => x.retiresOn)) {
      expect(M.findDeclaredModel(e.model)).toMatchObject({ status: 'deprecated', retiresOn: e.retiresOn });
    }
  });

  it('lot 35B — statut preview informatif : déclaré, sinon statut fournisseur ; un modèle inconnu n’est PLUS « preview »', () => {
    expect(M.isPreviewModel('gemini-3-flash-preview')).toBe(true);
    expect(M.isPreviewModel('gemini-3.5-flash-lite')).toBe(false);
    expect(M.isPreviewModel('gemini-2.5-pro')).toBe(false); // déprécié, pas preview
    expect(M.isPreviewModel('gemini-7-flash')).toBe(false); // inconnu, nom anodin : stable
    expect(M.isPreviewModel('gemini-7-flash', 'preview')).toBe(true); // statut fournisseur
    expect(M.isPreviewModel(null)).toBe(false);
    expect(registre.isPreviewModel('gemini-7-flash')).toBe(false);
    expect(registre.isPreviewModel('gemini-7-flash-preview-0901')).toBe(true);
    expect(M.declaredModelStatus('gemini-7-flash')).toBe('unknown');
  });

  it('contrôle de cohérence : exclusion documentée bloquante, déprécié et anomalie signalés, modèle inconnu SANS incohérence', () => {
    const issues = M.checkModelUses([
      { where: 'T6', model: 'gemini-2.5-pro', promptCode: 't6_master_v1' },
      { where: 'T1', model: 'gemini-2.5-pro', promptCode: 't1_master_v1' },
      { where: 'T4', model: 'gemini-9-flash', promptCode: 't4_master_v1' },
    ], '2026-10-05');
    expect(issues.map((i) => `${i.level}:${i.code}:${i.where}`)).toEqual([
      'error:MODEL_EXCLUDED:T6', 'warning:MODEL_DEPRECATED:T6', 'warning:MODEL_ANOMALY:T6',
      'warning:MODEL_DEPRECATED:T1', 'warning:MODEL_ANOMALY:T1',
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
  const deps = (primary: string, fallback: string[], hasPrice = true) => ({
    operations: ops(primary, fallback),
    resolve: async () => ({ primaryModel: primary, fallbackModels: fallback }),
    hasPrice: () => hasPrice,
  });

  it('configuration conforme', async () => {
    expect((await checkModelRegistry(deps('gemini-3.5-flash-lite', ['gemini-3.1-flash-lite']))).errors).toEqual([]);
  });

  it('CAT-01 — modèle absent du registre (nouveau modèle Google) : admis au démarrage, sans flag ni commit', async () => {
    const r = await checkModelRegistry(deps('gemini-7-flash', ['gemini-3.1-flash-lite']));
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('CAT-16 — modèle actif sans tarif connu : signalé, JAMAIS bloquant (même en production)', async () => {
    const env = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV = 'production';
    try {
      const r = await checkModelRegistry(deps('gemini-7-flash', ['gemini-3.1-flash-lite'], false));
      expect(r.ok).toBe(true);
      expect(r.warnings.join()).toMatch(/aucun prix connu pour gemini\/gemini-7-flash — coûts non calculables/);
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = env;
    }
  });

  it('PRO-04 — startup : un modèle Pro n’est plus refusé par catégorie (gemini-2.5-pro : signalé déprécié)', async () => {
    const r = await checkModelRegistry(deps('gemini-3.5-flash-lite', ['gemini-2.5-pro']));
    expect(r.errors.join()).not.toMatch(/Pro/);
    expect(r.errors.join()).not.toMatch(/pas déclaré compatible/);
    expect(r.warnings.join()).toMatch(/gemini-2\.5-pro.*déprécié/);
    // Un Pro preview : accepté au démarrage, sans autorisation preview.
    expect((await checkModelRegistry(deps('gemini-3.5-flash-lite', ['gemini-3.1-pro-preview']))).ok).toBe(true);
  });
});

describe('§15.14 — cohérence à l’activation d’une version', () => {
  const version = (entries: Array<[string, string | null, string | null]>) => ({
    entries: entries.map(([treatment, primaryModel, fallback1]) => ({ treatment, primaryModel, fallback1, fallback2: null })),
  }) as never;

  it('PRO-05 — registre : gemini-2.5-pro sur T2 n’est plus incohérent pour son nom (déprécié signalé ; refus porté par usableModelsForTreatment)', async () => {
    const w = await assertModelRegistryCoherence(version([['T2', 'gemini-3.5-flash-lite', 'gemini-2.5-pro']]));
    expect(w.map((i) => i.code)).toEqual(['MODEL_DEPRECATED', 'MODEL_ANOMALY']);
  });

  it('CAT-05 — T2 : modèle inconnu du registre ou preview acceptés sans autorisation, même verdict qu’au démarrage', async () => {
    await expect(assertModelRegistryCoherence(version([['T2', 'gemini-7-flash', 'gemini-3.1-flash-lite']]))).resolves.toEqual([]);
    await expect(assertModelRegistryCoherence(version([['T2', 'gemini-3.5-flash-lite', 'gemini-3-flash-preview']]))).resolves.toEqual([]);
    const r = await checkModelRegistry({
      operations: Object.fromEntries(['t2_understand', 't2_revalidate', 't2_answer'].map((c) => [c, { ...AI_OPERATIONS[c] }])) as never,
      resolve: async () => ({ primaryModel: 'gemini-7-flash', fallbackModels: ['gemini-3-flash-preview'] }),
      hasPrice: () => true,
    });
    expect(r.ok).toBe(true);
  });

  it('admet la configuration du code ; rend les avertissements (déprécié, anomalie) — un modèle inconnu n’en produit plus', async () => {
    const w = await assertModelRegistryCoherence(version([
      ['T1', 'gemini-3.1-flash-lite', 'gemini-2.5-pro'], ['T2', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'],
      ['T5', 'gemini-2.5-pro', 'gemini-3.1-flash-lite'], ['T4', 'gemini-7-flash', null],
    ]));
    expect(w.map((i) => i.code).sort()).toEqual(['MODEL_ANOMALY', 'MODEL_ANOMALY', 'MODEL_DEPRECATED', 'MODEL_DEPRECATED']);
  });
});

describe('§15.12 — vue par alias', () => {
  it('porte alias, fournisseur, modèle, statut, dates, capacités, prix, limites, qualification et schémas, rollback', () => {
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
    expect(rows[0].qualification).toMatchObject({ source: 'historical', structured: true, multimodal: true });
    expect(rows[0].compatibleSchemas).toEqual(expect.arrayContaining(['T2AnswerOutput', 'T2UnderstandOutput']));
    // Lot 35B : modèle hors registre — statut fournisseur (règle isolée), qualification en attente.
    expect(rows[1]).toMatchObject({
      alias: 'assistant-escalation', status: 'stable', price: null, rollbackModel: null, qualification: null,
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
