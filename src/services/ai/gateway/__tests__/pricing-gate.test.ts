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
 * jamais sur le référentiel complet. Lot 16b : plus aucun drapeau — tous les
 * usages tournent, leur périmètre est le référentiel entier.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { listLlmOperations } from '../../registry/operations';
import { AI_USE_CASE_CODES, type AiUseCaseCode } from '../../registry/use-cases';
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

const tous = (): CachedPrice[] => AI_USE_CASE_CODES.flatMap((u) => pricesFor(u));

beforeEach(() => {
  clearPricingCache();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  clearPricingCache();
});

describe('périmètre du contrôle tarifaire (lot 16b : tous les usages)', () => {
  it('tous les usages du référentiel sont actifs, sans drapeau', () => {
    primePricingCache([]);
    expect(getPricingReadiness().runningUseCases).toEqual([...AI_USE_CASE_CODES]);
  });

  it('laisse démarrer en production quand tous les tarifs sont connus', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    primePricingCache(tous());
    const state = getPricingReadiness();
    expect(state.missingForRunning).toEqual([]);
    expect(state.blocking).toBe(false);
    expect(listModelsWithoutPricing()).toEqual([]);
    await expect(assertPricingReady()).resolves.toBeUndefined();
  });

  it('bloque en production dès qu’un modèle d’un usage manque de tarif — y compris la réconciliation (T3)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    // Le modèle principal de T3 (partagé avec T1 et T4) sans tarif.
    const t3 = listLlmOperations().find((o) => o.operationCode === 't3_value_conflict')!.primaryModel;
    primePricingCache(tous().filter((p) => p.model !== t3));
    expect(getPricingReadiness().blocking).toBe(true);
    await expect(assertPricingReady()).rejects.toThrow(/sans tarif sur un usage actif/);
    // Un drapeau retiré encore posé ne retire rien du périmètre.
    process.env.AI_RECONCILIATION_ENGINE = 'legacy';
    expect(getPricingReadiness().blocking).toBe(true);
    delete process.env.AI_RECONCILIATION_ENGINE;
  });

  it('ne bloque jamais hors production', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    primePricingCache([]);
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
