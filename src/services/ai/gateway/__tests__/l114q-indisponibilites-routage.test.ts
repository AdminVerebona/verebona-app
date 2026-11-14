/**
 * Lot 114 — carte Trello #771 : propagation d'une indisponibilité confirmée jusqu'au ROUTAGE. Passerelle RÉELLE,
 * fournisseur simulé et instrumenté (décompte exact des requêtes). L'état canonique est simulé par une table en
 * mémoire lue par le lecteur de la passerelle ; sa persistance réelle est couverte par
 * `provider/__tests__/l114q-sondes-indisponibilites.test.ts` et le scénario PostgreSQL `l114q`.
 *
 *   L114Q-G01 (R03, E02, E05)  principal indisponible + repli sain ; repli seul indisponible ; tous inéligibles
 *   L114Q-G02 (R07, E04)       un vrai 404 explicite d'un appel métier met à jour l'état partagé ; les appels
 *                              suivants sautent la route ; 429 / 5xx ne retirent pas le modèle
 *   L114Q-G03 (R12, E06)       concurrence : seules les requêtes déjà envoyées échouent ; après publication,
 *                              zéro nouvelle requête vers la route ; aucun appel de sonde par traitement
 *   L114Q-G04 (E02)            verdict publié PENDANT une tentative : opposable au rang suivant du même appel
 *   L114Q-G05 (R11, #770)      articulation tarif / disponibilité : deux motifs distincts et cumulatifs
 *   L114Q-G06 (R09)            même garde pour T1, T2, T3, T4 et T6, principal, repli 1 et repli 2
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';

const h = vi.hoisted(() => ({ traces: [] as Array<Record<string, unknown>> }));
vi.mock('../diagnostics/diagnostic.repository', async (orig) => ({
  ...(await orig<typeof import('../diagnostics/diagnostic.repository')>()),
  recordCallDiagnostic: vi.fn(async () => undefined),
}));
vi.mock('../../telemetry/ai-trace.service', async (orig) => ({
  ...(await orig<typeof import('../../telemetry/ai-trace.service')>()),
  recordCallTrace: vi.fn(async (t: Record<string, unknown>) => { h.traces.push(t); return h.traces.length; }),
}));
vi.mock('../../queue/circuit-breaker.repository', async (orig) => ({
  ...(await orig<typeof import('../../queue/circuit-breaker.repository')>()),
  noteGatewayOutcome: vi.fn(),
}));

const { AiGateway } = await import('../ai-gateway');
const { FakeProvider, setAiProvider } = await import('../providers');
const { __setConfigForTests } = await import('../../config/config-resolver');
const { emptyTreatmentConfig } = await import('../../config/config-types');
const { __setFallbackContextForTests, refusalDecision } = await import('../fallback-context');
const { primePricingCache, clearPricingCache, __setVerifiedTestPricesForTests } = await import('../../gateway/pricing/pricing.repository');
const { TREATMENT_DEFINITIONS } = await import('../../config/treatments');
const { listOperationsByUseCase } = await import('../../registry/operations');
const { admitCandidate } = await import('../fallback-policy');
const { T1_TEST_OPERATION, t1TestVariables, t1Out, t1Schema } = await import('./t1-master-request');

type Hint = import('../fallback-context').OperationalHint;
type Trace = Record<string, unknown> & { model: string; errorCode?: string; costMicros?: number | null; inputTokens?: number; capture?: { callKind: string } };
const traces = () => h.traces as Trace[];
const sansAppel = () => traces().filter((t) => t.capture?.callKind === 'pre_call_refusal');

const Schema = t1Schema({ ok: z.boolean() });
const OK = { rawText: t1Out({ ok: true }), inputTokens: 1, outputTokens: 1 };
let fake: InstanceType<typeof FakeProvider>;

/** Refus de l'appel 15389, pour un modèle quelconque : HTTP 404 NOT_FOUND, message exact du fournisseur. */
const refus404 = (model: string) => Object.assign(
  new Error(`{"error":{"code":404,"message":"This model models/${model} is no longer available to new users","status":"NOT_FOUND"}}`), { status: 404 });
const quota = () => Object.assign(new Error('Resource has been exhausted (e.g. check quota).'), { status: 429 });
const indispo = () => Object.assign(new Error('{"error":{"code":503,"message":"overloaded","status":"UNAVAILABLE"}}'), { status: 503 });

