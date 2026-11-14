/**
 * Lot 114 (carte #776 — AC04, AC05, AC06, AC17) — la PASSERELLE et la
 * mémoire partagée des incompatibilités de schéma.
 *
 * Passerelle réelle, fournisseur SIMULÉ (FakeProvider). La mémoire partagée
 * est un magasin simulé qui applique la même politique que la base
 * (`policy.ts`) et SURVIT au « redémarrage » du processus
 * (`__resetSchemaCompatProcessForTests` : mémoire locale et cache vidés) —
 * c'est ainsi que sont rejoués le second worker et le redémarrage. Les
 * écritures SQL réelles sont vérifiées par le scénario de bout en bout
 * `l114j-t1-schemas-gemini-couverture.e2e.ts`. Horloge fixée (aucune
 * dépendance à la date du jour).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const capture = vi.hoisted(() => ({ traces: [] as Array<Record<string, unknown>> }));
vi.mock('../diagnostics/diagnostic.repository', async (orig) => ({
  ...(await orig<typeof import('../diagnostics/diagnostic.repository')>()),
  recordCallDiagnostic: vi.fn(async () => undefined),
}));
vi.mock('../../telemetry/ai-trace.service', async (orig) => ({
  ...(await orig<typeof import('../../telemetry/ai-trace.service')>()),
  recordCallTrace: vi.fn(async (t: Record<string, unknown>) => { capture.traces.push(t); return capture.traces.length; }),
}));

const { AiGateway } = await import('../ai-gateway');
const { FakeProvider, setAiProvider } = await import('../providers');
const rc = await import('../output-resolution/runtime-contract');
const { providerJsonSchema, PROVIDER_SCHEMA_ADAPTER_VERSION } = await import('../output-resolution/provider-schema');
const C = await import('../schema-compat');
const { refusalDecision } = await import('../fallback-context');
const { T1GroupUploadOutput } = await import('../../source-analysis/master/t1-contract');
const { T1_TEST_OPERATION, t1TestVariables } = await import('./t1-master-request');
type StoreApi = typeof import('../schema-compat/store');
type CoupleRow = import('../schema-compat/store').SchemaCoupleRow;
type Key = import('../schema-compat').SchemaCoupleKey;

const P = C.SCHEMA_COMPAT_POLICY;
const T0 = Date.UTC(2026, 10, 13, 8, 0, 0);

type Trace = {
  model: string; status: string; errorCode?: string;
  providerMeta?: { structuredOutput?: string };
  providerRequest?: { responseSchemaSent: boolean; schemaOmittedReason: string | null; schemaCompat?: { state: string; decision: string; why: string; retest: boolean; policyVersion: number; adapterVersion: string } };
  providerAttempts?: Array<{ kind: string; outcome: string; responseSchemaSent: boolean; httpStatus: number | null; responseMimeType: string | null; durationMs: number }>;
  runtimeContract?: { contractId: string; contractVersion: number; schemaHash: string };
};

const invalidArgument = () => Object.assign(
  new Error('{"error":{"code":400,"message":"Request contains an invalid argument.","status":"INVALID_ARGUMENT"}}'), { name: 'ClientError', status: 400 },
);
const groupOk = () => JSON.stringify({ task: 'GROUP_UPLOAD', groups: [[0]], reason: 'un seul fichier' });
const requete = () => ({
  useCaseCode: 'SOURCE_ANALYSIS' as const, operationCode: T1_TEST_OPERATION, accountId: 1,
  promptVariables: t1TestVariables('facture'), outputSchema: T1GroupUploadOutput, idempotencyKey: `l114j-${Math.random()}`,
});
const contrat = () => rc.resolveRuntimeContract({ schemaName: 'T1GroupUploadOutput', operationCode: T1_TEST_OPERATION, callerSchema: T1GroupUploadOutput }).contract;
const cleDe = (model: string, over: Partial<Key> = {}): Key => {
  const c = contrat();
  return {
    provider: 'fake', model, operationCode: T1_TEST_OPERATION, contractId: c.contractId, contractVersion: c.contractVersion, schemaHash: c.schemaHash,
    providerSchemaHash: rc.providerSchemaHash(providerJsonSchema(c.canonical).schema), adapterVersion: PROVIDER_SCHEMA_ADAPTER_VERSION, ...over,
  };
};
const traces = () => capture.traces as Trace[];

/** « Base » simulée : survit au redémarrage du processus, partagée par tous les « workers ». */
const base = new Map<string, CoupleRow>();
const ecritures = { rejections: 0, acceptances: 0, claims: 0, claimsWon: 0, releases: 0 };
const transitions: Array<{ to: string; from: string | null; keyId: string }> = [];
const enLigne = (s: import('../schema-compat').SchemaCoupleState): CoupleRow => ({
  ...s, firstRejectedAt: s.lastRejectedAt, lastHttpStatus: null, lastProviderCode: null, appVersion: null, createdAt: null, updatedAt: null,
});
const magasin: Partial<StoreApi> = {
  loadKnownCouples: async () => [...base.values()].filter((r) => r.state !== 'UNSUPPORTED_BY_CONTRACT' && r.state !== 'NOT_TESTED'),
  recordRejection: async (key, ev, now) => {
    ecritures.rejections++;
    const prev = base.get(C.coupleKeyId(key)) ?? null;
    const dejaMemorise = prev?.state === 'REJECTED_CONFIRMED' && (prev.nextRetestAt ?? 0) > now;
    const next = { ...enLigne(C.applySchemaOutcome(prev, key, { kind: 'REJECTED', reason: ev.reason }, now)), lastHttpStatus: ev.httpStatus, lastProviderCode: ev.providerCode };
    base.set(next.keyId, next);
    return { state: next, transition: !dejaMemorise };
  },
  recordAcceptance: async (key, _app, now) => {
    ecritures.acceptances++;
    const prev = base.get(C.coupleKeyId(key)) ?? null;
    const next = enLigne(C.applySchemaOutcome(prev, key, { kind: 'ACCEPTED' }, now));
    base.set(next.keyId, next);
    return { state: next, previous: prev?.state ?? null };
  },
  claimRetest: async (keyId, now) => {
    ecritures.claims++;
    const prev = base.get(keyId);
    const claimed = prev ? C.claimRetestOf(prev, now) : null;
    if (!claimed) return null;
    ecritures.claimsWon++;
    const row = enLigne(claimed);
    base.set(keyId, row);
    return row;
  },
  releaseRetest: async (keyId, now) => {
    ecritures.releases++;
    const prev = base.get(keyId);
    if (!prev || prev.state !== 'NEEDS_RECHECK') return false;
    base.set(keyId, enLigne(C.applySchemaOutcome(prev, prev.key, { kind: 'INCONCLUSIVE' }, now)));
    return true;
  },
  recordUnsupported: async () => true,
};

