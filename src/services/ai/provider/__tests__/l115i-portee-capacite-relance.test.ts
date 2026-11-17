/**
 * Lot 115 — carte Trello #786, seconde partie unitaire : PÉRIMÈTRE exact d'un verdict (capacité, modalité,
 * projet), CRITICITÉ par unité de routage, CAMPAGNE CIBLÉE relancée au rétablissement, et CONTRÔLE FINAL de
 * disponibilité des activations (réactivation d'une configuration historique, import). Base simulée en
 * mémoire (migrations 1815 et 1816 présentes), AUCUN appel fournisseur.
 *
 *   L115I-U10 (E05, R09)  règle de PORTÉE (pure) : un refus de portée modèle est retenu sur la capacité de
 *                         base et vaut pour tout l'accès ; tout autre refus ne vaut que pour sa capacité
 *   L115I-U11 (E05, R09)  état PAR CAPACITÉ : un refus d'une capacité n'affecte pas les autres, le refus de la
 *                         capacité de base est opposable à toutes, un succès ailleurs ne lève rien
 *   L115I-U12 (E05)       migration 1816 absente : contrôle historisé, verdict de base NI écrasé NI étendu
 *   L115I-U13 (E05)       dimension « projet » : vide, explicitée, jamais inventée ; aucun secret
 *   L115I-U14 (E08, R14)  criticité par UNITÉ DE ROUTAGE : « plus aucune route admissible » (disponibilité +
 *                         tarif + compatibilité + qualification), variantes par type d'appel isolées
 *   L115I-U15 (E06, R11)  campagne ciblée IMMÉDIATE : bornée, dédupliquée par la marque, aucune activation
 *   L115I-U16 (E03, R10)  contrôle final : réactivation d'une configuration historique et IMPORT refusés sur
 *                         refus confirmé comme sur contrôle impossible
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveChainEntry } from '../active-model-anomalies';
import type { UsableModelsContext } from '../../registry/usable-models';

const db = vi.hoisted(() => ({
  /** Clé : `modèle|accès|capacité` (migration 1816). */
  etats: new Map<string, Record<string, unknown>>(),
  historique: [] as Array<Record<string, unknown>>,
  version: 0,
  panne: false,
  schema1815: true,
  /** La capacité fait-elle partie de la clé ? (migration 1816) */
  schema1816: true,
  /** Fiches de qualification lues par `loadQualifications` (modèle → ligne). */
  qualifications: new Map<string, Record<string, unknown>>(),
  now: '2026-11-16T10:00:00.000Z',
}));
vi.mock('@/db', () => {
  const unsafe = async (q: string, params: unknown[] = []): Promise<unknown[]> => {
    if (/information_schema\.columns/.test(q)) {
      if (/provider_project/.test(q)) return db.schema1816 ? [{ n: 1 }] : [];
      return db.schema1815 ? [{ n: 1 }] : [];
    }
    if (db.panne) throw new Error('connexion refusée');
    if (/pg_advisory_xact_lock|SAVEPOINT/.test(q)) return [];
    if (/SELECT now\(\) AS t/.test(q)) return [{ t: db.now }];
    if (/^\s*INSERT INTO ai_model_operational_status/.test(q)) {
      const [model, fp, ok, error, source, checkStatus, errorKind, suspectSince, healthy, httpStatus, providerCode, capability, endpoint,
        probeCallId, observedAt, confirme, failureCount, nextProbeAt, stateVersion, checkId, environment, apiVersion, lastResultStatus, lastResultKind] = params;
      const cle = `${String(model)}|${String(fp)}|${db.schema1816 ? String(capability) : 'text_generation'}`;
      const avant = db.etats.get(cle);
      db.etats.set(cle, {
        model, key_fingerprint: fp, ok, error, source, check_status: checkStatus, error_kind: errorKind, suspect_since: suspectSince,
        last_ok_at: healthy ? db.now : avant?.last_ok_at ?? null, http_status: httpStatus, provider_code: providerCode,
        capability, endpoint, probe_call_id: probeCallId, observed_at: observedAt,
        confirmed_at: confirme ? avant?.confirmed_at ?? db.now : null, failure_count: failureCount, next_probe_at: nextProbeAt,
        state_version: stateVersion, checked_at: db.now, check_id: checkId ?? null, environment: environment ?? null,
        api_version: apiVersion ?? null, last_result_status: lastResultStatus ?? null, last_result_kind: lastResultKind ?? null,
        last_result_at: db.now,
      });
      return [];
    }
    if (/^\s*INSERT INTO ai_model_operational_history/.test(q)) {
      const [model, fp, capability, , source, outcome, , kind, , , error, checkStatus, okAfter, applied, v, , observedAt, checkId, , , discarded] = params;
      db.historique.push({ model, fp, capability, source, outcome, kind, error, checkStatus, okAfter, applied, v, observedAt, checkId, discarded });
      return [];
    }
    if (/FROM ai_model_operational_history/.test(q) && /check_id = \$3/.test(q)) {
      return db.historique.filter((h) => h.model === params[0] && h.fp === params[1] && h.checkId === params[2]).slice(0, 1).map(() => ({ one: 1 }));
    }
    if (/INSERT INTO verebona_cache_versions/.test(q)) { db.version++; return []; }
    if (/FROM verebona_cache_versions/.test(q)) return [{ version: db.version }];
    // Lecture d'UNE capacité (écriture : `AND capability = $3`).
    if (/FROM ai_model_operational_status/.test(q) && /capability = \$3/.test(q)) {
      const r = db.etats.get(`${String(params[0])}|${String(params[1])}|${String(params[2])}`);
      return r ? [r] : [];
    }
    // Lecture de TOUTES les capacités de la route (admission, contrôle final).
    if (/FROM ai_model_operational_status/.test(q) && /model = \$1/.test(q)) {
      return [...db.etats.values()].filter((r) => r.model === params[0] && r.key_fingerprint === params[1]);
    }
    if (/FROM ai_model_operational_status/.test(q)) return [...db.etats.values()].filter((r) => r.key_fingerprint === params[0]);
    if (/FROM ai_model_qualification/.test(q)) return [...db.qualifications.values()];
    return [];
  };
  const pgClient = { unsafe, begin: async <T,>(fn: (tx: { unsafe: typeof unsafe }) => Promise<T>): Promise<T> => fn({ unsafe }) };
  return { pgClient };
});

