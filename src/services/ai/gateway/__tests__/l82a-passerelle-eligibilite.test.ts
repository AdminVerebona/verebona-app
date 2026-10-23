/**
 * Lot 82A (décision PO C-Q10, §3.3) — passerelle IA, point de passage obligé
 * de TOUT appel modèle (T1, T2, T3, T4, T6) : aucun appel pour un compte non
 * actif, suspendu ou en lecture seule, avant tout contact fournisseur.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { __setProcessingEligibilityForTests, invalidateProcessingEligibility } from '@/services/account/processing-eligibility';

describe('L82A-G01 — passerelle : refus ACCOUNT_INELIGIBLE', () => {
  let fake: import('../providers').FakeProvider;
  beforeEach(async () => {
    const { FakeProvider, setAiProvider } = await import('../providers');
    fake = new FakeProvider();
    setAiProvider(fake);
    fake.onAny(() => ({ rawText: '{"title":"x"}', inputTokens: 1, outputTokens: 1 }));
    invalidateProcessingEligibility();
  });
  afterEach(() => {
    __setProcessingEligibilityForTests(async () => ({ eligible: true, reason: null }));
    invalidateProcessingEligibility();
  });

  const appel = async (accountId: number) => {
    const { AiGateway } = await import('../ai-gateway');
    const { T1_TEST_OPERATION, t1TestVariables, t1Schema } = await import('./t1-master-request');
    return AiGateway.execute({
      useCaseCode: 'SOURCE_ANALYSIS', operationCode: T1_TEST_OPERATION, accountId,
      promptVariables: t1TestVariables('facture'), outputSchema: t1Schema({ title: z.string() }),
      idempotencyKey: `l82a-${Math.random()}`,
    });
  };

  it('compte suspendu : refus non récupérable, motif porté, AUCUN appel fournisseur', async () => {
    __setProcessingEligibilityForTests(async () => ({ eligible: false, reason: 'ACCOUNT_SUSPENDED' }));
    await expect(appel(7)).rejects.toMatchObject({ code: 'ACCOUNT_INELIGIBLE', recoverable: false, reason: 'ACCOUNT_SUSPENDED' });
    expect(fake.calls).toHaveLength(0);
  });

  it('appel sans compte (sonde, système : compte 0) : non concerné', async () => {
    __setProcessingEligibilityForTests(async () => ({ eligible: false, reason: 'ACCOUNT_SUSPENDED' }));
    await expect(appel(0)).resolves.toBeDefined();
  });

  it('compte éligible : appel normal (aucune régression)', async () => {
    await expect(appel(7)).resolves.toBeDefined();
    expect(fake.calls.length).toBeGreaterThan(0);
  });
});
