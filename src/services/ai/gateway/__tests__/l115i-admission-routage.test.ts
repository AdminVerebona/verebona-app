/**
 * Lot 115 — carte Trello #786 : AUCUNE nouvelle requête ordinaire vers une route confirmée indisponible après
 * publication du verdict. Passerelle RÉELLE, fournisseur simulé et instrumenté (décompte exact des requêtes) ;
 * l'état partagé est simulé par une table en mémoire que la garde et le routage lisent TOUS LES DEUX (même
 * source, aucune divergence possible). Sa persistance réelle est couverte par
 * `provider/__tests__/l115i-admission-disponibilite.test.ts` et le scénario PostgreSQL `l115i`.
 *
 *   L115I-G01 (E02, R03)  verdict publié PENDANT un envoi déjà parti : la requête en vol finit, aucune nouvelle
 *                         ne part — sans attendre les 5 s du cache d'instance
 *   L115I-G02 (E02, R04)  verdict publié entre l'appel initial et une tentative INTERNE (essai sans schéma,
 *                         essai diagnostique, réparation) : zéro envoi interdit
 *   L115I-G03 (E02, R05)  chaînes : principal refusé / repli sain, repli seul refusé, tous refusés — chaîne
 *                         préconfigurée seulement, erreur contrôlée, zéro coût de saut
 *   L115I-G04 (E01, R02)  disponibilité INVÉRIFIABLE : suspension technique, zéro envoi, aucun modèle retiré
 *   L115I-G05 (E03, R06)  épreuve de qualification : plus d'exemption (règle remplacée, carte #786)
 *   L115I-G06 (E08)       mesures : envois refusés comptés par point, aucun coût ni appel fictif
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
const { __setFallbackContextForTests } = await import('../fallback-context');
const A = await import('../../provider/operational-admission');
const { T1_TEST_OPERATION, t1TestVariables, t1Out, t1Schema } = await import('./t1-master-request');

type Trace = Record<string, unknown> & {
  model: string; errorCode?: string; costMicros?: number | null; inputTokens?: number; capture?: { callKind: string };
};
const traces = () => h.traces as Trace[];
const sansAppel = () => traces().filter((t) => t.capture?.callKind === 'pre_call_refusal');

const Schema = t1Schema({ ok: z.boolean() });
const OK = { rawText: t1Out({ ok: true }), inputTokens: 1, outputTokens: 1 };
let fake: InstanceType<typeof FakeProvider>;

/** État PARTAGÉ simulé : ce que la garde et le routage lisent (jamais une sonde). */
const indisponibles = new Set<string>();
/** La lecture de l'état partagé est-elle possible ? (`false` : base illisible) */
let lectureFiable = true;
/** Nombre de lectures du verdict (une par envoi : la garde ne tolère aucun délai). */
let lectures = 0;

function brancherEtat() {
  A.__setPublishedVerdictReaderForTests(async (model: string) => {
    lectures++;
    if (!lectureFiable) return { ...A.unknownVerdict(model, false) };
    return {
      ...A.unknownVerdict(model, true),
      state: indisponibles.has(model) ? 'unavailable' : 'healthy',
      checkStatus: indisponibles.has(model) ? 'failed_confirmed' : 'ok',
      error: indisponibles.has(model) ? 'HTTP 404 NOT_FOUND — This model is no longer available to new users' : null,
      checkedAt: '2026-11-16T06:15:44.000Z',
    };
  });
}

function chaine(models: [string, string | null, string | null]) {
  __setConfigForTests({
    versionId: 1,
    entries: [{ ...emptyTreatmentConfig('T1'), primaryModel: models[0], fallback1: models[1], fallback2: models[2], maxOutputTokens: 2000 }],
  });
}
const req = (over: Record<string, unknown> = {}) => ({
  useCaseCode: 'SOURCE_ANALYSIS' as const, operationCode: T1_TEST_OPERATION, accountId: 7,
  sourceIds: [42], promptVariables: t1TestVariables('facture'), outputSchema: Schema, idempotencyKey: `l115i-${Math.random()}`,
  ...over,
});
const requetes = (model?: string) => fake.calls.filter((c) => !model || c.model === model).length;

beforeEach(() => {
  h.traces.length = 0;
  indisponibles.clear();
  lectureFiable = true;
  lectures = 0;
  fake = new FakeProvider();
  setAiProvider(fake);
  chaine(['m-a', 'm-b', 'm-c']);
  brancherEtat();
  A.__resetAdmissionMetrics();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  __setConfigForTests(null);
  __setFallbackContextForTests(null);
  A.__setPublishedVerdictReaderForTests(null);
  vi.restoreAllMocks();
});