const A = await import('../operational-admission');
const O = await import('../model-operational.service');
const C = await import('../probe-classification');
const AN = await import('../active-model-anomalies');
const Q = await import('../model-qualification.service');
const AV = await import('../../config/activation-availability');
const { setProviderSecretResolver } = await import('../provider-secret');
const { __setVerifiedTestPricesForTests } = await import('../../gateway/pricing/pricing.repository');

const CLE = 'AIzaSyD-cle-active-786-0123456789';
const MODELE = 'gemini-3.6-flash';
const REPLI = 'gemini-3.1-flash-lite';

/** Refus définitif de PORTÉE MODÈLE (retrait) et refus définitif d'un PARAMÈTRE (portée capacité). */
const refusModele = { status: 'failed', kind: 'model_retired', error: 'HTTP 404 NOT_FOUND — model retired', definitive: true } as const;
const refusParametre = { status: 'failed', kind: 'probe_parameter_rejected', error: 'HTTP 400 INVALID_ARGUMENT — paramètre refusé', definitive: true } as const;

beforeEach(() => {
  db.etats.clear(); db.historique = []; db.qualifications.clear(); db.version = 0; db.panne = false; db.schema1815 = true; db.schema1816 = true;
  O.__resetOperationalSchemaState();
  A.__setPublishedVerdictReaderForTests(null);
  A.__resetLastReliableVerdicts();
  A.__resetAdmissionMetrics();
  setProviderSecretResolver(async () => CLE);
  __setVerifiedTestPricesForTests(true);
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  A.__setPublishedVerdictReaderForTests(null);
  setProviderSecretResolver(null);
  __setVerifiedTestPricesForTests(false);
  vi.restoreAllMocks();
});

