/**
 * Lot 114 — carte Trello #771 « IA — Fiabiliser les sondes de modèles et propager les indisponibilités jusqu'au
 * routage et aux promotions ». Partie unitaire : classification, diagnostic, persistance ordonnée (base simulée
 * en mémoire, aucun appel fournisseur). Le routage est couvert par
 * `gateway/__tests__/l114q-indisponibilites-routage.test.ts`, PostgreSQL réel par
 * `src/test/e2e/scenarios/l114q-sondes-modeles-indisponibilites.e2e.ts`.
 *
 *   L114Q-U01 (R01, S03, S07)  appel 15389 : 404 « no longer available to new users » → failed_confirmed pour
 *                              l'accès, jamais UNKNOWN ; diagnostic restitué dans la trace et l'export
 *   L114Q-U02 (R04, S04, S05)  429, 5xx, délai, réseau, sortie vide, 401, 403 ambigu : non concluants, aucun
 *                              déclassement ; 404 nu : confirmation ; 404 explicite : indisponibilité
 *   L114Q-U03 (R05, S01)       paramètres de sonde ; réponse vide ou paramètre refusé jamais « retiré »
 *   L114Q-U04 (S04)            incident global : les sondes suivantes ne partent pas, aucun modèle déclassé
 *   L114Q-U05 (R02, S06)       un verdict par ACCÈS : une autre clé ne l'efface pas et n'en hérite pas
 *   L114Q-U06 (R06, P02, S02)  hors ordre, rejeu, recontrôle non concluant, base indisponible : aucune
 *                              réactivation indue ; historique conservé
 *   L114Q-U07 (A06)            recontrôle borné : délai doublé de 1 h à 24 h
 *   L114Q-U08 (A03)            contrôle final de disponibilité lu dans une transaction
 *   L114Q-U09 (R10, B01-B04)   BO : code, accès pseudonymisé, prochaine sonde, modèles et usages comptés à part,
 *                              suspect / inconclusive et incident global séparés, aucun secret
 *   L114Q-U10 (E04, R07)       refus d'un appel réel : décision commune (enregistrer / sonder / ne rien écrire)
 */
import * as React from 'react';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { React?: typeof React }).React = React;

type Ligne = Record<string, unknown>;
const db = vi.hoisted(() => ({
  etats: new Map<string, Record<string, unknown>>(),
  historique: [] as Array<Record<string, unknown>>,
  version: 0,
  panne: false,
  requetes: [] as string[],
}));
vi.mock('@/db', () => {
  const unsafe = async (q: string, params: unknown[] = []): Promise<unknown[]> => {
    db.requetes.push(q);
    if (db.panne) throw new Error('connexion refusée');
    if (/pg_advisory_xact_lock|SAVEPOINT/.test(q)) return [];
    if (/^\s*INSERT INTO ai_model_operational_status/.test(q)) {
      const [model, fp, ok, error, source, checkStatus, errorKind, suspectSince, healthy, httpStatus, providerCode, capability, endpoint,
        probeCallId, observedAt, confirme, failureCount, nextProbeAt, stateVersion] = params;
      const avant = db.etats.get(`${String(model)}|${String(fp)}`);
      db.etats.set(`${String(model)}|${String(fp)}`, {
        model, key_fingerprint: fp, ok, error, source, check_status: checkStatus, error_kind: errorKind, suspect_since: suspectSince,
        last_ok_at: healthy ? '2026-11-13T06:00:00Z' : avant?.last_ok_at ?? null, http_status: httpStatus, provider_code: providerCode,
        capability, endpoint, probe_call_id: probeCallId, observed_at: observedAt,
        confirmed_at: confirme ? avant?.confirmed_at ?? '2026-11-13T06:15:44Z' : null, failure_count: failureCount, next_probe_at: nextProbeAt,
        state_version: stateVersion, checked_at: '2026-11-13T06:15:44Z',
      });
      return [];
    }
    if (/^\s*INSERT INTO ai_model_operational_history/.test(q)) {
      const [model, fp, , , source, outcome, definitive, kind, httpStatus, providerCode, error, checkStatus, okAfter, applied, v, callId, observedAt] = params;
      db.historique.push({ model, fp, source, outcome, definitive, kind, httpStatus, providerCode, error, checkStatus, okAfter, applied, v, callId, observedAt });
      return [];
    }
    if (/INSERT INTO verebona_cache_versions/.test(q)) { db.version++; return []; }
    if (/FROM verebona_cache_versions/.test(q)) return [{ version: db.version }];
    if (/FROM ai_model_operational_status/.test(q) && /model = \$1/.test(q)) {
      const r = db.etats.get(`${String(params[0])}|${String(params[1])}`);
      return r ? [r] : [];
    }
    if (/FROM ai_model_operational_status/.test(q)) return [...db.etats.values()].filter((r) => r.key_fingerprint === params[0]);
    return [];
  };
  const pgClient = { unsafe, begin: async <T,>(fn: (tx: { unsafe: typeof unsafe }) => Promise<T>): Promise<T> => fn({ unsafe }) };
  return { pgClient };
});
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const C = await import('../probe-classification');
const O = await import('../model-operational.service');
const A = await import('../active-model-anomalies');
const F = await import('../../gateway/fallback-context');
const { buildExecutionDiagnosis } = await import('../../telemetry/execution-diagnosis');
const { UnavailableModelCard, OperationalWatchPanel } = await import('@/app/admin/ai-config/_components/CatalogBanners');
type UsableModelsContext = import('../../registry/usable-models').UsableModelsContext;
type ActiveChainEntry = import('../active-model-anomalies').ActiveChainEntry;

