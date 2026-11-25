/**
 * Carte Trello #786 — ÉCARTS RÉSIDUELS DU LOT 115I (audit du 22/11/2026). Partie unitaire : identité de route,
 * isolation par accès, verdict publié ≠ résultat calculé, ordre indépendant des horloges, réservation de sonde
 * et fencing, requalification universelle, alertes par accès.
 *
 * Base simulée en mémoire (colonnes 1815, 1816 et 1950 présentes), AUCUN appel fournisseur, AUCUNE base réelle.
 * Frontière de départ de la passerelle : `gateway/__tests__/c786-frontiere-depart.test.ts`.
 * Deux VRAIS processus et fournisseur HTTP instrumenté : `c786-deux-processus.manual.test.ts` (PostgreSQL requis).
 *
 *   C786-A01  route A lue / route B JAMAIS lue + base HS ⇒ zéro départ sur B, et B n'est pas déclarée retirée
 *   C786-A02  clé testée B alors que A est active ⇒ décision exclusivement sur B, dans les deux sens
 *   C786-A03  42P01, colonnes absentes, échec de commit ⇒ `not_persisted`, aucune activation, reprise idempotente
 *   C786-B02  ±30 s, ±90 s, dates identiques, succès ancien reçu après refus récent, rejeu identique
 *   C786-B03  route neuve : exactement UNE réservation ; bail repris ⇒ résultat tardif rejeté
 *   C786-C02  transition `failed_confirmed → ok` depuis CHAQUE source ⇒ un seul marquage de requalification
 *   C786-D02  A refusé / B sain ⇒ l'alerte de A reste ; aucune résolution transversale
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  /** Clé : `modèle|empreinte|capacité`. */
  etats: new Map<string, Record<string, unknown>>(),
  historique: [] as Array<Record<string, unknown>>,
  version: 0,
  panne: false,
  /** Erreur rendue par la base (code PostgreSQL), pour les cas de schéma. */
  codeErreur: null as string | null,
  schema1815: true,
  schema1816: true,
  schema1950: true,
  now: '2026-11-16T10:00:00.000Z',
  /** Compteur des UPDATE conditionnels de bail réellement gagnés (R13). */
  bauxGagnes: 0,
}));

vi.mock('@/db', () => {
  const lever = (): never => {
    const e = new Error(db.codeErreur ? `erreur ${db.codeErreur}` : 'connexion refusée');
    if (db.codeErreur) (e as Error & { code?: string }).code = db.codeErreur;
    throw e;
  };
  const cle = (model: unknown, fp: unknown, cap: unknown) => `${String(model)}|${String(fp)}|${String(cap)}`;
  /**
   * Horloge de la base pour les BAUX et les ÉCHÉANCES : l'horloge RÉELLE.
   *
   * `db.now` sert à simuler un décalage d'horloge entre un worker et la base (#786, B02) : c'est une date
   * figée. Les baux et les échéances, eux, sont comparés par le code de production à `Date.now()` — les
   * simuler sur une date figée dans le passé les ferait paraître tous expirés.
   */
  const leaseNowMs = () => Date.now();

  const unsafe = async (q: string, params: unknown[] = []): Promise<unknown[]> => {
    // Présence des colonnes : lue hors transaction, et jamais mise en panne (c'est un contrôle de schéma).
    if (/information_schema\.columns/.test(q)) {
      if (/'check_id'/.test(q)) return db.schema1815 ? [{ n: 1 }] : [];
      if (/'provider_project'/.test(q)) return db.schema1816 ? [{ n: 1 }] : [];
      if (/'probe_lease_generation'/.test(q)) return db.schema1950 ? [{ n: 1 }] : [];
      return [];
    }
    if (db.panne || db.codeErreur) lever();
    if (/pg_advisory_xact_lock|SAVEPOINT/.test(q)) return [];
    if (/SELECT now\(\) AS t/.test(q)) return [{ t: db.now }];

    // ── Réservation de sonde (#786, B03) ──
    // La LIBÉRATION est reconnue d'abord : les deux requêtes commencent par `SET probe_lease_owner`.
    if (/SET probe_lease_owner = NULL/.test(q)) {
      const [model, fp, owner, cap] = params;
      const r = db.etats.get(cle(model, fp, cap ?? 'text_generation'));
      if (r && r.probe_lease_owner === owner) { r.probe_lease_owner = null; r.probe_lease_until = null; }
      return [];
    }
    if (/SET probe_lease_owner = \$3/.test(q)) {
      const [model, fp, owner, ms, immediate, cap] = params;
      const r = db.etats.get(cle(model, fp, cap ?? 'text_generation'));
      if (!r) return [];
      const bail = r.probe_lease_until == null ? 0 : Date.parse(String(r.probe_lease_until));
      if (bail > leaseNowMs()) return [];
      const echeance = r.next_probe_at == null ? 0 : Date.parse(String(r.next_probe_at));
      if (!immediate && echeance > leaseNowMs()) return [];
      r.probe_lease_owner = owner;
      r.probe_lease_until = new Date(leaseNowMs() + Number(ms)).toISOString();
      r.probe_lease_at = db.now;
      r.probe_lease_generation = Number(r.probe_lease_generation ?? 0) + 1;
      db.bauxGagnes++;
      return [{ probe_lease_until: r.probe_lease_until, probe_lease_generation: r.probe_lease_generation }];
    }
    // Ligne d'état NEUVE, neutre (#786, B03) : état inconnu, aucun verdict fabriqué.
    if (/ON CONFLICT DO NOTHING/.test(q)) {
      const [model, fp, cap, endpoint, source, environment, apiVersion] = params;
      const k = cle(model, fp, cap);
      if (!db.etats.has(k)) {
        db.etats.set(k, {
          model, key_fingerprint: fp, capability: cap, endpoint, ok: null, error: null, source,
          checked_at: db.now, check_status: null, observed_at: null, environment, api_version: apiVersion,
          state_version: 0, failure_count: 0, next_probe_at: null, probe_lease_generation: 0,
          probe_lease_owner: null, probe_lease_until: null, suspect_since: null, last_ok_at: null,
        });
      }
      return [];
    }

    // ── Écriture du verdict ──
    if (/^\s*INSERT INTO ai_model_operational_status/.test(q)) {
      const [model, fp, ok, error, source, checkStatus, errorKind, suspectSince, healthy, httpStatus, providerCode, capability,
        endpoint, probeCallId, observedAt, confirme, failureCount, nextProbeAt, stateVersion,
        checkId, environment, apiVersion, lastResultStatus, lastResultKind] = params;
      const k = cle(model, fp, capability);
      const avant = db.etats.get(k);
      db.etats.set(k, {
        ...avant,
        model, key_fingerprint: fp, ok, error, source, check_status: checkStatus, error_kind: errorKind,
        suspect_since: suspectSince, last_ok_at: healthy ? db.now : avant?.last_ok_at ?? null,
        http_status: httpStatus, provider_code: providerCode, capability, endpoint, probe_call_id: probeCallId,
        observed_at: observedAt, confirmed_at: confirme ? avant?.confirmed_at ?? db.now : null,
        failure_count: failureCount, next_probe_at: nextProbeAt, state_version: stateVersion, checked_at: db.now,
        check_id: checkId ?? null, environment: environment ?? null, api_version: apiVersion ?? null,
        last_result_status: lastResultStatus ?? null, last_result_kind: lastResultKind ?? null, last_result_at: db.now,
        probe_lease_generation: avant?.probe_lease_generation ?? 0,
      });
      return [];
    }
    if (/^\s*INSERT INTO ai_model_operational_history/.test(q)) {
      const [model, fp, capability, , source, outcome, , kind, , , error, checkStatus, okAfter, applied, v, ,
        observedAt, checkId, , , discarded, leaseGeneration] = params;
      db.historique.push({ model, fp, capability, source, outcome, kind, error, checkStatus, okAfter, applied, v, observedAt, checkId, discarded, leaseGeneration });
      return [];
    }
    if (/FROM ai_model_operational_history/.test(q) && /check_id = \$3/.test(q)) {
      return db.historique.filter((h) => h.model === params[0] && h.fp === params[1] && h.checkId === params[2]).slice(0, 1).map(() => ({ one: 1 }));
    }
    if (/INSERT INTO verebona_cache_versions/.test(q)) { db.version++; return []; }
    if (/FROM verebona_cache_versions/.test(q)) return [{ version: db.version }];

    // ── Lectures d'état ──
    if (/FROM ai_model_operational_status/.test(q) && /AND capability = \$3/.test(q)) {
      const r = db.etats.get(cle(params[0], params[1], params[2]));
      return r ? [r] : [];
    }
    if (/FROM ai_model_operational_status/.test(q) && /model = \$1/.test(q)) {
      return [...db.etats.values()].filter((r) => r.model === params[0] && r.key_fingerprint === params[1]);
    }
    if (/FROM ai_model_operational_status/.test(q)) {
      return [...db.etats.values()].filter((r) => r.key_fingerprint === params[0]);
    }
    return [];
  };
  const pgClient = { unsafe, begin: async <T,>(fn: (tx: { unsafe: typeof unsafe }) => Promise<T>): Promise<T> => fn({ unsafe }) };
  return { pgClient };
});

