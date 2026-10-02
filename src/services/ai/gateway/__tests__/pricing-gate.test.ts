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

/**
 * Lot 16b : T5 (gouvernance) et T6 (mascotte) n'ont plus de drapeau — leur
 * nouveau moteur tourne toujours, leurs tarifs sont donc toujours exigés.
 */
const sansDrapeau = (): CachedPrice[] => [...pricesFor('AI_GOVERNANCE'), ...pricesFor('HOME_MASCOT')];

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
  it('ne bloque pas quand aucun usage à drapeau n\'est basculé, même en production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    primePricingCache(sansDrapeau()); // seuls les tarifs de T5/T6, toujours actifs

    await expect(assertPricingReady()).resolves.toBeUndefined();

    const state = getPricingReadiness();
    expect(state.runningUseCases).toEqual(['AI_GOVERNANCE', 'HOME_MASCOT']);
    expect(state.blocking).toBe(false);
  });

  it('ignore les usages non basculés dans le périmètre restreint', () => {
    primePricingCache(sansDrapeau());
    expect(listModelsWithoutPricing({ runningOnly: true })).toEqual([]);
    // Sans aucun tarif, le référentiel complet est signalé incomplet.
    clearPricingCache();
    primePricingCache([]);
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

  it('lot 16b : T5 et T6, sans drapeau, sont toujours dans le périmètre', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    primePricingCache([]);
    expect(getPricingReadiness().runningUseCases).toEqual(['AI_GOVERNANCE', 'HOME_MASCOT']);
    await expect(assertPricingReady()).rejects.toThrow(/sans tarif sur un usage actif/);
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
    primePricingCache([...pricesFor('SOURCE_ANALYSIS'), ...sansDrapeau()]);

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