/** État canonique simulé (ce que la passerelle lit, déjà synchronisé — jamais une sonde). */
const etat = new Map<string, Hint>();
let lectures = 0;
/** Lecteur et récepteur des refus : même décision que la production (`refusalDecision`), écriture en mémoire. */
function brancherEtat() {
  __setFallbackContextForTests({
    knownUnavailable: async () => { lectures++; return new Map(etat); },
    reportRefusal: async (p) => {
      const d = await refusalDecision(p);
      if (d?.action !== 'record') return d ? 'probe_requested' : null;
      etat.set(p.model, { checkedAt: p.sentAt.toISOString(), error: d.outcome.error });
      return 'recorded';
    },
  });
}

function chaine(models: [string, string | null, string | null], treatment: 'T1' = 'T1') {
  __setConfigForTests({
    versionId: 1,
    entries: [{ ...emptyTreatmentConfig(treatment), primaryModel: models[0], fallback1: models[1], fallback2: models[2], maxOutputTokens: 2000 }],
  });
}
const req = (over: Record<string, unknown> = {}) => ({
  useCaseCode: 'SOURCE_ANALYSIS' as const, operationCode: T1_TEST_OPERATION, accountId: 7,
  sourceIds: [42], promptVariables: t1TestVariables('facture'), outputSchema: Schema, idempotencyKey: `l114q-${Math.random()}`,
  ...over,
});
const requetes = (model?: string) => fake.calls.filter((c) => !model || c.model === model).length;

beforeEach(() => {
  h.traces.length = 0;
  etat.clear();
  lectures = 0;
  fake = new FakeProvider();
  setAiProvider(fake);
  chaine(['m-a', 'm-b', 'm-c']);
  brancherEtat();
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
  __setConfigForTests(null);
  __setFallbackContextForTests(null);
  __setVerifiedTestPricesForTests(true);
  clearPricingCache();
  vi.restoreAllMocks();
});

describe('L114Q-G01 — principal et replis (R03, E02, E05)', () => {
  it('principal confirmé indisponible + repli sain : principal sauté SANS appel ni coût, repli déjà configuré exécuté', async () => {
    etat.set('m-a', { checkedAt: '2026-11-13T06:15:44.000Z', error: 'HTTP 404 NOT_FOUND — This model models/m-a is no longer available to new users' });
    fake.on('m-b', () => OK);
    const r = await AiGateway.execute(req());
    expect(r.model).toBe('m-b');
    expect(fake.calls.map((c) => c.model)).toEqual(['m-b']);
    expect(sansAppel()).toHaveLength(1);
    expect(sansAppel()[0]).toMatchObject({
      model: 'm-a', errorCode: 'MODEL_KNOWN_UNAVAILABLE', inputTokens: 0, outputTokens: 0, costMicros: 0, billable: false, usedFallback: false,
      fallback: { decision: 'KNOWN_UNAVAILABLE', operational: { checkedAt: '2026-11-13T06:15:44.000Z' } },
    });
  });

  it('repli seul indisponible : principal inchangé, une seule requête, aucun rang tracé pour rien', async () => {
    etat.set('m-b', { checkedAt: null, error: null });
    fake.on('m-a', () => OK);
    const r = await AiGateway.execute(req());
    expect(r.model).toBe('m-a');
    expect(fake.calls.map((c) => c.model)).toEqual(['m-a']);
    expect(sansAppel()).toHaveLength(0);
  });

  it('principal en panne passagère, repli 1 indisponible confirmé : repli 1 sauté, repli 2 exécuté', async () => {
    etat.set('m-b', { checkedAt: null, error: null });
    fake.on('m-a', () => { throw indispo(); }).on('m-c', () => OK);
    const r = await AiGateway.execute(req());
    expect(r.model).toBe('m-c');
    expect(fake.calls.map((c) => c.model)).toEqual(['m-a', 'm-c']);
    expect(sansAppel().map((t) => [t.model, t.errorCode])).toEqual([['m-b', 'MODEL_KNOWN_UNAVAILABLE']]);
  });

  it('tous les rangs inéligibles : 0 requête, erreur technique contrôlée (suspension), aucun faux succès', async () => {
    for (const m of ['m-a', 'm-b', 'm-c']) etat.set(m, { checkedAt: null, error: null });
    const e = await AiGateway.execute(req()).catch((x) => x);
    expect(e).toMatchObject({ code: 'AI_SUSPENDED', failureCause: 'KNOWN_UNAVAILABLE' });
    expect(requetes()).toBe(0);
    expect(sansAppel().map((t) => t.model)).toEqual(['m-a', 'm-b', 'm-c']);
    expect(traces().every((t) => t.costMicros === 0 && t.inputTokens === 0)).toBe(true);
  });
});