/** Fournisseur qui refuse (400 générique) toute requête portant un schéma. */
const refuseLeSchema = (f: InstanceType<typeof FakeProvider>) => f.onAny((input) => {
  if (input.responseSchema) throw invalidArgument();
  return { rawText: groupOk(), inputTokens: 10, outputTokens: 5 };
});
const accepteTout = (f: InstanceType<typeof FakeProvider>) => f.onAny(() => ({ rawText: groupOk(), inputTokens: 10, outputTokens: 5 }));
const avecSchema = (f: InstanceType<typeof FakeProvider>) => f.calls.filter((c) => c.responseSchema !== undefined).length;

let fake: InstanceType<typeof FakeProvider>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  fake = new FakeProvider();
  setAiProvider(fake);
  capture.traces.length = 0;
  base.clear();
  transitions.length = 0;
  for (const k of Object.keys(ecritures) as Array<keyof typeof ecritures>) ecritures[k] = 0;
  C.__setSchemaCompatStoreForTests(magasin);
  C.__setSchemaCompatTransitionHookForTests(async (t) => { transitions.push({ to: t.to, from: t.from, keyId: t.keyId }); });
  delete process.env.AI_OUTPUT_REPAIR_PASS;
  delete process.env.AI_STRUCTURED_OUTPUT;
});
afterEach(async () => {
  await C.__flushSchemaCompatWritesForTests();
  C.__setSchemaCompatStoreForTests(null);
  C.__setSchemaCompatTransitionHookForTests(null);
  vi.useRealTimers();
});