describe('L115I-G01 — verdict publié pendant les envois (E02, R03)', () => {
  it('trois requêtes en vol, verdict publié : elles finissent, et plus AUCUNE ne part — sans délai de tolérance', async () => {
    let liberer: () => void = () => {};
    const verrou = new Promise<void>((resolve) => { liberer = resolve; });
    fake.on('m-a', async () => { await verrou; throw new Error('{"error":{"code":503,"status":"UNAVAILABLE"}}'); }).on('m-b', () => OK);
    const enVol = [AiGateway.execute(req()), AiGateway.execute(req()), AiGateway.execute(req())];
    await vi.waitFor(() => expect(requetes('m-a')).toBe(3));
    // Une AUTRE instance publie le verdict pendant que les trois requêtes sont en vol.
    indisponibles.add('m-a');
    liberer();
    expect((await Promise.all(enVol)).map((r) => r.model)).toEqual(['m-b', 'm-b', 'm-b']);
    expect(requetes('m-a')).toBe(3); // seules les requêtes DÉJÀ parties ont fini

    // Immédiatement après : aucune nouvelle tentative, sans attendre la relecture du cache d'instance.
    const apres = await Promise.all(Array.from({ length: 5 }, () => AiGateway.execute(req())));
    expect(apres.every((r) => r.model === 'm-b')).toBe(true);
    expect(requetes('m-a')).toBe(3);
    expect(sansAppel().filter((t) => t.model === 'm-a' && t.errorCode === 'MODEL_KNOWN_UNAVAILABLE')).toHaveLength(5);
    expect(sansAppel().every((t) => t.costMicros === 0 && t.inputTokens === 0)).toBe(true);
  });

  it('le verdict est relu à CHAQUE envoi : aucune requête ordinaire ne part pendant la fenêtre d’un cache', async () => {
    fake.onAny(() => OK);
    await AiGateway.execute(req());
    const apresPremier = lectures;
    expect(apresPremier).toBeGreaterThanOrEqual(1);
    indisponibles.add('m-a');
    // Aucune invalidation de cache, aucun délai : l'appel suivant saute déjà la route.
    expect((await AiGateway.execute(req())).model).toBe('m-b');
    expect(requetes('m-a')).toBe(1);
    expect(lectures).toBeGreaterThan(apresPremier);
  });

  it('une route redevenue saine est de nouveau appelée (aucune exclusion permanente)', async () => {
    indisponibles.add('m-a');
    fake.onAny(() => OK);
    expect((await AiGateway.execute(req())).model).toBe('m-b');
    indisponibles.delete('m-a');
    expect((await AiGateway.execute(req())).model).toBe('m-a');
  });
});

describe('L115I-G02 — tentatives INTERNES du même appel (E02, R04)', () => {
  it('verdict publié entre l’appel initial et la passe de réparation : la réparation n’est pas envoyée', async () => {
    // Première réponse : JSON invalide → la passerelle tenterait une réparation sur le MÊME modèle.
    let n = 0;
    fake.on('m-a', () => {
      n++;
      if (n === 1) {
        indisponibles.add('m-a'); // une autre instance publie le verdict pendant la tentative
        return { rawText: '{ ceci n', inputTokens: 1, outputTokens: 1 };
      }
      return OK;
    }).on('m-b', () => OK);
    const r = await AiGateway.execute(req());
    // La réparation (même modèle) n'a PAS été envoyée : le repli configuré a répondu.
    expect(requetes('m-a')).toBe(1);
    expect(r.model).toBe('m-b');
  });

  it('verdict publié avant l’essai interne sans schéma : aucun second envoi vers la route', async () => {
    fake.on('m-a', () => {
      indisponibles.add('m-a');
      throw Object.assign(new Error('{"error":{"code":400,"status":"INVALID_ARGUMENT","message":"response_schema is not supported"}}'), { status: 400 });
    }).on('m-b', () => OK);
    const r = await AiGateway.execute(req());
    expect(requetes('m-a')).toBe(1);
    expect(r.model).toBe('m-b');
  });
});

