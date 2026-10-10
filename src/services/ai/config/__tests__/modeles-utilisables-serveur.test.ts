/**
 * Lot 32B — validation serveur des modèles (ticket « modèles réellement
 * utilisables par traitement », §5) : enregistrement d'un brouillon, mise à
 * l'essai, activation. Une requête API manuelle ne contourne pas le filtrage
 * du BO. Contexte d'éligibilité injecté (aucune base, aucun fournisseur).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { emptyTreatmentConfig, type TreatmentConfig } from '../config-types';
import type { UsableModelsContext } from '../../registry/usable-models';
import { TREATMENTS, type Treatment } from '../treatments';

const repo = {
  getVersion: vi.fn(),
  getActiveVersion: vi.fn(async () => null),
  listVersions: vi.fn(async () => [] as unknown[]),
  promoteToTest: vi.fn(async () => 'TO_TEST'),
  switchActive: vi.fn(async () => ({ previousId: null })),
  markStaleDrafts: vi.fn(async () => 0),
  saveEntry: vi.fn(async () => undefined),
};
vi.mock('../config-version.repository', () => repo);
vi.mock('../config-resolver', () => ({ invalidateConfigCache: () => {} }));
vi.mock('../../telemetry/execution-context', () => ({ invalidateConfigVersionCache: () => {} }));
vi.mock('../../queue/job-queue.repository', () => ({ requeueRunning: async () => 0 }));
vi.mock('../config-cache-version', () => ({ bumpConfigVersionCounter: async () => true }));
vi.mock('@/services/verebona-assistant/core/model-startup-check', () => ({
  runAssistantStartupCheck: async () => ({ ok: true }),
}));

let disponible = new Set(['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-2.5-pro']);
const contexte = (): UsableModelsContext => ({
  environment: 'preprod',
  catalog: { refreshedAt: '2026-10-07T08:00:00Z', models: [...disponible].map((model) => ({ model, available: true, supportsGeneration: true })) },
  codeCatalog: [],
  price: () => ({ verified: true }),
  operational: new Map(),
  today: '2026-10-07',
});
vi.mock('../../registry/usable-models', async (orig) => ({
  ...(await orig<typeof import('../../registry/usable-models')>()),
  loadUsableModelsContext: async () => contexte(),
}));

const svc = await import('../config-version.service');

const entree = (t: Treatment, over: Partial<TreatmentConfig> = {}): TreatmentConfig => ({
  ...emptyTreatmentConfig(t),
  primaryModel: t === 'T2' || t === 'T6' ? 'gemini-3.5-flash-lite' : 'gemini-3.1-flash-lite',
  reasoningPrimary: 'standard', maxOutputTokens: 400,
  triggers: t === 'T1' ? [{ kind: 'event', code: 'source_uploaded', active: true }]
    : t === 'T3' ? [{ kind: 'event', code: 'asset_updated', active: true }]
      : t === 'T4' ? [{ kind: 'event', code: 'source_analyzed', active: true }] : [],
  ...over,
});
const brouillon = (over: Partial<Record<Treatment, Partial<TreatmentConfig>>> = {}) => ({
  id: 7, status: 'DRAFT', environment: 'local', isStale: false, label: 'b', activatedAt: null,
  entries: TREATMENTS.map((t) => entree(t, over[t] ?? {})),
});

beforeEach(() => {
  for (const f of Object.values(repo)) f.mockClear();
  disponible = new Set(['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-2.5-pro']);
  repo.getActiveVersion.mockResolvedValue({ id: 1, entries: TREATMENTS.map((t) => entree(t, { maxOutputTokens: 300 })) } as never);
});

describe('§5 — enregistrement d’un brouillon (contournement de l’interface)', () => {
  it('MOD-24 — modèle non utilisable nouvellement choisi via l’API : rejet serveur, rien n’est écrit', async () => {
    repo.getVersion.mockResolvedValue(brouillon());
    await expect(svc.saveTreatmentConfig(7, entree('T2', { fallback1: 'gemini-2.5-pro' }), 1))
      .rejects.toMatchObject({ code: 'MODEL_NOT_USABLE', message: expect.stringMatching(/gemini-2\.5-pro.*T2 : déprécié/) });
    await expect(svc.saveTreatmentConfig(7, entree('T3', { fallback2: 'gemini-9-inconnu' }), 1))
      .rejects.toMatchObject({ code: 'MODEL_NOT_USABLE', message: expect.stringMatching(/absent du catalogue du fournisseur/) });
    // Doublon nouvellement introduit : refusé aussi.
    await expect(svc.saveTreatmentConfig(7, entree('T1', { fallback1: 'gemini-3.1-flash-lite' }), 1))
      .rejects.toMatchObject({ code: 'MODEL_NOT_USABLE', message: expect.stringMatching(/déjà choisi à un autre rang/) });
    expect(repo.saveEntry).not.toHaveBeenCalled();
  });

  it('MOD-25 — valeur héritée devenue inutilisable : l’enregistrement d’autres champs reste possible (signalée, bloque la promotion)', async () => {
    repo.getVersion.mockResolvedValue(brouillon({ T5: { primaryModel: 'gemini-2.5-pro' } }));
    await svc.saveTreatmentConfig(7, entree('T5', { primaryModel: 'gemini-2.5-pro', maxOutputTokens: 900 }), 1);
    expect(repo.saveEntry).toHaveBeenCalledTimes(1);
    // Remplacement par un modèle utilisable (PO 26 : principal / replis T5 au BO).
    await svc.saveTreatmentConfig(7, entree('T5', { primaryModel: 'gemini-3.6-flash', fallback1: 'gemini-3.1-flash-lite', fallback2: 'gemini-3.5-flash', reasoningFallback1: 'standard', reasoningFallback2: 'standard' }), 1);
    expect(repo.saveEntry).toHaveBeenCalledTimes(2);
  });
});

describe('§5 — mise à l’essai, activation', () => {
  it('MOD-26 — brouillon référençant un modèle non utilisable : promotion refusée, motif par traitement et champ', async () => {
    repo.getVersion.mockResolvedValue(brouillon({ T5: { primaryModel: 'gemini-2.5-pro' } }));
    const r = await svc.promote(7);
    expect(r.promoted).toBe(false);
    expect(r.validation.issues.filter((i) => i.blocking).map((i) => `${i.treatment}:${i.field}`)).toEqual(['T5:primaryModel']);
    expect(repo.promoteToTest).not.toHaveBeenCalled();
  });

  it('MOD-27 — modèle retiré par le fournisseur entre l’édition et la promotion : promotion refusée ; avant : acceptée', async () => {
    repo.getVersion.mockResolvedValue(brouillon({ T4: { fallback1: 'gemini-3.5-flash', reasoningFallback1: 'standard' } }));
    expect((await svc.promote(7)).promoted).toBe(true);
    repo.promoteToTest.mockClear();
    disponible.delete('gemini-3.5-flash');
    const r = await svc.promote(7);
    expect(r.promoted).toBe(false);
    expect(r.validation.issues.find((i) => i.blocking)?.message).toMatch(/gemini-3\.5-flash.*absent du catalogue du fournisseur/);
    expect(repo.promoteToTest).not.toHaveBeenCalled();
  });

  it('MOD-28 — activation : modèle devenu non utilisable → refus MODEL_NOT_USABLE, aucune bascule ; rollback jamais bloqué', async () => {
    repo.getVersion.mockResolvedValue({ ...brouillon({ T1: { fallback2: 'gemini-3.5-flash' } }), status: 'VALIDATED' });
    disponible.delete('gemini-3.5-flash');
    await expect(svc.activate(7, 1)).rejects.toMatchObject({ code: 'MODEL_NOT_USABLE', details: [expect.objectContaining({ treatment: 'T1', field: 'fallback2' })] });
    expect(repo.switchActive).not.toHaveBeenCalled();
    repo.getVersion.mockResolvedValue({ ...brouillon({ T1: { fallback2: 'gemini-3.5-flash' } }), status: 'VALIDATED', activatedAt: new Date() });
    await expect(svc.rollback(7, 1)).resolves.toMatchObject({ interrupts: true });
  });

  it('PRO-13 — un Pro accepté sur T2 ne change rien aux protections coût / latence du contrat T2', async () => {
    const { AI_OPERATIONS, ASSISTANT_MAX_OUTPUT_TOKENS } = await import('../../registry/operations');
    expect(ASSISTANT_MAX_OUTPUT_TOKENS).toBe(500);
    expect([AI_OPERATIONS.t2_understand.timeoutMs, AI_OPERATIONS.t2_answer.timeoutMs, AI_OPERATIONS.t2_revalidate.timeoutMs]).toEqual([12_000, 12_000, 20_000]);
    const { validateTreatment } = await import('../config-validation.service');
    const issues = validateTreatment(entree('T2', { primaryModel: 'gemini-9-pro', maxOutputTokens: 4000 }), {
      availableModels: new Set(['gemini-9-pro']), pricedModels: new Set(['gemini-9-pro']), guardrailCodes: new Set(), triggerCodes: new Set(),
    });
    // Plafond V1 toujours signalé (min(BO, 500) à l'exécution), aucun refus « Pro ».
    expect(issues.some((i) => i.field === 'maxOutputTokens' && /plafonné à 500/.test(i.message))).toBe(true);
    expect(issues.some((i) => /Pro/.test(i.message))).toBe(false);
    const { assertConfigAtStartup, getAssistantConfig } = await import('@/services/verebona-assistant/config/assistant-config');
    expect(() => assertConfigAtStartup({ ...getAssistantConfig(), maxAiCallsPerRequest: 3 }, {})).toThrow(/> 2/);
  });
});
