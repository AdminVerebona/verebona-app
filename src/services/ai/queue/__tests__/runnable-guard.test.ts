/**
 * Garde d'exécution IA — OPS-011, OPS-008, WF-07, WF-08, MOD-012.
 *
 * La garde est en tête d'`AiGateway.execute` : un traitement coupé ou un arrêt
 * d'urgence refuse l'appel AVANT tout contact fournisseur, par une erreur non
 * récupérable `AI_BLOCKED`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import {
  assertTreatmentRunnable, blockReason, getRuntimeSnapshot, invalidateRuntimeGuardCache,
  setRuntimeSnapshotLoader, type RuntimeSnapshot,
} from '../runnable-guard';
import { AiGateway } from '../../gateway/ai-gateway';
import { FakeProvider, setAiProvider } from '../../gateway/providers';

const OUVERT: RuntimeSnapshot = { emergencyStop: false, states: {} };

afterEach(() => setRuntimeSnapshotLoader(null));

describe('blockReason', () => {
  it('laisse passer un traitement sans ligne (jamais configuré = activé)', () => {
    expect(blockReason(OUVERT, 'T3')).toBeNull();
  });
  it('bloque sur arrêt d’urgence, quel que soit l’état local', () => {
    expect(blockReason({ emergencyStop: true, states: { T2: 'ENABLED' } }, 'T2')).toMatch(/arrêt d'urgence/);
  });
  it('bloque un traitement désactivé ou suspendu, et lui seul (indépendance)', () => {
    const s: RuntimeSnapshot = { emergencyStop: false, states: { T3: 'DISABLED', T4: 'SUSPENDED' } };
    expect(blockReason(s, 'T3')).toMatch(/désactivé/);
    expect(blockReason(s, 'T4')).toMatch(/suspendu/);
    expect(blockReason(s, 'T1')).toBeNull();
  });
});

describe('assertTreatmentRunnable', () => {
  it('lève AI_BLOCKED non récupérable', async () => {
    setRuntimeSnapshotLoader(async () => ({ emergencyStop: true, states: {} }));
    await expect(assertTreatmentRunnable('T1', 'extract_source'))
      .rejects.toMatchObject({ code: 'AI_BLOCKED', recoverable: false, operationCode: 'extract_source' });
  });

  it('met l’état en cache (5 s) et le relit après invalidation', async () => {
    const loader = vi.fn(async () => OUVERT);
    setRuntimeSnapshotLoader(loader);
    await getRuntimeSnapshot();
    await getRuntimeSnapshot();
    expect(loader).toHaveBeenCalledTimes(1);
    invalidateRuntimeGuardCache();
    await getRuntimeSnapshot();
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('base illisible : conserve le dernier état connu (un arrêt lu reste appliqué)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let panne = false;
    setRuntimeSnapshotLoader(async () => {
      if (panne) throw new Error('connexion refusée');
      return { emergencyStop: true, states: {} };
    });
    await expect(assertTreatmentRunnable('T2')).rejects.toMatchObject({ code: 'AI_BLOCKED' });
    panne = true;
    invalidateRuntimeGuardCache();
    await expect(assertTreatmentRunnable('T2')).rejects.toMatchObject({ code: 'AI_BLOCKED' });
  });
});

describe('câblage dans la gateway', () => {
  let fake: FakeProvider;
  beforeEach(() => {
    fake = new FakeProvider();
    setAiProvider(fake);
    fake.onAny(() => ({ rawText: '{"title":"x","amountCents":1}', inputTokens: 1, outputTokens: 1 }));
  });

  const req = (useCaseCode: 'SOURCE_ANALYSIS' | 'INTELLIGENT_ASSISTANT', operationCode: string) => ({
    useCaseCode, operationCode, accountId: 1, promptVariables: {},
    outputSchema: z.object({ title: z.string(), amountCents: z.number() }),
    idempotencyKey: `g-${Math.random()}`,
  });

  it('arrêt d’urgence : aucun appel fournisseur, AI_BLOCKED', async () => {
    const spy = vi.spyOn(fake, 'call');
    setRuntimeSnapshotLoader(async () => ({ emergencyStop: true, states: {} }));
    await expect(AiGateway.execute(req('SOURCE_ANALYSIS', 'classify_document')))
      .rejects.toMatchObject({ code: 'AI_BLOCKED' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('T2 désactivé : l’assistant est refusé, T1 continue', async () => {
    setRuntimeSnapshotLoader(async () => ({ emergencyStop: false, states: { T2: 'DISABLED' } }));
    await expect(AiGateway.execute(req('INTELLIGENT_ASSISTANT', 'understand_request')))
      .rejects.toMatchObject({ code: 'AI_BLOCKED' });
    await expect(AiGateway.execute(req('SOURCE_ANALYSIS', 'classify_document')))
      .resolves.toMatchObject({ data: { title: 'x' } });
  });
});
