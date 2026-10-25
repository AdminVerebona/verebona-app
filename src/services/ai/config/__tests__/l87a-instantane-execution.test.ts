/**
 * Lot 87A — CDC Pilotage IA V2, phase P7 : instantané de configuration figé
 * pour une EXÉCUTION (RUN-04, DEC-04, R16, R53, R54 ; limite signalée au lot
 * 86B : un job épinglé sur la révision active voyait une promotion prise en
 * cours d'exécution).
 *
 *   L87A-S01  exécution synchrone T2 à plusieurs appels : une activation /
 *             un import pendant la demande ne change pas ses appels suivants
 *             (R53) ; la demande suivante prend la nouvelle configuration
 *   L87A-S02  promotion (surcouche 86B) prise pendant une exécution
 *             synchrone : chaîne figée ; exécutions suivantes promues
 *   L87A-S03  travail de file épinglé face à une promotion prise en cours :
 *             chaîne figée (limite 86B corrigée) ; contexte épinglé sur une
 *             autre révision : sa révision, jamais l'instantané
 *   L87A-S04  passerelle réelle : deux appels d'une même exécution
 *             synchrone, configuration changée entre les deux → même modèle ;
 *             instantané tracé avec chaque appel
 *   L87A-S05  T2 réel (`runAssistant`) : figé au démarrage de la demande
 *   L87A-S06  T6 réel (`formulateWithT6`) : figé au démarrage de l'exécution
 *   L87A-S07  dans un travail de file, aucun instantané synchrone ne
 *             remplace celui du travail ; jamais bloquant
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';

vi.mock('@/db', () => ({
  pgClient: { unsafe: vi.fn(async () => []) },
  db: {},
  ensureMigrations: vi.fn(async () => {}),
  ensureUnaccent: vi.fn(async () => {}),
}));
const h = vi.hoisted(() => ({ traces: [] as Array<Record<string, unknown>> }));
vi.mock('../../gateway/diagnostics/diagnostic.repository', async (orig) => ({
  ...(await orig<typeof import('../../gateway/diagnostics/diagnostic.repository')>()),
  recordCallDiagnostic: vi.fn(async () => undefined),
}));
vi.mock('../../telemetry/ai-trace.service', async (orig) => {
  const actual = await orig<typeof import('../../telemetry/ai-trace.service')>();
  return {
    ...actual,
    // Même métadonnée que l'écriture réelle (instantané lu dans le contexte).
    recordCallTrace: vi.fn(async (t: Record<string, unknown>) => { h.traces.push({ ...t, snapshotMeta: actual.executionSnapshotMetadata() }); return h.traces.length; }),
  };
});

const R = await import('../config-resolver');
const S = await import('../execution-snapshot');
const { emptyTreatmentConfig } = await import('../config-types');
const { runInJobContext } = await import('../../queue/job-context');
const { AiGateway } = await import('../../gateway/ai-gateway');
const { FakeProvider, setAiProvider } = await import('../../gateway/providers');
const { T1_TEST_OPERATION, t1TestVariables, t1Out, t1Schema } = await import('../../gateway/__tests__/t1-master-request');

type Treatment = import('../treatments').Treatment;
type Overlay = import('../routing-overlay').RoutingOverlay;

function poser(models: Partial<Record<Treatment, string>>, p: { versionId?: number; overlay?: Overlay } = {}) {
  R.__setConfigForTests({
    versionId: p.versionId ?? 1,
    entries: (Object.entries(models) as Array<[Treatment, string]>).map(([t, m]) => ({ ...emptyTreatmentConfig(t), primaryModel: m, fallback1: `${m}-repli` })),
    ...(p.overlay ? { overlay: p.overlay } : {}),
  });
}
const promotion = (op: string, model: string): Overlay => ({ exclusions: [], promotions: new Map([[op, { model, promotionId: 9 }]]) });

beforeEach(() => { h.traces.length = 0; });
afterEach(() => { R.__setConfigForTests(null); });

describe('L87A-S01 — T2 synchrone multi-appels : configuration figée au démarrage (R53)', () => {
  it('activation / import pendant la demande : appels suivants inchangés ; demande suivante : nouvelle configuration', async () => {
    poser({ T2: 'ancien' }, { versionId: 1 });
    const vus: string[] = [];
    await S.runWithConfigSnapshot('T2', async () => {
      vus.push((await R.resolveOperationConfig('t2_understand')).primaryModel);
      poser({ T2: 'nouveau' }, { versionId: 2 }); // import / activation pendant la demande
      const answer = await R.resolveOperationConfig('t2_answer');
      vus.push(answer.primaryModel);
      expect(answer.configVersionId).toBe(1);
    });
    expect(vus).toEqual(['ancien', 'ancien']);
    expect((await R.resolveOperationConfig('t2_answer')).primaryModel).toBe('nouveau');
  });
});

describe('L87A-S02 — promotion prise pendant une exécution synchrone', () => {
  it('chaîne figée pendant l’exécution ; promotion appliquée aux exécutions suivantes', async () => {
    poser({ T2: 'm-a' });
    await S.runWithConfigSnapshot('T2', async () => {
      poser({ T2: 'm-a' }, { overlay: promotion('t2_answer', 'm-a-repli') });
      const c = await R.resolveOperationConfig('t2_answer');
      expect([c.primaryModel, ...c.fallbackModels]).toEqual(['m-a', 'm-a-repli']);
      expect(c.routing).toBeUndefined();
    });
    const apres = await R.resolveOperationConfig('t2_answer');
    expect([apres.primaryModel, ...apres.fallbackModels]).toEqual(['m-a-repli', 'm-a']);
    expect(apres.routing).toMatchObject({ promotedModel: 'm-a-repli', promotionId: 9 });
  });
});

describe('L87A-S03 — travail de file épinglé face à une promotion (limite 86B corrigée)', () => {
  it('révision active épinglée au prélèvement : une promotion prise en cours ne change pas sa chaîne', async () => {
    poser({ T3: 't3-a' });
    const snapshot = await R.captureExecutionSnapshot('job', 'T3');
    await runInJobContext({ jobId: 41, treatment: 'T3', configVersionId: 1, configSnapshot: snapshot }, async () => {
      poser({ T3: 't3-a' }, { overlay: promotion('t3_value_conflict', 't3-a-repli') });
      const c = await R.resolveOperationConfig('t3_value_conflict');
      expect(c.primaryModel).toBe('t3-a');
      expect(c.routing).toBeUndefined();
    });
    // Travail suivant (nouveau prélèvement) : promotion appliquée.
    const suivant = await R.captureExecutionSnapshot('job', 'T3');
    await runInJobContext({ jobId: 42, treatment: 'T3', configVersionId: 1, configSnapshot: suivant }, async () => {
      expect((await R.resolveOperationConfig('t3_value_conflict')).primaryModel).toBe('t3-a-repli');
    });
  });

  it('instantané d’une AUTRE version que celle épinglée par le contexte : ignoré (la révision épinglée fait foi)', async () => {
    poser({ T3: 't3-a' }, { versionId: 1 });
    const snapshot = await R.captureExecutionSnapshot('job', 'T3');
    R.__setConfigForTests({ versionId: 2, entries: [{ ...emptyTreatmentConfig('T3'), primaryModel: 'actif-v2' }] },
      [{ versionId: 5, entries: [{ ...emptyTreatmentConfig('T3'), primaryModel: 'epingle-v5' }] }]);
    await runInJobContext({ jobId: 43, treatment: 'T3', configVersionId: 5, configSnapshot: snapshot }, async () => {
      expect((await R.resolveOperationConfig('t3_value_conflict')).primaryModel).toBe('epingle-v5');
    });
  });
});

describe('L87A-S04 — passerelle réelle : deux appels d’une même exécution synchrone', () => {
  const Schema = t1Schema({ ok: z.boolean() });
  const req = () => ({
    useCaseCode: 'SOURCE_ANALYSIS' as const, operationCode: T1_TEST_OPERATION, accountId: 7, sourceIds: [42],
    promptVariables: t1TestVariables('facture'), outputSchema: Schema, idempotencyKey: `s04-${Math.random()}`,
  });

  it('configuration changée entre les deux appels : même modèle ; instantané tracé avec chaque appel', async () => {
    const fake = new FakeProvider();
    setAiProvider(fake);
    fake.onAny(() => ({ rawText: t1Out({ ok: true }), inputTokens: 1, outputTokens: 1 }));
    poser({ T1: 'figé' }, { versionId: 1 });
    await S.runWithConfigSnapshot('T1', async () => {
      await AiGateway.execute(req());
      poser({ T1: 'activé-pendant' }, { versionId: 2 });
      await AiGateway.execute(req());
    });
    expect(fake.calls.map((c) => c.model)).toEqual(['figé', 'figé']);
    expect(h.traces).toHaveLength(2);
    for (const t of h.traces) {
      expect(t.configVersionId).toBe(1);
      expect(t.snapshotMeta).toMatchObject({ configSnapshot: { scope: 'sync', versionId: 1 } });
    }
    await AiGateway.execute(req());
    expect(fake.calls.at(-1)?.model).toBe('activé-pendant');
    expect(h.traces.at(-1)?.snapshotMeta).toEqual({});
  });
});

describe('L87A-S05 — T2 réel : runAssistant figé au démarrage de la demande', () => {
  it('import pendant la recherche : la génération résout la configuration de départ', async () => {
    const { runAssistant } = await import('@/services/verebona-assistant/core/assistant-orchestrator.service');
    poser({ T2: 't2-depart' }, { versionId: 1 });
    const vus: Array<{ model: string; snapshot: boolean }> = [];
    await runAssistant(
      { accountId: 7, userId: 3, planType: 'PREMIUM', message: 'Résume les garanties de mon vélo', clientRequestId: 'c', locale: 'fr-FR' },
      {
        retrieve: async () => {
          poser({ T2: 't2-importe' }, { versionId: 2 });
          return [{ id: 'doc_5', type: 'document', title: 'Facture vélo', content: 'Facture du 12/03/2024, 1 290 €.', relevanceScore: 0.8 } as never];
        },
        resolveSources: async (s: unknown) => s as never,
        resolveActions: async () => [],
        persist: async () => null,
        hasPendingClarification: async () => false,
        checkMonthlyBudget: async () => ({ allowed: true }) as never,
        generateWithAI: async () => {
          vus.push({ model: (await R.resolveOperationConfig('t2_answer')).primaryModel, snapshot: S.currentSyncConfigSnapshot() !== null });
          return null;
        },
      } as never,
    ).catch(() => null);
    expect(vus.length).toBeGreaterThan(0);
    expect(vus.every((v) => v.model === 't2-depart' && v.snapshot)).toBe(true);
    expect((await R.resolveOperationConfig('t2_answer')).primaryModel).toBe('t2-importe');
  });
});

describe('L87A-S06 — T6 réel : formulateWithT6 figé au démarrage de l’exécution', () => {
  it('activation pendant la lecture de version : la génération résout la configuration de départ', async () => {
    const { buildT6Input } = await import('@/services/home/mascot/t6-contract');
    const { formulateWithT6, resetT6Breaker } = await import('@/services/home/mascot/t6-runner');
    resetT6Breaker();
    poser({ T6: 't6-depart' }, { versionId: 1 });
    const input = buildT6Input([{
      subjectId: 'DATE-NEXT:1', sourceFamily: 'DATE' as const, sourceCode: 'DATE-NEXT' as const, accountId: 7,
      priority: null, requiresAttention: false, intent: 'deadline' as const,
      facts: { title: 'Ramonage', dateLabel: '15 octobre 2026', date: '2026-10-15', dateNature: 'confirmée' }, actions: [],
      fallbackText: 'Le prochain ramonage est à prévoir pour le 15 octobre 2026.', allowedHighlight: '15 octobre 2026',
      occurrenceKey: 'DATE-NEXT:1', dedupeKeys: [], secondaryLabel: '',
    }]);
    let vu: string | null = null;
    await formulateWithT6({ accountId: 7, input, contextHash: 's06', mode: 'display' }, {
      treatmentAvailable: async () => true,
      promptVersion: async () => { poser({ T6: 't6-active-pendant' }, { versionId: 2 }); return 'v1'; },
      displayWaitMs: () => 6_000,
      execute: async () => {
        vu = (await R.resolveOperationConfig('t6_formulate')).primaryModel;
        return { data: { schemaVersion: 't6-output-v2', messages: [{ subjectId: 'DATE-NEXT:1', text: 'Le ramonage est fixé au 15 octobre 2026.', highlight: null }] }, model: vu, usedFallback: false, costMicros: 0, traceId: 't' } as never;
      },
    });
    expect(vu).toBe('t6-depart');
    expect((await R.resolveOperationConfig('t6_formulate')).primaryModel).toBe('t6-active-pendant');
  });
});

describe('L87A-S07 — portée de l’instantané synchrone', () => {
  it('dans un travail de file : aucun instantané synchrone (celui du travail fait foi)', async () => {
    poser({ T1: 'x' });
    await runInJobContext({ jobId: 1, treatment: 'T1', configVersionId: 1 }, async () => {
      await S.runWithConfigSnapshot('T1', async () => { expect(S.currentSyncConfigSnapshot()).toBeNull(); });
    });
  });

  it('instantané déjà posé : l’exécution englobante fait foi (pas de second relevé)', async () => {
    poser({ T2: 'englobant' }, { versionId: 1 });
    await S.runWithConfigSnapshot('T2', async () => {
      const premier = S.currentSyncConfigSnapshot();
      poser({ T2: 'autre' }, { versionId: 2 });
      await S.runWithConfigSnapshot('T2', async () => {
        expect(S.currentSyncConfigSnapshot()).toBe(premier);
        expect((await R.resolveOperationConfig('t2_answer')).primaryModel).toBe('englobant');
      });
    });
  });

  it('trace de l’instantané : version, révision, promotions et nombre d’exclusions (sans contenu)', async () => {
    poser({ T2: 'm' }, { overlay: { exclusions: [{ kind: 'EXCLUSION', model: 'z', treatment: null }], promotions: new Map([['t2_answer', { model: 'm', promotionId: 3 }]]) } });
    const s = await R.captureExecutionSnapshot('sync', 'T2');
    expect(S.snapshotTrace(s)).toMatchObject({ scope: 'sync', versionId: 1, promotions: [{ operationCode: 't2_answer', model: 'm', promotionId: 3 }], exclusions: 1 });
    expect(S.snapshotTrace(null)).toBeNull();
  });
});