describe('L114J-GW — refus mémorisé : partagé, durable, tracé (AC06, AC17)', () => {
  it('L114J-GW-01 — refus puis réponse sans schéma : UN appel métier réussi, DEUX requêtes fournisseur, couple REJECTED_CONFIRMED en base', async () => {
    refuseLeSchema(fake);
    const res = await AiGateway.execute(requete());
    await C.__flushSchemaCompatWritesForTests();
    expect(res.usedFallback).toBe(false);
    expect(fake.calls.map((c) => c.responseSchema !== undefined)).toEqual([true, false]);
    const t = traces()[0];
    // AC17 : réussite finale ET refus visibles ensemble, durées par tentative.
    expect(t).toMatchObject({ status: 'success', providerMeta: { structuredOutput: 'schema_rejected_retried_without' } });
    expect(t.providerAttempts!.map((a) => [a.kind, a.outcome, a.responseSchemaSent, a.httpStatus, a.responseMimeType])).toEqual([
      ['initial', 'FAILED', true, 400, 'application/json'], ['diagnostic_retry', 'SUCCESS', false, null, 'application/json'],
    ]);
    for (const a of t.providerAttempts!) expect(typeof a.durationMs).toBe('number');
    // Décision tracée : couple non testé, schéma transmis, versions de politique et d'adaptateur.
    expect(t.providerRequest!.schemaCompat).toEqual({ state: 'NOT_TESTED', decision: 'sent', why: 'not_tested', retest: false, policyVersion: P.version, adapterVersion: PROVIDER_SCHEMA_ADAPTER_VERSION });
    // Mémoire PARTAGÉE : une ligne par couple, motif et réexamen.
    const row = base.get(C.coupleKeyId(cleDe(res.model)))!;
    expect(row).toMatchObject({ state: 'REJECTED_CONFIRMED', reason: 'GENERIC_400_ANSWERED_WITHOUT_SCHEMA', rejectionCount: 1, nextRetestAt: T0 + P.firstRetestMs, lastHttpStatus: 400, lastProviderCode: 'INVALID_ARGUMENT' });
    // Une réussite sans schéma ne QUALIFIE jamais le couple.
    expect(ecritures.acceptances).toBe(0);
    expect(transitions).toEqual([{ to: 'REJECTED_CONFIRMED', from: null, keyId: row.keyId }]);
  });

  it('L114J-GW-02 — APRÈS REDÉMARRAGE et sur un AUTRE worker : le refus est connu, le schéma n’est pas renvoyé, aucun 400 repayé', async () => {
    refuseLeSchema(fake);
    await AiGateway.execute(requete());
    await C.__flushSchemaCompatWritesForTests();
    // Redémarrage / second worker : mémoire locale et cache vides, seule la base fait foi.
    C.__resetSchemaCompatProcessForTests();
    fake.calls.length = 0;
    for (let i = 0; i < 4; i++) await AiGateway.execute(requete());
    expect(fake.calls).toHaveLength(4);
    expect(avecSchema(fake)).toBe(0);
    const t = traces()[traces().length - 1];
    expect(t.providerRequest).toMatchObject({ responseSchemaSent: false, schemaOmittedReason: 'recent_rejection', schemaCompat: { state: 'REJECTED_CONFIRMED', decision: 'skipped', why: 'recent_rejection', retest: false } });
    expect(t.providerMeta?.structuredOutput).toBe('schema_skipped_recent_rejection');
    // Pas de doublon : aucune nouvelle écriture de refus, aucune nouvelle transition (donc aucune alerte de plus).
    expect(ecritures.rejections).toBe(1);
    expect(transitions).toHaveLength(1);
  });

  it('L114J-GW-03 — sans base (tests unitaires, migration absente) : la mémoire locale assure le comportement antérieur', async () => {
    C.__setSchemaCompatStoreForTests(null);
    refuseLeSchema(fake);
    const res = await AiGateway.execute(requete());
    expect(C.schemaRejectedRecently(res.model, contrat().schemaHash)).toBe(true);
    fake.calls.length = 0;
    await AiGateway.execute(requete());
    expect(fake.calls.map((c) => c.responseSchema !== undefined)).toEqual([false]);
    expect(base.size).toBe(0);
  });
});