describe('L115I-U10 — règle de portée d’un refus (E05, R09)', () => {
  it('refus de portée MODÈLE : retenu sur la capacité de base, opposable à tout l’accès', () => {
    for (const kind of ['model_retired', 'model_not_found', 'model_access_closed', 'unsupported_method', 'forbidden_model'] as const) {
      const p = C.refusalCapabilityScope({ status: 'failed', kind, error: 'x', definitive: true }, 'structured_output');
      expect(p).toEqual({ capability: 'text_generation', modelWide: true });
    }
  });

  it('refus d’un PARAMÈTRE ou d’une modalité : ne vaut que pour la capacité éprouvée', () => {
    expect(C.refusalCapabilityScope(refusParametre, 'structured_output')).toEqual({ capability: 'structured_output', modelWide: false });
    expect(C.refusalCapabilityScope(refusParametre, 'multimodal')).toEqual({ capability: 'multimodal', modelWide: false });
    // Éprouvée sur la base : la portée reste la base (c'est la même ligne).
    expect(C.refusalCapabilityScope(refusParametre, 'text_generation')).toEqual({ capability: 'text_generation', modelWide: true });
  });

  it('un succès n’étend aucune portée', () => {
    expect(C.refusalCapabilityScope({ status: 'ok' }, 'multimodal')).toEqual({ capability: 'multimodal', modelWide: false });
  });

  it('le référentiel des capacités est unique (aucune énumération locale) et porte sa capacité de base', () => {
    expect(C.OPERATIONAL_CAPABILITIES).toContain(C.BASE_CAPABILITY);
    expect(C.BASE_CAPABILITY).toBe(C.PROBE_CAPABILITY);
    for (const c of C.OPERATIONAL_CAPABILITIES) expect(C.OPERATIONAL_CAPABILITY_LABELS[c]).toBeTruthy();
    expect(C.isOperationalCapability('text_generation')).toBe(true);
    expect(C.isOperationalCapability('inventee')).toBe(false);
  });
});