describe('L114Q-G02 — appel métier réel (R07, E04)', () => {
  it('404 explicite : état partagé mis à jour, repli exécuté ; appels suivants : route sautée, 0 nouvelle requête', async () => {
    fake.on('m-a', () => { throw refus404('m-a'); }).on('m-b', () => OK);
    const r1 = await AiGateway.execute(req());
    expect(r1.model).toBe('m-b');
    expect(etat.get('m-a')).toMatchObject({ error: expect.stringContaining('no longer available to new users') });
    expect(requetes('m-a')).toBe(1); // la tentative réellement envoyée, comptée une fois
    for (let i = 0; i < 3; i++) expect((await AiGateway.execute(req())).model).toBe('m-b');
    expect(requetes('m-a')).toBe(1); // plus aucune requête vers la route
    expect(requetes('m-b')).toBe(4);
    expect(sansAppel().filter((t) => t.model === 'm-a' && t.errorCode === 'MODEL_KNOWN_UNAVAILABLE')).toHaveLength(3);
  });

  it('429 et 5xx : repli pour cet appel, modèle JAMAIS marqué indisponible, rappelé à l’appel suivant', async () => {
    let n = 0;
    fake.on('m-a', () => { n++; if (n === 1) throw quota(); if (n === 2) throw indispo(); return OK; }).on('m-b', () => OK);
    expect((await AiGateway.execute(req())).model).toBe('m-b');
    expect((await AiGateway.execute(req())).model).toBe('m-b');
    expect(etat.size).toBe(0);
    expect((await AiGateway.execute(req())).model).toBe('m-a');
    expect(requetes('m-a')).toBe(3);
  });

  it('404 sans mention explicite du modèle : rien n’est écrit d’office (la sonde bornée tranchera)', async () => {
    fake.on('m-a', () => { throw Object.assign(new Error('Not Found'), { status: 404 }); }).on('m-b', () => OK);
    expect((await AiGateway.execute(req())).model).toBe('m-b');
    expect(etat.size).toBe(0);
  });
});

describe('L114Q-G03 — concurrence (R12, E06)', () => {
  it('demandes simultanées pendant le refus : seules les requêtes déjà envoyées échouent ; ensuite zéro requête vers la route', async () => {
    let liberer: () => void = () => {};
    const verrou = new Promise<void>((resolve) => { liberer = resolve; });
    fake.on('m-a', async () => { await verrou; throw refus404('m-a'); }).on('m-b', () => OK);
    const enVol = [AiGateway.execute(req()), AiGateway.execute(req()), AiGateway.execute(req())];
    await vi.waitFor(() => expect(requetes('m-a')).toBe(3)); // trois requêtes déjà parties avant le verdict
    liberer();
    expect((await Promise.all(enVol)).map((r) => r.model)).toEqual(['m-b', 'm-b', 'm-b']);
    expect(etat.has('m-a')).toBe(true);
    // Verdict publié : aucune nouvelle tentative, quel que soit le nombre de demandes.
    const apres = await Promise.all(Array.from({ length: 5 }, () => AiGateway.execute(req())));
    expect(apres.every((r) => r.model === 'm-b')).toBe(true);
    expect(requetes('m-a')).toBe(3);
    expect(requetes('m-b')).toBe(8);
  });

  it('aucun appel fournisseur additionnel par traitement pour sonder le catalogue : uniquement les requêtes du traitement', async () => {
    fake.on('m-a', () => OK);
    for (let i = 0; i < 4; i++) await AiGateway.execute(req());
    expect(fake.calls).toHaveLength(4);
    expect(fake.calls.every((c) => c.model === 'm-a' && c.operationCode === T1_TEST_OPERATION)).toBe(true);
    expect(lectures).toBeGreaterThanOrEqual(4); // l'état est LU (déjà synchronisé), jamais redécouvert
  });
});

describe('L114Q-G04 — verdict publié pendant une tentative (E02)', () => {
  it('le repli 1 est confirmé indisponible pendant l’appel du principal : sauté, repli 2 exécuté', async () => {
    fake.on('m-a', () => {
      // Une autre instance (ou la sonde) publie le verdict pendant que le principal répond.
      etat.set('m-b', { checkedAt: '2026-11-13T06:15:44.000Z', error: 'HTTP 404 NOT_FOUND' });
      throw indispo();
    }).on('m-c', () => OK);
    const r = await AiGateway.execute(req());
    expect(r.model).toBe('m-c');
    expect(fake.calls.map((c) => c.model)).toEqual(['m-a', 'm-c']);
    expect(requetes('m-b')).toBe(0);
  });
});