describe('L114J-GW — invalidation contrôlée (AC06)', () => {
  it('L114J-GW-04 — un autre modèle, un autre schéma projeté ou un autre adaptateur n’héritent PAS du refus', async () => {
    refuseLeSchema(fake);
    const res = await AiGateway.execute(requete());
    await C.__flushSchemaCompatWritesForTests();
    const now = T0 + 1000;
    expect(await C.decideSchemaUse(cleDe(res.model), now)).toMatchObject({ send: false, state: 'REJECTED_CONFIRMED' });
    for (const over of [{ model: 'autre-modele' }, { providerSchemaHash: 'ffffffffffff' }, { adapterVersion: 'ps-suivant' }, { schemaHash: 'eeeeeeeeeeee' }, { operationCode: 't3_document_naming' }] as Array<Partial<Key>>) {
      expect(await C.decideSchemaUse(cleDe(res.model, over), now)).toMatchObject({ send: true, retest: false, state: 'NOT_TESTED', why: 'not_tested' });
    }
  });
});

describe('L114J-GW — réexamen borné, sans rafale (AC06)', () => {
  const refuserPuisEcheance = async (): Promise<string> => {
    refuseLeSchema(fake);
    const res = await AiGateway.execute(requete());
    await C.__flushSchemaCompatWritesForTests();
    C.__resetSchemaCompatProcessForTests();
    fake.calls.length = 0;
    capture.traces.length = 0;
    vi.setSystemTime(T0 + P.firstRetestMs + 60_000);
    return res.model;
  };

  it('L114J-GW-05 — échéance atteinte, 8 requêtes CONCURRENTES : une seule porte le schéma (réexamen réservé), les autres restent sans schéma', async () => {
    await refuserPuisEcheance();
    await Promise.all(Array.from({ length: 8 }, () => AiGateway.execute(requete())));
    await C.__flushSchemaCompatWritesForTests();
    expect(avecSchema(fake)).toBe(1);
    expect(ecritures.claimsWon).toBe(1);
    const reexamens = traces().filter((t) => t.providerRequest?.schemaCompat?.retest);
    expect(reexamens).toHaveLength(1);
    expect(reexamens[0].providerRequest!.schemaCompat).toMatchObject({ decision: 'sent', why: 'retest_due' });
    for (const t of traces().filter((x) => !x.providerRequest?.schemaCompat?.retest)) {
      expect(t.providerRequest).toMatchObject({ responseSchemaSent: false, schemaOmittedReason: 'recent_rejection' });
    }
    // 8 appels métier réussis ; 9 requêtes fournisseur (un seul refus repayé, pas huit).
    expect(traces().every((t) => t.status === 'success')).toBe(true);
    expect(fake.calls).toHaveLength(9);
  });

  it('L114J-GW-06 — réexamen REFUSÉ : délai doublé, schéma de nouveau non transmis', async () => {
    const model = await refuserPuisEcheance();
    await AiGateway.execute(requete());
    await C.__flushSchemaCompatWritesForTests();
    const row = base.get(C.coupleKeyId(cleDe(model)))!;
    expect(row).toMatchObject({ state: 'REJECTED_CONFIRMED', consecutiveRejections: 2, rejectionCount: 2, retestCount: 1, retestClaimedUntil: null });
    expect(row.nextRetestAt).toBe(T0 + P.firstRetestMs + 60_000 + 2 * P.firstRetestMs);
    fake.calls.length = 0;
    await AiGateway.execute(requete());
    expect(avecSchema(fake)).toBe(0);
    // Même condition : pas de nouvelle transition (l'alerte existante est mise à jour, jamais doublée).
    expect(transitions.filter((t) => t.to === 'REJECTED_CONFIRMED')).toHaveLength(2);
  });

  it('L114J-GW-07 — réexamen ACCEPTÉ : couple QUALIFIED par un appel réel, schéma de nouveau transmis, alerte à résoudre', async () => {
    const model = await refuserPuisEcheance();
    accepteTout(fake);
    await AiGateway.execute(requete());
    await C.__flushSchemaCompatWritesForTests();
    expect(base.get(C.coupleKeyId(cleDe(model)))).toMatchObject({ state: 'QUALIFIED', reason: 'ACCEPTED_ON_REAL_CALL', consecutiveRejections: 0, nextRetestAt: null });
    expect(transitions[transitions.length - 1]).toMatchObject({ to: 'QUALIFIED', from: 'NEEDS_RECHECK' });
    expect(traces()[0].providerMeta?.structuredOutput).toBe('requested_schema');
    // Un autre worker (cache vide) transmet de nouveau le schéma.
    C.__resetSchemaCompatProcessForTests();
    fake.calls.length = 0;
    await AiGateway.execute(requete());
    expect(avecSchema(fake)).toBe(1);
    expect(traces()[traces().length - 1].providerRequest!.schemaCompat).toMatchObject({ state: 'QUALIFIED', decision: 'sent', why: 'qualified' });
  });

  it('L114J-GW-08 — réexamen SANS CONCLUSION (indisponibilité 503) : rien n’est déduit sur le schéma, réservation rendue, court report', async () => {
    const model = await refuserPuisEcheance();
    fake.onAny(() => { throw Object.assign(new Error('{"error":{"code":503,"message":"overloaded","status":"UNAVAILABLE"}}'), { status: 503 }); });
    await AiGateway.execute(requete()).catch(() => null);
    await C.__flushSchemaCompatWritesForTests();
    const row = base.get(C.coupleKeyId(cleDe(model)))!;
    expect(row).toMatchObject({ state: 'REJECTED_CONFIRMED', reason: 'RETEST_INCONCLUSIVE', consecutiveRejections: 1, retestClaimedUntil: null });
    expect(row.nextRetestAt).toBe(T0 + P.firstRetestMs + 60_000 + P.inconclusiveRetestMs);
    expect(ecritures.releases).toBeGreaterThanOrEqual(1);
    expect(ecritures.rejections).toBe(1);
  });
});

