/**
 * Carte #863 — passerelle IA : requêtes RÉELLEMENT envoyées (C1), coûts
 * complets et incertitude (C2), fencing des résultats de qualification (A1),
 * cache périmé et stockage indisponible (A2), report de requalification
 * opposable (A3).
 *
 * Passerelle RÉELLE, transport fournisseur MOCKÉ (FakeProvider) ; mémoire
 * partagée SIMULÉE (magasin en mémoire qui applique le MÊME fencing que la
 * base : jeton de bail valide ou génération inchangée). Les écritures SQL
 * réelles (fencing en base, concurrence multi-connexions) sont prouvées par
 * `src/test/e2e/scenarios/c863-gateway-fencing-couts-alertes.e2e.ts`. Aucun
 * appel Gemini : rien ici n'établit l'acceptation réelle d'un schéma.
 *
 *   C863-C1-*  départ réel de chaque tentative, égalité avec le transport ;
 *   C863-C2-*  chiffrage canonique, agrégation de TOUTE l'exécution ;
 *   C863-A1-*  bail borné, fencing, écriture en échec, réservation tardive ;
 *   C863-A2-*  cache périmé, migration absente, lectures bornées ;
 *   C863-A3-*  report opposable, version servie sans schéma.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const h = vi.hoisted(() => ({ traces: [] as Array<Record<string, unknown>>, refuserEnvoi: null as string | null }));
// Test HERMÉTIQUE : aucune connexion réelle (même convention que c838).
vi.mock('@/db', async (orig) => {
  const coupure = () => new Error('base indisponible (test unitaire isolé, carte #863)');
  const horsBase: unknown = new Proxy(function horsBase() { /* double */ }, {
    get: (_t, p) => (p === 'then' ? (_ok: unknown, ko: (e: Error) => void) => ko(coupure()) : horsBase),
    apply: () => horsBase,
  });
  return { ...(await orig<typeof import('@/db')>()), db: horsBase, pgClient: horsBase };
});
vi.mock('../diagnostics/diagnostic.repository', async (orig) => ({
  ...(await orig<typeof import('../diagnostics/diagnostic.repository')>()),
  recordCallDiagnostic: vi.fn(async () => undefined),
}));
vi.mock('../../telemetry/ai-trace.service', async (orig) => ({
  ...(await orig<typeof import('../../telemetry/ai-trace.service')>()),
  recordCallTrace: vi.fn(async (t: Record<string, unknown>) => { h.traces.push(t); return h.traces.length; }),
}));
// Garde d'admission (#786) : refus programmable AU POINT D'ENVOI (le rang, lui, est admis).
vi.mock('../../provider/operational-admission', async (orig) => {
  const o = await orig<typeof import('../../provider/operational-admission')>();
  return {
    ...o,
    guardSend: vi.fn(async (p: Parameters<typeof o.guardSend>[0]) => {
      if (p.point === 'gateway_send' && h.refuserEnvoi === p.model) {
        return { admitted: false, code: 'MODEL_UNAVAILABLE', label: 'modèle connu indisponible (test)', verdict: { checkedAt: null, error: null } } as never;
      }
      return o.guardSend(p);
    }),
  };
});

const { AiGateway } = await import('../ai-gateway');
const { FakeProvider, setAiProvider } = await import('../providers');
const { __setConfigForTests } = await import('../../config/config-resolver');
const { emptyTreatmentConfig } = await import('../../config/config-types');
const C = await import('../schema-compat');
const { attemptCost, costEvidenceOf, combineCostEvidence, exhaustiveCostMicros } = await import('../cost-evidence');
const { schemaCostViewOf, addSchemaCostViews } = await import('../schema-compat/supervision');
const { calcCostMicros } = await import('../cost-catalog');
const { T1_TEST_OPERATION, t1TestVariables, t1Out, t1Schema } = await import('./t1-master-request');

type StoreApi = typeof import('../schema-compat/store');
type CoupleRow = import('../schema-compat/store').SchemaCoupleRow;
type Key = import('../schema-compat').SchemaCoupleKey;
type Attempt = {
  kind: string; outcome: string; dispatch?: string; costStatus?: string; costMicros?: number | null; attemptId?: string; parentAttemptId?: string | null;
  phase?: string; callIndex?: number; rank?: string | null; model?: string | null; httpStatus: number | null; responseSchemaSent: boolean;
};
type Trace = Record<string, unknown> & { callKind?: string; model: string; costMicros: number | null; providerAttempts?: Attempt[]; costEvidence?: Record<string, unknown> };
const traces = () => h.traces as Trace[];
const tentatives = () => traces().flatMap((t) => t.providerAttempts ?? []);

const P = C.SCHEMA_COMPAT_POLICY;
const T0 = Date.UTC(2026, 10, 25, 9, 0, 0);
const Schema = t1Schema({ ok: z.boolean() });
const req = (i: number | string = 0) => ({
  useCaseCode: 'SOURCE_ANALYSIS' as const, operationCode: T1_TEST_OPERATION, accountId: 7, userId: 3,
  promptVariables: t1TestVariables(`facture ${i}`), outputSchema: Schema, idempotencyKey: `c863-${i}-${Math.random()}`,
});
function t1(primary: string, f1: string | null = null) {
  return { ...emptyTreatmentConfig('T1'), primaryModel: primary, fallback1: f1, fallback2: null, maxOutputTokens: 4000 };
}
const invalidArgument = () => Object.assign(
  new Error('{"error":{"code":400,"message":"Request contains an invalid argument.","status":"INVALID_ARGUMENT"}}'), { name: 'ClientError', status: 400 },
);
/** Transport MOCKÉ : nombre de requêtes réellement reçues (une erreur locale de construction n'en est pas une). */
const transport = { recues: 0 };
const recu = <T>(v: T): T => { transport.recues++; return v; };

