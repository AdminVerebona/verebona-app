/**
 * Carte #838 — passerelle IA : qualification réservée, mémoire en panne,
 * requalification bornée, traces et coûts de TOUTES les tentatives.
 *
 * Passerelle RÉELLE, fournisseur SIMULÉ (FakeProvider) ; mémoire partagée
 * SIMULÉE (magasin en mémoire appliquant la même politique que la base,
 * bail atomique compris) qui survit au « redémarrage » d'un processus
 * (`__resetSchemaCompatProcessForTests`) — c'est ainsi qu'un second worker
 * est rejoué. Les écritures SQL réelles (bail, concurrence multi-connexions)
 * sont prouvées par `src/test/e2e/scenarios/c838-gateway-t1-ecarts.e2e.ts`.
 * Aucun appel Gemini : ces tests n'établissent PAS l'acceptation réelle d'un
 * schéma par le fournisseur.
 *
 *   C838-A1-*  premier essai de qualification réservé (bail, reprise) ;
 *   C838-A2-*  panne de la mémoire partagée : dégradation conservatrice ;
 *   C838-A3-*  requalification bornée d'une version servie incertaine ;
 *   C838-C1-*  traces de la réparation (refus du schéma puis JSON) ;
 *   C838-C2-*  nature du coût : observé, zéro prouvé, inconnu, partiel.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const h = vi.hoisted(() => ({ traces: [] as Array<Record<string, unknown>> }));
// Test unitaire HERMÉTIQUE : aucune connexion réelle, quelle que soit `DATABASE_URL`.
// Sans ce double, la passerelle (tarifs, idempotence, admission, disjoncteur…) ouvrait de
// vraies connexions : instantanément refusées sans base, mais bloquées jusqu'au
// `connect_timeout` (20 s) quand `DATABASE_URL` vise une base injoignable — les 20 requêtes
// concurrentes de C838-A1-01 dépassaient alors les 30 s. Toute lecture échoue tout de suite,
// comme sans base : la mémoire partagée du test reste le magasin simulé ci-dessous.
vi.mock('@/db', async (orig) => {
  const coupure = () => new Error('base indisponible (test unitaire isolé, carte #838)');
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

const { AiGateway } = await import('../ai-gateway');
const { FakeProvider, setAiProvider } = await import('../providers');
const { __setConfigForTests } = await import('../../config/config-resolver');
const { emptyTreatmentConfig } = await import('../../config/config-types');
const C = await import('../schema-compat');
const { costEvidenceOf, combineCostEvidence } = await import('../cost-evidence');
const { getSchemaCostViews, getSchemaUsageReport, schemaCostViewOf } = await import('../schema-compat/supervision');
const { T1_TEST_OPERATION, t1TestVariables, t1Out, t1Schema } = await import('./t1-master-request');

type StoreApi = typeof import('../schema-compat/store');
type CoupleRow = import('../schema-compat/store').SchemaCoupleRow;
type Key = import('../schema-compat').SchemaCoupleKey;
type Trace = Record<string, unknown> & {
  status: string; callKind?: string; model: string; parentCallIndex?: number;
  providerRequest?: { responseSchemaSent: boolean; schemaOmittedReason: string | null; schemaCompat?: { why: string; qualification?: string | null; degradedCause?: string | null } };
  providerAttempts?: Array<{ kind: string; outcome: string; responseSchemaSent: boolean; httpStatus: number | null; responseMimeType: string | null; costStatus?: string; costMicros?: number | null; durationMs: number }>;
  costEvidence?: { status: string; attempts: number; unknownAttempts: number; observedMicros: number };
};
const traces = () => h.traces as Trace[];

const P = C.SCHEMA_COMPAT_POLICY;
const T0 = Date.UTC(2026, 10, 25, 9, 0, 0);
const Schema = t1Schema({ ok: z.boolean() });

// ── Mémoire partagée simulée (survit au « redémarrage ») ─────────────────────
const base = new Map<string, CoupleRow>();
const baux = new Map<string, { token: string; until: number }>();
const compteurs = { loads: 0, claims: 0, claimsWon: 0, releases: 0, acceptances: 0, rejections: 0 };
const pannes = { load: false, get: false, claim: false };
let seq = 0;
const enLigne = (s: import('../schema-compat').SchemaCoupleState): CoupleRow => ({
  ...s, firstRejectedAt: s.lastRejectedAt, lastHttpStatus: null, lastProviderCode: null, appVersion: null, createdAt: null, updatedAt: null,
});
const magasin: Partial<StoreApi> = {
  loadKnownCouples: async () => {
    compteurs.loads++;
    if (pannes.load) throw new Error('connexion refusée (panne simulée)');
    return { rows: [...base.values()].filter((r) => r.state !== 'NOT_TESTED' && r.state !== 'UNSUPPORTED_BY_CONTRACT'), truncated: false };
  },
  getCouple: async (keyId) => {
    if (pannes.get) throw new Error('lecture par clé impossible (panne simulée)');
    return base.get(keyId) ?? null;
  },
  claimQualification: async (key, kind, now) => {
    compteurs.claims++;
    if (pannes.claim) throw new Error('bail non demandable (panne simulée)');
    const id = C.coupleKeyId(key);
    const b = baux.get(id);
    if (b && b.until > now) return { status: 'busy', until: b.until };
    if (C.qualificationDueOf(base.get(id) ?? null, now) !== kind) return { status: 'busy', until: null };
    const token = `jeton-${++seq}`;
    baux.set(id, { token, until: now + P.qualificationLeaseMs });
    compteurs.claimsWon++;
    return { status: 'claimed', token, until: now + P.qualificationLeaseMs, attempts: compteurs.claimsWon };
  },
  releaseQualification: async (keyId, token, now, inconclusive) => {
    const b = baux.get(keyId);
    if (!b || b.token !== token) return false;
    baux.delete(keyId);
    compteurs.releases++;
    const r = base.get(keyId);
    if (inconclusive && r?.state === 'QUALIFIED') base.set(keyId, { ...r, nextRetestAt: now + P.inconclusiveRetestMs });
    return true;
  },
  recordAcceptance: async (key, _app, now, servedModelVersion = null) => {
    compteurs.acceptances++;
    const prev = base.get(C.coupleKeyId(key)) ?? null;
    const next = enLigne(C.applySchemaOutcome(prev, key, { kind: 'ACCEPTED', servedModelVersion }, now));
    base.set(next.keyId, next);
    return { state: next, previous: prev?.state ?? null };
  },
  recordRejection: async (key, ev, now) => {
    compteurs.rejections++;
    const prev = base.get(C.coupleKeyId(key)) ?? null;
    const next = enLigne(C.applySchemaOutcome(prev, key, { kind: 'REJECTED', reason: ev.reason }, now));
    base.set(next.keyId, next);
    return { state: next, transition: prev?.state !== 'REJECTED_CONFIRMED' };
  },
  noteServedModelVersion: async () => null,
  claimRetest: async () => null,
  releaseRetest: async () => false,
  recordUnsupported: async () => true,
};

const cle = (over: Partial<Key> = {}): Key => ({
  provider: 'fake', model: 'm-c838', operationCode: 't1_analyze_document', contractId: 'T1_ANALYZE_DOCUMENT', contractVersion: 7,
  schemaHash: 'aaaaaaaaaaaa', providerSchemaHash: 'bbbbbbbbbbbb', adapterVersion: 'ps-test', generationProfileHash: '-', ...over,
});
const qualifie = (k: Key, at: number, servedModelVersion: string | null) =>
  base.set(C.coupleKeyId(k), enLigne(C.applySchemaOutcome(null, k, { kind: 'ACCEPTED', servedModelVersion }, at)));

function t1(primary: string, f1: string | null = null) {
  return { ...emptyTreatmentConfig('T1'), primaryModel: primary, fallback1: f1, fallback2: null, maxOutputTokens: 4000 };
}
const req = (i: number | string = 0) => ({
  useCaseCode: 'SOURCE_ANALYSIS' as const, operationCode: T1_TEST_OPERATION, accountId: 7, userId: 3,
  promptVariables: t1TestVariables(`facture ${i}`), outputSchema: Schema, idempotencyKey: `c838-${i}-${Math.random()}`,
});
const invalidArgument = () => Object.assign(
  new Error('{"error":{"code":400,"message":"Request contains an invalid argument.","status":"INVALID_ARGUMENT"}}'), { name: 'ClientError', status: 400 },
);
const refusExplicite = () => Object.assign(new Error('Invalid JSON payload: response_schema is too complex'), { status: 400 });

let fake: InstanceType<typeof FakeProvider>;
beforeEach(() => {
  h.traces.length = 0;
  base.clear(); baux.clear(); seq = 0;
  for (const k of Object.keys(compteurs) as Array<keyof typeof compteurs>) compteurs[k] = 0;
  pannes.load = false; pannes.get = false; pannes.claim = false;
  fake = new FakeProvider();
  setAiProvider(fake);
  C.__setSchemaCompatStoreForTests(null);
  delete process.env.AI_OUTPUT_REPAIR_PASS;
  delete process.env.AI_STRUCTURED_OUTPUT;
});
afterEach(async () => {
  await C.__flushSchemaCompatWritesForTests();
  C.__setSchemaCompatStoreForTests(null);
  __setConfigForTests(null);
  vi.restoreAllMocks();
});

describe('C838-A — politique pure', () => {
  it('C838-A-01 — essai de qualification dû : couple inconnu (FIRST), qualification incertaine échue (REQUALIFY), jamais pour une version connue', () => {
    const k = cle();
    expect(C.qualificationDueOf(null, T0)).toBe('FIRST');
    const connue = enLigne(C.applySchemaOutcome(null, k, { kind: 'ACCEPTED', servedModelVersion: 'gemini-x-001' }, T0));
    const incertaine = enLigne(C.applySchemaOutcome(null, k, { kind: 'ACCEPTED', servedModelVersion: null }, T0));
    expect(incertaine.versionUncertain).toBe(true);
    // Version connue : jamais échue par cette règle (aucune invalidation abusive), même 100 jours plus tard.
    expect(C.qualificationDueOf(connue, T0 + 100 * 86_400_000)).toBeNull();
    // Version incertaine : valide pendant la fenêtre, puis UN essai réservé est dû.
    expect(C.qualificationDueOf(incertaine, T0 + P.uncertainQualificationTtlMs - 1)).toBeNull();
    expect(C.qualificationDueOf(incertaine, T0 + P.uncertainQualificationTtlMs)).toBe('REQUALIFY');
    // Report explicite (essai sans conclusion) : respecté, puis dû.
    expect(C.qualificationDueOf({ ...connue, nextRetestAt: T0 + 10 }, T0 + 9)).toBeNull();
    expect(C.qualificationDueOf({ ...connue, nextRetestAt: T0 + 10 }, T0 + 10)).toBe('REQUALIFY');
    // Refus : géré par le réexamen (claimRetest), pas par la qualification.
    expect(C.qualificationDueOf(enLigne(C.applySchemaOutcome(null, k, { kind: 'REJECTED', reason: 'EXPLICIT_SCHEMA_REJECTION' }, T0)), T0)).toBeNull();
    // Politique versionnée (tracée avec chaque état). Règle complétée (carte #863) : politique v3.
    expect(P.version).toBe(3);
    expect(P.qualificationLeaseMs).toBeGreaterThan(0);
  });
});

describe('C838-A1 — premier essai de qualification réservé', () => {
  it('C838-A1-01 — 20 requêtes concurrentes sur un couple jamais testé : UN seul envoi du schéma, les autres en JSON sans attendre', async () => {
    C.__setSchemaCompatStoreForTests(magasin);
    __setConfigForTests({ versionId: 1, entries: [t1('m-a')] });
    fake.onAny(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return { rawText: t1Out({ ok: true }), inputTokens: 10, outputTokens: 5 };
    });
    const res = await Promise.all(Array.from({ length: 20 }, (_, i) => AiGateway.execute(req(i))));
    await C.__flushSchemaCompatWritesForTests();
    // Toutes les demandes aboutissent (aucune attente indéfinie), validées par le même contrat local (Zod).
    expect(res.every((r) => (r.data as { ok: boolean }).ok === true)).toBe(true);
    // UNE seule requête fournisseur porte le schéma NON QUALIFIÉ (l'essai réservé) ; une demande arrivée APRÈS
    // l'issue de l'essai envoie le schéma désormais qualifié — jamais pendant l'essai.
    expect(fake.calls).toHaveLength(20);
    const pourquoi = traces().map((t) => t.providerRequest?.schemaCompat?.why);
    expect(pourquoi.filter((w) => w === 'first_qualification')).toHaveLength(1);
    expect(traces().filter((t) => t.providerRequest?.responseSchemaSent === true && t.providerRequest?.schemaCompat?.why !== 'qualified'))
      .toHaveLength(1);
    expect(fake.calls.filter((c) => c.responseSchema !== undefined)).toHaveLength(1 + pourquoi.filter((w) => w === 'qualified').length);
    // Les autres pendant l'essai : JSON (`application/json`), motif tracé distinct d'un refus.
    const sans = traces().filter((t) => t.providerRequest?.responseSchemaSent === false);
    expect(sans.length).toBeGreaterThanOrEqual(5);
    expect(sans.length + pourquoi.filter((w) => w === 'qualified').length).toBe(19);
    for (const t of sans) {
      expect(t.providerRequest).toMatchObject({ schemaOmittedReason: 'qualification_in_progress', schemaCompat: { why: 'qualification_in_progress' } });
      expect(t.providerAttempts?.[0]).toMatchObject({ responseSchemaSent: false, responseMimeType: 'application/json' });
    }
    const essai = traces().find((t) => t.providerRequest?.responseSchemaSent === true)!;
    expect(essai.providerRequest?.schemaCompat).toMatchObject({ why: 'first_qualification', qualification: 'FIRST' });
    // Issue écrite, bail rendu : le couple est qualifié et la demande suivante envoie le schéma normalement.
    expect(compteurs).toMatchObject({ claimsWon: 1, acceptances: 1, releases: 1 });
    expect([...base.values()][0]).toMatchObject({ state: 'QUALIFIED' });
    expect(baux.size).toBe(0);
    h.traces.length = 0; fake.calls.length = 0;
    await AiGateway.execute(req('suivante'));
    expect(fake.calls[0].responseSchema).toBeDefined();
    expect(traces()[0].providerRequest?.schemaCompat).toMatchObject({ why: 'qualified' });
  });

  it('C838-A1-02 — processus interrompu pendant l’essai : un autre worker ne tente RIEN tant que le bail vit, puis le reprend', async () => {
    C.__setSchemaCompatStoreForTests(magasin);
    const k = cle();
    const d1 = await C.decideSchemaUse(k, T0);
    expect(d1).toMatchObject({ send: true, why: 'first_qualification', qualification: { kind: 'FIRST' } });
    // « Crash » : aucune issue rapportée, mémoire du processus perdue ; le bail reste en base.
    C.__resetSchemaCompatProcessForTests();
    const d2 = await C.decideSchemaUse(k, T0 + 1_000);
    expect(d2).toMatchObject({ send: false, retest: false, why: 'qualification_in_progress' });
    // Bail expiré : reprise par le second worker (un seul essai, jamais en parallèle).
    C.__resetSchemaCompatProcessForTests();
    const d3 = await C.decideSchemaUse(k, T0 + P.qualificationLeaseMs + 1);
    expect(d3).toMatchObject({ send: true, why: 'first_qualification' });
    expect(d3.qualification?.token).not.toBe(d1.qualification?.token);
    // L'ancien détenteur ne peut plus rendre le bail d'un autre (fencing par jeton).
    expect(await magasin.releaseQualification!(d3.keyId, d1.qualification!.token, T0 + P.qualificationLeaseMs + 2, false)).toBe(false);
    // Refus constaté par l'essai repris : mémorisé, bail rendu, aucun nouvel essai avant l'échéance.
    C.reportSchemaOutcome(d3, { kind: 'REJECTED', reason: 'EXPLICIT_SCHEMA_REJECTION' }, { httpStatus: 400 }, T0 + P.qualificationLeaseMs + 3);
    await C.__flushSchemaCompatWritesForTests();
    expect(baux.size).toBe(0);
    C.__resetSchemaCompatProcessForTests();
    expect(await C.decideSchemaUse(k, T0 + P.qualificationLeaseMs + 10)).toMatchObject({ send: false, why: 'recent_rejection' });
  });

  it('C838-A1-03 — essai sans conclusion (délai, 503) : bail rendu, le premier essai redevient prenable — aucun état déduit', async () => {
    C.__setSchemaCompatStoreForTests(magasin);
    const k = cle();
    const d = await C.decideSchemaUse(k, T0);
    C.reportSchemaOutcome(d, { kind: 'INCONCLUSIVE' }, {}, T0 + 5);
    await C.__flushSchemaCompatWritesForTests();
    expect(baux.size).toBe(0);
    expect(base.get(d.keyId)).toBeUndefined();
    C.__resetSchemaCompatProcessForTests();
    expect(await C.decideSchemaUse(k, T0 + 10)).toMatchObject({ send: true, why: 'first_qualification' });
  });

  it('C838-A1-04 — magasin antérieur à la carte (sans bail) : comportement #784 inchangé, signalé par le motif', async () => {
    const { claimQualification: _c, releaseQualification: _r, ...ancien } = magasin;
    void _c; void _r;
    C.__setSchemaCompatStoreForTests(ancien);
    expect(await C.decideSchemaUse(cle(), T0)).toMatchObject({ send: true, why: 'not_tested' });
  });
});

describe('C838-A2 — mémoire partagée illisible', () => {
  it('C838-A2-01 — cache FROID et base en panne : JSON sans schéma (jamais send:true par défaut), une seule relecture par période', async () => {
    C.__setSchemaCompatStoreForTests(magasin);
    pannes.load = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const d = await C.decideSchemaUse(cle(), T0);
    expect(d).toMatchObject({ send: false, retest: false, why: 'memory_unavailable', degraded: { cause: 'shared_unreadable' } });
    // Pas de tempête : 50 décisions pendant la panne → une seule tentative de relecture.
    for (let i = 1; i <= 50; i++) await C.decideSchemaUse(cle({ model: `m-${i}` }), T0 + i);
    expect(compteurs.loads).toBe(1);
    expect(compteurs.claims).toBe(0);
    // Journal du mode dégradé : borné (une ligne par minute), compteurs exacts.
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('MODE DÉGRADÉ'))).toHaveLength(1);
    expect(C.schemaMemoryDegradedStats()).toMatchObject({ decisions: 51, byCause: { shared_unreadable: 51 }, sharedHealthy: false });
  });

  it('C838-A2-02 — cache CHAUD avec refus connu : le refus commande toujours ; qualifié connu : schéma ; inconnu : dégradé', async () => {
    C.__setSchemaCompatStoreForTests(magasin);
    const refuse = cle({ model: 'm-refuse' });
    const ok = cle({ model: 'm-ok' });
    base.set(C.coupleKeyId(refuse), enLigne(C.applySchemaOutcome(null, refuse, { kind: 'REJECTED', reason: 'GENERIC_400_ANSWERED_WITHOUT_SCHEMA' }, T0)));
    qualifie(ok, T0, 'v1');
    await C.decideSchemaUse(ok, T0 + 1);
    pannes.load = true; pannes.get = true; pannes.claim = true;
    const t = T0 + C.SHARED_TTL_MS + 5;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await C.decideSchemaUse(refuse, t)).toMatchObject({ send: false, why: 'recent_rejection' });
    expect(await C.decideSchemaUse(ok, t)).toMatchObject({ send: true, why: 'qualified' });
    expect(await C.decideSchemaUse(cle({ model: 'm-inconnu' }), t)).toMatchObject({ send: false, why: 'memory_unavailable' });
    // Second worker (cache froid) pendant la panne : le refus n'est PAS réautorisé.
    C.__resetSchemaCompatProcessForTests();
    expect(await C.decideSchemaUse(refuse, t + 1)).toMatchObject({ send: false, why: 'memory_unavailable' });
    // Base rétablie : relecture à la période suivante, décisions prouvées de nouveau.
    pannes.load = false; pannes.get = false; pannes.claim = false;
    const r = T0 + 3 * C.SHARED_TTL_MS;
    expect(await C.decideSchemaUse(refuse, r)).toMatchObject({ send: false, why: 'recent_rejection' });
    expect(await C.decideSchemaUse(cle({ model: 'm-inconnu' }), r)).toMatchObject({ send: true, why: 'first_qualification' });
  });

  it('C838-A2-03 — bail non demandable (panne pendant la réservation) : dégradé `claim_failed`, aucun essai', async () => {
    C.__setSchemaCompatStoreForTests(magasin);
    pannes.claim = true;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await C.decideSchemaUse(cle(), T0)).toMatchObject({ send: false, why: 'memory_unavailable', degraded: { cause: 'claim_failed' } });
  });

  it('C838-A2-04 — passerelle en mode dégradé : réponse JSON validée par Zod, motif et cause tracés, aucune qualification écrite', async () => {
    C.__setSchemaCompatStoreForTests(magasin);
    pannes.load = true;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    __setConfigForTests({ versionId: 1, entries: [t1('m-a')] });
    fake.onAny(() => ({ rawText: t1Out({ ok: 'pas un booléen' }), inputTokens: 10, outputTokens: 5 }));
    process.env.AI_OUTPUT_REPAIR_PASS = 'off';
    await expect(AiGateway.execute(req('degrade'))).rejects.toThrow();
    // Validation locale MAINTENUE : la sortie non conforme est refusée, même sans schéma fournisseur.
    expect(traces()[0]).toMatchObject({ status: 'error', errorCode: 'INVALID_OUTPUT' });
    expect(traces()[0].providerRequest).toMatchObject({
      responseSchemaSent: false, schemaOmittedReason: 'memory_unavailable', schemaCompat: { why: 'memory_unavailable', degradedCause: 'shared_unreadable' },
    });
    expect(fake.calls[0].responseSchema).toBeUndefined();
    expect(fake.calls[0].jsonResponse).toBe(true);
    await C.__flushSchemaCompatWritesForTests();
    expect(compteurs.acceptances + compteurs.rejections).toBe(0);
  });
});

describe('C838-A3 — requalification bornée (version servie incertaine)', () => {
  it('C838-A3-01 — alias inchangé et version incertaine : UNE requalification réservée après la fenêtre, puis fenêtre renouvelée', async () => {
    C.__setSchemaCompatStoreForTests(magasin);
    const k = cle();
    qualifie(k, T0, null);
    // Dans la fenêtre : schéma envoyé, aucune réservation (jamais à chaque requête).
    expect(await C.decideSchemaUse(k, T0 + 1_000)).toMatchObject({ send: true, why: 'qualified' });
    expect(compteurs.claims).toBe(0);
    const echu = T0 + P.uncertainQualificationTtlMs + 1;
    C.__resetSchemaCompatProcessForTests();
    const d = await C.decideSchemaUse(k, echu);
    expect(d).toMatchObject({ send: true, why: 'requalification_due', qualification: { kind: 'REQUALIFY' } });
    // Autre worker pendant la requalification : JSON, aucun essai parallèle.
    C.__resetSchemaCompatProcessForTests();
    expect(await C.decideSchemaUse(k, echu + 10)).toMatchObject({ send: false, why: 'qualification_in_progress' });
    // Acceptation (toujours écrite, même pour un couple déjà qualifié) : fenêtre renouvelée, bail rendu.
    C.reportSchemaOutcome(d, { kind: 'ACCEPTED', servedModelVersion: null }, {}, echu + 20);
    await C.__flushSchemaCompatWritesForTests();
    expect(base.get(d.keyId)).toMatchObject({ state: 'QUALIFIED', lastAcceptedAt: echu + 20, versionUncertain: true });
    expect(baux.size).toBe(0);
    C.__resetSchemaCompatProcessForTests();
    expect(await C.decideSchemaUse(k, echu + 1_000)).toMatchObject({ send: true, why: 'qualified' });
  });

  it('C838-A3-02 — refus lors de la requalification : couple refusé, backoff normal ; essai sans conclusion : report borné', async () => {
    C.__setSchemaCompatStoreForTests(magasin);
    const k = cle();
    qualifie(k, T0, null);
    const echu = T0 + P.uncertainQualificationTtlMs + 1;
    const d = await C.decideSchemaUse(k, echu);
    C.reportSchemaOutcome(d, { kind: 'REJECTED', reason: 'GENERIC_400_ANSWERED_WITHOUT_SCHEMA' }, { httpStatus: 400 }, echu + 5);
    await C.__flushSchemaCompatWritesForTests();
    expect(base.get(d.keyId)).toMatchObject({ state: 'REJECTED_CONFIRMED', nextRetestAt: echu + 5 + P.retestAfterQualifiedMs });
    C.__resetSchemaCompatProcessForTests();
    expect(await C.decideSchemaUse(k, echu + 10)).toMatchObject({ send: false, why: 'recent_rejection' });

    // Second couple : essai sans conclusion → report de `inconclusiveRetestMs`. Règle remplacée (carte #863, A3) : le
    // report est OPPOSABLE — aucun schéma entre-temps (JSON + validation locale), puis UN essai réservé à l'échéance.
    const k2 = cle({ model: 'm-2' });
    qualifie(k2, T0, null);
    C.__resetSchemaCompatProcessForTests();
    const d2 = await C.decideSchemaUse(k2, echu);
    expect(d2).toMatchObject({ send: true, why: 'requalification_due' });
    C.reportSchemaOutcome(d2, { kind: 'INCONCLUSIVE' }, {}, echu + 5);
    await C.__flushSchemaCompatWritesForTests();
    expect(base.get(d2.keyId)?.nextRetestAt).toBe(echu + 5 + P.inconclusiveRetestMs);
    C.__resetSchemaCompatProcessForTests();
    expect(await C.decideSchemaUse(k2, echu + 60_000)).toMatchObject({ send: false, why: 'requalification_deferred' });
    C.__resetSchemaCompatProcessForTests();
    expect(await C.decideSchemaUse(k2, echu + 5 + P.inconclusiveRetestMs)).toMatchObject({ send: true, why: 'requalification_due' });
  });

  it('C838-A3-03 — changement de profil ou d’adaptateur : AUTRE couple (premier essai), sans toucher la qualification existante', async () => {
    C.__setSchemaCompatStoreForTests(magasin);
    const k = cle();
    qualifie(k, T0, 'v1');
    expect(await C.decideSchemaUse(cle({ generationProfileHash: 'abcdef123456' }), T0 + 1)).toMatchObject({ send: true, why: 'first_qualification' });
    expect(await C.decideSchemaUse(cle({ adapterVersion: 'ps-test-2' }), T0 + 2)).toMatchObject({ send: true, why: 'first_qualification' });
    expect(await C.decideSchemaUse(k, T0 + 3)).toMatchObject({ send: true, why: 'qualified' });
    expect(base.get(C.coupleKeyId(k))?.state).toBe('QUALIFIED');
  });
});

describe('C838-C1 — traces de TOUTES les requêtes, réparation comprise', () => {
  it('C838-C1-01 — réparation : refus explicite du schéma (HTTP 400) puis essai JSON → 2 requêtes tracées, chiffrées ou INCONNUES, corrélées', async () => {
    __setConfigForTests({ versionId: 1, entries: [t1('m-a')] });
    fake.onAny((input) => {
      if (input.callKind === 'repair') {
        if (input.responseSchema) throw refusExplicite();
        return { rawText: t1Out({ ok: true }), inputTokens: 5, outputTokens: 5 };
      }
      return { rawText: t1Out({ ok: 'peut-être' }), inputTokens: 10, outputTokens: 5 };
    });
    const res = await AiGateway.execute(req('reparation'));
    expect(res.data).toMatchObject({ ok: true });
    expect(fake.calls[0].responseSchema).toBeDefined();
    expect(traces().map((t) => t.callKind)).toEqual(['analysis', 'repair']);
    const rep = traces()[1];
    // Requête de réparation décrite (sans contenu) et ses DEUX tentatives réellement envoyées.
    expect(rep.providerRequest).toMatchObject({ responseSchemaSent: true, responseMimeType: 'application/json' });
    expect(rep.providerAttempts).toHaveLength(2);
    expect(rep.providerAttempts![0]).toMatchObject({ kind: 'initial', responseSchemaSent: true, outcome: 'FAILED', httpStatus: 400, costStatus: 'UNKNOWN', costMicros: null });
    expect(rep.providerAttempts![1]).toMatchObject({ kind: 'schema_rejected_retry', responseSchemaSent: false, outcome: 'SUCCESS', responseMimeType: 'application/json' });
    expect(typeof rep.providerAttempts![1].durationMs).toBe('number');
    // Coût : la tentative refusée n'est JAMAIS comptée 0 € — part inconnue exposée.
    expect(rep.costEvidence).toMatchObject({ attempts: 2 });
    expect(rep.costEvidence!.unknownAttempts).toBeGreaterThanOrEqual(1);
    expect(['UNKNOWN', 'PARTIAL']).toContain(rep.costEvidence!.status);
    // Corrélation parent / enfant, sans double compte : l'analyse porte ses tentatives, la réparation les siennes.
    expect(rep.parentCallIndex).toBe(0);
    expect(traces()[0].providerAttempts).toHaveLength(1);
    expect(fake.calls).toHaveLength(3);
    // Le résultat dit que son coût n'est pas exhaustif.
    expect(res.costUnknownAttempts).toBeGreaterThanOrEqual(1);
    expect(['UNKNOWN', 'PARTIAL']).toContain(res.costStatus);
  });

  it('C838-C1-02 — analyse en mode JSON (schéma non envoyé) : la réparation n’essaie PAS le schéma non qualifié', async () => {
    C.__setSchemaCompatStoreForTests(magasin);
    pannes.load = true;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    __setConfigForTests({ versionId: 1, entries: [t1('m-a')] });
    fake.onAny((input) => (input.callKind === 'repair'
      ? { rawText: t1Out({ ok: true }), inputTokens: 5, outputTokens: 5 }
      : { rawText: t1Out({ ok: 'peut-être' }), inputTokens: 10, outputTokens: 5 }));
    await AiGateway.execute(req('reparation-json'));
    expect(fake.calls.map((c) => c.responseSchema === undefined)).toEqual([true, true]);
    expect(traces()[1].providerRequest).toMatchObject({ responseSchemaSent: false, schemaOmittedReason: 'not_sent_in_analysis' });
  });
});

describe('C838-C2 — nature du coût : jamais 0 par défaut', () => {
  it('C838-C2-01 — 400 générique puis JSON (2 appels) : une tentative INCONNUE, la réussite chiffrée — total PARTIEL ou INCONNU', async () => {
    __setConfigForTests({ versionId: 1, entries: [t1('m-a')] });
    fake.onAny((input) => {
      if (input.responseSchema) throw invalidArgument();
      return { rawText: t1Out({ ok: true }), inputTokens: 10, outputTokens: 5 };
    });
    const res = await AiGateway.execute(req('400-json'));
    expect(fake.calls).toHaveLength(2);
    const t = traces()[0];
    expect(t.providerAttempts!.map((a) => [a.kind, a.outcome, a.httpStatus, a.costStatus === 'UNKNOWN'])).toEqual([
      ['initial', 'FAILED', 400, true], ['diagnostic_retry', 'SUCCESS', null, false],
    ]);
    expect(t.costEvidence).toMatchObject({ attempts: 2, unknownAttempts: 1 });
    expect(res.costUnknownAttempts).toBe(1);
    expect(res.costStatus).not.toBe('OBSERVED');
    expect(res.costStatus).not.toBe('ZERO_REPORTED');
  });

  it('C838-C2-02 — consommation NULLE explicitement rendue : ZERO_REPORTED (0 € prouvé) ; échec sans métadonnées : UNKNOWN', async () => {
    __setConfigForTests({ versionId: 1, entries: [t1('m-a', 'm-b')] });
    fake.on('m-a', () => { throw Object.assign(new Error('503 Service Unavailable'), { status: 503 }); });
    fake.on('m-b', () => ({ rawText: t1Out({ ok: true }), inputTokens: 0, outputTokens: 0 }));
    const res = await AiGateway.execute(req('zero'));
    expect(traces().map((t) => t.costEvidence?.status)).toEqual(['UNKNOWN', 'ZERO_REPORTED']);
    // Règle remplacée (carte #863, C2) : la nature du coût rendue porte sur TOUTE l'exécution — le premier rang
    // (503, coût inconnu) n'est plus oublié : zéro prouvé + inconnu = PARTIEL, jamais « 0 € prouvé ».
    expect(res.costStatus).toBe('PARTIAL');
    expect(res.costUnknownAttempts).toBe(1);
  });

  it('C838-C2-03 — échec final de toute la chaîne : chaque tentative envoyée reste comptée, coût INCONNU (jamais 0 €)', async () => {
    __setConfigForTests({ versionId: 1, entries: [t1('m-a', 'm-b')] });
    fake.onAny(() => { throw Object.assign(new Error('503 Service Unavailable'), { status: 503 }); });
    await expect(AiGateway.execute(req('echec'))).rejects.toThrow();
    const envoyees = traces().filter((t) => (t.providerAttempts?.length ?? 0) > 0);
    expect(envoyees.length).toBeGreaterThanOrEqual(1);
    for (const t of envoyees) expect(t.costEvidence).toMatchObject({ status: 'UNKNOWN', observedMicros: 0 });
  });

  it('C838-C2-04 — combinaison pure : observé + inconnu = PARTIEL (minimum), zéro prouvé seul = ZERO_REPORTED, rien = NONE', () => {
    const obs = costEvidenceOf([{ costStatus: 'OBSERVED', costMicros: 120 }]);
    const unk = costEvidenceOf([{ costStatus: 'UNKNOWN', costMicros: null }, { costStatus: 'NO_PRICE', costMicros: null }]);
    expect(obs.status).toBe('OBSERVED');
    expect(unk).toMatchObject({ status: 'UNKNOWN', unknownAttempts: 2, observedMicros: 0 });
    expect(combineCostEvidence(obs, unk)).toMatchObject({ status: 'PARTIAL', observedMicros: 120, unknownAttempts: 2, attempts: 3 });
    expect(costEvidenceOf([{ costStatus: 'ZERO_REPORTED', costMicros: 0 }]).status).toBe('ZERO_REPORTED');
    expect(combineCostEvidence().status).toBe('NONE');
    expect(costEvidenceOf([{ costMicros: 5 } as never]).status).toBe('UNKNOWN');
  });

  it('C838-C2-05 — vues analyse / réparation / total : réparations visibles, part inconnue exposée ; lecture impossible ≠ 0', async () => {
    const vus: string[] = [];
    const run = async (sql: string) => {
      vus.push(sql);
      return [
        { call_kind: 'analysis', calls: 10, provider_requests: 14, final_success: 9, attempts_observed: 10, attempts_zero: 0, attempts_unknown: 4, observed_micros: '5000' },
        { call_kind: 'repair', calls: 3, provider_requests: 5, final_success: 2, attempts_observed: 2, attempts_zero: 1, attempts_unknown: 2, observed_micros: '300' },
      ];
    };
    const v = await getSchemaCostViews({ days: 7, operationCode: 't1_analyze_document' }, new Date(T0), run);
    expect(v.unavailable).toBeNull();
    expect(v.views!.analysis).toMatchObject({ calls: 10, providerRequests: 14, costStatus: 'PARTIAL', observedCostMicros: 5000 });
    expect(v.views!.repair).toMatchObject({ calls: 3, providerRequests: 5, costStatus: 'PARTIAL', attemptsCostUnknown: 2 });
    expect(v.views!.total).toMatchObject({ calls: 13, providerRequests: 19, attemptsCostUnknown: 6, observedCostMicros: 5300, costStatus: 'PARTIAL' });
    expect(v.views!.total.unknownShare).toBeCloseTo(6 / 19, 3);
    // Réparations lues : la vue ne filtre pas `callKind = analysis`.
    expect(vus[0]).toMatch(/callKind' = 'repair'/);
    expect(vus[0]).not.toMatch(/prompt|ai_call_captures|output_preview/i);
    const ko = await getSchemaCostViews({ days: 7 }, new Date(T0), async () => { throw new Error('délai dépassé'); });
    expect(ko).toEqual({ views: null, unavailable: 'délai dépassé' });
    expect(schemaCostViewOf({ calls: 0, providerRequests: 0, finalSuccess: 0, attemptsCostObserved: 0, attemptsCostZero: 0, attemptsCostUnknown: 0, observedCostMicros: 0 }))
      .toMatchObject({ costStatus: 'NONE', unknownShare: null });
    // Le rapport historique « analyse seule » reste lu en TROIS lectures, inchangé.
    const lectures: string[] = [];
    await getSchemaUsageReport({ days: 7 }, new Date(T0), async (sql: string) => { lectures.push(sql); return []; });
    expect(lectures).toHaveLength(3);
  });
});