/** #786 (C02) : la requalification est OBSERVÉE — un seul marquage, une seule campagne, quelle que soit la source. */
const requalif = vi.hoisted(() => ({ marques: [] as Array<{ models: readonly string[]; reason: string }>, campagnes: [] as string[][], dejaMarque: false }));
vi.mock('../model-qualification.service', async (orig) => ({
  ...(await orig<typeof import('../model-qualification.service')>()),
  markRequalificationRequired: vi.fn(async (models: readonly string[], _secret: string, reason: string) => {
    // Idempotence réelle de la requête SQL : seules les qualifications NON encore marquées sont marquées.
    if (requalif.dejaMarque) return 0;
    requalif.dejaMarque = true;
    requalif.marques.push({ models, reason });
    return models.length;
  }),
  runTargetedRequalification: vi.fn(async (models: readonly string[]) => {
    requalif.campagnes.push([...models]);
    return { attempted: [...models], qualified: [], failed: [], inconclusive: [], skipped: [] };
  }),
}));

/** #786 (D02) : dépôt d'alertes simulé — on observe ce qui est levé, remplacé et résolu. */
const alertes = vi.hoisted(() => ({
  ouvertes: [] as Array<{ id: number; details: unknown }>,
  resolues: [] as Array<{ ids: number[]; code: string }>,
  prochainId: 100,
}));
vi.mock('../../alerts/alerts.repository', () => ({
  raiseConditionAlert: vi.fn(async (a: { details: unknown }) => {
    const id = alertes.prochainId++;
    alertes.ouvertes.push({ id, details: a.details });
    return { created: true, id };
  }),
  listUnresolvedAlerts: vi.fn(async () => alertes.ouvertes.map((a) => ({ id: a.id, details: a.details }))),
  resolveAlerts: vi.fn(async (ids: number[], o: { code: string }) => {
    if (ids.length === 0) return 0;
    alertes.resolues.push({ ids: [...ids], code: o.code });
    alertes.ouvertes = alertes.ouvertes.filter((a) => !ids.includes(a.id));
    return ids.length;
  }),
}));

const A = await import('../operational-admission');
const O = await import('../model-operational.service');
const C = await import('../probe-classification');
const AN = await import('../active-model-anomalies');
const { setProviderSecretResolver } = await import('../provider-secret');
const { keyFingerprint } = await import('../access-identity');

const CLE_A = 'AIzaSyD-acces-A-786-0123456789';
const CLE_B = 'AIzaSyD-acces-B-786-9876543210';
const MODELE = 'gemini-3.6-flash';
const AUTRE_MODELE = 'gemini-3.6-pro';
const refus404 = (model = MODELE) => new Error(
  `{"error":{"code":404,"message":"This model models/${model} is no longer available to new users","status":"NOT_FOUND"}}`);
const refus = (model = MODELE) => C.classifyProbeFailure(refus404(model), { model });
const etat = (model: string, cle: string, cap = 'text_generation') => db.etats.get(`${model}|${keyFingerprint(cle)}|${cap}`);

beforeEach(() => {
  db.etats.clear(); db.historique = []; db.version = 0; db.panne = false; db.codeErreur = null;
  db.schema1815 = true; db.schema1816 = true; db.schema1950 = true;
  db.now = '2026-11-16T10:00:00.000Z'; db.bauxGagnes = 0;
  requalif.marques = []; requalif.campagnes = []; requalif.dejaMarque = false;
  alertes.ouvertes = []; alertes.resolues = []; alertes.prochainId = 100;
  O.__resetOperationalSchemaState();
  O.__resetOperationalSnapshotMemory();
  A.__setPublishedVerdictReaderForTests(null);
  A.__setOperationalVersionReaderForTests(null);
  A.__resetLastReliableVerdicts();
  A.__resetAdmissionMetrics();
  setProviderSecretResolver(async () => CLE_A);
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  A.__setPublishedVerdictReaderForTests(null);
  A.__setOperationalVersionReaderForTests(null);
  A.__enableAdmissionDbForTests(false);
  setProviderSecretResolver(null);
  vi.restoreAllMocks();
});