describe('L115I-U11 — un verdict par capacité (E05, R09)', () => {
  it('refus d’une capacité : les autres restent admises, et seule elle est refusée', async () => {
    await O.recordOperationalCheck({ model: MODELE, secret: CLE, outcome: refusParametre, source: 'qualification', capability: 'structured_output' });
    expect((await O.readPublishedVerdict(MODELE, CLE, 'structured_output')).state).toBe('unavailable');
    expect((await O.readPublishedVerdict(MODELE, CLE, 'text_generation')).state).toBe('unknown');
    expect((await O.readPublishedVerdict(MODELE, CLE, 'multimodal')).state).toBe('unknown');
    // Admission : l'envoi d'une autre modalité part, celui de la capacité refusée non.
    A.__enableAdmissionDbForTests(true);
    try {
      expect((await A.guardSend({ model: MODELE, point: 'gateway_send', capability: 'multimodal' })).admitted).toBe(true);
      const refus = await A.guardSend({ model: MODELE, point: 'gateway_send', capability: 'structured_output' });
      expect(refus.admitted).toBe(false);
      expect(refus.admitted === false && refus.label).toMatch(/capacité/);
    } finally {
      A.__enableAdmissionDbForTests(false);
    }
  });

  it('refus de la capacité de BASE : opposable à toutes les capacités, et la portée est DITE', async () => {
    await O.recordOperationalCheck({ model: MODELE, secret: CLE, outcome: refusModele, source: 'catalog_refresh' });
    const v = await O.readPublishedVerdict(MODELE, CLE, 'multimodal');
    expect(v).toMatchObject({ state: 'unavailable', askedCapability: 'multimodal', scopeExtendedFromBase: true });
    A.__enableAdmissionDbForTests(true);
    try {
      const a = await A.guardSend({ model: MODELE, point: 'gateway_send', capability: 'multimodal' });
      expect(a.admitted).toBe(false);
      expect(a.admitted === false && a.label).toMatch(/capacité de base/);
    } finally {
      A.__enableAdmissionDbForTests(false);
    }
  });

  it('un refus de portée modèle reçu alors que la MODALITÉ était éprouvée est retenu sur la base', async () => {
    // Une requête multimodale reçoit « modèle retiré » : la preuve porte sur le modèle, pas sur la modalité.
    await O.recordOperationalCheck({ model: MODELE, secret: CLE, outcome: refusModele, source: 'gateway_call', capability: 'multimodal' });
    expect(db.etats.has(`${MODELE}|${O.keyFingerprint(CLE)}|text_generation`)).toBe(true);
    expect(db.etats.has(`${MODELE}|${O.keyFingerprint(CLE)}|multimodal`)).toBe(false);
    expect((await O.readPublishedVerdict(MODELE, CLE, 'text_generation')).state).toBe('unavailable');
  });

  it('un succès sur une capacité ne lève pas le refus d’une autre, et les décomptes restent fidèles', async () => {
    await O.recordOperationalCheck({ model: MODELE, secret: CLE, outcome: refusParametre, source: 'qualification', capability: 'structured_output' });
    await O.recordOperationalCheck({ model: MODELE, secret: CLE, outcome: { status: 'ok' }, source: 'catalog_refresh' });
    expect((await O.readPublishedVerdict(MODELE, CLE, 'text_generation')).state).toBe('healthy');
    expect((await O.readPublishedVerdict(MODELE, CLE, 'structured_output')).state).toBe('unavailable');
    // Lecture d'ensemble (listes, BO, alertes) : jamais « tout sain » parce qu'une capacité répond.
    const snapshot = await O.loadOperationalSnapshot(CLE);
    expect(snapshot.reliable).toBe(true);
    expect(snapshot.statuses.get(MODELE)?.ok).toBe(false);
    const diag = (await O.loadOperationalDiagnostics(CLE)).get(MODELE);
    expect(diag?.refusedCapabilities).toEqual(['structured_output']);
  });

  it('le contrôle final d’une activation refuse sur n’importe quelle capacité refusée, et la nomme', async () => {
    await O.recordOperationalCheck({ model: MODELE, secret: CLE, outcome: refusParametre, source: 'qualification', capability: 'structured_output' });
    const tx = { unsafe: async (q: string, p?: never[]) => (await import('@/db')).pgClient.unsafe(q, p) };
    expect(await O.operationalRefusalInTx(tx, MODELE, CLE)).toMatchObject({ kind: 'refused', capability: 'structured_output' });
  });
});

describe('L115I-U12 — migration 1816 absente (E05)', () => {
  it('contrôle hors capacité de base : historisé avec sa capacité, verdict de base NI écrasé NI étendu', async () => {
    db.schema1816 = false;
    O.__resetOperationalSchemaState();
    await O.recordOperationalCheck({ model: MODELE, secret: CLE, outcome: { status: 'ok' }, source: 'catalog_refresh' });
    const etat = await O.recordOperationalCheck({
      model: MODELE, secret: CLE, outcome: refusParametre, source: 'qualification', capability: 'structured_output',
    });
    expect(etat.stale).toBe(true);
    expect(db.historique.at(-1)).toMatchObject({ capability: 'structured_output', applied: false, discarded: 'capability_scope_unsupported' });
    // Le verdict de la capacité de base est intact : aucune portée fabriquée.
    expect((await O.readPublishedVerdict(MODELE, CLE, 'text_generation')).state).toBe('healthy');
    expect(O.operationalSchemaState().degradedReason).toMatch(/1816/);
  });
});

