/**
 * Lot 115 — carte Trello #786 « IA — Corriger les 8 écarts du lot 114Q ». Partie unitaire : frontière commune
 * d'admission des envois, politique de validité, lecture fiable ou non, ordre et idempotence des contrôles.
 * Base simulée en mémoire (colonnes 1815 présentes), AUCUN appel fournisseur.
 * Routage : `gateway/__tests__/l115i-admission-routage.test.ts` ; PostgreSQL réel :
 * `src/test/e2e/scenarios/l115i-ia-disponibilite.e2e.ts`.
 *
 *   L115I-U01 (E06, R12)  politique de validité : absent, inconnu, non concluant, sain, refus confirmé
 *   L115I-U02 (E01, R01)  panne de lecture : le dernier verdict FIABLE est conservé — les interdictions tiennent,
 *                         un refus confirmé n'expire jamais en autorisation
 *   L115I-U03 (E01, R02)  cache froid sans aucun verdict fiable : envoi SUSPENDU (invérifiable), jamais un faux
 *                         retrait du modèle, jamais un blocage global
 *   L115I-U04 (E03, R17)  inventaire des points d'envoi : chacun a sa garde ; seules les sondes explicites de
 *                         disponibilité et de rétablissement sont exemptées
 *   L115I-U05 (E04, R08)  identifiant stable : rejouer un contrôle ne change ni état, ni compteur, ni échéance
 *   L115I-U06 (E04, R07)  dates égales et horloge de worker en avance : un refus confirmé n'est pas levé
 *   L115I-U07 (E05, R09)  accès figé à l'ENVOI : une rotation de clé en vol n'attribue rien à la nouvelle clé
 *   L115I-U08 (E01, R02)  contrôle final de promotion impossible : verdict « invérifiable », jamais « rien ne s'oppose »
 *   L115I-U09 (E08)       mesures d'admission : envois autorisés, refusés par motif, aucun coût fictif
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  etats: new Map<string, Record<string, unknown>>(),
  historique: [] as Array<Record<string, unknown>>,
  version: 0,
  panne: false,
  /** Colonnes de la migration 1815 présentes ? */
  schema1815: true,
  now: '2026-11-16T10:00:00.000Z',
}));
vi.mock('@/db', () => {
  const unsafe = async (q: string, params: unknown[] = []): Promise<unknown[]> => {
    if (/information_schema\.columns/.test(q)) return db.schema1815 ? [{ n: 1 }] : [];
    if (db.panne) throw new Error('connexion refusée');
    if (/pg_advisory_xact_lock|SAVEPOINT/.test(q)) return [];
    if (/SELECT now\(\) AS t/.test(q)) return [{ t: db.now }];
    if (/^\s*INSERT INTO ai_model_operational_status/.test(q)) {
      const [model, fp, ok, error, source, checkStatus, errorKind, suspectSince, healthy, httpStatus, providerCode, capability, endpoint,
        probeCallId, observedAt, confirme, failureCount, nextProbeAt, stateVersion, checkId, environment, apiVersion, lastResultStatus, lastResultKind] = params;
      const avant = db.etats.get(`${String(model)}|${String(fp)}`);
      db.etats.set(`${String(model)}|${String(fp)}`, {
        model, key_fingerprint: fp, ok, error, source, check_status: checkStatus, error_kind: errorKind, suspect_since: suspectSince,
        last_ok_at: healthy ? db.now : avant?.last_ok_at ?? null, http_status: httpStatus, provider_code: providerCode,
        capability, endpoint, probe_call_id: probeCallId, observed_at: observedAt,
        confirmed_at: confirme ? avant?.confirmed_at ?? db.now : null, failure_count: failureCount, next_probe_at: nextProbeAt,
        state_version: stateVersion, checked_at: db.now,
        check_id: checkId ?? null, environment: environment ?? null, api_version: apiVersion ?? null,
        last_result_status: lastResultStatus ?? null, last_result_kind: lastResultKind ?? null, last_result_at: db.now,
      });
      return [];
    }
    if (/^\s*INSERT INTO ai_model_operational_history/.test(q)) {
      const [model, fp, , , source, outcome, , kind, , , error, checkStatus, okAfter, applied, v, , observedAt, checkId, , , discarded] = params;
      db.historique.push({ model, fp, source, outcome, kind, error, checkStatus, okAfter, applied, v, observedAt, checkId, discarded });
      return [];
    }
    if (/FROM ai_model_operational_history/.test(q) && /check_id = \$3/.test(q)) {
      return db.historique.filter((h) => h.model === params[0] && h.fp === params[1] && h.checkId === params[2]).slice(0, 1).map(() => ({ one: 1 }));
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

const A = await import('../operational-admission');
const O = await import('../model-operational.service');
const C = await import('../probe-classification');
const F = await import('../../gateway/fallback-context');
const { setProviderSecretResolver } = await import('../provider-secret');

const CLE = 'AIzaSyD-cle-active-786-0123456789';
const AUTRE_CLE = 'AIzaSyD-autre-cle-786-9876543210';
const MODELE = 'gemini-3.6-flash';
const refus404 = (model = MODELE) => new Error(
  `{"error":{"code":404,"message":"This model models/${model} is no longer available to new users","status":"NOT_FOUND"}}`);

const verdict = (over: Partial<import('../operational-admission').PublishedVerdict> = {}) => ({
  ...A.unknownVerdict(MODELE, true), ...over,
});

beforeEach(() => {
  db.etats.clear(); db.historique = []; db.version = 0; db.panne = false; db.schema1815 = true;
  O.__resetOperationalSchemaState();
  A.__setPublishedVerdictReaderForTests(null);
  A.__resetLastReliableVerdicts();
  A.__resetAdmissionMetrics();
  setProviderSecretResolver(async () => CLE);
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  A.__setPublishedVerdictReaderForTests(null);
  setProviderSecretResolver(null);
  vi.restoreAllMocks();
});

describe('L115I-U01 — politique de validité d’une route (E06, R12)', () => {
  const cas: Array<[string, import('../operational-admission').PublishedVerdict, boolean, string | null]> = [
    ['refus confirmé', verdict({ state: 'unavailable', checkStatus: 'failed_confirmed' }), false, 'MODEL_UNAVAILABLE'],
    ['sain', verdict({ state: 'healthy', checkStatus: 'ok' }), true, null],
    ['dernier contrôle non concluant, état retenu sain', verdict({ state: 'healthy', checkStatus: 'inconclusive' }), true, null],
    ['à confirmer (suspect), état retenu sain', verdict({ state: 'healthy', checkStatus: 'suspect' }), true, null],
    ['absent / jamais contrôlé (lecture fiable)', verdict(), true, null],
    ['refus confirmé + dernier contrôle non concluant', verdict({ state: 'unavailable', checkStatus: 'failed_confirmed', lastResultStatus: 'inconclusive' }), false, 'MODEL_UNAVAILABLE'],
    ['lecture impossible, aucun verdict fiable', verdict({ reliable: false }), false, 'ADMISSION_UNVERIFIABLE'],
    ['lecture impossible, dernier verdict fiable « refusé »', verdict({ state: 'unavailable', reliable: false, fromLastReliable: true }), false, 'MODEL_UNAVAILABLE'],
    ['lecture impossible, dernier verdict fiable « sain »', verdict({ state: 'healthy', reliable: false, fromLastReliable: true }), true, null],
  ];
  for (const [nom, v, admis, code] of cas) {
    it(`${nom} : ${admis ? 'envoi admis' : `envoi refusé (${code})`}`, () => {
      const a = A.admitSend({ point: 'gateway_send', verdict: v, dimensionActive: true });
      expect(a.admitted).toBe(admis);
      if (!a.admitted) expect(a.code).toBe(code);
    });
  }

  it('un refus confirmé ne s’éteint ni par ancienneté du verdict, ni par expiration de cache', () => {
    const vieux = verdict({ state: 'unavailable', checkStatus: 'failed_confirmed', checkedAt: '2020-01-01T00:00:00.000Z', confirmedAt: '2020-01-01T00:00:00.000Z' });
    expect(A.admitSend({ point: 'gateway_send', verdict: vieux, dimensionActive: true }).admitted).toBe(false);
    // Même verdict servi depuis la mémoire d'instance (base illisible) : toujours opposable.
    expect(A.admitSend({ point: 'gateway_send', verdict: { ...vieux, reliable: false, fromLastReliable: true }, dimensionActive: true }).admitted).toBe(false);
  });

  it('dimension non instrumentée (test unitaire sans base) : rien n’est refusé ni suspendu', () => {
    const a = A.admitSend({ point: 'gateway_send', verdict: verdict({ reliable: false }), dimensionActive: false });
    expect(a).toMatchObject({ admitted: true, reason: 'DIMENSION_INACTIVE' });
  });
});

describe('L115I-U02 — panne de lecture : dernier verdict fiable conservé (E01, R01)', () => {
  it('cache chaud contenant un refus, puis base inaccessible : l’interdiction tient, zéro envoi', async () => {
    await O.recordOperationalCheck({ model: MODELE, secret: CLE, outcome: C.classifyProbeFailure(refus404(), { model: MODELE }), source: 'catalog_refresh', checkId: 'l115i-admission-disponibilite-141' });
    A.__enableAdmissionDbForTests(true);
    try {
      // Lecture fiable : la route est refusée, le verdict est mémorisé.
      expect((await A.guardSend({ model: MODELE, point: 'gateway_send' })).admitted).toBe(false);
      // Base inaccessible : la lecture échoue — le dernier verdict FIABLE reste opposable.
      db.panne = true;
      const a = await A.guardSend({ model: MODELE, point: 'gateway_send' });
      expect(a.admitted).toBe(false);
      expect(a).toMatchObject({ code: 'MODEL_UNAVAILABLE', verdict: { fromLastReliable: true } });
      expect(A.admissionMetrics().servedFromLastReliable).toBeGreaterThanOrEqual(1);
    } finally {
      A.__enableAdmissionDbForTests(false);
    }
  });

  it('lecture en erreur : l’instantané n’est PAS « aucune indisponibilité » (règle remplacée, carte #786)', async () => {
    await O.recordOperationalCheck({ model: MODELE, secret: CLE, outcome: C.classifyProbeFailure(refus404(), { model: MODELE }), source: 'catalog_refresh', checkId: 'l115i-admission-disponibilite-158' });
    const bon = await O.loadOperationalSnapshot(CLE);
    expect(bon.reliable).toBe(true);
    expect([...bon.statuses.keys()]).toEqual([MODELE]);
    db.panne = true;
    const mauvais = await O.loadOperationalSnapshot(CLE);
    expect(mauvais.reliable).toBe(false);
    /**
     * Règle complétée (carte #786, D01) : la lecture impossible rendait une table VIDE. Le BO et l'API
     * `catalog-status` recalculaient alors les anomalies sur ce vide et montraient « tout sain », alors
     * qu'aucun rétablissement n'avait eu lieu. Le DERNIER INSTANTANÉ FIABLE est désormais rendu — avec
     * `reliable: false` et sa PROVENANCE, pour qu'aucun appelant ne le confonde avec une lecture fraîche.
     */
    expect(mauvais.completeness).toBe('last_reliable');
    expect([...mauvais.statuses.keys()]).toEqual([MODELE]);
    expect(mauvais.statuses.get(MODELE)?.ok).toBe(false); // l'interdiction tient, jamais « ok »
    // Démarrage à FROID (aucun instantané fiable connu) : rien n'est su, et surtout rien n'est « sain ».
    O.__resetOperationalSnapshotMemory();
    const froid = await O.loadOperationalSnapshot(CLE);
    expect(froid).toMatchObject({ reliable: false, completeness: 'none' });
    expect(froid.statuses.size).toBe(0);
  });

  it('une route lue FIABLEMENT comme absente reste admise pendant la panne (l’inconnu n’exclut rien)', async () => {
    A.__enableAdmissionDbForTests(true);
    try {
      expect((await A.guardSend({ model: 'm-jamais-controle', point: 'gateway_send' })).admitted).toBe(true);
      db.panne = true;
      const a = await A.guardSend({ model: 'm-jamais-controle', point: 'gateway_send' });
      expect(a).toMatchObject({ admitted: true, verdict: { fromLastReliable: true } });
    } finally {
      A.__enableAdmissionDbForTests(false);
    }
  });
});

describe('L115I-U03 — cache froid et admission invérifiable (E01, R02)', () => {
  it('démarrage à froid pendant une panne : envoi SUSPENDU, aucun modèle déclaré retiré, aucune écriture', async () => {
    db.panne = true;
    A.__enableAdmissionDbForTests(true); // remet aussi la mémoire des verdicts à zéro (démarrage à froid)
    try {
      const a = await A.guardSend({ model: MODELE, point: 'gateway_send' });
      expect(a).toMatchObject({ admitted: false, code: 'ADMISSION_UNVERIFIABLE' });
      expect(a.verdict.state).toBe('unknown'); // rien n'est conclu sur le modèle
      expect(db.etats.size).toBe(0); // aucune écriture, aucun faux retrait
      expect(A.admissionMetrics()).toMatchObject({ refusedUnverifiable: 1, refusedUnavailable: 0 });
    } finally {
      A.__enableAdmissionDbForTests(false);
    }
  });

  it('migration critique absente : signalée, et l’admission devient prudente (pas de repli silencieux)', async () => {
    db.schema1815 = false;
    O.__resetOperationalSchemaState();
    await O.recordOperationalCheck({ model: MODELE, secret: CLE, outcome: { status: 'ok' }, source: 'catalog_refresh', checkId: 'l115i-admission-disponibilite-199' });
    expect(O.operationalSchemaState()).toMatchObject({ complete: false, degradedReason: expect.stringMatching(/1815/) });
  });
});

describe('L115I-U04 — inventaire des points d’envoi (E03, R17)', () => {
  it('tout point d’envoi est recensé avec sa nature ; seules les sondes explicites sont exemptées', () => {
    const ordinaires = A.SEND_POINTS.filter((s) => s.kind === 'ordinary').map((s) => s.point);
    const sondes = A.SEND_POINTS.filter((s) => s.kind === 'authorized_probe').map((s) => s.point);
    expect(ordinaires).toEqual([
      'gateway_rank', 'gateway_send', 'gateway_schema_retry', 'gateway_diagnostic_retry', 'gateway_repair',
      'qualification_trial', 'provider_key_test', 'breaker_probe',
    ]);
    expect(sondes).toEqual(['availability_probe', 'recovery_probe']);
    // Une épreuve de qualification n'est PAS une sonde de récupération (règle remplacée, carte #786).
    expect(A.sendKindOf('qualification_trial')).toBe('ordinary');
    for (const p of ordinaires) {
      expect(A.admitSend({ point: p, verdict: verdict({ state: 'unavailable' }), dimensionActive: true }).admitted, p).toBe(false);
    }
    for (const p of sondes) {
      expect(A.admitSend({ point: p, verdict: verdict({ state: 'unavailable' }), dimensionActive: true }).admitted, p).toBe(true);
    }
    expect(A.SEND_POINTS.every((s) => s.label.length > 10)).toBe(true);
  });

  it('`assertSendAdmissible` lève une erreur nommée pour les appelants hors passerelle', async () => {
    A.__setPublishedVerdictReaderForTests(async (model) => verdict({ model, state: 'unavailable', checkStatus: 'failed_confirmed', error: 'HTTP 404 NOT_FOUND' }));
    await expect(A.assertSendAdmissible({ model: MODELE, point: 'qualification_trial' })).rejects.toMatchObject({
      name: 'ModelSendRefused', code: 'MODEL_UNAVAILABLE', model: MODELE, point: 'qualification_trial',
    });
    // Une sonde autorisée passe, même sur une route refusée (elle doit l'atteindre pour trancher).
    await expect(A.assertSendAdmissible({ model: MODELE, point: 'recovery_probe' })).resolves.toBeUndefined();
  });
});

describe('L115I-U05 — identifiant stable et idempotence (E04, R08)', () => {
  it('rejouer le même contrôle : aucun changement d’état, de compteur, d’échéance, ni seconde ligne d’historique', async () => {
    const refus = C.classifyProbeFailure(refus404(), { model: MODELE });
    const un = await O.recordOperationalCheck({ model: MODELE, secret: CLE, outcome: refus, source: 'catalog_refresh', checkId: 'c-1' });
    const apres1 = { ...db.etats.get(`${MODELE}|${O.keyFingerprint(CLE)}`) };
    const lignes1 = db.historique.length;
    const deux = await O.recordOperationalCheck({ model: MODELE, secret: CLE, outcome: refus, source: 'catalog_refresh', checkId: 'c-1' });
    expect(deux.changed).toBe(false);
    expect(db.historique).toHaveLength(lignes1);
    expect({ ...db.etats.get(`${MODELE}|${O.keyFingerprint(CLE)}`) }).toEqual(apres1);
    expect(un.nextProbeAt).toBe(deux.nextProbeAt);
    expect(apres1.failure_count).toBe(1); // un même échec reçu deux fois n'est pas deux sondes
  });

  it('un recontrôle NOUVEAU qui échoue de nouveau garde son effet : échéance doublée (A06 conservé)', async () => {
    const refus = C.classifyProbeFailure(refus404(), { model: MODELE });
    const a = await O.recordOperationalCheck({ model: MODELE, secret: CLE, outcome: refus, source: 'catalog_refresh', checkId: 'c-1', now: new Date('2026-11-16T06:00:00Z') });
    const b = await O.recordOperationalCheck({ model: MODELE, secret: CLE, outcome: refus, source: 'recovery_check', checkId: 'c-2', now: new Date('2026-11-16T08:00:00Z') });
    expect(a.nextProbeAt).toBe('2026-11-16T07:00:00.000Z');
    expect(b.nextProbeAt).toBe('2026-11-16T10:00:00.000Z');
    expect(db.etats.get(`${MODELE}|${O.keyFingerprint(CLE)}`)).toMatchObject({ failure_count: 2 });
  });

  it('le dernier RÉSULTAT reçu est conservé à part du verdict retenu', async () => {
    await O.recordOperationalCheck({ model: MODELE, secret: CLE, outcome: C.classifyProbeFailure(refus404(), { model: MODELE }), source: 'catalog_refresh', checkId: 'r-1' });
    await O.recordOperationalCheck({
      model: MODELE, secret: CLE, source: 'recovery_check', checkId: 'r-2',
      outcome: { status: 'inconclusive', kind: 'quota', error: 'HTTP 429 RESOURCE_EXHAUSTED' },
    });
    const e = db.etats.get(`${MODELE}|${O.keyFingerprint(CLE)}`)!;
    // Verdict RETENU : toujours refusé (`ok = false`), même si le dernier contrôle n'a rien conclu — c'est
    // pourquoi le décompte « indisponibles confirmés » suit l'état retenu et non le dernier `check_status`.
    expect(e).toMatchObject({ ok: false, check_status: 'inconclusive', last_result_status: 'inconclusive', last_result_kind: 'quota' });
    const v = await O.readPublishedVerdict(MODELE, CLE);
    expect(v).toMatchObject({ state: 'unavailable', reliable: true, lastResultStatus: 'inconclusive' });
  });
});

describe('L115I-U06 — ordre : dates égales, horloge décalée (E04, R07)', () => {
  it('instant d’envoi ÉGAL à celui du verdict en vigueur : un succès ne lève pas le refus (écarté, historisé)', async () => {
    const quand = new Date('2026-11-16T09:00:00.000Z');
    await O.recordOperationalCheck({ model: MODELE, secret: CLE, outcome: C.classifyProbeFailure(refus404(), { model: MODELE }), source: 'catalog_refresh', observedAt: quand, checkId: 'o-1' });
    const r = await O.recordOperationalCheck({ model: MODELE, secret: CLE, outcome: { status: 'ok' }, source: 'provider_test', observedAt: quand, checkId: 'o-2' });
    expect(r.stale).toBe(true);
    expect(db.etats.get(`${MODELE}|${O.keyFingerprint(CLE)}`)).toMatchObject({ ok: false, check_status: 'failed_confirmed' });
    expect(db.historique.at(-1)).toMatchObject({ applied: false, discarded: 'equal_instant', checkId: 'o-2' });
  });

  /**
   * Règle complétée (carte #786, B02) : l'écart d'horloge est désormais MESURÉ entre l'horloge du worker
   * (`now`, son heure au moment de l'enregistrement) et celle de la base, puis l'instant d'envoi est DÉPLACÉ
   * de cet écart — dans les deux sens. Le test fournit donc `now`, sans quoi l'instant d'envoi et l'heure du
   * worker seraient sur deux échelles de temps différentes (il s'appuyait auparavant sur la seule comparaison
   * `observedAt` / heure de la base, qui ne corrigeait que l'avance).
   */
  it('horloge d’un worker en AVANCE : l’instant d’envoi est ramené à l’heure de la base, jamais extrapolé', async () => {
    db.now = '2026-11-16T10:00:00.000Z';
    // Worker en avance de 2 h : il croit qu'il est 12 h 00 et date son envoi de 12 h 00.
    const horlogeWorker = new Date('2026-11-16T12:00:00.000Z');
    await O.recordOperationalCheck({
      model: MODELE, secret: CLE, outcome: C.classifyProbeFailure(refus404(), { model: MODELE }),
      source: 'catalog_refresh', observedAt: horlogeWorker, now: horlogeWorker, checkId: 'h-1',
    });
    expect(db.etats.get(`${MODELE}|${O.keyFingerprint(CLE)}`)).toMatchObject({ observed_at: db.now });
    // Un contrôle réellement postérieur (heure de la base) reste, lui, pris en compte.
    const r = await O.recordOperationalCheck({
      model: MODELE, secret: CLE, outcome: { status: 'ok' }, source: 'recovery_check',
      observedAt: new Date('2026-11-16T10:00:05.000Z'), now: new Date('2026-11-16T10:00:05.000Z'), checkId: 'h-2',
    });
    expect(r.ok).toBe(true);
  });

  /**
   * #786 (B02) — horloge d'un worker en RETARD : corrigée elle aussi (elle ne l'était pas). Un résultat
   * réellement postérieur au verdict en vigueur n'est plus écarté à tort parce que son worker est en retard.
   */
  it('horloge d’un worker en RETARD : l’instant d’envoi est recalé, et le résultat n’est pas écarté à tort', async () => {
    db.now = '2026-11-16T10:00:00.000Z';
    // Refus publié par un worker à l'heure (son horloge est celle de la base) : envoi daté 09 h 00.
    await O.recordOperationalCheck({
      model: MODELE, secret: CLE, outcome: C.classifyProbeFailure(refus404(), { model: MODELE }),
      source: 'catalog_refresh', observedAt: new Date('2026-11-16T09:00:00.000Z'), now: new Date(db.now), checkId: 'rt-1',
    });
    // Worker en retard de 2 h : il croit qu'il est 08 h 00 alors que la base est à 10 h 00 — son envoi,
    // daté 07 h 59 sur SA montre, est en réalité postérieur au refus de 09 h 00 (heure de la base).
    const r = await O.recordOperationalCheck({
      model: MODELE, secret: CLE, outcome: { status: 'ok' }, source: 'recovery_check',
      observedAt: new Date('2026-11-16T07:59:00.000Z'), now: new Date('2026-11-16T08:00:00.000Z'), checkId: 'rt-2',
    });
    expect(r.stale).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(db.etats.get(`${MODELE}|${O.keyFingerprint(CLE)}`)).toMatchObject({ ok: true, observed_at: '2026-11-16T09:59:00.000Z' });
  });

  it('un contrôle envoyé AVANT le verdict en vigueur est écarté avec son motif', async () => {
    await O.recordOperationalCheck({ model: MODELE, secret: CLE, outcome: C.classifyProbeFailure(refus404(), { model: MODELE }), source: 'catalog_refresh', observedAt: new Date('2026-11-16T09:00:00Z'), checkId: 'p-1' });
    const r = await O.recordOperationalCheck({ model: MODELE, secret: CLE, outcome: { status: 'ok' }, source: 'provider_test', observedAt: new Date('2026-11-16T08:00:00Z'), checkId: 'p-2' });
    expect(r.stale).toBe(true);
    expect(db.historique.at(-1)).toMatchObject({ applied: false, discarded: 'out_of_order' });
  });
});

describe('L115I-U07 — accès figé à l’envoi (E05, R09)', () => {
  it('rotation de clé en vol : le résultat est attribué à l’accès qui a ENVOYÉ, jamais à la nouvelle clé', async () => {
    const envoyeur = O.keyFingerprint(CLE);
    // La clé active est désormais AUTRE_CLE, mais la requête était partie avec CLE.
    await O.recordOperationalCheck({
      model: MODELE, secret: AUTRE_CLE, accessFingerprint: envoyeur, source: 'gateway_call', checkId: 'rot-1',
      outcome: C.classifyProbeFailure(refus404(), { model: MODELE }),
    });
    expect(db.etats.get(`${MODELE}|${envoyeur}`)).toMatchObject({ ok: false });
    expect(db.etats.get(`${MODELE}|${O.keyFingerprint(AUTRE_CLE)}`)).toBeUndefined();
    // Un succès sur l'accès B ne réhabilite pas A.
    await O.recordOperationalCheck({ model: MODELE, secret: AUTRE_CLE, outcome: { status: 'ok' }, source: 'provider_test', checkId: 'rot-2' });
    expect(db.etats.get(`${MODELE}|${envoyeur}`)).toMatchObject({ ok: false });
    expect(db.etats.get(`${MODELE}|${O.keyFingerprint(AUTRE_CLE)}`)).toMatchObject({ ok: true });
  });

  it('le contexte d’accès est figé avec le contrôle : capacité, point d’accès, environnement, version d’API', async () => {
    await O.recordOperationalCheck({ model: MODELE, secret: CLE, outcome: { status: 'ok' }, source: 'catalog_refresh', checkId: 'ctx-1' });
    expect(db.etats.get(`${MODELE}|${O.keyFingerprint(CLE)}`)).toMatchObject({
      capability: 'text_generation', endpoint: 'generateContent', api_version: O.PROBE_API_VERSION, environment: 'local',
    });
    const v = await O.readPublishedVerdict(MODELE, CLE);
    expect(v).toMatchObject({ capability: 'text_generation', endpoint: 'generateContent', apiVersion: O.PROBE_API_VERSION });
    // Jamais la clé, seulement son empreinte pseudonymisée.
    expect(JSON.stringify(v)).not.toContain(CLE);
    expect(v.access).toMatch(/^clé …/);
  });
});

describe('L115I-U08 — contrôle final de promotion (E01, R02, R10)', () => {
  const tx = () => ({ unsafe: async (q: string, p?: never[]) => (await import('@/db')).pgClient.unsafe(q, p) });

  it('lecture impossible dans la transaction : « invérifiable » — la promotion est refusée, jamais admise', async () => {
    db.panne = true;
    expect(await O.operationalRefusalInTx(tx(), MODELE, CLE)).toMatchObject({ kind: 'unverifiable' });
  });

  it('clé active illisible : « invérifiable » ; aucune clé configurée : rien ne s’oppose', async () => {
    expect(await O.operationalRefusalInTx(tx(), MODELE, null)).toEqual({ kind: 'clear' });
    await O.recordOperationalCheck({ model: MODELE, secret: CLE, outcome: C.classifyProbeFailure(refus404(), { model: MODELE }), source: 'catalog_refresh', checkId: 'tx-1' });
    expect(await O.operationalRefusalInTx(tx(), MODELE, CLE)).toMatchObject({ kind: 'refused' });
  });
});

describe('L115I-U09 — mesures d’admission (E08)', () => {
  it('envois autorisés, refusés par motif et par point : aucun coût ni appel fictif pour un refus', async () => {
    A.__setPublishedVerdictReaderForTests(async (model) => (model === MODELE
      ? verdict({ model, state: 'unavailable', checkStatus: 'failed_confirmed' })
      : verdict({ model, state: 'healthy', checkStatus: 'ok' })));
    await A.guardSend({ model: MODELE, point: 'gateway_rank' });
    await A.guardSend({ model: MODELE, point: 'gateway_send' });
    await A.guardSend({ model: 'm-sain', point: 'gateway_send' });
    await A.guardSend({ model: MODELE, point: 'availability_probe' });
    const m = A.admissionMetrics();
    expect(m).toMatchObject({ allowed: 2, refusedUnavailable: 2, refusedUnverifiable: 0, authorizedProbes: 1 });
    expect(m.byPoint).toMatchObject({
      gateway_rank: { allowed: 0, refused: 1 },
      gateway_send: { allowed: 1, refused: 1 },
      availability_probe: { allowed: 1, refused: 0 },
    });
  });

  it('le lecteur de la passerelle et la garde lisent la MÊME source (aucune divergence possible)', async () => {
    F.__setFallbackContextForTests({ knownUnavailable: async () => new Map([[MODELE, { checkedAt: null, error: 'refus' }]]) });
    // `__setFallbackContextForTests` installe le lecteur dérivé de façon asynchrone.
    await new Promise((r) => setTimeout(r, 0));
    expect((await A.guardSend({ model: MODELE, point: 'gateway_send' })).admitted).toBe(false);
    expect((await A.guardSend({ model: 'm-sain', point: 'gateway_send' })).admitted).toBe(true);
    F.__setFallbackContextForTests(null);
    await new Promise((r) => setTimeout(r, 0));
  });
});