describe('L115I-G03 — chaînes préconfigurées (E02, R05)', () => {
  it('principal refusé, repli sain : principal sauté sans appel ni coût, repli CONFIGURÉ exécuté', async () => {
    indisponibles.add('m-a');
    fake.on('m-b', () => OK);
    const r = await AiGateway.execute(req());
    expect(r.model).toBe('m-b');
    expect(fake.calls.map((c) => c.model)).toEqual(['m-b']);
    expect(sansAppel()[0]).toMatchObject({
      model: 'm-a', errorCode: 'MODEL_KNOWN_UNAVAILABLE', inputTokens: 0, outputTokens: 0, costMicros: 0, billable: false,
      fallback: { decision: 'KNOWN_UNAVAILABLE', operational: { error: expect.stringContaining('no longer available') } },
    });
  });

  it('tous les rangs refusés : zéro requête, suspension contrôlée, aucun faux succès, aucune double écriture', async () => {
    for (const m of ['m-a', 'm-b', 'm-c']) indisponibles.add(m);
    fake.onAny(() => OK);
    const e = await AiGateway.execute(req()).catch((x) => x);
    expect(e).toMatchObject({ code: 'AI_SUSPENDED', failureCause: 'KNOWN_UNAVAILABLE' });
    expect(requetes()).toBe(0);
    expect(sansAppel().map((t) => t.model)).toEqual(['m-a', 'm-b', 'm-c']);
    expect(traces().every((t) => t.costMicros === 0 && t.inputTokens === 0)).toBe(true);
  });

  it('seul le repli PRÉCONFIGURÉ est considéré : aucun modèle improvisé hors de la chaîne', async () => {
    chaine(['m-a', 'm-b', null]);
    for (const m of ['m-a', 'm-b']) indisponibles.add(m);
    fake.onAny(() => OK);
    await AiGateway.execute(req()).catch(() => undefined);
    expect(requetes()).toBe(0);
    expect(sansAppel().map((t) => t.model)).toEqual(['m-a', 'm-b']); // jamais m-c
  });
});

describe('L115I-G04 — disponibilité invérifiable (E01, R02)', () => {
  it('état partagé illisible au démarrage à froid : suspension technique, zéro envoi, aucun modèle retiré', async () => {
    lectureFiable = false;
    fake.onAny(() => OK);
    const e = await AiGateway.execute(req()).catch((x) => x);
    expect(e).toMatchObject({ code: 'AI_SUSPENDED', failureCause: 'ADMISSION_UNVERIFIABLE' });
    expect(requetes()).toBe(0);
    // Chaque rang est tracé « non sollicité » avec un code DISTINCT d'une indisponibilité.
    expect(sansAppel().map((t) => [t.model, t.errorCode])).toEqual([
      ['m-a', 'MODEL_ADMISSION_UNVERIFIABLE'], ['m-b', 'MODEL_ADMISSION_UNVERIFIABLE'], ['m-c', 'MODEL_ADMISSION_UNVERIFIABLE'],
    ]);
    expect(traces().every((t) => t.costMicros === 0)).toBe(true);
  });

  it('lecture rétablie : les envois repartent sans intervention', async () => {
    lectureFiable = false;
    fake.onAny(() => OK);
    await AiGateway.execute(req()).catch(() => undefined);
    lectureFiable = true;
    expect((await AiGateway.execute(req())).model).toBe('m-a');
  });
});

describe('L115I-G05 — qualification sans exemption (E03, R06)', () => {
  it('épreuve de qualification sur une route refusée : aucun envoi (règle remplacée, carte #786)', async () => {
    indisponibles.add('m-a');
    fake.onAny(() => OK);
    const e = await AiGateway.execute(req({ triggerCode: 'qualification', maxModelAttempts: 1 })).catch((x) => x);
    expect(e).toMatchObject({ code: 'AI_SUSPENDED', failureCause: 'KNOWN_UNAVAILABLE' });
    expect(requetes()).toBe(0);
  });

  it('épreuve de qualification sur une route saine : le modèle désigné est atteint', async () => {
    fake.on('m-a', () => OK);
    const r = await AiGateway.execute(req({ triggerCode: 'qualification', maxModelAttempts: 1 }));
    expect(r.model).toBe('m-a');
    expect(requetes('m-a')).toBe(1);
  });
});

describe('L115I-G06 — mesures d’admission (E08)', () => {
  it('les refus sont comptés par point d’envoi ; un saut ne compte ni appel ni coût', async () => {
    indisponibles.add('m-a');
    fake.on('m-b', () => OK);
    await AiGateway.execute(req());
    const m = A.admissionMetrics();
    expect(m.refusedUnavailable).toBeGreaterThanOrEqual(1);
    expect(m.byPoint.gateway_rank?.refused).toBeGreaterThanOrEqual(1);
    expect(m.allowed).toBeGreaterThanOrEqual(1);
    // Aucun coût fictif : le rang sauté est tracé à 0.
    expect(sansAppel().every((t) => t.costMicros === 0 && t.inputTokens === 0)).toBe(true);
  });
});