const CLE = 'AIzaSyD-cle-active-de-test-0123456789';
const AUTRE_CLE = 'AIzaSyD-autre-cle-de-test-9876543210';
const MODELE = 'gemini-2.5-flash-lite';
/** Appel 15389 (faits de la carte) : HTTP 404 NOT_FOUND, message exact du fournisseur. */
const MESSAGE_15389 = 'This model models/gemini-2.5-flash-lite is no longer available to new users';
const erreur15389 = () => new Error(`{"error":{"code":404,"message":"${MESSAGE_15389}","status":"NOT_FOUND"}}`);
const etat = (model: string, cle = CLE) => db.etats.get(`${model}|${O.keyFingerprint(cle)}`) as Ligne | undefined;

beforeEach(() => {
  db.etats.clear(); db.historique = []; db.version = 0; db.panne = false; db.requetes = [];
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('L114Q-U01 — appel 15389 : refus explicite du modèle pour l’accès (R01, S03, S07)', () => {
  it('404 « no longer available to new users » : failed, définitif, fermé à CET accès — pas un retrait global, pas UNKNOWN', () => {
    for (const e of [erreur15389(), new Error(`got status: 404. ${MESSAGE_15389}`), Object.assign(new Error(MESSAGE_15389), { status: 404 })]) {
      const o = C.classifyProbeFailure(e, { model: MODELE, secret: CLE });
      expect(o).toMatchObject({ status: 'failed', kind: 'model_access_closed', definitive: true });
      expect(C.probeErrorCodeOf(o)).toBe('MODEL_UNAVAILABLE_CONFIRMED');
    }
    expect(C.PROBE_ERROR_KIND_LABELS.model_access_closed).toMatch(/accès/);
    // La règle ne dépend d'aucun nom de modèle : même verdict pour un identifiant quelconque.
    expect(C.classifyProbeFailure(new Error('{"error":{"code":404,"message":"This model models/modele-x-9 is no longer available to new users","status":"NOT_FOUND"}}'), { model: 'modele-x-9' }))
      .toMatchObject({ status: 'failed', kind: 'model_access_closed', definitive: true });
    // Un vrai retrait global reste « retiré ».
    expect(C.classifyProbeFailure(new Error('{"error":{"code":404,"status":"NOT_FOUND","message":"models/m has been retired and is no longer available."}}'), { model: 'm' }))
      .toMatchObject({ kind: 'model_retired', definitive: true });
  });

  it('diagnostic restitué : code d’erreur, famille, étape, HTTP 404, NOT_FOUND — l’export n’affiche plus UNKNOWN', () => {
    const e = erreur15389();
    const o = C.classifyProbeFailure(e, { model: MODELE, secret: CLE });
    const codes = C.providerCodesOf(e);
    expect(codes).toEqual({ httpStatus: 404, providerCode: 'NOT_FOUND' });
    const d = O.probeFailureDiagnostic(o, codes);
    expect(d.errorCode).toBe('MODEL_UNAVAILABLE_CONFIRMED');
    expect(d.failure).toMatchObject({ family: 'INPUT_ERROR', stage: 'provider_request', signature: 'probe:model_access_closed' });
    expect(d.providerMeta).toMatchObject({
      httpStatus: 404, providerErrorCode: 'NOT_FOUND',
      probe: { verdict: 'failed_confirmed', kind: 'model_access_closed', nature: 'provider_rejection', definitive: true, capability: 'text_generation', endpoint: 'generateContent' },
    });
    // Ce que l'export d'exécution reconstruit depuis la trace de l'appel (ligne d'usage sans diagnostic détaillé).
    const ligne = (avecDiagnostic: boolean) => ({
      id: 15389, status: 'error', model: MODELE, provider: 'gemini', modelRank: null, usedFallback: false, callKind: 'analysis',
      inputTokens: 0, outputTokens: 0, durationMs: 188, costMicros: 0, errorMessage: `HTTP 404 NOT_FOUND — ${MESSAGE_15389}`,
      errorCode: avecDiagnostic ? d.errorCode : null, failure: avecDiagnostic ? d.failure : undefined,
    });
    const rapport = (avec: boolean) => buildExecutionDiagnosis({ treatment: null, calls: [ligne(avec)] as never, diagnostics: [], job: null }).calls[0];
    // Avant la carte (trace sans code ni famille) : le défaut constaté dans l'export 15389.
    expect(rapport(false)).toMatchObject({ cause: 'UNKNOWN', errorCode: null, failureCategory: null });
    // Après : cause explicite.
    expect(rapport(true)).toMatchObject({ cause: 'INPUT_ERROR', errorCode: 'MODEL_UNAVAILABLE_CONFIRMED', failureCategory: 'REQUEST_REJECTED' });
  });

  it('sonde : UN seul appel, état persisté failed_confirmed avec son diagnostic, version de cache incrémentée, aucun secret', async () => {
    let appels = 0;
    const r = await O.probeModels([MODELE], CLE, { call: async () => { appels++; throw erreur15389(); }, confirmDelayMs: 0 });
    expect(appels).toBe(1); // message explicite et définitif : pas de seconde sonde (S05)
    expect(r).toEqual([{ model: MODELE, ok: false, error: `HTTP 404 NOT_FOUND — ${MESSAGE_15389}`, checkStatus: 'failed_confirmed' }]);
    expect(etat(MODELE)).toMatchObject({
      ok: false, check_status: 'failed_confirmed', error_kind: 'model_access_closed', http_status: 404, provider_code: 'NOT_FOUND',
      capability: 'text_generation', endpoint: 'generateContent', source: 'catalog_refresh', failure_count: 1, state_version: 1,
    });
    expect(etat(MODELE)?.next_probe_at).toEqual(expect.any(String));
    expect(db.version).toBe(1);
    expect(db.historique).toEqual([expect.objectContaining({ model: MODELE, outcome: 'failed', definitive: true, checkStatus: 'failed_confirmed', okAfter: false, applied: true })]);
    // Opposable aux lecteurs : sélecteurs (états retenus) et BO (diagnostic).
    expect((await O.loadOperationalStatuses(CLE)).get(MODELE)).toMatchObject({ ok: false, nextProbeAt: expect.any(String) });
    const diag = (await O.loadOperationalDiagnostics(CLE)).get(MODELE)!;
    expect(diag).toMatchObject({ ok: false, checkStatus: 'failed_confirmed', httpStatus: 404, providerCode: 'NOT_FOUND', access: `clé …${O.keyFingerprint(CLE).slice(0, 8)}` });
    expect(JSON.stringify([...db.etats.values(), ...db.historique, diag])).not.toContain(CLE);
  });
});

describe('L114Q-U02 — erreurs transitoires, globales et 404 (R04, S04, S05)', () => {
  const NON_CONCLUANTS: Array<[string, unknown, string, string]> = [
    ['429', Object.assign(new Error('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"Quota exceeded"}}'), { status: 429 }), 'quota', 'PROBE_INCONCLUSIVE'],
    ['503', Object.assign(new Error('{"error":{"code":503,"status":"UNAVAILABLE","message":"The model is overloaded."}}'), { status: 503 }), 'server', 'PROBE_INCONCLUSIVE'],
    ['500', Object.assign(new Error('Internal error'), { status: 500 }), 'server', 'PROBE_INCONCLUSIVE'],
    ['délai', Object.assign(new Error('Délai dépassé'), { code: 'TIMEOUT' }), 'timeout', 'PROBE_INCONCLUSIVE'],
    ['réseau', new Error('fetch failed: ECONNRESET'), 'network', 'PROBE_INCONCLUSIVE'],
    ['401', Object.assign(new Error('{"error":{"code":401,"status":"UNAUTHENTICATED","message":"Request had invalid authentication credentials."}}'), { status: 401 }), 'auth_global', 'PROVIDER_AUTH_FAILURE'],
    ['clé invalide (400)', new Error('{"error":{"code":400,"status":"INVALID_ARGUMENT","message":"API key not valid. Please pass a valid API key."}}'), 'auth_global', 'PROVIDER_AUTH_FAILURE'],
    ['projet', Object.assign(new Error('{"error":{"code":403,"status":"PERMISSION_DENIED","message":"Generative Language API has not been used in project 123 before or it is disabled."}}'), { status: 403 }), 'project_global', 'PROVIDER_AUTH_FAILURE'],
    ['403 ambigu', Object.assign(new Error('{"error":{"code":403,"status":"PERMISSION_DENIED","message":"The caller does not have permission"}}'), { status: 403 }), 'forbidden_ambiguous', 'PROBE_INCONCLUSIVE'],
  ];

  it.each(NON_CONCLUANTS)('%s : inconclusive, jamais un déclassement', async (_nom, e, kind, code) => {
    const o = C.classifyProbeFailure(e, { model: 'm-sain', secret: CLE });
    expect(o).toMatchObject({ status: 'inconclusive', kind });
    expect(C.probeErrorCodeOf(o)).toBe(code);
    // Modèle antérieurement sain : il le reste ; modèle jamais contrôlé : il reste inconnu (pas de `ok` inventé).
    await O.recordOperationalCheck({ model: 'm-sain', secret: CLE, outcome: { status: 'ok' }, source: 'catalog_refresh' });
    const apres = await O.recordOperationalCheck({ model: 'm-sain', secret: CLE, outcome: o, source: 'catalog_refresh' });
    expect(apres).toMatchObject({ ok: true, checkStatus: 'inconclusive', changed: false });
    const inconnu = await O.recordOperationalCheck({ model: 'm-neuf', secret: CLE, outcome: o, source: 'catalog_refresh' });
    expect(inconnu.ok).toBeNull();
    expect((await O.loadOperationalStatuses(CLE)).has('m-neuf')).toBe(false);
    expect([...db.etats.values()].some((r) => r.ok === false)).toBe(false);
  });

  it('sortie vide, même répétée : jamais un retrait confirmé', async () => {
    const r = await O.probeModels(['m-sain'], CLE, { call: async () => ({ rawText: '   ' }), confirmDelayMs: 0 });
    const r2 = await O.probeModels(['m-sain'], CLE, { call: async () => ({ rawText: '' }), confirmDelayMs: 0 });
    for (const x of [...r, ...r2]) expect(x).toMatchObject({ ok: false, transient: true, checkStatus: 'inconclusive' });
    expect(etat('m-sain')).toMatchObject({ ok: null, check_status: 'inconclusive', error_kind: 'empty_response', failure_count: 0, next_probe_at: null });
  });

  it('404 présumé définitif mais non explicite : suspect, puis confirmation par une SECONDE sonde bornée', async () => {
    await O.recordOperationalCheck({ model: 'm-sain', secret: CLE, outcome: { status: 'ok' }, source: 'catalog_refresh' });
    let appels = 0;
    const nu = () => Object.assign(new Error('Not Found'), { status: 404 });
    expect(C.classifyProbeFailure(nu(), { model: 'm-sain' })).toMatchObject({ status: 'failed', kind: 'model_not_found', definitive: false });
    // Premier échec, second contrôle réussi : le modèle reste sain (aucun déclassement).
    const r1 = await O.probeModels(['m-sain'], CLE, { call: async () => { appels++; if (appels === 1) throw nu(); return { rawText: 'OK' }; }, confirmDelayMs: 0 });
    expect(appels).toBe(2);
    expect(r1[0]).toMatchObject({ ok: true, checkStatus: 'ok' });
    expect(db.historique.map((x) => x.checkStatus)).toEqual(['ok', 'suspect', 'ok']);
    // Deux échecs consécutifs : indisponibilité confirmée, deux appels exactement.
    appels = 0;
    const r2 = await O.probeModels(['m-sain'], CLE, { call: async () => { appels++; throw nu(); }, confirmDelayMs: 0 });
    expect(appels).toBe(2);
    expect(r2[0]).toMatchObject({ ok: false, checkStatus: 'failed_confirmed' });
    expect(etat('m-sain')).toMatchObject({ ok: false, http_status: 404 });
  });
});

describe('L114Q-U03 — robustesse de la sonde (R05, S01)', () => {
  it('prompt minimal sans donnée utilisateur, raisonnement minimal, plafond de sortie 512, délai borné', () => {
    expect(O.probeCallInput('m')).toEqual({ model: 'm', prompt: 'Réponds exactement : OK', attachments: [], timeoutMs: 20_000, maxOutputTokens: 512, reasoning: 'minimal' });
  });

  it('paramètre de sonde refusé, réponse vide ou erreur de parsing : jamais « retiré » — non concluant', async () => {
    const param = Object.assign(new Error('{"error":{"code":400,"status":"INVALID_ARGUMENT","message":"Request contains an invalid argument."}}'), { status: 400 });
    expect(C.classifyProbeFailure(param, { model: 'modele-x-9' })).toMatchObject({ status: 'inconclusive', kind: 'probe_error' });
    const paramModele = Object.assign(new Error('{"error":{"code":400,"status":"INVALID_ARGUMENT","message":"Thinking level is not supported for this model."}}'), { status: 400 });
    // Paramètre de la sonde nommé par le fournisseur : la sonde est en cause — non concluant, même répété.
    expect(C.classifyProbeFailure(paramModele, { model: 'modele-x-9' })).toMatchObject({ status: 'inconclusive', kind: 'probe_parameter_rejected' });
    const max = Object.assign(new Error(`{"error":{"code":400,"status":"INVALID_ARGUMENT","message":"Invalid value at 'generation_config.max_output_tokens' for model models/modele-x-9"}}`), { status: 400 });
    expect(C.classifyProbeFailure(max, { model: 'modele-x-9' })).toMatchObject({ status: 'inconclusive', kind: 'probe_parameter_rejected' });
    expect(C.classifyProbeFailure(new SyntaxError('Unexpected token < in JSON at position 0'), { model: 'modele-x-9' })).toMatchObject({ status: 'inconclusive', kind: 'probe_error' });
    expect(C.classifyProbeResponse('')).toMatchObject({ status: 'inconclusive', kind: 'empty_response' });
    // Sonde incompatible, deux passages de suite sur un modèle sain : toujours sain, un seul appel par passage.
    await O.recordOperationalCheck({ model: 'modele-x-9', secret: CLE, outcome: { status: 'ok' }, source: 'catalog_refresh' });
    let appels = 0;
    for (let i = 0; i < 2; i++) await O.probeModels(['modele-x-9'], CLE, { call: async () => { appels++; throw paramModele; }, confirmDelayMs: 0 });
    expect(appels).toBe(2);
    expect(etat('modele-x-9')).toMatchObject({ ok: true, check_status: 'inconclusive', error_kind: 'probe_parameter_rejected' });
    expect(O.probeFailureDiagnostic({ status: 'inconclusive', kind: 'empty_response', error: 'réponse vide' }, { httpStatus: null, providerCode: null }))
      .toMatchObject({ errorCode: 'PROBE_INCONCLUSIVE', failure: { family: 'INVALID_OUTPUT', subtype: 'EMPTY_RESPONSE' }, providerMeta: { probe: { nature: 'probe_technical_failure' } } });
  });
});

describe('L114Q-U04 — incident global du fournisseur (S04)', () => {
  it('le premier modèle bute sur une clé refusée : les autres sondes ne partent pas, aucun modèle à ok=false', async () => {
    const envoyes: string[] = [];
    const r = await O.probeModels(['m-1', 'm-2', 'm-3'], CLE, {
      call: async (m) => { envoyes.push(m); throw Object.assign(new Error('{"error":{"code":401,"status":"UNAUTHENTICATED","message":"API key not valid."}}'), { status: 401 }); },
      confirmDelayMs: 0,
    });
    expect(envoyes).toEqual(['m-1']);
    expect(r.map((x) => [x.model, x.checkStatus, x.transient, x.notSent ?? false])).toEqual([
      ['m-1', 'inconclusive', true, false], ['m-2', 'inconclusive', true, true], ['m-3', 'inconclusive', true, true],
    ]);
    expect([...db.etats.values()].some((x) => x.ok === false)).toBe(false);
    // Sondes non envoyées : dernier contrôle noté non concluant (motif global), sans appel tracé, état inconnu conservé.
    expect([...db.etats.values()].map((x) => [x.model, x.ok, x.check_status, x.error_kind, x.probe_call_id])).toEqual([
      ['m-1', null, 'inconclusive', 'auth_global', null], ['m-2', null, 'inconclusive', 'auth_global', null], ['m-3', null, 'inconclusive', 'auth_global', null],
    ]);
    const veille = A.operationalWatchOf(await O.loadOperationalDiagnostics(CLE));
    expect(veille.providerIncident).toMatchObject({ code: 'PROVIDER_AUTH_FAILURE', kind: 'auth_global', models: ['m-1', 'm-2', 'm-3'] });
    expect(veille.inconclusive).toEqual([]); // l'incident global n'est pas compté parmi les modèles non concluants
  });
});

describe('L114Q-U05 — un verdict par accès (R02, S06)', () => {
  it('refus avec la clé active ; le même modèle répond avec une autre clé : ni effacement, ni exclusion globale', async () => {
    await O.probeModels([MODELE], CLE, { call: async () => { throw erreur15389(); }, confirmDelayMs: 0 });
    // « Tester la clé » avec une autre clé (avant rotation) : le modèle y répond.
    await O.recordOperationalCheck({ model: MODELE, secret: AUTRE_CLE, outcome: { status: 'ok' }, source: 'provider_test' });
    expect((await O.loadOperationalStatuses(CLE)).get(MODELE)?.ok).toBe(false);       // verdict de la clé active conservé
    expect((await O.loadOperationalStatuses(AUTRE_CLE)).get(MODELE)?.ok).toBe(true);   // pas d'exclusion pour l'autre accès
    expect(db.etats.size).toBe(2);
    // Capacité éprouvée tracée : le verdict ne prétend rien sur d'autres capacités.
    expect(etat(MODELE)).toMatchObject({ capability: 'text_generation', endpoint: 'generateContent' });
    expect(O.accessLabel(O.keyFingerprint(CLE))).toMatch(/^clé …[0-9a-f]{8}$/);
  });
});

describe('L114Q-U06 — persistance ordonnée (R06, P02, S02)', () => {
  const refus = () => C.classifyProbeFailure(erreur15389(), { model: MODELE });
  const t = (s: string) => new Date(`2026-11-13T${s}Z`);

  it('une réponse ANCIENNE n’efface pas un refus plus récent (sondes simultanées, retours hors ordre)', async () => {
    // Sonde A envoyée à 06:15:00 (lente) ; sonde B envoyée à 06:15:44, refus reçu et écrit d'abord.
    await O.recordOperationalCheck({ model: MODELE, secret: CLE, outcome: refus(), source: 'catalog_refresh', observedAt: t('06:15:44') });
    const tardive = await O.recordOperationalCheck({ model: MODELE, secret: CLE, outcome: { status: 'ok' }, source: 'provider_test', observedAt: t('06:15:00') });
    expect(tardive).toMatchObject({ ok: false, checkStatus: 'failed_confirmed', stale: true, changed: false });
    expect(etat(MODELE)).toMatchObject({ ok: false, check_status: 'failed_confirmed', state_version: 1 });
    expect(db.version).toBe(1); // aucune invalidation pour un contrôle écarté
    expect(db.historique.map((x) => [x.outcome, x.applied])).toEqual([['failed', true], ['ok', false]]);
    // Un succès POSTÉRIEUR au refus réhabilite (preuve) : état sain, blocage levé, version incrémentée.
    const preuve = await O.recordOperationalCheck({ model: MODELE, secret: CLE, outcome: { status: 'ok' }, source: 'recovery_check', observedAt: t('09:00:00') });
    expect(preuve).toMatchObject({ ok: true, checkStatus: 'ok', changed: true });
    expect(etat(MODELE)).toMatchObject({ ok: true, failure_count: 0, next_probe_at: null, confirmed_at: null });
    expect(db.version).toBe(2);
  });

  it('une indisponibilité confirmée ne redevient pas disponible sur une erreur de recontrôle ; rejeu sans effet', async () => {
    await O.recordOperationalCheck({ model: MODELE, secret: CLE, outcome: refus(), source: 'catalog_refresh', observedAt: t('06:15:44') });
    const echeance = etat(MODELE)?.next_probe_at;
    for (const o of [C.classifyProbeResponse(''), C.classifyProbeFailure(Object.assign(new Error('overloaded'), { status: 503 }))]) {
      const r = await O.recordOperationalCheck({ model: MODELE, secret: CLE, outcome: o, source: 'catalog_refresh', observedAt: t('07:00:00') });
      expect(r).toMatchObject({ ok: false, checkStatus: 'inconclusive', changed: false });
    }
    expect(etat(MODELE)).toMatchObject({ ok: false, next_probe_at: echeance, failure_count: 1 });
    // Refus rapporté par des appels réels encore en vol : réception idempotente (ni échéance repoussée, ni version).
    for (let i = 0; i < 3; i++) {
      await O.recordOperationalCheck({ model: MODELE, secret: CLE, outcome: refus(), source: 'gateway_call', observedAt: t('07:30:00') });
    }
    expect(etat(MODELE)).toMatchObject({ ok: false, failure_count: 1, next_probe_at: echeance });
    expect(db.version).toBe(1);
    expect(db.historique.filter((x) => x.source === 'gateway_call').every((x) => x.applied === false)).toBe(true);
  });

  it('base momentanément inaccessible : rien n’est inventé, rien n’est réactivé, aucune exception', async () => {
    await O.recordOperationalCheck({ model: MODELE, secret: CLE, outcome: refus(), source: 'catalog_refresh' });
    db.panne = true;
    const r = await O.recordOperationalCheck({ model: MODELE, secret: CLE, outcome: { status: 'ok' }, source: 'catalog_refresh' });
    expect(r.changed).toBe(false);
    expect((await O.loadOperationalStatuses(CLE)).size).toBe(0); // illisible : inconnu, jamais « ok »
    db.panne = false;
    expect(etat(MODELE)).toMatchObject({ ok: false, check_status: 'failed_confirmed' }); // état canonique intact
  });
});

describe('L114Q-U07 — recontrôle borné d’un modèle refusé (A06)', () => {
  it('délai doublé à chaque échec confirmé, de 1 h à 24 h', () => {
    const h1 = 60 * 60_000;
    expect([1, 2, 3, 4, 5, 6, 50].map((n) => C.nextProbeDelayMs(n) / h1)).toEqual([1, 2, 4, 8, 16, 24, 24]);
    expect(C.nextProbeDelayMs(0)).toBe(h1);
  });

  it('chaque recontrôle en échec repousse l’échéance ; la passerelle ne relance aucune sonde avant elle', async () => {
    const now = new Date('2026-11-13T06:15:44Z');
    const refus = C.classifyProbeFailure(erreur15389(), { model: MODELE });
    const a = await O.recordOperationalCheck({ model: MODELE, secret: CLE, outcome: refus, source: 'catalog_refresh', now });
    expect(a.nextProbeAt).toBe('2026-11-13T07:15:44.000Z');
    const b = await O.recordOperationalCheck({ model: MODELE, secret: CLE, outcome: refus, source: 'recovery_check', now: new Date('2026-11-13T07:20:00Z') });
    expect(b.nextProbeAt).toBe('2026-11-13T09:20:00.000Z');
    expect(etat(MODELE)).toMatchObject({ failure_count: 2 });
    // Sans base autorisée en test unitaire, la passerelle ne sonde jamais ; l'échéance est portée par l'indice lu.
    expect(F.noteKnownUnavailableSkipped(MODELE, { checkedAt: '2026-11-13T07:20:00.000Z', error: null, nextProbeAt: b.nextProbeAt }, Date.parse('2026-11-13T08:30:00Z'))).toBe(false);
  });
});

describe('L114Q-U08 — contrôle final de disponibilité dans une transaction (A03)', () => {
  it('confirmé indisponible pour la clé active : refus ; sain, inconnu, suspect, autre clé ou illisible : aucun refus', async () => {
    const tx = { unsafe: (await import('@/db')).pgClient.unsafe as (q: string, p?: never[]) => Promise<unknown> };
    expect(await O.operationalRefusalInTx(tx, MODELE, CLE)).toBeNull(); // jamais contrôlé
    await O.recordOperationalCheck({ model: MODELE, secret: CLE, outcome: C.classifyProbeFailure(erreur15389(), { model: MODELE }), source: 'catalog_refresh' });
    expect(await O.operationalRefusalInTx(tx, MODELE, CLE)).toMatchObject({ error: `HTTP 404 NOT_FOUND — ${MESSAGE_15389}`, checkedAt: expect.any(String) });
    expect(await O.operationalRefusalInTx(tx, MODELE, AUTRE_CLE)).toBeNull();
    expect(await O.operationalRefusalInTx(tx, MODELE, null)).toBeNull();
    await O.recordOperationalCheck({ model: 'm-suspect', secret: CLE, outcome: { status: 'failed', kind: 'model_not_found', error: 'HTTP 404', definitive: false }, source: 'catalog_refresh' });
    expect(await O.operationalRefusalInTx(tx, 'm-suspect', CLE)).toBeNull();
    db.panne = true;
    expect(await O.operationalRefusalInTx(tx, MODELE, CLE)).toBeNull();
  });
});

describe('L114Q-U09 — BO et alertes (R10, B01 à B04)', () => {
  // Même règle pour tout modèle : le cas est rejoué sur un modèle des chaînes de test (catalogue simulé).
  const ACTIF = 'gemini-3.6-flash';
  const REPLI = 'gemini-3.1-flash-lite';
  const refusActif = () => new Error(`{"error":{"code":404,"message":"This model models/${ACTIF} is no longer available to new users","status":"NOT_FOUND"}} key=${CLE}`);
  const CHAINES: ActiveChainEntry[] = [
    { treatment: 'T1', rank: 'primaryModel', model: ACTIF, source: 'version' },
    { treatment: 'T2', rank: 'fallback1', model: ACTIF, source: 'version' },
    { treatment: 'T3', rank: 'fallback2', model: ACTIF, source: 'version' },
    { treatment: 'T4', rank: 'fallback1', model: ACTIF, source: 'version' },
    { treatment: 'T6', rank: 'fallback1', model: ACTIF, source: 'version' },
    { treatment: 'T1', rank: 'fallback1', model: REPLI, source: 'version' },
  ];
  const contexte = (operational: UsableModelsContext['operational']): UsableModelsContext => ({
    environment: 'production',
    catalog: {
      refreshedAt: '2026-11-13T06:00:00Z',
      models: [ACTIF, REPLI].map((model) => ({ model, available: true, supportsGeneration: true, lifecycle: 'stable' as const })),
    },
    codeCatalog: [],
    price: () => ({ verified: false, eligible: true }),
    operational,
    qualifications: new Map(),
    today: '2026-11-13',
  });

  it('1 modèle indisponible — 5 usages impactés ; code, accès pseudonymisé et prochaine sonde affichés ; aucun secret', async () => {
    await O.probeModels([ACTIF], CLE, { call: async () => { throw refusActif(); }, confirmDelayMs: 0 });
    const diagnostics = await O.loadOperationalDiagnostics(CLE);
    const anomalies = A.detectActiveModelAnomalies(CHAINES, contexte(await O.loadOperationalStatuses(CLE)));
    const groupes = A.groupAnomaliesByModel(anomalies, diagnostics);
    expect(A.unavailableBannerTitle(groupes)).toBe('1 modèle actif indisponible — 5 usages impactés');
    expect(groupes).toHaveLength(1);
    expect(groupes[0].diagnostic).toMatchObject({
      status: 'failed_confirmed', httpStatus: 404, providerCode: 'NOT_FOUND', errorKindLabel: C.PROBE_ERROR_KIND_LABELS.model_access_closed,
      access: `clé …${O.keyFingerprint(CLE).slice(0, 8)}`, nextProbeAt: expect.any(String), sourceLabel: 'actualisation du catalogue (sonde)',
    });
    const html = renderToStaticMarkup(h('ul', null, h(UnavailableModelCard, { group: groupes[0] as never })));
    expect(html).toContain('HTTP 404 · NOT_FOUND');
    expect(html).toContain('no longer available to new users');
    expect(html).toContain('Accès concerné');
    expect(html).toContain('Prochaine sonde');
    expect(html).not.toContain(CLE);
    expect(html).not.toMatch(/AIza/);
    expect(html).not.toMatch(/#[0-9a-fA-F]{6}\b/); // charte : jetons CSS uniquement

    // Alerte : UNE par modèle (usages regroupés, modèles et usages comptés à part), niveau agrégé.
    const levees: Array<Record<string, unknown>> = [];
    const n = await A.raiseActiveModelAlerts(anomalies, new Date('2026-11-13T08:00:00Z'), async (a) => { levees.push(a as never); return true; }, diagnostics);
    expect(n).toBe(1);
    expect(levees[0]).toMatchObject({
      code: 'ai_active_model_unavailable', severity: 'warning',
      details: { model: ACTIF, counts: { models: 1, usages: 5 }, diagnostic: { httpStatus: 404, providerCode: 'NOT_FOUND', errorKind: 'model_access_closed' } },
    });
    expect(JSON.stringify(levees)).not.toContain(CLE);
    // Aucun repli utilisable pour un principal : critique.
    const sansRepli = A.detectActiveModelAnomalies(CHAINES.slice(0, 5), contexte(await O.loadOperationalStatuses(CLE)));
    expect(A.groupAnomaliesByModel(sansRepli, diagnostics)[0].severity).toBe('critical');
  });

  it('suspect et inconclusive affichés à part des indisponibilités ; décompte jamais « tout est sain » faute de sonde', async () => {
    expect(A.operationalWatchOf(new Map()).summary).toMatch(/Aucun modèle contrôlé/);
    await O.recordOperationalCheck({ model: 'm-ok', secret: CLE, outcome: { status: 'ok' }, source: 'catalog_refresh' });
    await O.recordOperationalCheck({ model: 'm-suspect', secret: CLE, outcome: { status: 'failed', kind: 'model_not_found', error: 'HTTP 404 NOT_FOUND', definitive: false }, source: 'qualification' });
    await O.recordOperationalCheck({ model: 'm-quota', secret: CLE, outcome: { status: 'inconclusive', kind: 'quota', error: 'HTTP 429 RESOURCE_EXHAUSTED — Quota exceeded' }, source: 'catalog_refresh' });
    const veille = A.operationalWatchOf(await O.loadOperationalDiagnostics(CLE));
    expect(veille.providerIncident).toBeNull();
    expect(veille.suspect.map((e) => e.model)).toEqual(['m-suspect']);
    expect(veille.inconclusive).toEqual([expect.objectContaining({ model: 'm-quota', httpStatus: 429, providerCode: 'RESOURCE_EXHAUSTED', operational: null })]);
    expect(veille.counts).toEqual({ controlled: 3, ok: 1, failedConfirmed: 0, suspect: 1, inconclusive: 1 });
    const html = renderToStaticMarkup(h(OperationalWatchPanel, { watch: veille as never }));
    expect(html).toContain('m-suspect');
    expect(html).toContain('modèle toujours appelable');
    expect(html).toContain('HTTP 429 · RESOURCE_EXHAUSTED');
    expect(html).not.toContain('Incident global');
  });
});

describe('L114Q-U10 — refus d’un appel réel : décision commune aux sondes (E04, R07)', () => {
  const d = (error: unknown, httpStatus: number | null, model = MODELE) => F.refusalDecision({ model, error, httpStatus });

  it('404 explicite visant le modèle appelé : enregistrer ; 404 nu ou 403 visant le modèle : sonde bornée', async () => {
    expect(await d(erreur15389(), 404)).toMatchObject({ action: 'record', outcome: { kind: 'model_access_closed', definitive: true } });
    expect(await d(Object.assign(new Error('Not Found'), { status: 404 }), 404)).toMatchObject({ action: 'probe' });
    expect(await d(new Error(`{"error":{"code":403,"status":"PERMISSION_DENIED","message":"Permission denied on model models/${MODELE}"}}`), 403)).toMatchObject({ action: 'probe' });
    // Message définitif qui cite UN AUTRE modèle que celui appelé : jamais enregistré d'office.
    expect((await d(new Error('{"error":{"code":404,"status":"NOT_FOUND","message":"models/autre-modele is not found for API version v1beta"}}'), 404))?.action).toBe('probe');
  });

  it('429, 5xx, délai, réseau, clé, projet, paramètre refusé : rien n’est écrit, aucune sonde', async () => {
    const riens: Array<[unknown, number | null]> = [
      [Object.assign(new Error('Resource has been exhausted (e.g. check quota).'), { status: 429 }), 429],
      [Object.assign(new Error('{"error":{"code":503,"message":"overloaded","status":"UNAVAILABLE"}}'), { status: 503 }), 503],
      [Object.assign(new Error('Délai dépassé'), { code: 'TIMEOUT' }), null],
      [new Error('fetch failed'), null],
      [Object.assign(new Error('{"error":{"code":401,"message":"API key not valid.","status":"UNAUTHENTICATED"}}'), { status: 401 }), 401],
      [Object.assign(new Error('{"error":{"code":400,"message":"Thinking level is not supported for this model.","status":"INVALID_ARGUMENT"}}'), { status: 400 }), 400],
      [new Error('quelque chose d’inattendu'), null],
    ];
    for (const [e, s] of riens) expect(await d(e, s)).toBeNull();
    // Le lecteur par défaut n'écrit jamais en test unitaire (aucune base) : rien n'est modifié.
    expect(await F.fallbackContext().reportRefusal({ model: MODELE, error: erreur15389(), httpStatus: 404, sentAt: new Date() })).toBeNull();
    expect(db.etats.size).toBe(0);
  });
});
