/**
 * Tests de la gateway — CDC §5.2, §5.3, §11.4.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { AiGateway } from '../ai-gateway';
import { AiGatewayError } from '../errors';
import { FakeProvider, setAiProvider } from '../providers';
import { primePricingCache, clearPricingCache } from '../pricing/pricing.repository';

const Schema = z.object({ title: z.string(), amountCents: z.number().int() });

let fake: FakeProvider;

beforeEach(() => {
  fake = new FakeProvider();
  setAiProvider(fake);
  clearPricingCache();
  primePricingCache([{
    provider: 'gemini', model: 'gemini-3.1-flash-lite',
    inputMicros: 0.05, outputMicros: 0.20, currency: 'USD',
    source: 'manual', verified: true, fetchedAt: new Date(),
  }, {
    provider: 'gemini', model: 'gemini-3.5-flash',
    inputMicros: 0.10, outputMicros: 0.40, currency: 'USD',
    source: 'manual', verified: true, fetchedAt: new Date(),
  }]);
});

function request(overrides: Record<string, unknown> = {}) {
  return {
    useCaseCode: 'SOURCE_ANALYSIS' as const,
    operationCode: 'classify_document',
    accountId: 1,
    promptVariables: { DOC: 'facture' },
    outputSchema: Schema,
    // Clé explicite : évite toute collision d'idempotence entre tests.
    idempotencyKey: `test-${Math.random()}`,
    ...overrides,
  };
}

describe('cohérence référentielle', () => {
  it('refuse un couple usage / opération incohérent (critère 5)', async () => {
    await expect(
      AiGateway.execute(request({ useCaseCode: 'AI_GOVERNANCE' })),
    ).rejects.toMatchObject({ code: 'USE_CASE_MISMATCH' });
  });

  it('refuse une opération déterministe', async () => {
    await expect(
      AiGateway.execute(request({ useCaseCode: 'DATA_RECONCILIATION', operationCode: 'compare_values' })),
    ).rejects.toBeInstanceOf(AiGatewayError);
  });
});

describe('validation des sorties (§5.3)', () => {
  it('accepte une sortie conforme, y compris encadrée de balises de code', async () => {
    fake.onAny(() => ({
      rawText: '```json\n{"title":"Facture EDF","amountCents":12900}\n```',
      inputTokens: 100, outputTokens: 20,
    }));

    const res = await AiGateway.execute(request());
    expect(res.data).toEqual({ title: 'Facture EDF', amountCents: 12900 });
    expect(res.costMicros).toBeGreaterThan(0);
    expect(res.usedFallback).toBe(false);
  });

  it('ne persiste jamais une sortie non conforme au schéma', async () => {
    fake.onAny(() => ({ rawText: '{"title":"Facture"}', inputTokens: 10, outputTokens: 5 }));
    await expect(AiGateway.execute(request())).rejects.toMatchObject({ code: 'ALL_MODELS_FAILED' });
  });
});

describe('repli et résilience (§11.4)', () => {
  it('bascule sur le modèle de repli après échec du modèle nominal', async () => {
    fake.on('gemini-3.1-flash-lite', () => { throw new Error('503 indisponible'); });
    fake.on('gemini-3.5-flash', () => ({
      rawText: '{"title":"OK","amountCents":100}', inputTokens: 50, outputTokens: 10,
    }));

    const res = await AiGateway.execute(request());
    expect(res.usedFallback).toBe(true);
    expect(res.model).toBe('gemini-3.5-flash');
  });

  it('remonte une erreur exploitable lorsque tous les modèles échouent', async () => {
    fake.onAny(() => { throw new Error('panne fournisseur'); });
    await expect(AiGateway.execute(request())).rejects.toMatchObject({
      code: 'ALL_MODELS_FAILED', recoverable: true,
    });
    // Le nominal et les deux replis ont bien été tentés.
    expect(fake.calls).toHaveLength(3);
  });
});

describe('mesure du coût', () => {
  it('calcule le coût lorsque le tarif est connu', async () => {
    fake.onAny(() => ({
      rawText: '{"title":"x","amountCents":1}', inputTokens: 1000, outputTokens: 100,
    }));
    const res = await AiGateway.execute(request());
    expect(res.costMicros).toBe(Math.round(1000 * 0.05 + 100 * 0.20));
  });

  it('RENVOIE LE RÉSULTAT même sans tarif connu — un défaut de mesure ne détruit pas une réponse', async () => {
    clearPricingCache();
    fake.onAny(() => ({
      rawText: '{"title":"Facture","amountCents":900}', inputTokens: 50, outputTokens: 10,
    }));
    const res = await AiGateway.execute(request());
    expect(res.data).toEqual({ title: 'Facture', amountCents: 900 });
    expect(res.costMicros).toBe(0);
  });
});

describe('masquage avant transmission (§5.2)', () => {
  it('ne transmet jamais un IBAN en clair au fournisseur', async () => {
    fake.onAny(() => ({ rawText: '{"title":"x","amountCents":1}', inputTokens: 1, outputTokens: 1 }));

    await AiGateway.execute(request({
      promptVariables: { DOC: 'Virement vers FR76 3000 4008 2800 0123 4567 890' },
    }));

    const sent = fake.calls[0].prompt;
    expect(sent).not.toMatch(/FR76 3000/);
  });
});