let fake: InstanceType<typeof FakeProvider>;
beforeEach(() => {
  h.traces.length = 0;
  h.refuserEnvoi = null;
  transport.recues = 0;
  fake = new FakeProvider();
  setAiProvider(fake);
  C.__setSchemaCompatStoreForTests(null);
  delete process.env.AI_OUTPUT_REPAIR_PASS;
  delete process.env.AI_STRUCTURED_OUTPUT;
});
afterEach(async () => {
  await C.__flushSchemaCompatWritesForTests();
  C.__setSchemaCompatStoreForTests(null);
  C.__setSchemaCompatTransitionHookForTests(null);
  __setConfigForTests(null);
  vi.useRealTimers();
});

async function echec(p: Promise<unknown>): Promise<Error & { costEvidence?: Record<string, number | string> }> {
  try { await p; } catch (e) { return e as Error & { costEvidence?: Record<string, number | string> }; }
  throw new Error('échec attendu');
}

// ═══════════════════════════════════════════════════════════════════════════
describe('C863-C1 — seules les requêtes réellement envoyées sont comptées', () => {
  it('C863-C1-01 — refus de la garde AVANT le départ : tentative conservée (diagnostic), ZÉRO requête modèle, aucun coût', async () => {
    __setConfigForTests({ versionId: 1, entries: [t1('m-a')] });
    h.refuserEnvoi = 'm-a';
    fake.onAny(() => recu({ rawText: t1Out({ ok: true }), inputTokens: 10, outputTokens: 5 }));
    const e = await echec(AiGateway.execute(req('garde')));
    expect(fake.calls).toHaveLength(0);
    expect(tentatives().map((a) => a.dispatch)).toEqual(['NOT_SENT_GUARD']);
    expect(tentatives()[0]).toMatchObject({ costStatus: 'NOT_SENT', costMicros: null });
    expect(e.costEvidence).toMatchObject({ status: 'NONE', attempts: 0, notSentAttempts: 1 });
    // La ligne d'usage porte la part connue (aucun envoi : 0 réel), jamais un coût supposé.
    expect(traces()[0].costMicros).toBe(0);
  });

  it('C863-C1-02 — erreur locale de construction : NON envoyée, exclue des requêtes', async () => {
    __setConfigForTests({ versionId: 1, entries: [t1('m-a')] });
    fake.onAny(() => { throw new TypeError('Invalid header value'); });
    const e = await echec(AiGateway.execute(req('build')));
    expect(transport.recues).toBe(0);
    expect(tentatives().map((a) => a.dispatch)).toEqual(['NOT_SENT_BUILD']);
    expect(e.costEvidence).toMatchObject({ attempts: 0, notSentAttempts: 1, status: 'NONE' });
  });

  it('C863-C1-03 — transfert de pièce jointe sans génération : aucune requête modèle comptée', async () => {
    __setConfigForTests({ versionId: 1, entries: [t1('m-a')] });
    fake.onAny(() => { throw Object.assign(new Error('Files API : 403 PERMISSION_DENIED'), { aiStage: 'attachment_transfer', status: 403 }); });
    const e = await echec(AiGateway.execute(req('transfert')));
    expect(tentatives().map((a) => a.dispatch)).toEqual(['TRANSFER_NO_GENERATION']);
    expect(e.costEvidence).toMatchObject({ attempts: 0, notSentAttempts: 1 });
  });

  it('C863-C1-04 — 400 générique + essai JSON : 2 requêtes réelles, identifiants stables et parent, égalité avec le transport', async () => {
    __setConfigForTests({ versionId: 1, entries: [t1('m-a')] });
    fake.onAny((i) => {
      if (i.responseSchema) { transport.recues++; throw invalidArgument(); }
      return recu({ rawText: t1Out({ ok: true }), inputTokens: 10, outputTokens: 5 });
    });
    const res = await AiGateway.execute(req('400'));
    expect(res.providerRequests).toBe(2);
    expect(res.providerRequests).toBe(transport.recues);
    expect(res.providerRequests).toBe(fake.calls.length);
    const [a1, a2] = tentatives();
    expect(a1).toMatchObject({ kind: 'initial', dispatch: 'SENT', phase: 'analysis', callIndex: 0, parentAttemptId: null, rank: 'primary', model: 'm-a', costStatus: 'UNKNOWN' });
    expect(a2).toMatchObject({ kind: 'diagnostic_retry', dispatch: 'SENT', parentAttemptId: a1.attemptId });
    expect(a1.attemptId).toBe(`${res.traceId}:0:1`);
    // Au plus UN essai sans schéma, MIME JSON conservé.
    expect(fake.calls.filter((c) => !c.responseSchema)).toHaveLength(1);
    expect(fake.calls[1].jsonResponse).toBe(true);
    expect(res.costStatus).toBe('PARTIAL');
  });

  it('C863-C1-05 — réparation : 400 générique sur le schéma + JSON = 2 requêtes SUPPLÉMENTAIRES, rattachées à l’analyse', async () => {
    __setConfigForTests({ versionId: 1, entries: [t1('m-a')] });
    fake.onAny((i) => {
      if (i.callKind === 'repair') {
        if (i.responseSchema) { transport.recues++; throw invalidArgument(); }
        return recu({ rawText: t1Out({ ok: true }), inputTokens: 4, outputTokens: 4 });
      }
      return recu({ rawText: t1Out({ ok: 'peut-être' }), inputTokens: 10, outputTokens: 5 });
    });
    const res = await AiGateway.execute(req('reparation'));
    expect(res.data).toMatchObject({ ok: true });
    expect(res.providerRequests).toBe(3);
    expect(transport.recues).toBe(3);
    const rep = traces().find((t) => t.callKind === 'repair')!;
    expect(rep.providerAttempts!.map((a) => [a.kind, a.outcome, a.dispatch, a.phase])).toEqual([
      ['initial', 'FAILED', 'SENT', 'repair'], ['diagnostic_retry', 'SUCCESS', 'SENT', 'repair'],
    ]);
    const analyse = traces().find((t) => t.callKind === 'analysis')!;
    expect(rep.providerAttempts![0].parentAttemptId).toBe(analyse.providerAttempts![0].attemptId);
    expect(rep.providerAttempts![0].callIndex).toBe(1);
    // Éligibilité stricte (#437) : un autre motif d'échec de la réparation ne déclenche aucun essai diagnostique.
    h.traces.length = 0; transport.recues = 0;
    fake.onAny((i) => {
      if (i.callKind === 'repair') { transport.recues++; throw Object.assign(new Error('Quota exceeded'), { status: 429 }); }
      return recu({ rawText: t1Out({ ok: 'peut-être' }), inputTokens: 10, outputTokens: 5 });
    });
    await AiGateway.execute(req('reparation-429')).catch(() => null);
    expect(traces().filter((t) => t.callKind === 'repair').flatMap((t) => t.providerAttempts ?? []).map((a) => a.kind)).toEqual(['initial']);
  });

  it.each([
    ['délai', () => Object.assign(new Error('deadline exceeded'), { name: 'AbortError' })],
    ['429', () => Object.assign(new Error('Resource exhausted'), { status: 429 })],
    ['5xx', () => Object.assign(new Error('503 Service Unavailable'), { status: 503 })],
    ['authentification', () => Object.assign(new Error('API key not valid'), { status: 401 })],
  ])('C863-C1-06 — échec %s : requête PARTIE, comptée une fois, coût inconnu (jamais 0)', async (_n, erreur) => {
    __setConfigForTests({ versionId: 1, entries: [t1('m-a')] });
    fake.onAny(() => { transport.recues++; throw erreur(); });
    const e = await echec(AiGateway.execute(req('echec')));
    expect(tentatives().every((a) => a.dispatch === 'SENT')).toBe(true);
    expect(e.costEvidence?.attempts).toBe(transport.recues);
    expect(e.costEvidence).toMatchObject({ status: 'UNKNOWN', observedMicros: 0 });
    expect(traces().filter((t) => (t.providerAttempts?.length ?? 0) > 0).every((t) => t.costMicros === null)).toBe(true);
  });

  it('C863-C1-07 — réseau sans réponse : départ NON prouvable — ni requête réelle, ni non-envoi, part inconnue', async () => {
    __setConfigForTests({ versionId: 1, entries: [t1('m-a')] });
    fake.onAny(() => { throw Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' }); });
    const e = await echec(AiGateway.execute(req('reseau')));
    expect(tentatives().map((a) => a.dispatch)).toEqual(['DEPARTURE_UNPROVEN']);
    expect(e.costEvidence).toMatchObject({ attempts: 0, unprovenAttempts: 1, unknownAttempts: 1, status: 'UNKNOWN' });
  });

  it('C863-C1-08 — repli vers un autre modèle puis échec terminal : chaque envoi tracé, total = transport', async () => {
    __setConfigForTests({ versionId: 1, entries: [t1('m-a', 'm-b')] });
    fake.onAny(() => { transport.recues++; throw Object.assign(new Error('503 Service Unavailable'), { status: 503 }); });
    const e = await echec(AiGateway.execute(req('terminal')));
    expect(e.costEvidence?.attempts).toBe(transport.recues);
    expect(e.costEvidence?.attempts).toBe(fake.calls.length);
    expect(new Set(tentatives().map((a) => a.rank))).toEqual(new Set(['primary', 'fallback_1']));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('C863-C2 — coût canonique, incertitude et agrégation de toute l’exécution', () => {
  const prix = (i: number, o: number) => i * 2 + o * 10;
  it('C863-C2-01 — chiffrage canonique (pur) : complet, partiel, zéro prouvé, 0 + manquant, réflexion, tarif absent, total seul', () => {
    expect(attemptCost({ inputTokens: 10, outputTokens: 5, thoughtsTokens: null }, prix)).toEqual({ costMicros: 70, costStatus: 'OBSERVED' });
    // Réflexion facturée au tarif de sortie, ajoutée UNE fois à la sortie visible.
    expect(attemptCost({ inputTokens: 10, outputTokens: 5, thoughtsTokens: 20 }, prix)).toEqual({ costMicros: 270, costStatus: 'OBSERVED' });
    expect(attemptCost({ inputTokens: 10, outputTokens: null, thoughtsTokens: null }, prix)).toEqual({ costMicros: 20, costStatus: 'PARTIAL' });
    expect(attemptCost({ inputTokens: 0, outputTokens: 0, thoughtsTokens: null }, prix)).toEqual({ costMicros: 0, costStatus: 'ZERO_REPORTED' });
    expect(attemptCost({ inputTokens: 0, outputTokens: 0, thoughtsTokens: 3 }, prix)).toEqual({ costMicros: 30, costStatus: 'OBSERVED' });
    // « 0 + manquant » n'est PAS un zéro prouvé.
    expect(attemptCost({ inputTokens: 0, outputTokens: null, thoughtsTokens: null }, prix)).toEqual({ costMicros: 0, costStatus: 'PARTIAL' });
    expect(attemptCost({ inputTokens: 10, outputTokens: 5, thoughtsTokens: null }, () => null)).toEqual({ costMicros: null, costStatus: 'NO_PRICE' });
    expect(attemptCost({ inputTokens: null, outputTokens: null, thoughtsTokens: null }, prix)).toEqual({ costMicros: null, costStatus: 'UNKNOWN' });
  });

  it('C863-C2-02 — nature d’un ensemble : NO_PRICE, PARTIAL (minimum compté), non-envois exclus', () => {
    expect(costEvidenceOf([{ costStatus: 'NO_PRICE', costMicros: null }]).status).toBe('NO_PRICE');
    const partiel = costEvidenceOf([{ costStatus: 'OBSERVED', costMicros: 100 }, { costStatus: 'PARTIAL', costMicros: 20 }]);
    expect(partiel).toMatchObject({ status: 'PARTIAL', observedMicros: 120, attempts: 2, partialAttempts: 1, unknownAttempts: 1 });
    const nonEnvoi = costEvidenceOf([{ costStatus: 'NOT_SENT', costMicros: null, dispatch: 'NOT_SENT_GUARD' }, { costStatus: 'ZERO_REPORTED', costMicros: 0, dispatch: 'SENT' }]);
    expect(nonEnvoi).toMatchObject({ status: 'ZERO_REPORTED', attempts: 1, notSentAttempts: 1 });
    expect(combineCostEvidence(partiel, nonEnvoi)).toMatchObject({ status: 'PARTIAL', attempts: 3 });
    // Consommateurs historiques : une somme partielle n'est jamais utilisée comme un total.
    expect(exhaustiveCostMicros({ costMicros: 120, costStatus: 'PARTIAL' })).toBeNull();
    expect(exhaustiveCostMicros({ costMicros: 0, costStatus: 'UNKNOWN' })).toBeNull();
    expect(exhaustiveCostMicros({ costMicros: 70, costStatus: 'OBSERVED' })).toBe(70);
    expect(exhaustiveCostMicros({ costMicros: 70 })).toBe(70);
  });

  it('C863-C2-03 — premier rang consommateur en échec (jetons ventilés) puis autre rang réussi : TOUTES les tentatives agrégées', async () => {
    __setConfigForTests({ versionId: 1, entries: [t1('m-a', 'm-b')] });
    fake.on('m-a', () => { throw Object.assign(new Error('Resource exhausted'), { status: 429, inputTokens: 100 }); });
    fake.on('m-b', () => ({ rawText: t1Out({ ok: true }), inputTokens: 10, outputTokens: 5, meta: { thoughtsTokens: 7 } }));
    const res = await AiGateway.execute(req('agrege'));
    const a = tentatives();
    // Échec avec ventilation RÉELLE rendue : chiffrée (entrée seule → partielle), jamais ignorée ni ventilée artificiellement.
    expect(a[0]).toMatchObject({ dispatch: 'SENT', costStatus: 'PARTIAL', costMicros: calcCostMicros('m-a', 100, 0, 'gemini') ?? null });
    expect(a[1]).toMatchObject({ costStatus: 'OBSERVED', costMicros: calcCostMicros('m-b', 10, 12, 'gemini') });
    expect(res.providerRequests).toBe(2);
    expect(res.costStatus).toBe('PARTIAL');
    expect(res.costMicros).toBe((a[0].costMicros ?? 0) + (a[1].costMicros ?? 0));
    expect(res.costEvidence).toMatchObject({ attempts: 2, partialAttempts: 1 });
  });

  it('C863-C2-04 — jetons PARTIELS rendus par le fournisseur : jamais présentés comme exhaustifs', async () => {
    __setConfigForTests({ versionId: 1, entries: [t1('m-a')] });
    fake.onAny(() => ({ rawText: t1Out({ ok: true }), inputTokens: 10, outputTokens: undefined as unknown as number }));
    const res = await AiGateway.execute(req('partiel'));
    expect(tentatives()[0]).toMatchObject({ costStatus: 'PARTIAL' });
    expect(res.costStatus).toBe('PARTIAL');
    expect(exhaustiveCostMicros(res)).toBeNull();
  });

  it('C863-C2-05 — vues pures : appels historiques sans détail = part INCONNUE (jamais « 1 requête »), total = analyse + réparation', () => {
    const historique = schemaCostViewOf({
      calls: 3, providerRequests: 0, finalSuccess: 3, attemptsCostObserved: 0, attemptsCostZero: 0, attemptsCostUnknown: 0, observedCostMicros: 0,
      callsWithoutDetail: 3,
    });
    expect(historique).toMatchObject({ costStatus: 'UNKNOWN', providerRequests: 0, unknownShare: 1 });
    const analyse = schemaCostViewOf({ calls: 2, providerRequests: 3, finalSuccess: 2, attemptsCostObserved: 2, attemptsCostZero: 0, attemptsCostUnknown: 1, observedCostMicros: 50 });
    const reparation = schemaCostViewOf({ calls: 1, providerRequests: 2, finalSuccess: 1, attemptsCostObserved: 0, attemptsCostZero: 2, attemptsCostUnknown: 0, observedCostMicros: 0 });
    expect(reparation.costStatus).toBe('ZERO_REPORTED');
    const total = addSchemaCostViews(analyse, reparation);
    expect(total).toMatchObject({ calls: 3, providerRequests: 5, observedCostMicros: 50, costStatus: 'PARTIAL', attemptsCostZero: 2 });
    expect(schemaCostViewOf({ calls: 1, providerRequests: 1, finalSuccess: 1, attemptsCostObserved: 0, attemptsCostZero: 0, attemptsCostUnknown: 1, observedCostMicros: 0, attemptsNoPrice: 1 }).costStatus).toBe('NO_PRICE');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Mémoire partagée SIMULÉE avec le MÊME fencing que la base (jeton de bail valide, génération inchangée).
const base = new Map<string, CoupleRow>();
const baux = new Map<string, { token: string; until: number }>();
const journal: string[] = [];
const pannes = { load: false, get: false, claim: false, ecriture: 0, unsupported: false };
const cpt = { loads: 0, gets: 0, claims: 0, releases: 0 };
let options: Array<{ leaseMs?: number }> = [];
let seq = 0;
const enLigne = (s: import('../schema-compat').SchemaCoupleState, gen = 1): CoupleRow => ({
  ...s, generation: gen, firstRejectedAt: s.lastRejectedAt, lastHttpStatus: null, lastProviderCode: null, appVersion: null, createdAt: null, updatedAt: null,
});
type Fence = { token?: string | null; generation?: number | null } | null;
const opposable = (id: string, f: Fence | undefined, kind: 'A' | 'R', now: number): boolean => {
  const r = base.get(id);
  if (!f) return true;
  if (f.token) { const b = baux.get(id); return Boolean(b && b.token === f.token && b.until > now); }
  if (!r) return false;
  if (kind === 'A') return r.state === 'QUALIFIED';
  return r.state === 'REJECTED_CONFIRMED' || (f.generation != null ? r.generation === f.generation : r.state === 'QUALIFIED');
};
const magasin: Partial<StoreApi> = {
  loadKnownCouples: async () => {
    cpt.loads++;
    if (pannes.load) throw new Error('connexion refusée (panne simulée)');
    return { rows: [...base.values()].filter((r) => r.state !== 'NOT_TESTED'), truncated: false };
  },
  getCouple: async (keyId) => { cpt.gets++; if (pannes.get) throw new Error('lecture par clé impossible'); return base.get(keyId) ?? null; },
  claimQualification: async (key, kind, now, opts) => {
    cpt.claims++;
    options.push({ leaseMs: opts?.leaseMs });
    if (pannes.unsupported) return { status: 'unsupported' };
    if (pannes.claim) throw new Error('bail non demandable');
    const id = C.coupleKeyId(key);
    const b = baux.get(id);
    if (b && b.until > now) return { status: 'busy', until: b.until };
    if (C.qualificationDueOf(base.get(id) ?? null, now) !== kind) return { status: 'busy', until: null };
    const token = `jeton-${++seq}`;
    const until = now + (opts?.leaseMs ?? P.qualificationLeaseMs);
    baux.set(id, { token, until });
    return { status: 'claimed', token, until, attempts: seq };
  },
  releaseQualification: async (keyId, token, now, inconclusive) => {
    journal.push('release');
    const b = baux.get(keyId);
    if (!b || b.token !== token) return false;
    baux.delete(keyId);
    cpt.releases++;
    const r = base.get(keyId);
    if (inconclusive && r?.state === 'QUALIFIED') base.set(keyId, { ...r, nextRetestAt: now + P.inconclusiveRetestMs });
    return true;
  },
  releaseQualificationState: async (keyId, token, now, inconclusive) => {
    const released = await magasin.releaseQualification!(keyId, token, now, inconclusive);
    return { released, state: base.get(keyId) ?? null };
  },
  recordAcceptance: (async (key: Key, _a: string | null, now: number, served: string | null = null, fence?: Fence) => {
    journal.push('acceptance');
    if (pannes.ecriture > 0) { pannes.ecriture--; throw new Error('écriture impossible (panne simulée)'); }
    const id = C.coupleKeyId(key);
    const prev = base.get(id) ?? null;
    if (!opposable(id, fence, 'A', now)) return { applied: false, cause: 'LEASE_EXPIRED', state: prev, transition: false, previous: null };
    const next = enLigne(C.applySchemaOutcome(prev, key, { kind: 'ACCEPTED', servedModelVersion: served }, now), (prev?.generation ?? 0) + (prev?.state === 'QUALIFIED' ? 0 : 1));
    base.set(id, next);
    return { applied: true, state: next, previous: prev?.state ?? null, transition: prev?.state !== 'QUALIFIED' };
  }) as never,
  recordRejection: (async (key: Key, ev: { reason: 'EXPLICIT_SCHEMA_REJECTION' | 'GENERIC_400_ANSWERED_WITHOUT_SCHEMA' }, now: number, fence?: Fence) => {
    journal.push('rejection');
    const id = C.coupleKeyId(key);
    const prev = base.get(id) ?? null;
    if (!opposable(id, fence, 'R', now)) return { applied: false, cause: 'STALE_GENERATION', state: prev, transition: false, previous: null };
    const next = enLigne(C.applySchemaOutcome(prev, key, { kind: 'REJECTED', reason: ev.reason }, now), (prev?.generation ?? 0) + 1);
    base.set(id, next);
    return { applied: true, state: next, transition: prev?.state !== 'REJECTED_CONFIRMED', previous: prev?.state ?? null };
  }) as never,
  recordObservation: async () => true,
  noteServedModelVersion: async () => null,
  claimRetest: async () => null,
  releaseRetest: async () => false,
  recordUnsupported: async () => true,
};
const cle = (over: Partial<Key> = {}): Key => ({
  provider: 'fake', model: 'm-c863', operationCode: 't1_analyze_document', contractId: 'T1_ANALYZE_DOCUMENT', contractVersion: 7,
  schemaHash: 'aaaaaaaaaaaa', providerSchemaHash: 'bbbbbbbbbbbb', adapterVersion: 'ps-test', generationProfileHash: '-', ...over,
});
const qualifie = (k: Key, at: number, v: string | null) => base.set(C.coupleKeyId(k), enLigne(C.applySchemaOutcome(null, k, { kind: 'ACCEPTED', servedModelVersion: v }, at)));
const resetMagasin = () => {
  base.clear(); baux.clear(); journal.length = 0; options = []; seq = 0;
  Object.assign(pannes, { load: false, get: false, claim: false, ecriture: 0, unsupported: false });
  Object.assign(cpt, { loads: 0, gets: 0, claims: 0, releases: 0 });
};

describe('C863-A1 — fencing des résultats et des effets de qualification', () => {
  beforeEach(() => { resetMagasin(); C.__setSchemaCompatStoreForTests(magasin); });

  it('C863-A1-01 — bail dimensionné sur la durée TOTALE de l’essai ; validité revérifiée avant l’envoi', async () => {
    const d = await C.decideSchemaUse(cle(), T0, { callBudgetMs: 20 * 60_000 });
    expect(d).toMatchObject({ send: true, why: 'first_qualification' });
    expect(options[0].leaseMs).toBe(21 * 60_000);
    expect(d.fence).toMatchObject({ token: d.qualification!.token, until: T0 + 21 * 60_000 });
    expect(C.qualificationLeaseFor(null)).toBe(P.qualificationLeaseMs);
    // Juste avant l'envoi : bail trop court pour l'essai → aucun envoi du schéma.
    expect(C.qualificationStillValid(d, 20 * 60_000, T0 + 1)).toBe(true);
    expect(C.qualificationStillValid(d, 20 * 60_000, T0 + 2 * 60_000)).toBe(false);
  });

  it('C863-A1-02 — A expire, B reprend et REFUSE, A accepte tardivement : l’état, le cache et les alertes de B tiennent', async () => {
    const k = cle();
    const id = C.coupleKeyId(k);
    const transitions: string[] = [];
    C.__setSchemaCompatTransitionHookForTests(async (t) => { transitions.push(t.to); });
    const dA = await C.decideSchemaUse(k, T0);
    expect(dA.why).toBe('first_qualification');
    // A est arrêté (bail échu) ; B (autre processus) reprend.
    C.__resetSchemaCompatProcessForTests();
    const tB = T0 + P.qualificationLeaseMs + 1;
    const dB = await C.decideSchemaUse(k, tB);
    expect(dB.why).toBe('first_qualification');
    C.reportSchemaOutcome(dB, { kind: 'REJECTED', reason: 'EXPLICIT_SCHEMA_REJECTION' }, { httpStatus: 400 }, tB + 10);
    await C.__flushSchemaCompatWritesForTests();
    expect(base.get(id)?.state).toBe('REJECTED_CONFIRMED');
    // A accepte TARDIVEMENT avec son ancien jeton : écarté (non opposable), aucune transition, aucun bail libéré.
    C.reportSchemaOutcome(dA, { kind: 'ACCEPTED' }, {}, tB + 20);
    await C.__flushSchemaCompatWritesForTests();
    expect(base.get(id)?.state).toBe('REJECTED_CONFIRMED');
    expect(transitions).toEqual(['REJECTED_CONFIRMED']);
    expect(C.schemaMemoryDegradedStats().writesFenced).toBe(1);
    // Le cache du processus reflète l'état COURANT (pas la qualification tardive) : pas de schéma.
    expect(await C.decideSchemaUse(k, tB + 30)).toMatchObject({ send: false, why: 'recent_rejection' });
  });

  it('C863-A1-03 — inverse : B accepte, A refuse tardivement (ancien bail) — la qualification de B tient', async () => {
    const k = cle({ model: 'm-inverse' });
    const id = C.coupleKeyId(k);
    const dA = await C.decideSchemaUse(k, T0);
    C.__resetSchemaCompatProcessForTests();
    const tB = T0 + P.qualificationLeaseMs + 1;
    const dB = await C.decideSchemaUse(k, tB);
    C.reportSchemaOutcome(dB, { kind: 'ACCEPTED', servedModelVersion: 'v1' }, {}, tB + 5);
    await C.__flushSchemaCompatWritesForTests();
    C.reportSchemaOutcome(dA, { kind: 'REJECTED', reason: 'GENERIC_400_ANSWERED_WITHOUT_SCHEMA' }, { httpStatus: 400 }, tB + 6);
    await C.__flushSchemaCompatWritesForTests();
    expect(base.get(id)).toMatchObject({ state: 'QUALIFIED', servedModelVersion: 'v1' });
    expect(await C.decideSchemaUse(k, tB + 7)).toMatchObject({ send: true, why: 'qualified' });
  });

  it('C863-A1-04 — résultat ÉCRIT avant la libération du bail ; qualification publiée seulement APRÈS confirmation durable', async () => {
    const k = cle({ model: 'm-ordre' });
    const d = await C.decideSchemaUse(k, T0);
    C.reportSchemaOutcome(d, { kind: 'ACCEPTED' }, {}, T0 + 1);
    // Avant l'écriture : aucune qualification locale publiée (le couple reste « en cours »).
    expect(await C.decideSchemaUse(k, T0 + 2)).toMatchObject({ send: false, why: 'qualification_in_progress' });
    await C.__flushSchemaCompatWritesForTests();
    expect(journal).toEqual(['acceptance', 'release']);
    expect(await C.decideSchemaUse(k, T0 + 3)).toMatchObject({ send: true, why: 'qualified' });
  });

  it('C863-A1-05 — écriture en ÉCHEC : reprise bornée, bail CONSERVÉ (jamais de libération prématurée ni de rafale)', async () => {
    const k = cle({ model: 'm-panne-ecriture' });
    const d = await C.decideSchemaUse(k, T0);
    pannes.ecriture = 10;
    C.reportSchemaOutcome(d, { kind: 'ACCEPTED' }, {}, T0 + 1);
    await C.__flushSchemaCompatWritesForTests();
    expect(journal.filter((j) => j === 'acceptance')).toHaveLength(3);
    expect(journal).not.toContain('release');
    expect(cpt.releases).toBe(0);
    expect(C.schemaMemoryDegradedStats().writesFailed).toBe(1);
    // Aucune qualification supposée ; les autres instances restent en JSON jusqu'à l'échéance du bail.
    C.__resetSchemaCompatProcessForTests();
    expect(await C.decideSchemaUse(k, T0 + 10)).toMatchObject({ send: false, why: 'qualification_in_progress' });
    expect(base.get(C.coupleKeyId(k))?.state ?? 'NOT_TESTED').not.toBe('QUALIFIED');
  });

  it('C863-A1-06 — réservation SQL aboutie APRÈS le délai : décision dégradée, bail tardif rendu aussitôt', async () => {
    const k = cle({ model: 'm-tardif' });
    const lent: Partial<StoreApi> = {
      ...magasin,
      claimQualification: async (key, kind, now, opts) => {
        await new Promise((r) => setTimeout(r, 2_300));
        return magasin.claimQualification!(key, kind, now, opts);
      },
    };
    C.__setSchemaCompatStoreForTests(lent);
    const d = await C.decideSchemaUse(k, T0);
    expect(d).toMatchObject({ send: false, why: 'memory_unavailable', degraded: { cause: 'claim_failed' } });
    await new Promise((r) => setTimeout(r, 600));
    await C.__flushSchemaCompatWritesForTests();
    expect(C.schemaMemoryDegradedStats().lateClaimsReleased).toBe(1);
    expect(baux.size).toBe(0);
  }, 10_000);

  it('C863-A1-07 — UN seul essai par clé : 25 décisions concurrentes → 1 bail ; une autre clé reste indépendante', async () => {
    const k = cle({ model: 'm-25' });
    const ds = await Promise.all(Array.from({ length: 25 }, () => C.decideSchemaUse(k, T0)));
    expect(ds.filter((d) => d.send)).toHaveLength(1);
    expect(ds.filter((d) => d.why === 'qualification_in_progress')).toHaveLength(24);
    expect(await C.decideSchemaUse(cle({ model: 'm-autre-cle' }), T0)).toMatchObject({ send: true, why: 'first_qualification' });
  });
});

describe('C863-A2 — cache périmé et stockage indisponible', () => {
  beforeEach(() => { resetMagasin(); C.__setSchemaCompatStoreForTests(magasin); });

  it('C863-A2-01 — cache jamais RAJEUNI : qualification ancienne non prouvable au-delà de la tolérance ; refus connu toujours opposable', async () => {
    const q = cle({ model: 'm-qualifie' });
    const r = cle({ model: 'm-refuse' });
    qualifie(q, T0 - 1000, 'v1');
    base.set(C.coupleKeyId(r), enLigne(C.applySchemaOutcome(null, r, { kind: 'REJECTED', reason: 'EXPLICIT_SCHEMA_REJECTION' }, T0 - 1000)));
    expect(await C.decideSchemaUse(q, T0)).toMatchObject({ send: true, why: 'qualified' });
    // Dans l'intervalle, B refuse le schéma : la base change, A ne peut plus la lire.
    pannes.load = true;
    const dansTolerance = T0 + C.SHARED_TTL_MS + 5;
    expect(await C.decideSchemaUse(q, dansTolerance)).toMatchObject({ send: true, why: 'qualified' });
    const horsTolerance = T0 + C.SHARED_TTL_MS + C.QUALIFIED_STALE_TOLERANCE_MS + 1;
    expect(await C.decideSchemaUse(q, horsTolerance)).toMatchObject({ send: false, why: 'memory_unavailable', degraded: { cause: 'stale_cache' } });
    // Encore plus tard : toujours aucun schéma (la panne ne prolonge rien).
    expect(await C.decideSchemaUse(q, horsTolerance + 10 * C.SHARED_TTL_MS)).toMatchObject({ send: false, degraded: { cause: 'stale_cache' } });
    expect(await C.decideSchemaUse(r, horsTolerance + 10 * C.SHARED_TTL_MS)).toMatchObject({ send: false, why: 'recent_rejection' });
    // Lectures bornées : une tentative par période, pas une par décision.
    expect(cpt.loads).toBeLessThanOrEqual(13);
    // Base restaurée : reprise automatique sur lecture saine.
    pannes.load = false;
    expect(await C.decideSchemaUse(q, horsTolerance + 12 * C.SHARED_TTL_MS)).toMatchObject({ send: true, why: 'qualified' });
  });

  it('C863-A2-02 — migration du bail absente (`unsupported`) : JSON sans schéma, compteur DISTINCT (jamais un essai non réservé)', async () => {
    pannes.unsupported = true;
    const d = await C.decideSchemaUse(cle({ model: 'm-1980' }), T0);
    expect(d).toMatchObject({ send: false, why: 'memory_unavailable', degraded: { cause: 'migration_not_ready' } });
    expect(C.schemaMemoryDegradedStats().byWhy).toMatchObject({ migration_not_ready: 1 });
  });

  it('C863-A2-03 — erreur imprévue de décision : plus d’exception pour un QUALIFIED local — aucun schéma', async () => {
    const k = cle({ model: 'm-erreur' });
    qualifie(k, T0, 'v1');
    expect(await C.decideSchemaUse(k, T0)).toMatchObject({ send: true });
    C.__setSchemaCompatStoreForTests({ ...magasin, loadKnownCouples: () => { throw new Error('erreur imprévue (synchrone)'); } }, { keepProcessMemory: true });
    const d = await C.decideSchemaUse(k, T0 + 3 * C.SHARED_TTL_MS);
    expect(d.send).toBe(false);
  });

  it('C863-A2-04 — lecture par clé (cache tronqué) en échec : bornée, sans retry en cascade', async () => {
    C.__setSchemaCompatStoreForTests({ ...magasin, loadKnownCouples: async () => ({ rows: [], truncated: true }) });
    pannes.get = true;
    const k = cle({ model: 'm-tronque' });
    expect(await C.decideSchemaUse(k, T0)).toMatchObject({ send: false, degraded: { cause: 'couple_unreadable' } });
    for (let i = 1; i <= 20; i++) await C.decideSchemaUse(k, T0 + i);
    expect(cpt.gets).toBe(1);
    pannes.get = false;
    expect(await C.decideSchemaUse(k, T0 + C.SHARED_TTL_MS + 1)).toMatchObject({ send: true, why: 'first_qualification' });
    expect(cpt.gets).toBe(2);
  });

  it('C863-A2-05 — 40 décisions CONCURRENTES à froid : une seule lecture du cache, un seul envoi du schéma non qualifié', async () => {
    const k = cle({ model: 'm-40' });
    const ds = await Promise.all(Array.from({ length: 40 }, () => C.decideSchemaUse(k, T0)));
    expect(cpt.loads).toBe(1);
    expect(ds.filter((d) => d.send)).toHaveLength(1);
  });
});

describe('C863-A3 — backoff de requalification réellement opposable', () => {
  beforeEach(() => { resetMagasin(); C.__setSchemaCompatStoreForTests(magasin); });

  it('C863-A3-01 — alias stable, TTL échue : avant / à / après le report ; seule une acceptation AVEC schéma renouvelle la fenêtre', async () => {
    const k = cle({ model: 'm-alias' });
    qualifie(k, T0, null);
    expect(await C.decideSchemaUse(k, T0 + P.uncertainQualificationTtlMs - 1)).toMatchObject({ send: true, why: 'qualified' });
    const echu = T0 + P.uncertainQualificationTtlMs + 1;
    const d = await C.decideSchemaUse(k, echu);
    expect(d).toMatchObject({ send: true, why: 'requalification_due', qualification: { kind: 'REQUALIFY' } });
    C.reportSchemaOutcome(d, { kind: 'INCONCLUSIVE' }, {}, echu + 1);
    await C.__flushSchemaCompatWritesForTests();
    // Cache SYNCHRONISÉ avec le report écrit en base (même processus, sans relecture).
    expect(await C.decideSchemaUse(k, echu + 2)).toMatchObject({ send: false, why: 'requalification_deferred' });
    // Redémarrage : le report est relu en base, toujours opposable.
    C.__resetSchemaCompatProcessForTests();
    expect(await C.decideSchemaUse(k, echu + P.inconclusiveRetestMs)).toMatchObject({ send: false, why: 'requalification_deferred' });
    // À l'échéance : UN essai réservé (concurrence : un seul parmi dix).
    C.__resetSchemaCompatProcessForTests();
    const ds = await Promise.all(Array.from({ length: 10 }, () => C.decideSchemaUse(k, echu + 1 + P.inconclusiveRetestMs)));
    expect(ds.filter((x) => x.send)).toHaveLength(1);
    const gagnant = ds.find((x) => x.send)!;
    C.reportSchemaOutcome(gagnant, { kind: 'ACCEPTED' }, {}, echu + 2 + P.inconclusiveRetestMs);
    await C.__flushSchemaCompatWritesForTests();
    expect(await C.decideSchemaUse(k, echu + 3 + P.inconclusiveRetestMs)).toMatchObject({ send: true, why: 'qualified' });
  });

  it('C863-A3-02 — réponse SANS schéma : version mémorisée, incertitude JAMAIS levée ; version connue jamais invalidée', () => {
    const k = cle();
    const incertaine = C.applySchemaOutcome(null, k, { kind: 'ACCEPTED', servedModelVersion: null }, T0);
    const vu = C.applyServedVersion(incertaine, 'gemini-x-003', T0 + 1)!;
    expect(vu).toMatchObject({ servedModelVersion: 'gemini-x-003', versionUncertain: true, servedVersionAtState: null });
    expect(C.qualificationDueOf(vu, T0 + P.uncertainQualificationTtlMs)).toBe('REQUALIFY');
    const connue = C.applySchemaOutcome(null, k, { kind: 'ACCEPTED', servedModelVersion: 'v1' }, T0);
    expect(C.qualifiedValidityOf(connue, T0 + 365 * 86_400_000)).toBe('VALID');
    expect(C.qualificationDueOf(C.applyServedVersion(connue, 'v2', T0 + 2)!, T0 + 3)).toBeNull();
  });

  it('C863-A3-03 — profil / adaptateur distincts : AUTRES clés, la qualification existante est intacte', async () => {
    const k = cle({ model: 'm-profil' });
    qualifie(k, T0, 'v1');
    expect(await C.decideSchemaUse(cle({ model: 'm-profil', generationProfileHash: 'abcdef123456' }), T0 + 1)).toMatchObject({ why: 'first_qualification' });
    expect(await C.decideSchemaUse(cle({ model: 'm-profil', adapterVersion: 'ps-2' }), T0 + 2)).toMatchObject({ why: 'first_qualification' });
    expect(await C.decideSchemaUse(k, T0 + 3)).toMatchObject({ send: true, why: 'qualified' });
  });
});
