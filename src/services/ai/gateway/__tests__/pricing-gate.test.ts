/**
 * CDC Assistant §15.14 — contrôle de présence des prix au démarrage.
 *
 * Ces tests documentent la correction du défaut qui rendait le socle
 * indéployable : le contrôle bloquait la production alors que les cinq drapeaux
 * valaient `legacy`, c'est-à-dire alors qu'aucun appel modèle ne passait par la
 * nouvelle gateway. Il exigeait des tarifs pour des appels qui n'avaient pas
 * lieu.
 *
 * La règle testée ici : le blocage porte sur le périmètre RÉELLEMENT actif,
 * jamais sur le référentiel complet.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AI_FLAGS } from '../../flags/ai-feature-flags';
import { listLlmOperations } from '../../registry/operations';
import type { AiUseCaseCode } from '../../registry/use-cases';
import {
  assertPricingReady, getPricingReadiness, listModelsWithoutPricing,
} from '../cost-catalog';
import {
  primePricingCache, clearPricingCache, getCacheState, type CachedPrice,
} from '../pricing/pricing.repository';

/** Tarifs fictifs couvrant tous les modèles d'un usage donné. */
function pricesFor(useCaseCode: AiUseCaseCode): CachedPrice[] {
  const seen = new Map<string, CachedPrice>();
  for (const op of listLlmOperations()) {
    if (op.useCaseCode !== useCaseCode) continue;
    for (const model of [op.primaryModel, ...op.fallbackModels]) {
      seen.set(`${op.provider}:${model}`, {
        provider: op.provider, model, inputMicros: 0.1, outputMicros: 0.4,
        currency: 'USD', source: 'manual', verified: true, fetchedAt: new Date(),
      });
    }
  }
  return [...seen.values()];
}

beforeEach(() => {
  clearPricingCache();
  for (const f of AI_FLAGS) delete process.env[f];
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  clearPricingCache();
});

describe('périmètre du contrôle tarifaire', () => {
  it('ne bloque pas quand aucun usage n\'est basculé, même en production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    primePricingCache([]); // catalogue vide : aucun tarif connu

    await expect(assertPricingReady()).resolves.toBeUndefined();

    const state = getPricingReadiness();
    expect(state.runningUseCases).toEqual([]);
    expect(state.blocking).toBe(false);
    // Le référentiel reste incomplet — c'est signalé, pas bloquant.
    expect(state.missingOverall.length).toBeGreaterThan(0);
  });

  it('ignore les usages non basculés dans le périmètre restreint', () => {
    primePricingCache([]);
    expect(listModelsWithoutPricing({ runningOnly: true })).toEqual([]);
    expect(listModelsWithoutPricing()).not.toEqual([]);
  });

  it('bloque en production dès qu\'un usage basculé manque de tarif', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    process.env.AI_UNIFIED_SOURCE_ANALYSIS = 'enabled';
    primePricingCache([]);

    expect(getPricingReadiness().blocking).toBe(true);
    await expect(assertPricingReady()).rejects.toThrow(/sans tarif sur un usage actif/);
  });

  it('bloque aussi en mode observation — le shadow consomme des appels', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    process.env.AI_RECONCILIATION_ENGINE = 'shadow';
    primePricingCache([]);

    await expect(assertPricingReady()).rejects.toThrow(/DATA_RECONCILIATION/);
  });

  it('ne bloque jamais hors production', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    process.env.AI_UNIFIED_SOURCE_ANALYSIS = 'enabled';
    primePricingCache([]);

    await expect(assertPricingReady()).resolves.toBeUndefined();
  });

  it('laisse démarrer quand les tarifs de l\'usage basculé sont connus', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    process.env.AI_UNIFIED_SOURCE_ANALYSIS = 'enabled';
    primePricingCache(pricesFor('SOURCE_ANALYSIS'));

    const state = getPricingReadiness();
    expect(state.missingForRunning).toEqual([]);
    expect(state.blocking).toBe(false);
    await expect(assertPricingReady()).resolves.toBeUndefined();
  });
});

describe('état du cache', () => {
  it('un catalogue vide mais chargé est un état connu, pas une absence', () => {
    primePricingCache([]);
    const state = getCacheState();
    expect(state.size).toBe(0);
    expect(state.loadedAt).not.toBeNull();
    expect(state.degraded).toBe(false);
  });

  it('repart d\'un état neuf après remise à zéro', () => {
    primePricingCache(pricesFor('SOURCE_ANALYSIS'));
    expect(getCacheState().size).toBeGreaterThan(0);
    clearPricingCache();
    expect(getCacheState()).toMatchObject({ size: 0, loadedAt: null, degraded: false });
  });
});