describe('L114J-GW — qualification par appel réel et limites (AC04, AC05)', () => {
  it('L114J-GW-09 — schéma accepté : QUALIFIED écrit une fois (pas une écriture par appel), aucune requête supplémentaire', async () => {
    accepteTout(fake);
    for (let i = 0; i < 5; i++) await AiGateway.execute(requete());
    await C.__flushSchemaCompatWritesForTests();
    expect(fake.calls).toHaveLength(5);
    expect(avecSchema(fake)).toBe(5);
    expect(ecritures.acceptances).toBe(1);
    expect([...base.values()][0]).toMatchObject({ state: 'QUALIFIED' });
    expect(traces()[4].providerRequest!.schemaCompat).toMatchObject({ state: 'QUALIFIED', decision: 'sent', why: 'qualified' });
    expect(transitions).toEqual([]);
  });

  it('L114J-GW-10 — AC04 : quota, authentification, délai, réseau, indisponibilité → AUCUN essai sans schéma, rien de mémorisé', async () => {
    const erreurs = [
      Object.assign(new Error('{"error":{"code":429,"message":"quota","status":"RESOURCE_EXHAUSTED"}}'), { status: 429 }),
      Object.assign(new Error('{"error":{"code":401,"message":"API key not valid","status":"UNAUTHENTICATED"}}'), { status: 401 }),
      Object.assign(new Error('{"error":{"code":503,"message":"overloaded","status":"UNAVAILABLE"}}'), { status: 503 }),
      Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' }),
    ];
    for (const erreur of erreurs) {
      fake.reset();
      capture.traces.length = 0;
      fake.onAny(() => { throw erreur; });
      await AiGateway.execute(requete()).catch(() => null);
      await C.__flushSchemaCompatWritesForTests();
      // Chaque modèle sollicité ne reçoit qu'UNE requête : jamais d'essai diagnostique.
      const parModele = new Map<string, number>();
      for (const c of fake.calls) parModele.set(c.model, (parModele.get(c.model) ?? 0) + 1);
      for (const nb of parModele.values()) expect(nb).toBe(1);
      for (const t of traces()) for (const a of t.providerAttempts ?? []) expect(a.kind).toBe('initial');
    }
    expect(base.size).toBe(0);
    expect(ecritures.rejections).toBe(0);
  });

  it('L114J-GW-11 — AC05 : l’essai sans schéma garde application/json et le contrat dans le prompt ; un JSON non conforme n’est JAMAIS une réussite', async () => {
    process.env.AI_OUTPUT_REPAIR_PASS = 'off';
    fake.onAny((input) => {
      if (input.responseSchema) throw invalidArgument();
      return { rawText: JSON.stringify({ task: 'GROUP_UPLOAD', groups: 'pas une liste' }), inputTokens: 10, outputTokens: 5 };
    });
    const err = await AiGateway.execute(requete()).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    const sans = fake.calls.filter((c) => c.responseSchema === undefined);
    expect(sans.length).toBeGreaterThan(0);
    for (const c of sans) {
      expect(c.jsonResponse).toBe(true);
      expect(c.prompt).toContain(contrat().schemaHash);
    }
    expect(traces().some((t) => t.status === 'success')).toBe(false);
    expect(traces()[0]).toMatchObject({ status: 'error', errorCode: 'INVALID_OUTPUT' });
    // Même contrat runtime pour la génération et la validation (AC03).
    expect(traces()[0].runtimeContract).toMatchObject({ contractId: contrat().contractId, contractVersion: contrat().contractVersion, schemaHash: contrat().schemaHash });
  });

  it('L114J-GW-12 — un refus de SCHÉMA n’est jamais une indisponibilité du modèle (#771) : aucun verdict de disponibilité', async () => {
    const explicite = Object.assign(new Error('Invalid JSON payload: response_schema is too complex'), { status: 400 });
    expect(await refusalDecision({ model: 'gemini-x', error: invalidArgument(), httpStatus: 400 })).toBeNull();
    expect(await refusalDecision({ model: 'gemini-x', error: explicite, httpStatus: 400 })).toBeNull();
    // Même quand le message cite le modèle : requête refusée, pas modèle indisponible.
    const citant = Object.assign(new Error('{"error":{"code":400,"message":"Invalid argument for models/gemini-x: response schema","status":"INVALID_ARGUMENT"}}'), { status: 400 });
    expect(await refusalDecision({ model: 'gemini-x', error: citant, httpStatus: 400 })).toBeNull();
  });

  it('L114J-GW-13 — mémoire partagée illisible ou lente : l’appel aboutit quand même (jamais bloquant)', async () => {
    C.__setSchemaCompatStoreForTests({
      loadKnownCouples: async () => { throw new Error('base indisponible'); },
      recordAcceptance: async () => { throw new Error('base indisponible'); },
      recordRejection: async () => { throw new Error('base indisponible'); },
    });
    refuseLeSchema(fake);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await AiGateway.execute(requete());
    await C.__flushSchemaCompatWritesForTests();
    expect(res.data).toMatchObject({ task: 'GROUP_UPLOAD' });
    // La mémoire locale prend le relais : pas de second refus payé.
    fake.calls.length = 0;
    await AiGateway.execute(requete());
    expect(avecSchema(fake)).toBe(0);
    warn.mockRestore();
  });
});
