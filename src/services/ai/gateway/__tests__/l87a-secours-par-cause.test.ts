/**
 * Lot 87A — CDC Pilotage IA V2, phase P7 « secours ciblés, disponibilité,
 * reprises ». Passerelle RÉELLE avec fournisseur simulé.
 *
 *   L87A-U01  cause établie d'un échec (tableau §8 du CDC), pure
 *   L87A-U02  pannes par cause : quota, indisponibilité, délai, paramètre
 *             refusé, sortie invalide, sortie tronquée, cause inconnue,
 *             défaut commun, accès global
 *   L87A-U03  modèle CONNU indisponible sauté sans appel (RUN-03) ; chaîne
 *             entièrement indisponible → suspension, disjoncteur non avancé ;
 *             qualification jamais détournée
 *   L87A-U04  secours limités aux couples qualifiés (règle prudente)
 *   L87A-U05  exclusion 86B respectée, y compris prise en cours d'exécution
 *   L87A-U06  décision 08 : une sortie tronquée n'est JAMAIS une réussite
 *             (principal ou secours, même rendue conforme)
 *   L87A-U07  traces : chaque choix / refus (cause, rang, modèle, motif)
 *             dans ai_usage_event, la capture et l'erreur finale
 *   L87A-U08  disjoncteur cohérent (85C) : chaîne refusée ou sautée avant
 *             appel, paramètres refusés → n'avance pas
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';

const h = vi.hoisted(() => ({ traces: [] as Array<Record<string, unknown>>, outcomes: [] as Array<Record<string, unknown>> }));
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
  noteGatewayOutcome: vi.fn((o: Record<string, unknown>) => { h.outcomes.push(o); }),
}));

const { AiGateway } = await import('../ai-gateway');
const { FakeProvider, setAiProvider } = await import('../providers');
const { __setConfigForTests } = await import('../../config/config-resolver');
const { emptyTreatmentConfig } = await import('../../config/config-types');
const { __setFallbackContextForTests } = await import('../fallback-context');
const P = await import('../fallback-policy');
const { runInJobContext } = await import('../../queue/job-context');
const { isExecutionCancelled } = await import('../../queue/execution-control');
const { T1_TEST_OPERATION, t1TestVariables, t1Out, t1Schema } = await import('./t1-master-request');

type Decision = import('../fallback-policy').FallbackDecision;
type Trace = Record<string, unknown> & {
  model: string; status: string; errorCode?: string; modelRank?: string;
  fallback?: Decision; capture?: { callKind: string; params: Record<string, unknown> };
};
const traces = () => h.traces as Trace[];
const appels = () => traces().filter((t) => t.capture?.callKind !== 'pre_call_refusal');
const sansAppel = () => traces().filter((t) => t.capture?.callKind === 'pre_call_refusal');

const Schema = t1Schema({ ok: z.boolean() });
const OK = { rawText: t1Out({ ok: true }), inputTokens: 1, outputTokens: 1 };
let fake: InstanceType<typeof FakeProvider>;

const err = (status: number, message = `HTTP ${status}`) => Object.assign(new Error(message), { status });
const quota = () => err(429, 'Resource has been exhausted (e.g. check quota).');
const indispo = () => err(503, '{"error":{"code":503,"message":"overloaded","status":"UNAVAILABLE"}}');
const delai = () => Object.assign(new Error('Délai dépassé'), { code: 'TIMEOUT' });
const paramRefuse = () => err(400, '{"error":{"code":400,"message":"Thinking level is not supported for this model.","status":"INVALID_ARGUMENT"}}');
const inconnue = () => new Error('quelque chose d’inattendu');
const cle = () => err(401, '{"error":{"code":401,"message":"API key not valid.","status":"UNAUTHENTICATED"}}');
const defautCommun = () => Object.assign(new Error('construction impossible'), { aiStage: 'request_build' });

function chaine(models: [string, string | null, string | null], over: Record<string, unknown> = {}) {
  __setConfigForTests({
    versionId: 1,
    entries: [{ ...emptyTreatmentConfig('T1'), primaryModel: models[0], fallback1: models[1], fallback2: models[2], maxOutputTokens: 2000, ...over }],
  });
}
const req = (over: Record<string, unknown> = {}) => ({
  useCaseCode: 'SOURCE_ANALYSIS' as const, operationCode: T1_TEST_OPERATION, accountId: 7,
  sourceIds: [42], promptVariables: t1TestVariables('facture'), outputSchema: Schema, idempotencyKey: `l87a-${Math.random()}`,
  ...over,
});

beforeEach(() => {
  h.traces.length = 0;
  h.outcomes.length = 0;
  fake = new FakeProvider();
  setAiProvider(fake);
  chaine(['m-a', 'm-b', 'm-c']);
});
afterEach(() => {
  __setConfigForTests(null);
  __setFallbackContextForTests(null);
});

describe('L87A-U01 — cause établie (tableau §8)', () => {
  it('famille / sous-type / statut → cause', () => {
    const c = (f: import('../fallback-policy').FailureFacts) => P.causeOfFailure(f);
    expect(c({ family: 'RATE_LIMIT' })).toBe('QUOTA');
    expect(c({ family: 'PROVIDER_ERROR' })).toBe('UNAVAILABLE');
    expect(c({ family: 'TIMEOUT' })).toBe('TIMEOUT');
    expect(c({ family: 'CONTEXT_TOO_LARGE' })).toBe('MODEL_LIMIT');
    expect(c({ family: 'INPUT_ERROR', subtype: 'PARAMETER_REJECTED' })).toBe('PARAMETER_REJECTED');
    expect(c({ family: 'INPUT_ERROR', subtype: 'PARAMETER_INCOMPATIBLE' })).toBe('PARAMETER_INCOMPATIBLE');
    expect(c({ family: 'INPUT_ERROR', httpStatus: 404 })).toBe('UNAVAILABLE');
    expect(c({ family: 'INPUT_ERROR', httpStatus: 400 })).toBe('UNKNOWN');
    expect(c({ family: 'AUTH_ERROR', httpStatus: 401 })).toBe('GLOBAL_ACCESS');
    expect(c({ family: 'AUTH_ERROR', httpStatus: 403, message: 'permission denied on model' })).toBe('UNKNOWN');
    expect(c({ family: 'INTERNAL_ERROR' })).toBe('COMMON_DEFECT');
    expect(c({ family: 'INVALID_OUTPUT', subtype: 'MISSING_REQUIRED_FIELD' })).toBe('INVALID_OUTPUT');
    expect(c({ family: 'INVALID_OUTPUT', subtype: 'OUTPUT_TRUNCATED' })).toBe('OUTPUT_TRUNCATED');
    expect(c({ family: 'NETWORK_ERROR' })).toBe('UNKNOWN');
    expect(c({ family: 'SAFETY_BLOCK' })).toBe('UNKNOWN');
    expect(c({ family: 'UNKNOWN' })).toBe('UNKNOWN');
  });
  it('chaque cause a une politique et un libellé ; les paramètres refusés ne comptent pas pour le disjoncteur', () => {
    for (const cause of P.FAILURE_CAUSES) expect(P.CAUSE_POLICY[cause].label.length).toBeGreaterThan(3);
    expect(P.CAUSE_POLICY.PARAMETER_REJECTED.countsForBreaker).toBe(false);
    expect(P.CAUSE_POLICY.PARAMETER_INCOMPATIBLE.countsForBreaker).toBe(false);
    expect(P.CAUSE_POLICY.KNOWN_UNAVAILABLE.countsForBreaker).toBe(false);
    expect(P.CAUSE_POLICY.COMMON_DEFECT.fallback).toBe('STOP');
    expect(P.CAUSE_POLICY.UNKNOWN.fallback).toBe('ONE_ALTERNATIVE');
  });
});

describe('L87A-U02 — pannes par cause dans la boucle existante', () => {
  it.each([
    ['quota', quota, 'QUOTA'],
    ['indisponibilité', indispo, 'UNAVAILABLE'],
    ['délai', delai, 'TIMEOUT'],
  ])('%s du principal → secours de la chaîne, cause tracée', async (_n, panne, cause) => {
    fake.on('m-a', () => { throw panne(); }).on('m-b', () => OK);
    const r = await AiGateway.execute(req());
    expect(r.model).toBe('m-b');
    expect(fake.calls.map((c) => c.model)).toEqual(['m-a', 'm-b']);
    expect(appels()[1].fallback).toMatchObject({ rank: 'fallback_1', model: 'm-b', decision: 'MANUAL_UNTESTED', afterCause: cause, afterModel: 'm-a' });
  });

  it('indisponibilité sur toute la chaîne : tous les secours admissibles essayés, échec (pas de suspension)', async () => {
    fake.onAny(() => { throw indispo(); });
    await expect(AiGateway.execute(req())).rejects.toMatchObject({ code: 'ALL_MODELS_FAILED', recoverable: true });
    expect(fake.calls).toHaveLength(3);
  });

  it('paramètre refusé : incompatibilité de requête (jamais « indisponible »), une autre configuration prend le relais', async () => {
    fake.on('m-a', () => { throw paramRefuse(); }).on('m-b', () => OK);
    const r = await AiGateway.execute(req());
    expect(r.model).toBe('m-b');
    expect(appels()[0]).toMatchObject({ errorCode: 'PROVIDER_REQUEST_REJECTED' });
    expect(appels()[1].fallback?.afterCause).toBe('PARAMETER_REJECTED');
    // L87A-U08 : le modèle n'est pas compté défaillant par le disjoncteur.
    expect(h.outcomes[0]).toMatchObject({ attempts: [{ model: 'm-b', succeeded: true }], chainSucceeded: true });
  });

  it('sortie invalide : reprise ciblée existante — le secours est informé de l’erreur', async () => {
    fake.on('m-a', () => ({ rawText: t1Out({ ok: 'pas un booléen' }), inputTokens: 1, outputTokens: 1 })).on('m-b', () => OK);
    const r = await AiGateway.execute(req());
    expect(r.model).toBe('m-b');
    expect(fake.calls.find((c) => c.model === 'm-b')!.prompt).toContain('REPRISE APRÈS SORTIE INVALIDE');
    expect(appels().find((t) => t.model === 'm-b')!.fallback?.afterCause).toBe('INVALID_OUTPUT');
  });

  it('cause inconnue (R10, R57) : au plus UN essai alternatif, le reste refusé et tracé, jamais tout le catalogue', async () => {
    fake.onAny(() => { throw inconnue(); });
    const e = await AiGateway.execute(req()).catch((x) => x);
    expect(e).toMatchObject({ code: 'ALL_MODELS_FAILED' });
    expect(fake.calls.map((c) => c.model)).toEqual(['m-a', 'm-b']);
    expect(sansAppel()).toHaveLength(1);
    expect(sansAppel()[0]).toMatchObject({ model: 'm-c', errorCode: 'FALLBACK_NOT_ADMISSIBLE', fallback: { decision: 'UNKNOWN_CAUSE_LIMIT', afterCause: 'UNKNOWN' } });
    expect((e as { fallbackDecisions: Decision[] }).fallbackDecisions.map((d) => d.decision)).toEqual(['FIRST', 'MANUAL_UNTESTED', 'UNKNOWN_CAUSE_LIMIT']);
  });

  it('cause inconnue puis cause établie : la politique de la nouvelle cause s’applique', async () => {
    fake.on('m-a', () => { throw inconnue(); }).on('m-b', () => { throw indispo(); }).on('m-c', () => OK);
    const r = await AiGateway.execute(req());
    expect(r.model).toBe('m-c');
    expect(appels()[2].fallback?.afterCause).toBe('UNAVAILABLE');
  });

  it('défaut commun (construction applicative) : aucune cascade inutile', async () => {
    fake.onAny(() => { throw defautCommun(); });
    await expect(AiGateway.execute(req())).rejects.toMatchObject({ code: 'ALL_MODELS_FAILED' });
    expect(fake.calls).toHaveLength(1);
    expect(sansAppel().map((t) => t.fallback?.decision)).toEqual(['CAUSE_STOPS_CHAIN', 'CAUSE_STOPS_CHAIN']);
  });

  it('accès global refusé (clé) : arrêt et SUSPENSION (reprise possible), jamais d’autre modèle', async () => {
    fake.onAny(() => { throw cle(); });
    const e = await AiGateway.execute(req()).catch((x) => x);
    expect(e).toMatchObject({ code: 'AI_SUSPENDED', recoverable: false, failureCause: 'GLOBAL_ACCESS' });
    expect(fake.calls).toHaveLength(1);
  });
});

describe('L87A-U03 — état opérationnel lu AVANT appel (RUN-03)', () => {
  it('principal connu indisponible : sauté sans appel, secours sollicité ; lien avec le dernier contrôle tracé', async () => {
    __setFallbackContextForTests({ knownUnavailable: async () => new Map([['m-a', { checkedAt: '2026-10-24T08:00:00.000Z', error: 'modèle retiré' }]]) });
    fake.on('m-b', () => OK);
    const r = await AiGateway.execute(req());
    expect(r.model).toBe('m-b');
    expect(fake.calls.map((c) => c.model)).toEqual(['m-b']);
    expect(sansAppel()[0]).toMatchObject({
      model: 'm-a', errorCode: 'MODEL_KNOWN_UNAVAILABLE', costMicros: 0, billable: false,
      fallback: { decision: 'KNOWN_UNAVAILABLE', operational: { checkedAt: '2026-10-24T08:00:00.000Z', error: 'modèle retiré' } },
    });
    expect(appels()[0].fallback).toMatchObject({ model: 'm-b', afterCause: 'KNOWN_UNAVAILABLE', decision: 'MANUAL_UNTESTED' });
  });

  it('R11 — seul modèle de la chaîne connu indisponible : suspension sans appel, sans modèle improvisé, disjoncteur non avancé', async () => {
    chaine(['m-a', null, null]);
    __setFallbackContextForTests({ knownUnavailable: async () => new Map([['m-a', { checkedAt: null, error: null }]]) });
    const e = await AiGateway.execute(req()).catch((x) => x);
    expect(e).toMatchObject({ code: 'AI_SUSPENDED', failureCause: 'KNOWN_UNAVAILABLE' });
    expect(fake.calls).toHaveLength(0);
    expect(h.outcomes).toEqual([expect.objectContaining({ attempts: [], chainSucceeded: null })]);
  });

  it('qualification d’un couple : le modèle désigné est toujours atteint (rang forcé, jamais sauté)', async () => {
    __setFallbackContextForTests({ knownUnavailable: async () => new Map([['m-a', { checkedAt: null, error: null }]]) });
    fake.on('m-a', () => OK);
    const r = await AiGateway.execute(req({ triggerCode: 'qualification', maxModelAttempts: 1 }));
    expect(r.model).toBe('m-a');
  });
});

describe('L87A-U04 — secours limités aux couples qualifiés (RUN-02, règle prudente)', () => {
  it('couple REFUSÉ à la qualification : jamais choisi ; le couple ADMISSIBLE suivant l’est (« secours qualifié »)', async () => {
    __setFallbackContextForTests({
      coupleQualifications: async () => ({ origin: 'manual', byModel: new Map([['m-b', 'REFUSED' as const], ['m-c', 'ADMISSIBLE' as const]]) }),
    });
    fake.on('m-a', () => { throw quota(); }).on('m-c', () => OK);
    const r = await AiGateway.execute(req());
    expect(r.model).toBe('m-c');
    expect(fake.calls.map((c) => c.model)).toEqual(['m-a', 'm-c']);
    expect(sansAppel()[0]).toMatchObject({ model: 'm-b', fallback: { decision: 'COUPLE_REFUSED', qualification: 'REFUSED', afterCause: 'QUOTA' } });
    expect(appels()[1].fallback).toMatchObject({ decision: 'QUALIFIED', qualification: 'ADMISSIBLE' });
  });

  it('aucun secours admissible après un quota : SUSPENSION sans écriture (cause et refus portés par l’erreur)', async () => {
    __setFallbackContextForTests({
      coupleQualifications: async () => ({ origin: 'manual', byModel: new Map([['m-b', 'REFUSED' as const], ['m-c', 'REFUSED' as const]]) }),
    });
    fake.on('m-a', () => { throw quota(); });
    const e = await AiGateway.execute(req()).catch((x) => x);
    expect(e).toMatchObject({ code: 'AI_SUSPENDED', failureCause: 'QUOTA', lastFailureCode: 'PROVIDER_UNAVAILABLE' });
    expect(e.message).toMatch(/aucun secours admissible après « quota/);
    expect((e.decisions as Decision[]).map((d) => [d.model, d.decision])).toEqual([['m-a', 'FIRST'], ['m-b', 'COUPLE_REFUSED'], ['m-c', 'COUPLE_REFUSED']]);
    expect(fake.calls).toHaveLength(1);
  });

  it('configuration d’origine AUTOMATIQUE sans preuve admissible courante : secours refusé (aucun choix spontané du système)', async () => {
    __setFallbackContextForTests({
      coupleQualifications: async () => ({ origin: 'auto', byModel: new Map([['m-b', 'OBSOLETE' as const], ['m-c', 'NEVER_TESTED' as const]]) }),
    });
    fake.on('m-a', () => { throw indispo(); });
    await expect(AiGateway.execute(req())).rejects.toMatchObject({ code: 'AI_SUSPENDED' });
    expect(sansAppel().map((t) => t.fallback?.decision)).toEqual(['NOT_QUALIFIED_AUTOMATIC', 'NOT_QUALIFIED_AUTOMATIC']);
  });

  it('sans preuve admissible (configuration manuelle, jamais testée) : secours de la chaîne admis comme « non testé — choix de l’administrateur »', () => {
    const a = P.admitCandidate({ model: 'm-b', rankIndex: 1, knownUnavailable: false, excluded: false, qualification: 'NEVER_TESTED', maxOutputTokens: 1000 },
      { cause: 'QUOTA', truncatedAtMaxOutputTokens: null, unknownAlternativesUsed: 0 }, { configOrigin: 'manual' });
    expect(a).toEqual({ admitted: true, reason: 'MANUAL_UNTESTED' });
    const inconnu = P.admitCandidate({ model: 'm-b', rankIndex: 1, knownUnavailable: false, excluded: false, qualification: 'UNKNOWN', maxOutputTokens: 1000 },
      { cause: 'QUOTA', truncatedAtMaxOutputTokens: null, unknownAlternativesUsed: 0 }, { configOrigin: null });
    expect(inconnu.admitted).toBe(true);
  });

  it('suspension d’un AUTRE traitement dans un travail de file (T3 sollicité par T1) : pas une interruption du travail (repli local conservé)', async () => {
    __setFallbackContextForTests({ coupleQualifications: async () => ({ origin: 'manual', byModel: new Map([['m-b', 'REFUSED' as const], ['m-c', 'REFUSED' as const]]) }) });
    fake.on('m-a', () => { throw quota(); });
    const e = await AiGateway.execute(req()).catch((x) => x);
    expect(e).toMatchObject({ code: 'AI_SUSPENDED', treatment: 'T1' });
    await runInJobContext({ jobId: 2, treatment: 'T3', configVersionId: null }, async () => {
      expect(isExecutionCancelled(e)).toBe(false);
    });
  });

  it('suspension dans une exécution de file = interruption : les exécutants la laissent remonter sans repli déterministe', async () => {
    __setFallbackContextForTests({ coupleQualifications: async () => ({ origin: 'manual', byModel: new Map([['m-b', 'REFUSED' as const], ['m-c', 'REFUSED' as const]]) }) });
    fake.on('m-a', () => { throw quota(); });
    const e = await AiGateway.execute(req()).catch((x) => x);
    expect(isExecutionCancelled(e)).toBe(false); // hors file : repli sans IA de l'appelant
    await runInJobContext({ jobId: 1, treatment: 'T1', configVersionId: null }, async () => {
      expect(isExecutionCancelled(e)).toBe(true);
    });
  });
});

describe('L87A-U05 — exclusions 86B respectées', () => {
  it('principal exclu PENDANT l’exécution (chaîne figée) : sauté sans appel, le suivant devient le premier sollicité (aucune cause d’échec)', async () => {
    __setFallbackContextForTests({ currentExclusions: async () => [{ kind: 'EXCLUSION', model: 'm-a', treatment: 'T1' }] });
    fake.on('m-b', () => OK);
    const r = await AiGateway.execute(req());
    expect(r.model).toBe('m-b');
    expect(fake.calls.map((c) => c.model)).toEqual(['m-b']);
    expect(sansAppel()[0]).toMatchObject({ model: 'm-a', errorCode: 'FALLBACK_NOT_ADMISSIBLE', fallback: { decision: 'EXCLUDED', afterCause: null } });
    expect(appels()[0].fallback).toMatchObject({ model: 'm-b', decision: 'FIRST', afterCause: null });
  });

  it('exclusion d’un autre traitement : sans effet', async () => {
    __setFallbackContextForTests({ currentExclusions: async () => [{ kind: 'EXCLUSION', model: 'm-a', treatment: 'T3' }] });
    fake.on('m-a', () => OK);
    expect((await AiGateway.execute(req())).model).toBe('m-a');
  });

  it('exclusions qui videraient la chaîne : ignorées (même règle que la surcouche 86B)', async () => {
    chaine(['m-a', null, null]);
    __setFallbackContextForTests({ currentExclusions: async () => [{ kind: 'EXCLUSION', model: 'm-a', treatment: null }] });
    fake.on('m-a', () => OK);
    expect((await AiGateway.execute(req())).model).toBe('m-a');
  });

  it('épreuve de qualification : jamais détournée par une exclusion', async () => {
    __setFallbackContextForTests({ currentExclusions: async () => [{ kind: 'EXCLUSION', model: 'm-a', treatment: null }] });
    fake.on('m-a', () => OK);
    expect((await AiGateway.execute(req({ triggerCode: 'qualification', maxModelAttempts: 1 }))).model).toBe('m-a');
  });

  it('exclusion EN VIGUEUR (même prise pendant l’exécution) : le secours n’est jamais appelé', async () => {
    __setFallbackContextForTests({ currentExclusions: async () => [{ kind: 'EXCLUSION', model: 'm-b', treatment: null }] });
    fake.on('m-a', () => { throw indispo(); }).on('m-c', () => OK);
    const r = await AiGateway.execute(req());
    expect(r.model).toBe('m-c');
    expect(fake.calls.map((c) => c.model)).toEqual(['m-a', 'm-c']);
    expect(sansAppel()[0]).toMatchObject({ model: 'm-b', fallback: { decision: 'EXCLUDED' } });
  });
});

describe('L87A-U06 — décision PO 08 : sortie tronquée jamais transformée en réussite', () => {
  const tronquee = (raw: string) => ({ rawText: raw, inputTokens: 5, outputTokens: 2000, meta: { finishReason: 'MAX_TOKENS' } });

  it('sortie JSON conforme mais génération arrêtée sur le plafond : échec OUTPUT_TRUNCATED, jamais réussie', async () => {
    chaine(['m-a', null, null]);
    fake.on('m-a', () => tronquee(t1Out({ ok: true })));
    const e = await AiGateway.execute(req()).catch((x) => x);
    expect(e).toMatchObject({ code: 'ALL_MODELS_FAILED', lastFailureCode: 'INVALID_OUTPUT' });
    expect(appels()[0]).toMatchObject({ status: 'error', errorCode: 'INVALID_OUTPUT', failure: { subtype: 'OUTPUT_TRUNCATED' } });
  });

  it('secours au plafond NON supérieur : refusé (le profil ne peut pas résoudre) ; secours au plafond supérieur : essayé', async () => {
    chaine(['m-a', 'm-b', 'm-c'], { operationProfiles: { [T1_TEST_OPERATION]: { maxOutputTokensByRank: [2000, 2000, 6000] } } });
    fake.on('m-a', () => tronquee('{"task":"GROUP_UPLOAD","ok":')).on('m-c', () => OK);
    const r = await AiGateway.execute(req());
    expect(r.model).toBe('m-c');
    expect(fake.calls.map((c) => [c.model, c.maxOutputTokens])).toEqual([['m-a', 2000], ['m-c', 6000]]);
    expect(sansAppel()[0]).toMatchObject({ model: 'm-b', fallback: { decision: 'PROFILE_CANNOT_RESOLVE', afterCause: 'OUTPUT_TRUNCATED' } });
  });

  it('SECOURS dont la sortie est tronquée : l’exécution n’est jamais une réussite (même si le JSON passe le schéma)', async () => {
    chaine(['m-a', 'm-b', null], { operationProfiles: { [T1_TEST_OPERATION]: { maxOutputTokensByRank: [2000, 8000] } } });
    fake.on('m-a', () => { throw indispo(); }).on('m-b', () => tronquee(t1Out({ ok: true })));
    const e = await AiGateway.execute(req()).catch((x) => x);
    expect(e).toMatchObject({ code: 'ALL_MODELS_FAILED', lastFailureCode: 'INVALID_OUTPUT' });
    expect(appels().find((t) => t.model === 'm-b')).toMatchObject({ status: 'error', failure: { subtype: 'OUTPUT_TRUNCATED' } });
  });
});

describe('L87A-U07 — traces de chaque repli (ai_usage_event, capture, erreur)', () => {
  it('appel et refus : décision dans la métadonnée ET dans les paramètres capturés', async () => {
    __setFallbackContextForTests({ coupleQualifications: async () => ({ origin: 'manual', byModel: new Map([['m-b', 'REFUSED' as const], ['m-c', 'ADMISSIBLE' as const]]) }) });
    fake.on('m-a', () => { throw delai(); }).on('m-c', () => OK);
    await AiGateway.execute(req());
    for (const t of traces()) {
      expect(t.fallback).toMatchObject({ policy: 'p7-v1', model: t.model });
      expect(t.capture?.params.fallback).toEqual(t.fallback);
    }
    expect(traces().map((t) => [t.model, t.modelRank, t.fallback?.decision, t.fallback?.afterCause ?? null])).toEqual([
      ['m-a', 'primary', 'FIRST', null],
      ['m-b', 'fallback_1', 'COUPLE_REFUSED', 'TIMEOUT'],
      ['m-c', 'fallback_2', 'QUALIFIED', 'TIMEOUT'],
    ]);
    expect(sansAppel()[0]).toMatchObject({ status: 'error', inputTokens: 0, outputTokens: 0, costMicros: 0, durationMs: 0, billable: false });
  });
});

describe('L87A-U08 — disjoncteur conservé et cohérent', () => {
  it('chaîne entièrement refusée avant appel (85C) : jamais d’avance du disjoncteur', async () => {
    __setFallbackContextForTests({ knownUnavailable: async () => new Map([['m-a', { checkedAt: null, error: null }], ['m-b', { checkedAt: null, error: null }], ['m-c', { checkedAt: null, error: null }]]) });
    await expect(AiGateway.execute(req())).rejects.toMatchObject({ code: 'AI_SUSPENDED', failureCause: 'KNOWN_UNAVAILABLE' });
    expect(fake.calls).toHaveLength(0);
    expect(h.outcomes[0]).toMatchObject({ attempts: [], chainSucceeded: null });
  });

  it('paramètres refusés sur toute la chaîne : aucun modèle compté défaillant', async () => {
    fake.onAny(() => { throw paramRefuse(); });
    await expect(AiGateway.execute(req())).rejects.toMatchObject({ code: 'ALL_MODELS_FAILED' });
    expect(fake.calls).toHaveLength(3);
    expect(h.outcomes[0]).toMatchObject({ attempts: [], chainSucceeded: null });
  });

  it('indisponibilité réelle sur toute la chaîne : échec complet compté (comportement existant)', async () => {
    fake.onAny(() => { throw indispo(); });
    await expect(AiGateway.execute(req())).rejects.toMatchObject({ code: 'ALL_MODELS_FAILED' });
    expect(h.outcomes[0]).toMatchObject({ chainSucceeded: false });
    expect((h.outcomes[0].attempts as unknown[]).length).toBe(3);
  });

  it('issue de chaîne (pure) : suspension seulement sans secours admissible après une panne de disponibilité', () => {
    const d = (decision: import('../fallback-policy').AdmissionReason) => ({ decision });
    expect(P.chainOutcome({ lastCause: 'QUOTA', decisions: [d('FIRST'), d('COUPLE_REFUSED')], attempted: 1 })).toBe('SUSPEND');
    expect(P.chainOutcome({ lastCause: 'QUOTA', decisions: [d('FIRST'), d('MANUAL_UNTESTED')], attempted: 2 })).toBe('FAIL');
    expect(P.chainOutcome({ lastCause: 'INVALID_OUTPUT', decisions: [d('FIRST'), d('COUPLE_REFUSED')], attempted: 1 })).toBe('FAIL');
    expect(P.chainOutcome({ lastCause: 'UNKNOWN', decisions: [d('FIRST'), d('MANUAL_UNTESTED'), d('UNKNOWN_CAUSE_LIMIT')], attempted: 2 })).toBe('FAIL');
    expect(P.chainOutcome({ lastCause: 'KNOWN_UNAVAILABLE', decisions: [d('KNOWN_UNAVAILABLE')], attempted: 0 })).toBe('SUSPEND');
    expect(P.chainOutcome({ lastCause: 'PARAMETER_INCOMPATIBLE', decisions: [d('FIRST')], attempted: 0 })).toBe('FAIL');
  });
});