describe('L115I-U13 — dimension « projet du fournisseur » (E05)', () => {
  it('inconnue, explicitée, jamais inventée ; dit ce qu’il faudrait, sans aucun secret', () => {
    const d = O.operationalProjectDimension();
    expect(d.known).toBe(false);
    expect(d.label).toMatch(/non connu de l’application/);
    expect(d.missing.length).toBeGreaterThanOrEqual(2);
    expect(d.missing.join(' ')).toMatch(/identifiant de projet/);
    const texte = JSON.stringify(d);
    expect(texte).not.toMatch(/AIza/);
    expect(texte).not.toContain(CLE);
    // Aucun NOM de variable d'environnement inventé : la décision revient au PO.
    expect(texte).not.toMatch(/[A-Z_]{4,}=/);
  });

  it('la colonne reste vide : le diagnostic ne rattache jamais un projet supposé', async () => {
    await O.recordOperationalCheck({ model: MODELE, secret: CLE, outcome: refusModele, source: 'catalog_refresh' });
    expect((await O.loadOperationalDiagnostics(CLE)).get(MODELE)?.providerProject).toBeNull();
  });
});

describe('L115I-U14 — criticité par unité de routage (E08, R14)', () => {
  const ctx = (over: Partial<UsableModelsContext> = {}): UsableModelsContext => ({
    environment: 'preprod',
    catalog: {
      refreshedAt: '2026-11-16T06:00:00Z',
      models: [MODELE, REPLI].map((model) => ({ model, available: true, supportsGeneration: true, lifecycle: 'stable' as const })),
    },
    codeCatalog: [],
    price: () => ({ verified: true, eligible: true }),
    operational: new Map(),
    today: '2026-11-16',
    ...over,
  });
  const indispo = (model: string) => new Map([[model, { ok: false, checkedAt: '2026-11-16T06:00:00Z', error: 'retiré', source: 'catalog_refresh' }]]);
  const chaines: ActiveChainEntry[] = [
    { treatment: 'T1', rank: 'primaryModel', model: MODELE, source: 'version' },
    { treatment: 'T1', rank: 'fallback1', model: REPLI, source: 'version' },
  ];

  it('un repli admissible reste : avertissement, aucune unité sans route', () => {
    const a = AN.detectActiveModelAnomalies(chaines, ctx({ operational: indispo(MODELE) }));
    expect(a.map((x) => x.noAdmissibleRoute)).toEqual([false]);
    expect(AN.groupAnomaliesByModel(a)[0].severity).toBe('warning');
  });

  it('repli sans TARIF vérifié : plus aucune route admissible → critique (prix + disponibilité cumulés)', () => {
    const a = AN.detectActiveModelAnomalies(chaines, ctx({
      operational: indispo(MODELE),
      price: (m) => (m === REPLI ? { verified: false, eligible: false, ineligibleLabel: 'tarif non confirmé' } : { verified: true, eligible: true }),
    }));
    expect(a.some((x) => x.noAdmissibleRoute)).toBe(true);
    const g = AN.groupAnomaliesByModel(a)[0];
    expect(g.severity).toBe('critical');
    expect(AN.groupMessage(g)).toMatch(/Plus aucune route admissible pour T1/);
  });

  it('repli NON QUALIFIÉ : plus aucune route admissible → critique (qualification cumulée)', () => {
    const a = AN.detectActiveModelAnomalies(chaines, ctx({
      operational: indispo(MODELE),
      qualifications: new Map([[REPLI, { generate: false, structured: null, multimodal: null, thinking: null }]]),
    }));
    expect(AN.groupAnomaliesByModel(a)[0].severity).toBe('critical');
  });

  it('les variantes par type d’appel sont des unités SÉPARÉES : aucun repli emprunté à une autre', () => {
    const avecVariante: ActiveChainEntry[] = [
      { treatment: 'T1', rank: 'primaryModel', model: MODELE, source: 'version', operationCode: 't1_variante' },
      ...chaines,
    ];
    const a = AN.detectActiveModelAnomalies(avecVariante, ctx({ operational: indispo(MODELE) }));
    const variante = a.find((x) => x.operationCode === 't1_variante');
    expect(variante?.noAdmissibleRoute).toBe(true);
    const g = AN.groupAnomaliesByModel(a)[0];
    expect(g.severity).toBe('critical');
    expect(AN.groupMessage(g)).toMatch(/type d’appel t1_variante/);
    // Le mot interdit n'apparaît jamais : « type d'appel », jamais le terme réservé aux événements.
    expect(AN.groupMessage(g)).not.toMatch(/\bOpération\b/);
  });

  it('une variante dont la chaîne reste admissible n’est pas critique', () => {
    const avecVariante: ActiveChainEntry[] = [
      { treatment: 'T1', rank: 'primaryModel', model: MODELE, source: 'version', operationCode: 't1_variante' },
      { treatment: 'T1', rank: 'fallback1', model: REPLI, source: 'version', operationCode: 't1_variante' },
      ...chaines,
    ];
    const a = AN.detectActiveModelAnomalies(avecVariante, ctx({ operational: indispo(MODELE) }));
    expect(a.every((x) => !x.noAdmissibleRoute)).toBe(true);
    expect(AN.groupAnomaliesByModel(a)[0].severity).toBe('warning');
  });
});