// ════════════════════════════════════════════════════════════════════════════
describe('C786-A01 — identité de route et preuve de lecture PAR ROUTE', () => {
  it('la clé de route distingue l’accès, l’environnement, le point d’accès et la version d’API', () => {
    const base = { model: MODELE, capability: 'text_generation' as const, accessFingerprint: 'aaa', environment: 'preprod', endpoint: 'generateContent', apiVersion: 'v1beta' };
    const k = A.routeKeyOf(base);
    expect(A.routeKeyOf(base)).toBe(k); // pure et déterministe
    for (const over of [
      { accessFingerprint: 'bbb' }, { environment: 'production' }, { endpoint: 'streamGenerateContent' },
      { apiVersion: 'v1' }, { capability: 'multimodal' as const }, { model: AUTRE_MODELE },
    ]) {
      expect(A.routeKeyOf({ ...base, ...over }), JSON.stringify(over)).not.toBe(k);
    }
    // Dimension inconnue : DITE comme telle, jamais confondue avec une valeur.
    expect(A.routeKeyOf({ ...base, environment: null })).not.toBe(A.routeKeyOf({ ...base, environment: 'null' }));
  });

  /**
   * Preuve de l'écart A01 : une lecture fiable de la route A ne vaut PLUS preuve pour la route B. Le booléen
   * global `lectureFiableObtenue` rendait « inconnu non bloquant + fromLastReliable » sur B, et l'envoi partait.
   */
  it('route A lue puis base HS : zéro départ sur la route B jamais lue, et B n’est PAS déclarée retirée', async () => {
    let lectureHS = false;
    A.__setPublishedVerdictReaderForTests(async (model, capability, route) => {
      if (lectureHS) throw new Error('base inaccessible');
      return { ...A.unknownVerdict(model, true, capability), state: 'healthy', checkStatus: 'ok', accessFingerprint: route.accessFingerprint };
    });
    // Route A : lecture FIABLE, verdict mémorisé.
    const a1 = await A.guardSend({ model: MODELE, point: 'gateway_send', access: { secret: CLE_A } });
    expect(a1).toMatchObject({ admitted: true, reason: 'AVAILABLE' });

    lectureHS = true;
    // Route A pendant la panne : le dernier verdict FIABLE de CETTE route est servi — l'envoi part.
    const a2 = await A.guardSend({ model: MODELE, point: 'gateway_send', access: { secret: CLE_A } });
    expect(a2).toMatchObject({ admitted: true, verdict: { fromLastReliable: true } });

    // Route B, JAMAIS lue : admission INVÉRIFIABLE — aucun départ.
    const b = await A.guardSend({ model: MODELE, point: 'gateway_send', access: { secret: CLE_B } });
    expect(b.admitted).toBe(false);
    expect(b).toMatchObject({ code: 'ADMISSION_UNVERIFIABLE' });
    // …et B n'est PAS déclarée retirée : l'état reste INCONNU, pas « indisponible ».
    expect(b.verdict.state).not.toBe('unavailable');
    expect(b.verdict.state).toBe('unknown');
    // Une autre CAPACITÉ de la route B est tout aussi invérifiable (la route n'a jamais été lue).
    const bCap = await A.guardSend({ model: MODELE, point: 'gateway_send', capability: 'multimodal', access: { secret: CLE_B } });
    expect(bCap).toMatchObject({ admitted: false, code: 'ADMISSION_UNVERIFIABLE' });
    // Un autre MODÈLE jamais lu l'est aussi, sur l'accès A compris.
    expect(await A.guardSend({ model: AUTRE_MODELE, point: 'gateway_send', access: { secret: CLE_A } }))
      .toMatchObject({ admitted: false, code: 'ADMISSION_UNVERIFIABLE' });
  });

  it('une route lue FIABLEMENT comme absente reste admise pendant la panne (l’inconnu n’exclut rien)', async () => {
    let lectureHS = false;
    A.__setPublishedVerdictReaderForTests(async (model, capability, route) => {
      if (lectureHS) throw new Error('base inaccessible');
      return { ...A.unknownVerdict(model, true, capability), accessFingerprint: route.accessFingerprint };
    });
    expect(await A.guardSend({ model: MODELE, point: 'gateway_send', access: { secret: CLE_A } }))
      .toMatchObject({ admitted: true, reason: 'UNKNOWN_NOT_BLOCKING' });
    lectureHS = true;
    expect(await A.guardSend({ model: MODELE, point: 'gateway_send', access: { secret: CLE_A } }))
      .toMatchObject({ admitted: true, reason: 'UNKNOWN_NOT_BLOCKING', verdict: { fromLastReliable: true } });
  });

  it('un refus mémorisé reste opposable indéfiniment, et seulement pour SON accès', async () => {
    let lectureHS = false;
    A.__setPublishedVerdictReaderForTests(async (model, capability, route) => {
      if (lectureHS) throw new Error('base inaccessible');
      const refuse = route.accessFingerprint === keyFingerprint(CLE_A);
      return {
        ...A.unknownVerdict(model, true, capability), accessFingerprint: route.accessFingerprint,
        state: refuse ? 'unavailable' : 'healthy', checkStatus: refuse ? 'failed_confirmed' : 'ok',
        checkedAt: '2020-01-01T00:00:00.000Z', confirmedAt: '2020-01-01T00:00:00.000Z',
      };
    });
    expect((await A.guardSend({ model: MODELE, point: 'gateway_send', access: { secret: CLE_A } })).admitted).toBe(false);
    expect((await A.guardSend({ model: MODELE, point: 'gateway_send', access: { secret: CLE_B } })).admitted).toBe(true);
    lectureHS = true;
    // Panne : le refus de A tient (aucune ancienneté ne l'éteint), et le verdict sain de B n'y change rien.
    expect(await A.guardSend({ model: MODELE, point: 'gateway_send', access: { secret: CLE_A } }))
      .toMatchObject({ admitted: false, code: 'MODEL_UNAVAILABLE' });
    expect((await A.guardSend({ model: MODELE, point: 'gateway_send', access: { secret: CLE_B } })).admitted).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('C786-A02 — « Tester la clé » décide sur la clé TESTÉE, jamais sur la clé active', () => {
  /**
   * Preuve de l'écart A02 : `guardSend({ point: 'provider_key_test' })` était appelé SANS la clé testée et
   * relisait donc le verdict de la clé ACTIVE. Le verdict de A pouvait autoriser ou bloquer un départ sur B.
   */
  it('A refusée / B saine : la garde du test de clé B laisse partir, celle de la clé active refuse', async () => {
    await O.recordOperationalCheck({ model: MODELE, secret: CLE_A, outcome: refus(), source: 'catalog_refresh', checkId: 'a02-1' });
    A.__enableAdmissionDbForTests(true);
    // Clé active (A) : refusée.
    expect(await A.guardSend({ model: MODELE, point: 'provider_key_test' }))
      .toMatchObject({ admitted: false, code: 'MODEL_UNAVAILABLE' });
    // Clé TESTÉE (B) : aucun verdict ne lui est opposable — l'envoi part, par son empreinte comme par son secret.
    expect((await A.guardSend({ model: MODELE, point: 'provider_key_test', access: { fingerprint: keyFingerprint(CLE_B) } })).admitted).toBe(true);
    expect((await A.guardSend({ model: MODELE, point: 'provider_key_test', access: { secret: CLE_B } })).admitted).toBe(true);
  });

  it('A saine / B refusée : le test de la clé B est refusé, la clé active reste admise', async () => {
    await O.recordOperationalCheck({ model: MODELE, secret: CLE_B, outcome: refus(), source: 'provider_test', checkId: 'a02-2' });
    A.__enableAdmissionDbForTests(true);
    expect((await A.guardSend({ model: MODELE, point: 'provider_key_test' })).admitted).toBe(true);
    expect(await A.guardSend({ model: MODELE, point: 'provider_key_test', access: { fingerprint: keyFingerprint(CLE_B) } }))
      .toMatchObject({ admitted: false, code: 'MODEL_UNAVAILABLE' });
  });

  it('le résultat est attribué à l’accès qui a ENVOYÉ : la ligne de la clé active n’est pas touchée', async () => {
    await O.recordOperationalCheck({ model: MODELE, secret: CLE_A, outcome: { status: 'ok' }, source: 'catalog_refresh', checkId: 'a02-3' });
    // Test de la clé B : empreinte figée AVANT la requête, transmise à l'enregistrement.
    await O.recordOperationalCheck({
      model: MODELE, secret: CLE_B, outcome: refus(), source: 'provider_test', checkId: 'a02-4',
      accessFingerprint: keyFingerprint(CLE_B),
    });
    expect(etat(MODELE, CLE_A)).toMatchObject({ ok: true });
    expect(etat(MODELE, CLE_B)).toMatchObject({ ok: false, check_status: 'failed_confirmed' });
    // Aucun secret dans l'état ni dans l'historique : seulement des empreintes.
    const tout = JSON.stringify([...db.etats.values(), ...db.historique]);
    expect(tout).not.toContain(CLE_A);
    expect(tout).not.toContain(CLE_B);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('C786-A03 — résultat CALCULÉ ≠ verdict PUBLIÉ', () => {
  it('échec de commit : aucun verdict publié, état `not_persisted`, reprise idempotente avec le même identifiant', async () => {
    db.panne = true;
    const r = await O.recordOperationalCheck({ model: MODELE, secret: CLE_A, outcome: refus(), source: 'catalog_refresh', checkId: 'a03-reprise' });
    expect(r.persistence).toBe('not_persisted');
    expect(O.isPublishedVerdict(r)).toBe(false);
    expect(r.notPersistedReason).toMatch(/commit|schéma/);
    expect(db.etats.size).toBe(0); // rien d'écrit, surtout pas au format antérieur à 1692
    // Reprise après rétablissement : le MÊME identifiant publie le verdict UNE fois.
    db.panne = false;
    const ok = await O.recordOperationalCheck({ model: MODELE, secret: CLE_A, outcome: refus(), source: 'catalog_refresh', checkId: 'a03-reprise' });
    expect(ok.persistence).toBe('published');
    expect(etat(MODELE, CLE_A)).toMatchObject({ ok: false, failure_count: 1 });
    // Et un second rejeu ne compte pas pour une seconde sonde.
    const rejeu = await O.recordOperationalCheck({ model: MODELE, secret: CLE_A, outcome: refus(), source: 'catalog_refresh', checkId: 'a03-reprise' });
    expect(rejeu.persistence).toBe('published');
    expect(etat(MODELE, CLE_A)).toMatchObject({ failure_count: 1 });
  });

  it('table absente (42P01) : aucune écriture au format antérieur, aucun verdict publié', async () => {
    db.codeErreur = '42P01';
    const r = await O.recordOperationalCheck({ model: MODELE, secret: CLE_A, outcome: refus(), source: 'catalog_refresh', checkId: 'a03-42p01' });
    expect(r.persistence).toBe('not_persisted');
    expect(db.etats.size).toBe(0);
    expect(O.operationalSchemaState().degradedReason).toMatch(/migration critique/);
  });

  it('colonne absente (42703) : aucun verdict publié non plus (le repli 1692 écrasait les autres accès)', async () => {
    db.codeErreur = '42703';
    const r = await O.recordOperationalCheck({ model: MODELE, secret: CLE_A, outcome: refus(), source: 'catalog_refresh', checkId: 'a03-42703' });
    expect(r.persistence).toBe('not_persisted');
    expect(db.etats.size).toBe(0);
  });

  /**
   * Preuve de l'écart A03 : `operationalRefusalInTx` rendait `clear` sur `42P01`, et une promotion, une
   * activation ou un import passait alors que la table critique était absente.
   */
  it('contrôle final : 42P01 rend `unverifiable` quand la disponibilité est instrumentée, `clear` sinon', async () => {
    const sqlKO = { unsafe: async (q: string) => {
      if (/SAVEPOINT/.test(q)) return [];
      const e = new Error('relation inexistante') as Error & { code?: string };
      e.code = '42P01';
      throw e;
    } };
    // Dimension INSTRUMENTÉE (un lecteur de verdict est branché) : contrôle final impossible ⇒ refus.
    A.__setPublishedVerdictReaderForTests(async (m, c) => A.unknownVerdict(m, true, c));
    expect(await O.operationalRefusalInTx(sqlKO, MODELE, CLE_A)).toMatchObject({ kind: 'unverifiable' });
    // Dimension NON instrumentée (test unitaire sans base) : rien à contrôler ⇒ l'application n'est pas bloquée.
    A.__setPublishedVerdictReaderForTests(null);
    A.__enableAdmissionDbForTests(false);
    expect(await O.operationalRefusalInTx(sqlKO, MODELE, CLE_A)).toEqual({ kind: 'clear' });
  });

  it('migration critique absente : admission et activation bloquées, candidate et preuves conservées', async () => {
    db.schema1815 = false;
    A.__setPublishedVerdictReaderForTests(async (m, c) => A.unknownVerdict(m, true, c));
    // Le schéma est constaté incomplet dès la première lecture…
    await O.readPublishedVerdict(MODELE, CLE_A);
    expect(O.operationalSchemaState()).toMatchObject({ complete: false });
    // …et le contrôle final refuse, sans rien modifier à la configuration.
    const sqlOK = { unsafe: async () => [] };
    expect(await O.operationalRefusalInTx(sqlOK, MODELE, CLE_A)).toMatchObject({ kind: 'unverifiable' });
    expect(db.etats.size).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('C786-B02 — ordre déterministe, indépendant des horloges', () => {
  const t = (h: string) => new Date(`2026-11-16T${h}.000Z`);
  /**
   * Un contrôle envoyé à `envoi`, enregistré par un worker dont la montre indique `montre`, alors que
   * l'horloge de la BASE indique `base` (l'écart entre les deux est ce que le recalage doit corriger).
   */
  const controler = (p: {
    issue: 'ok' | 'refus'; envoi: string; montre?: string; base?: string; checkId: string;
    source?: 'catalog_refresh' | 'provider_test';
  }) => {
    if (p.base) db.now = t(p.base).toISOString();
    return O.recordOperationalCheck({
      model: MODELE, secret: CLE_A, source: p.source ?? 'catalog_refresh', checkId: p.checkId,
      outcome: p.issue === 'ok' ? { status: 'ok' } : refus(),
      observedAt: t(p.envoi), now: t(p.montre ?? db.now.slice(11, 19)),
    });
  };

  it('±30 s (dans la tolérance) : aucun recalage, l’ordre suit les instants d’envoi', async () => {
    for (const montre of ['10:00:30', '09:59:30']) {
      db.etats.clear(); db.historique = [];
      await controler({ issue: 'refus', envoi: '09:00:00', montre, checkId: `b02-tol-${montre}-1` });
      expect(etat(MODELE, CLE_A)).toMatchObject({ observed_at: t('09:00:00').toISOString() });
      // Un succès STRICTEMENT postérieur lève bien la disponibilité.
      const r = await controler({ issue: 'ok', envoi: '09:30:00', montre, checkId: `b02-tol-${montre}-2` });
      expect(r.ok).toBe(true);
    }
  });

  it('+90 s (worker en AVANCE) : l’instant d’envoi est recalé en arrière, jamais extrapolé', async () => {
    await controler({ issue: 'refus', envoi: '09:01:30', montre: '10:01:30', checkId: 'b02-avance' });
    // Écart mesuré +90 s : l'envoi daté 09:01:30 sur la montre du worker vaut 09:00:00 à l'heure de la base.
    expect(etat(MODELE, CLE_A)).toMatchObject({ observed_at: t('09:00:00').toISOString() });
  });

  it('−90 s (worker en RETARD) : recalé en avant — un résultat réellement postérieur n’est plus écarté à tort', async () => {
    await controler({ issue: 'refus', envoi: '09:00:00', checkId: 'b02-retard-1' });
    // Worker en retard de 90 s : son envoi daté 08:58:30 vaut 09:00:00 à l'heure de la base — donc à INSTANT
    // ÉGAL du refus en vigueur, et non avant lui. L'arbitrage déterministe s'applique (le refus tient).
    const egal = await controler({ issue: 'ok', envoi: '08:58:30', montre: '09:58:30', checkId: 'b02-retard-2' });
    expect(egal.stale).toBe(true);
    expect(db.historique.at(-1)).toMatchObject({ applied: false, discarded: 'equal_instant' });
    // Et un envoi réellement postérieur est bien appliqué : 10 min plus tard, la montre du worker comme
    // l'horloge de la base ont avancé de 10 min — l'écart reste de −90 s, et l'envoi vaut 09:10:00.
    const apres = await controler({ issue: 'ok', envoi: '09:08:30', montre: '10:08:30', base: '10:10:00', checkId: 'b02-retard-3' });
    expect(apres.ok).toBe(true);
    expect(etat(MODELE, CLE_A)).toMatchObject({ observed_at: t('09:10:00').toISOString() });
  });

  it('dates IDENTIQUES : arbitrage déterministe — le refus tient, quelle que soit l’issue reçue', async () => {
    await controler({ issue: 'refus', envoi: '09:00:00', checkId: 'b02-egal-1' });
    const avant = { ...etat(MODELE, CLE_A) };
    // Un succès à instant égal ne lève pas le refus…
    const succes = await controler({ issue: 'ok', envoi: '09:00:00', checkId: 'b02-egal-2', source: 'provider_test' });
    expect(succes.stale).toBe(true);
    expect(etat(MODELE, CLE_A)).toMatchObject({ ok: false, check_status: 'failed_confirmed' });
    // …et le résultat écarté est HISTORISÉ avec son motif, sans réhabilitation.
    expect(db.historique.at(-1)).toMatchObject({ applied: false, discarded: 'equal_instant', checkId: 'b02-egal-2' });
    // Ni compteur, ni échéance, ni version ne bougent.
    expect(etat(MODELE, CLE_A)).toMatchObject({
      failure_count: avant.failure_count, next_probe_at: avant.next_probe_at, state_version: avant.state_version,
    });
  });

  it('succès ANCIEN reçu après un refus récent : écarté « hors ordre », jamais une réhabilitation', async () => {
    await controler({ issue: 'refus', envoi: '09:00:00', checkId: 'b02-ordre-1' });
    const r = await controler({ issue: 'ok', envoi: '08:00:00', checkId: 'b02-ordre-2', source: 'provider_test' });
    expect(r.stale).toBe(true);
    expect(etat(MODELE, CLE_A)).toMatchObject({ ok: false });
    expect(db.historique.at(-1)).toMatchObject({ applied: false, discarded: 'out_of_order' });
  });

  it('rejeu IDENTIQUE : ni état, ni compteur, ni échéance, ni version, ni ligne d’historique, ni alerte', async () => {
    await controler({ issue: 'refus', envoi: '09:00:00', checkId: 'b02-rejeu' });
    const avant = { ...etat(MODELE, CLE_A) };
    const lignes = db.historique.length;
    const versionAvant = db.version;
    const r = await O.recordOperationalCheck({
      model: MODELE, secret: CLE_A, outcome: refus(), source: 'catalog_refresh', checkId: 'b02-rejeu',
      observedAt: t('09:00:00'), now: t('10:00:00'),
    });
    expect(r.changed).toBe(false);
    expect({ ...etat(MODELE, CLE_A) }).toEqual(avant);
    expect(db.historique).toHaveLength(lignes);
    expect(db.version).toBe(versionAvant);
  });

  it('« dernier verdict retenu » et « dernier résultat reçu » restent séparés', async () => {
    await controler({ issue: 'refus', envoi: '09:00:00', checkId: 'b02-sep-1' });
    await O.recordOperationalCheck({
      model: MODELE, secret: CLE_A, source: 'recovery_check', checkId: 'b02-sep-2',
      outcome: { status: 'inconclusive', kind: 'quota', error: 'HTTP 429 RESOURCE_EXHAUSTED' },
      observedAt: t('09:30:00'), now: t('10:00:00'),
    });
    expect(etat(MODELE, CLE_A)).toMatchObject({ ok: false, last_result_status: 'inconclusive', last_result_kind: 'quota' });
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('C786-B03 — réservation de sonde et fencing', () => {
  const owner = (n: number) => `worker-${n}:probe`;

  /**
   * Preuve de l'écart B03 : sans ligne d'état, `acquireProbeLease` rendait
   * `{ acquired: true, reason: 'no_state' }` SANS réservation — deux instances sondaient donc un modèle neuf.
   */
  it('route JAMAIS sondée : la ligne est créée puis réservée — exactement UN détenteur', async () => {
    const premier = await O.acquireProbeLease({ model: MODELE, secret: CLE_A, owner: owner(1) });
    expect(premier).toMatchObject({ acquired: true, reason: 'acquired' });
    expect(premier.reason).not.toBe('no_state');
    expect(premier.generation).toBe(1);
    // La ligne créée est NEUTRE : état inconnu, aucun verdict fabriqué, aucun modèle retiré.
    expect(etat(MODELE, CLE_A)).toMatchObject({ ok: null, check_status: null, next_probe_at: null });
    // Un second worker arrivé ensuite ne l'obtient pas.
    const second = await O.acquireProbeLease({ model: MODELE, secret: CLE_A, owner: owner(2) });
    expect(second).toMatchObject({ acquired: false, reason: 'held_elsewhere' });
    expect(db.bauxGagnes).toBe(1);
  });

  it('deux workers SIMULTANÉS sur une route neuve : une seule réservation', async () => {
    const [a, b, c] = await Promise.all([
      O.acquireProbeLease({ model: MODELE, secret: CLE_A, owner: owner(1) }),
      O.acquireProbeLease({ model: MODELE, secret: CLE_A, owner: owner(2) }),
      O.acquireProbeLease({ model: MODELE, secret: CLE_A, owner: owner(3) }),
    ]);
    expect([a, b, c].filter((x) => x.acquired)).toHaveLength(1);
    expect(db.bauxGagnes).toBe(1);
  });

  it('le bail rend un JETON incrémenté à chaque réservation', async () => {
    const un = await O.acquireProbeLease({ model: MODELE, secret: CLE_A, owner: owner(1) });
    await O.releaseProbeLease({ model: MODELE, secret: CLE_A, owner: owner(1) });
    const deux = await O.acquireProbeLease({ model: MODELE, secret: CLE_A, owner: owner(2) });
    expect([un.generation, deux.generation]).toEqual([1, 2]);
  });

  /**
   * Preuve de l'écart B03 (second volet) : un détenteur dont le bail a expiré pouvait publier son résultat
   * APRÈS la reprise du bail par un autre worker, et écraser un verdict plus récent.
   */
  it('bail REPRIS par un autre worker : le résultat tardif de l’ancien détenteur est rejeté et historisé', async () => {
    const ancien = await O.acquireProbeLease({ model: MODELE, secret: CLE_A, owner: owner(1) });
    expect(ancien.generation).toBe(1);
    // Le bail expire (arrêt brutal du détenteur) et un autre worker le reprend.
    const ligne = etat(MODELE, CLE_A)!;
    ligne.probe_lease_until = new Date(Date.now() - 1_000).toISOString();
    const nouveau = await O.acquireProbeLease({ model: MODELE, secret: CLE_A, owner: owner(2) });
    expect(nouveau).toMatchObject({ acquired: true, generation: 2 });
    // Résultat TARDIF de l'ancien détenteur : rejeté, état inchangé.
    const tardif = await O.recordOperationalCheck({
      model: MODELE, secret: CLE_A, outcome: refus(), source: 'recovery_check', checkId: 'b03-tardif',
      leaseGeneration: ancien.generation,
    });
    expect(tardif.stale).toBe(true);
    expect(etat(MODELE, CLE_A)).toMatchObject({ ok: null });
    expect(db.historique.at(-1)).toMatchObject({ applied: false, discarded: 'lease_fenced', checkId: 'b03-tardif' });
    // Le résultat du NOUVEAU détenteur, lui, s'applique.
    const bon = await O.recordOperationalCheck({
      model: MODELE, secret: CLE_A, outcome: refus(), source: 'recovery_check', checkId: 'b03-bon',
      leaseGeneration: nouveau.generation,
    });
    expect(bon.persistence).toBe('published');
    expect(etat(MODELE, CLE_A)).toMatchObject({ ok: false });
  });

  it('résultat de sonde SANS jeton alors qu’un bail est en cours : rejeté, et historisé comme tel', async () => {
    await O.acquireProbeLease({ model: MODELE, secret: CLE_A, owner: owner(1) });
    const sansJeton = await O.recordOperationalCheck({
      model: MODELE, secret: CLE_A, outcome: refus(), source: 'catalog_refresh', checkId: 'b03-sans-jeton',
    });
    expect(sansJeton.stale).toBe(true);
    expect(db.historique.at(-1)).toMatchObject({ applied: false, discarded: 'lease_missing' });
    // Un test de clé, lui, n'est pas une sonde réservée : il n'est jamais écarté pour cette raison.
    const test = await O.recordOperationalCheck({
      model: MODELE, secret: CLE_A, outcome: { status: 'ok' }, source: 'provider_test', checkId: 'b03-test-cle',
    });
    expect(test.persistence).toBe('published');
    expect(test.stale).toBeUndefined();
  });

  it('échéance non atteinte : aucune réservation, donc aucune rafale — et la sonde non envoyée est COMPTÉE', async () => {
    await O.recordOperationalCheck({ model: MODELE, secret: CLE_A, outcome: refus(), source: 'catalog_refresh', checkId: 'b03-echeance' });
    expect(etat(MODELE, CLE_A)!.next_probe_at).toBeTruthy();
    for (let i = 0; i < 5; i++) {
      expect(await O.acquireProbeLease({ model: MODELE, secret: CLE_A, owner: owner(i) })).toMatchObject({ acquired: false, reason: 'not_due' });
    }
    // Geste manuel : l'échéance est ignorée, mais la réservation reste exigée (double clic ⇒ une seule sonde).
    const manuel = await Promise.all([
      O.acquireProbeLease({ model: MODELE, secret: CLE_A, owner: owner(8), immediate: true }),
      O.acquireProbeLease({ model: MODELE, secret: CLE_A, owner: owner(9), immediate: true }),
    ]);
    expect(manuel.filter((x) => x.acquired)).toHaveLength(1);
  });

  it('base illisible : aucune réservation (aucune sonde pendant une panne)', async () => {
    db.panne = true;
    expect(await O.acquireProbeLease({ model: MODELE, secret: CLE_A, owner: owner(1) }))
      .toMatchObject({ acquired: false, reason: 'unreadable' });
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('C786-C02 — requalification universelle au retour à sain', () => {
  const SOURCES = ['provider_test', 'catalog_refresh', 'qualification', 'gateway_call', 'recovery_check'] as const;

  /**
   * Preuve de l'écart C02 : seul `fallback-context.probeUnderReservation` marquait les qualifications
   * obsolètes et relançait la campagne. Un rétablissement constaté par le catalogue, par « Tester la clé »,
   * par une qualification ou par un appel réel ne requalifiait rien.
   */
  for (const source of SOURCES) {
    it(`transition failed_confirmed → ok depuis « ${source} » : un marquage et une campagne`, async () => {
      await O.recordOperationalCheck({
        model: MODELE, secret: CLE_A, outcome: refus(), source: 'catalog_refresh', checkId: `c02-${source}-refus`,
        observedAt: new Date('2026-11-16T09:00:00Z'), now: new Date(db.now),
      });
      expect(requalif.marques).toHaveLength(0); // un refus ne requalifie rien
      const r = await O.recordOperationalCheck({
        model: MODELE, secret: CLE_A, outcome: { status: 'ok' }, source, checkId: `c02-${source}-ok`,
        observedAt: new Date('2026-11-16T09:30:00Z'), now: new Date(db.now),
      });
      expect(r.recovered).toBe(true);
      expect(r.persistence).toBe('published');
      expect(requalif.marques).toHaveLength(1);
      expect(requalif.campagnes).toEqual([[MODELE]]);
    });
  }

  it('rejeu et second passage : UN SEUL marquage, UNE SEULE campagne (idempotent et reprenable)', async () => {
    await O.recordOperationalCheck({
      model: MODELE, secret: CLE_A, outcome: refus(), source: 'catalog_refresh', checkId: 'c02-idem-refus',
      observedAt: new Date('2026-11-16T09:00:00Z'), now: new Date(db.now),
    });
    const succes = {
      model: MODELE, secret: CLE_A, outcome: { status: 'ok' } as const, source: 'catalog_refresh' as const,
      checkId: 'c02-idem-ok', observedAt: new Date('2026-11-16T09:30:00Z'), now: new Date(db.now),
    };
    await O.recordOperationalCheck(succes);
    await O.recordOperationalCheck(succes); // rejeu exact (reprise après crash)
    await O.recordOperationalCheck({ ...succes, checkId: 'c02-idem-ok-2', observedAt: new Date('2026-11-16T09:45:00Z') });
    expect(requalif.marques).toHaveLength(1);
    expect(requalif.campagnes).toHaveLength(1);
  });

  it('un résultat NON CONCLUANT ne lève rien et ne requalifie rien', async () => {
    await O.recordOperationalCheck({
      model: MODELE, secret: CLE_A, outcome: refus(), source: 'catalog_refresh', checkId: 'c02-inc-refus',
      observedAt: new Date('2026-11-16T09:00:00Z'), now: new Date(db.now),
    });
    const r = await O.recordOperationalCheck({
      model: MODELE, secret: CLE_A, source: 'recovery_check', checkId: 'c02-inc',
      outcome: { status: 'inconclusive', kind: 'quota', error: 'HTTP 429' },
      observedAt: new Date('2026-11-16T09:30:00Z'), now: new Date(db.now),
    });
    expect(r.recovered).toBeUndefined();
    expect(etat(MODELE, CLE_A)).toMatchObject({ ok: false });
    expect(requalif.marques).toHaveLength(0);
    expect(requalif.campagnes).toHaveLength(0);
  });

  it('un succès sur une route JAMAIS refusée ne requalifie rien (rien n’a été levé)', async () => {
    const r = await O.recordOperationalCheck({ model: MODELE, secret: CLE_A, outcome: { status: 'ok' }, source: 'catalog_refresh', checkId: 'c02-neuf' });
    expect(r.recovered).toBeUndefined();
    expect(requalif.marques).toHaveLength(0);
  });

  it('écriture NON persistée : aucune requalification (aucun verdict publié, donc aucune transition)', async () => {
    await O.recordOperationalCheck({
      model: MODELE, secret: CLE_A, outcome: refus(), source: 'catalog_refresh', checkId: 'c02-np-refus',
      observedAt: new Date('2026-11-16T09:00:00Z'), now: new Date(db.now),
    });
    db.panne = true;
    const r = await O.recordOperationalCheck({
      model: MODELE, secret: CLE_A, outcome: { status: 'ok' }, source: 'provider_test', checkId: 'c02-np-ok',
      observedAt: new Date('2026-11-16T09:30:00Z'), now: new Date(db.now),
    });
    expect(r.persistence).toBe('not_persisted');
    expect(requalif.marques).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('C786-D02 — alertes isolées par accès et par capacité', () => {
  const diagnostic = (over: Partial<import('../model-operational.service').OperationalDiagnostic> = {}) => ({
    model: MODELE, ok: false, checkStatus: 'failed_confirmed' as const, error: 'HTTP 404 NOT_FOUND',
    errorKind: 'model_retired' as const, checkedAt: '2026-11-16T08:00:00.000Z', source: 'catalog_refresh',
    lastOkAt: null, suspectSince: null, access: 'clé …aaaaaaaa', capability: 'text_generation',
    ...over,
  });

  it('la clé d’alerte porte le modèle, l’ACCÈS et la CAPACITÉ', () => {
    const k = (over: Parameters<typeof diagnostic>[0]) => AN.alertScopeKey(AN.alertScopeOf({ model: MODELE, diagnostic: diagnostic(over) as never }));
    expect(k({})).toBe('ai:active-model:gemini-3.6-flash:clé …aaaaaaaa:text_generation');
    expect(k({ access: 'clé …bbbbbbbb' })).not.toBe(k({}));
    expect(k({ capability: 'multimodal' })).not.toBe(k({}));
    // Dimension non renseignée : DITE comme telle, jamais fusionnée avec une valeur.
    expect(k({ access: undefined })).toContain('acces-inconnu');
  });

  /**
   * Preuve de l'écart D02 : la résolution comparait le seul nom de MODÈLE. Un succès sur l'accès B résolvait
   * donc l'incident de l'accès A, alors que A n'avait pas été éprouvé.
   */
  it('A refusé / B sain : l’alerte de A reste ouverte, aucune résolution transversale', async () => {
    alertes.ouvertes = [
      { id: 1, details: { model: MODELE, scope: { model: MODELE, access: 'clé …aaaaaaaa', capability: 'text_generation' } } },
      { id: 2, details: { model: MODELE, scope: { model: MODELE, access: 'clé …bbbbbbbb', capability: 'text_generation' } } },
    ];
    // La lecture ne couvre QUE l'accès B, où le modèle est redevenu sain : aucune anomalie n'est détectée.
    const perimetre: import('../active-model-anomalies').AlertPerimeter = { reliable: true, accesses: ['clé …bbbbbbbb'] };
    await AN.resolveRecoveredModelAlerts([], perimetre, new Map());
    // Seule l'alerte de B est résolue ; celle de A, hors lecture, reste visible.
    expect(alertes.resolues).toEqual([{ ids: [2], code: 'MODEL_AVAILABLE_AGAIN' }]);
    expect(alertes.ouvertes.map((a) => a.id)).toEqual([1]);
  });

  it('A et B avec des CAPACITÉS distinctes : résoudre l’une ne résout pas l’autre', async () => {
    alertes.ouvertes = [
      { id: 1, details: { model: MODELE, scope: { model: MODELE, access: 'clé …aaaaaaaa', capability: 'text_generation' } } },
      { id: 2, details: { model: MODELE, scope: { model: MODELE, access: 'clé …aaaaaaaa', capability: 'multimodal' } } },
    ];
    // La capacité de base est TOUJOURS en anomalie ; la modalité multimodale est rétablie.
    const anomalie = {
      treatment: 'T1' as const, rank: 'primaryModel' as const, model: MODELE, source: 'version' as const,
      reasons: ['NOT_OPERATIONAL' as const], reasonText: 'non opérationnel', fallbackAvailable: false, noAdmissibleRoute: true,
    };
    await AN.resolveRecoveredModelAlerts([anomalie], { reliable: true, accesses: ['clé …aaaaaaaa'] },
      new Map([[MODELE, diagnostic() as never]]));
    expect(alertes.resolues).toEqual([{ ids: [2], code: 'MODEL_AVAILABLE_AGAIN' }]);
    expect(alertes.ouvertes.map((a) => a.id)).toEqual([1]);
  });

  it('lecture INCOMPLÈTE : aucune alerte levée, actualisée ni résolue (une erreur de base ≠ un rétablissement)', async () => {
    alertes.ouvertes = [{ id: 1, details: { model: MODELE, scope: { model: MODELE, access: 'clé …aaaaaaaa', capability: 'text_generation' } } }];
    const partiel: import('../active-model-anomalies').AlertPerimeter = { reliable: false, accesses: [] };
    expect(await AN.resolveRecoveredModelAlerts([], partiel, new Map())).toBe(0);
    const anomalie = {
      treatment: 'T1' as const, rank: 'primaryModel' as const, model: AUTRE_MODELE, source: 'version' as const,
      reasons: ['NOT_OPERATIONAL' as const], reasonText: 'non opérationnel', fallbackAvailable: false, noAdmissibleRoute: true,
    };
    expect(await AN.raiseActiveModelAlerts([anomalie], new Date(db.now), undefined, new Map(), partiel)).toBe(0);
    expect(alertes.resolues).toHaveLength(0);
    expect(alertes.ouvertes.map((a) => a.id)).toEqual([1]);
  });

  it('incident global du fournisseur : résolu seulement pour les accès RÉELLEMENT lus', async () => {
    alertes.ouvertes = [
      { id: 1, details: { access: 'clé …aaaaaaaa' } },
      { id: 2, details: { access: 'clé …bbbbbbbb' } },
    ];
    const veille = AN.operationalWatchOf(new Map([[MODELE, diagnostic({ ok: true, checkStatus: 'ok' }) as never]]), true);
    expect(veille.providerIncident).toBeNull();
    await AN.reconcileProviderIncidentAlert(veille, { reliable: true, accesses: ['clé …bbbbbbbb'] });
    expect(alertes.resolues).toEqual([{ ids: [2], code: 'PROVIDER_ACCESS_RESTORED' }]);
    expect(alertes.ouvertes.map((a) => a.id)).toEqual([1]);
  });

  it('état retenu refusé + dernier test NON CONCLUANT : toujours compté indisponible', () => {
    const veille = AN.operationalWatchOf(new Map([[MODELE, diagnostic({ checkStatus: 'inconclusive', errorKind: 'quota' }) as never]]), true);
    expect(veille.counts).toMatchObject({ failedConfirmed: 1, unavailableWithInconclusiveLastCheck: 1 });
    expect(veille.summary).not.toMatch(/sain/);
  });

  it('lecture non fiable : aucun décompte opposable, et jamais « tout sain »', () => {
    const veille = AN.operationalWatchOf(new Map(), false);
    expect(veille.reliable).toBe(false);
    expect(veille.summary).toMatch(/illisible/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('C786-D03 — mesures : autorisé, réellement parti, refusé, sonde non envoyée', () => {
  it('un départ annulé entre la garde et le réseau est compté refusé, jamais parti', async () => {
    let refuse = false;
    A.__setPublishedVerdictReaderForTests(async (model, capability, route) => ({
      ...A.unknownVerdict(model, true, capability), accessFingerprint: route.accessFingerprint,
      state: refuse ? 'unavailable' : 'healthy', checkStatus: refuse ? 'failed_confirmed' : 'ok',
    }));
    let version = 1;
    A.__setOperationalVersionReaderForTests(async () => version);
    const admission = await A.guardSend({ model: MODELE, point: 'gateway_send' });
    expect(admission.admitted).toBe(true);
    // Publication CONCURRENTE : le verdict change et la version est incrémentée.
    refuse = true; version = 2;
    const depart = await A.confirmDeparture(admission);
    expect(depart.departed).toBe(false);
    const m = A.admissionMetrics();
    expect(m.allowed).toBe(1);
    expect(m.departed).toBe(0);
    expect(m.refusedAfterPublication).toBe(1);
    expect(m.byPoint.gateway_send).toMatchObject({ allowed: 1, departed: 0, refused: 1 });
  });

  it('version inchangée : le départ est compté comme RÉELLEMENT effectué', async () => {
    A.__setPublishedVerdictReaderForTests(async (model, capability, route) => ({
      ...A.unknownVerdict(model, true, capability), accessFingerprint: route.accessFingerprint, state: 'healthy', checkStatus: 'ok',
    }));
    A.__setOperationalVersionReaderForTests(async () => 7);
    const admission = await A.guardSend({ model: MODELE, point: 'gateway_send' });
    expect(await A.confirmDeparture(admission)).toMatchObject({ departed: true, reason: 'UNCHANGED' });
    expect(A.admissionMetrics()).toMatchObject({ allowed: 1, departed: 1, refusedAfterPublication: 0 });
  });

  it('le journal des départs corrèle route, identifiant de contrôle, version et worker', async () => {
    let refuse = false;
    A.__setPublishedVerdictReaderForTests(async (model, capability, route) => ({
      ...A.unknownVerdict(model, true, capability), accessFingerprint: route.accessFingerprint,
      state: refuse ? 'unavailable' : 'healthy', checkStatus: refuse ? 'failed_confirmed' : 'ok',
    }));
    let version = 4;
    A.__setOperationalVersionReaderForTests(async () => version);
    // Un départ réellement effectué.
    const parti = await A.guardSend({ model: MODELE, point: 'gateway_send', checkId: 'gateway_call:t1:0' });
    expect((await A.confirmDeparture(parti)).departed).toBe(true);
    // Un départ annulé par une publication concurrente.
    const annule = await A.guardSend({ model: AUTRE_MODELE, point: 'gateway_send', checkId: 'gateway_call:t1:1' });
    refuse = true; version = 5;
    expect((await A.confirmDeparture(annule)).departed).toBe(false);

    const journal = A.departureJournal();
    expect(journal).toHaveLength(2);
    expect(journal[0]).toMatchObject({
      model: MODELE, capability: 'text_generation', point: 'gateway_send',
      checkId: 'gateway_call:t1:0', version: 4, outcome: 'departed', worker: String(process.pid),
    });
    expect(journal[1]).toMatchObject({
      model: AUTRE_MODELE, checkId: 'gateway_call:t1:1', version: 5, outcome: 'cancelled_after_publication',
    });
    // La route est identifiée par sa CLÉ CANONIQUE complète, et les deux routes sont distinctes.
    expect(journal[0]!.routeKey).not.toBe(journal[1]!.routeKey);
    // Aucun secret ne figure dans le journal.
    const brut = JSON.stringify(journal);
    expect(brut).not.toContain(CLE_A);
    expect(brut).not.toContain(CLE_B);
  });

  it('sonde non envoyée : comptée à part, et aucun coût ni appel fictif n’est compté pour un saut', async () => {
    A.__setPublishedVerdictReaderForTests(async (m, c) => A.unknownVerdict(m, true, c));
    A.noteProbeNotSent();
    const refusee = await A.guardSend({ model: MODELE, point: 'gateway_send' });
    expect(refusee.admitted).toBe(true);
    expect(A.admissionMetrics().probesNotSent).toBe(1);
  });
});