describe('L114Q-G05 — articulation avec l’éligibilité tarifaire #770 (R11)', () => {
  const prix = (model: string, input = 1, output = 2) => ({
    provider: 'gemini', model, inputMicros: input, outputMicros: output, currency: 'USD', source: 'billing_api' as const, verified: true,
    fetchedAt: new Date('2026-11-01T00:00:00Z'), effectiveFrom: new Date('2026-01-01T00:00:00Z'),
  });
  beforeEach(() => __setVerifiedTestPricesForTests(false));

  it('opérationnel sans tarif vérifié : inéligible au titre de #770 ; tarifé mais indisponible : inéligible au titre de #771', async () => {
    // m-a : répond, mais sans tarif → PRICING ; m-b : tarifé, confirmé indisponible → KNOWN_UNAVAILABLE ; m-c : tarifé et sain.
    primePricingCache([prix('m-b'), prix('m-c')] as never);
    etat.set('m-b', { checkedAt: null, error: null });
    fake.onAny(() => OK);
    const r = await AiGateway.execute(req());
    expect(r.model).toBe('m-c');
    expect(fake.calls.map((c) => c.model)).toEqual(['m-c']);
    expect(sansAppel().map((t) => [t.model, t.errorCode])).toEqual([
      ['m-a', 'MODEL_PRICING_UNVERIFIED'], ['m-b', 'MODEL_KNOWN_UNAVAILABLE'],
    ]);
  });

  it('tarif officiel effectivement nul : valide, n’empêche ni l’appel ni le verdict de disponibilité', async () => {
    primePricingCache([prix('m-a', 0, 0), prix('m-b')] as never);
    fake.on('m-a', () => OK);
    expect((await AiGateway.execute(req())).model).toBe('m-a');
    // Le même modèle gratuit, une fois confirmé indisponible, est sauté au titre de la disponibilité.
    etat.set('m-a', { checkedAt: null, error: null });
    fake.on('m-b', () => OK);
    expect((await AiGateway.execute(req())).model).toBe('m-b');
    expect(sansAppel().map((t) => t.errorCode)).toEqual(['MODEL_KNOWN_UNAVAILABLE']);
  });

  it('les deux motifs sont distincts ; sans tarif ET indisponible : le motif tarifaire est donné (aucun appel dans les deux cas)', () => {
    const c = { model: 'm', rankIndex: 0, excluded: false, qualification: 'UNKNOWN' as const, maxOutputTokens: 1000 };
    expect(admitCandidate({ ...c, knownUnavailable: true }, null, { configOrigin: null })).toEqual({ admitted: false, reason: 'KNOWN_UNAVAILABLE' });
    expect(admitCandidate({ ...c, knownUnavailable: false, pricingUnverified: true }, null, { configOrigin: null })).toEqual({ admitted: false, reason: 'PRICING_UNVERIFIED' });
    expect(admitCandidate({ ...c, knownUnavailable: true, pricingUnverified: true }, null, { configOrigin: null })).toEqual({ admitted: false, reason: 'PRICING_UNVERIFIED' });
  });
});

describe('L114Q-G06 — même garde pour tous les traitements (R09)', () => {
  it('T1, T2, T3, T4 et T6 passent par la passerelle : une seule lecture d’état, un seul point de décision', () => {
    // Toutes les opérations modèle des cinq traitements sont des opérations du registre exécutées par
    // `AiGateway.execute` : la garde de disponibilité (ci-dessus) est donc la même pour chacune.
    for (const t of ['T1', 'T2', 'T3', 'T4', 'T6'] as const) {
      const ops = listOperationsByUseCase(TREATMENT_DEFINITIONS[t].useCaseCode).filter((o) => o.provider !== 'none' && o.active);
      expect(ops.length, t).toBeGreaterThan(0);
    }
    // Chaque rang (principal, repli 1, repli 2) est refusé de la même façon, quel que soit le rang.
    for (const rankIndex of [0, 1, 2]) {
      expect(admitCandidate({ model: 'm', rankIndex, knownUnavailable: true, excluded: false, qualification: 'ADMISSIBLE', maxOutputTokens: 1000 },
        rankIndex === 0 ? null : { cause: 'UNAVAILABLE', truncatedAtMaxOutputTokens: null, unknownAlternativesUsed: 0 }, { configOrigin: 'manual' }))
        .toEqual({ admitted: false, reason: 'KNOWN_UNAVAILABLE' });
    }
  });
});