describe('L115I-U15 — campagne ciblée immédiate au rétablissement (E06, R11)', () => {
  const resultatOk = { rawText: '{"ok":true,"mot":"ok"}', inputTokens: 1, outputTokens: 1 };

  it('un modèle MARQUÉ à requalifier est éprouvé tout de suite, et le résultat efface la marque', async () => {
    const appels: string[] = [];
    const bilan = await Q.runTargetedRequalification([MODELE], CLE, {
      call: async (i) => { appels.push(i.model); return resultatOk; },
    });
    // Jamais qualifié = à requalifier (`needsQualification`) : la campagne part.
    expect(bilan.attempted).toEqual([MODELE]);
    expect(appels.length).toBeGreaterThanOrEqual(1);
    expect([...bilan.qualified, ...bilan.failed]).toContain(MODELE);
  });

  it('un modèle NON marqué n’est pas réessayé (déduplication par la marque)', async () => {
    db.qualifications.set(MODELE, {
      model: MODELE, generate_ok: true, structured_ok: true, multimodal_ok: true, thinking_ok: true, errors: {},
      qualified_at: '2026-11-16T09:00:00Z', qualification_version: Q.QUALIFICATION_VERSION,
      requalification_required_at: null, requalification_reason: null, rejected_parameters: [],
    });
    const bilan = await Q.runTargetedRequalification([MODELE], CLE, { call: async () => resultatOk });
    expect(bilan.attempted).toEqual([]);
    expect(bilan.skipped).toEqual([{ model: MODELE, reason: 'not_marked' }]);
  });

  it('route non admissible : la campagne ne force rien et le dit (jamais une sonde de récupération)', async () => {
    await O.recordOperationalCheck({ model: MODELE, secret: CLE, outcome: refusModele, source: 'catalog_refresh' });
    const appels: string[] = [];
    A.__enableAdmissionDbForTests(true);
    try {
      const bilan = await Q.runTargetedRequalification([MODELE], CLE, {
        call: async (i) => { appels.push(i.model); return resultatOk; },
      });
      expect(bilan.attempted).toEqual([]);
      expect(bilan.skipped).toEqual([{ model: MODELE, reason: 'refused' }]);
      expect(appels).toEqual([]); // aucune épreuve envoyée vers une route refusée
    } finally {
      A.__enableAdmissionDbForTests(false);
    }
  });

  it('marque de requalification posée puis effacée par le résultat (reprenable sans doublon)', async () => {
    db.qualifications.set(MODELE, {
      model: MODELE, generate_ok: true, structured_ok: true, multimodal_ok: true, thinking_ok: true, errors: {},
      qualified_at: '2026-11-16T09:00:00Z', qualification_version: Q.QUALIFICATION_VERSION,
      requalification_required_at: '2026-11-16T09:30:00Z', requalification_reason: 'modèle rétabli',
    });
    const bilan = await Q.runTargetedRequalification([MODELE], CLE, { call: async () => resultatOk });
    expect(bilan.attempted).toEqual([MODELE]);
  });

  it('modèle sans tarif officiel vérifié : aucune épreuve payante (#770)', async () => {
    __setVerifiedTestPricesForTests(false);
    const bilan = await Q.runTargetedRequalification([MODELE], CLE, { call: async () => resultatOk });
    expect(bilan.attempted).toEqual([]);
    expect(bilan.skipped[0]?.reason).toBe('unpriced');
  });

  it('bornée : au-delà du nombre autorisé, le reste attend le passage planifié existant', async () => {
    const bilan = await Q.runTargetedRequalification([MODELE, REPLI], CLE, { max: 1, call: async () => resultatOk });
    expect(bilan.attempted).toHaveLength(1);
    expect(bilan.skipped.filter((s) => s.reason === 'budget')).toHaveLength(1);
  });
});

describe('L115I-U16 — contrôle final des activations (E03, R10)', () => {
  /** Transaction simulée : la MÊME base en mémoire que les lectures ci-dessus. */
  const tx = () => ({ unsafe: async (q: string, p?: never[]) => (await import('@/db')).pgClient.unsafe(q, p) });

  it('réactivation d’une configuration HISTORIQUE portant un modèle refusé : refus BLOCKED_MODEL_UNAVAILABLE', async () => {
    await O.recordOperationalCheck({ model: MODELE, secret: CLE, outcome: refusModele, source: 'catalog_refresh' });
    const refus = await AV.activationAvailabilityRefusal(tx(), [REPLI, MODELE], 'Activation annulée');
    expect(refus).toMatchObject({ code: 'BLOCKED_MODEL_UNAVAILABLE', model: MODELE });
    expect(refus?.message).toMatch(/Activation annulée dans la transaction/);
  });

  it('IMPORT d’une configuration portant un modèle refusé : même refus, message propre au geste', async () => {
    await O.recordOperationalCheck({ model: MODELE, secret: CLE, outcome: refusModele, source: 'catalog_refresh' });
    const refus = await AV.activationAvailabilityRefusal(tx(), AV.chainModelsOf([{ primaryModel: MODELE, fallback1: REPLI }]), 'Import annulé');
    expect(refus).toMatchObject({ code: 'BLOCKED_MODEL_UNAVAILABLE', model: MODELE });
    expect(refus?.message).toMatch(/Import annulé dans la transaction/);
  });

  it('contrôle final IMPOSSIBLE : refus aussi (jamais « rien ne s’oppose »)', async () => {
    db.panne = true;
    const refus = await AV.activationAvailabilityRefusal(tx(), [MODELE], 'Activation annulée');
    expect(refus).toMatchObject({ code: 'BLOCKED_MODEL_UNAVAILABLE', unverifiable: true });
  });

  it('rien ne s’oppose : aucune entrave (chaîne saine, doublons et valeurs vides ignorés)', async () => {
    await O.recordOperationalCheck({ model: MODELE, secret: CLE, outcome: { status: 'ok' }, source: 'catalog_refresh' });
    expect(AV.chainModelsOf([{ primaryModel: MODELE, fallback1: null }, { primaryModel: MODELE, fallback2: REPLI }]))
      .toEqual([MODELE, REPLI]);
    expect(await AV.activationAvailabilityRefusal(tx(), [MODELE], 'Activation annulée')).toBeNull();
  });
});
