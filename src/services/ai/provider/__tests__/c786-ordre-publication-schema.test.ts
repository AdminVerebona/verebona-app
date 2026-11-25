/**
 * Carte Trello #786 — RÉGRESSIONS RÉVÉLÉES PAR LA RECETTE E2E SUR POSTGRESQL RÉEL (B02 et A03).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUE CE FICHIER DÉMONTRE, ET POURQUOI IL EXISTE
 *
 * Les deux défauts corrigés ici ne se voyaient PAS sans base réelle :
 *
 *   R1 (B02) · l'arbitrage des résultats « à instant égal » comparait l'instant
 *              d'ENVOI du nouveau contrôle à l'instant d'ENVOI de celui qui
 *              fonde l'état (`observed_at`) — jamais à l'instant où ce verdict a
 *              été PUBLIÉ (`checked_at`). Tout contrôle parti moins d'une
 *              seconde après le départ du précédent était donc réputé
 *              concurrent, et ÉCARTÉ s'il améliorait la disponibilité : une
 *              sonde de rétablissement lancée juste après un refus ne levait
 *              jamais ce refus. Sur une base réelle, où les étapes s'enchaînent
 *              en quelques dizaines de millisecondes, c'était systématique ;
 *              avec des instants d'envoi fabriqués (dates figées très
 *              antérieures), les tests unitaires ne le voyaient pas.
 *
 *   R2 (A03) · « migration critique absente » était conclu par le `catch` d'une
 *              lecture (ou d'une écriture) de DONNÉES, dans un drapeau de
 *              processus jamais effacé. Une table momentanément illisible
 *              condamnait tout le processus : le contrôle final de disponibilité
 *              rendait `unverifiable` sur une base parfaitement migrée, et
 *              promotion, activation et import étaient refusés à tort. De même,
 *              `has1815/1816/1950` gravaient un NÉGATIF sur une sonde en échec.
 *
 * Les cas ci-dessous ÉCHOUENT sur le code d'avant la correction et passent
 * après. Base simulée en mémoire : l'horloge de la BASE y est distincte de
 * celle du worker, et `checked_at` y est posé par elle — c'est exactement ce
 * que la recette PostgreSQL a mis en évidence.
 *
 *   C786-R1-01  sonde de rétablissement partie APRÈS la publication du refus :
 *               elle s'applique, même à quelques millisecondes d'écart
 *   C786-R1-02  garantie B02 intacte : deux contrôles réellement en vol en même
 *               temps restent arbitrés par le rang de prudence, et le verdict
 *               final ne dépend pas de l'ordre des commits
 *   C786-R1-03  un résultat réellement plus ancien reste écarté (`out_of_order`)
 *   C786-R2-01  lecture de données impossible : aucune migration déclarée
 *               absente, et le contrôle final reste opposable après la panne
 *   C786-R2-02  migration réellement absente : promotion / activation bloquées,
 *               lacune NOMMÉE (A03 intacte)
 *   C786-R2-03  sonde de schéma en échec : aucun négatif mis en cache
 * ══════════════════════════════════════════════════════════════════════════
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Base simulée : colonnes 1815 / 1816 / 1950 présentes, horloge de BASE propre. */
const db = vi.hoisted(() => ({
  /** Clé : `modèle|empreinte|capacité`. */
  etats: new Map<string, Record<string, unknown>>(),
  historique: [] as Array<Record<string, unknown>>,
  version: 0,
  /** Horloge de la BASE : `now()` et `checked_at` (instant de PUBLICATION). */
  baseNow: '2026-11-16T10:00:00.000Z',
  /** Observation de `information_schema` : colonne présente, absente, ou sonde en échec. */
  schema: 'presente' as 'presente' | 'absente' | 'panne',
  /** Code d'erreur rendu par les lectures / écritures de DONNÉES (`null` : elles répondent). */
  codeDonnees: null as string | null,
}));

vi.mock('@/db', () => {
  const cle = (model: unknown, fp: unknown, cap: unknown) => `${String(model)}|${String(fp)}|${String(cap)}`;
  const lever = (code: string): never => {
    const e = new Error(`erreur ${code}`) as Error & { code?: string };
    e.code = code;
    throw e;
  };
  const unsafe = async (q: string, params: unknown[] = []): Promise<unknown[]> => {
    // Observation du CATALOGUE : jamais mise en panne par `codeDonnees` (c'est une autre question).
    if (/information_schema\.columns/.test(q)) {
      if (db.schema === 'panne') lever('57P01');
      return db.schema === 'presente' ? [{ n: 1 }] : [];
    }
    if (/pg_advisory_xact_lock|SAVEPOINT/.test(q)) return [];
    if (/SELECT now\(\) AS t/.test(q)) return [{ t: db.baseNow }];
    if (db.codeDonnees) lever(db.codeDonnees);

    // ── Réservation de sonde ──
    if (/SET probe_lease_owner = \$3/.test(q)) {
      const [model, fp, owner, ms, immediate, cap] = params;
      const r = db.etats.get(cle(model, fp, cap ?? 'text_generation'));
      if (!r) return [];
      if (r.probe_lease_until != null && Date.parse(String(r.probe_lease_until)) > Date.now()) return [];
      if (!immediate && r.next_probe_at != null && Date.parse(String(r.next_probe_at)) > Date.now()) return [];
      r.probe_lease_owner = owner;
      r.probe_lease_until = new Date(Date.now() + Number(ms)).toISOString();
      r.probe_lease_generation = Number(r.probe_lease_generation ?? 0) + 1;
      return [{ probe_lease_until: r.probe_lease_until, probe_lease_generation: r.probe_lease_generation }];
    }
    if (/ON CONFLICT DO NOTHING/.test(q)) {
      const [model, fp, cap, endpoint, source, environment, apiVersion] = params;
      const k = cle(model, fp, cap);
      if (!db.etats.has(k)) {
        db.etats.set(k, {
          model, key_fingerprint: fp, capability: cap, endpoint, ok: null, error: null, source, checked_at: db.baseNow,
          check_status: null, observed_at: null, environment, api_version: apiVersion, state_version: 0, failure_count: 0,
          next_probe_at: null, probe_lease_generation: 0, probe_lease_owner: null, probe_lease_until: null,
          suspect_since: null, last_ok_at: null,
        });
      }
      return [];
    }

    // ── Écriture du verdict : `checked_at` est posé par l'horloge de la BASE (NOW()) ──
    if (/^\s*INSERT INTO ai_model_operational_status/.test(q)) {
      const [model, fp, ok, error, source, checkStatus, errorKind, suspectSince, healthy, httpStatus, providerCode,
        capability, endpoint, probeCallId, observedAt, confirme, failureCount, nextProbeAt, stateVersion,
        checkId, environment, apiVersion, lastResultStatus, lastResultKind] = params;
      const k = cle(model, fp, capability);
      const avant = db.etats.get(k);
      db.etats.set(k, {
        ...avant,
        model, key_fingerprint: fp, ok, error, source, check_status: checkStatus, error_kind: errorKind,
        suspect_since: suspectSince, last_ok_at: healthy ? db.baseNow : avant?.last_ok_at ?? null,
        http_status: httpStatus, provider_code: providerCode, capability, endpoint, probe_call_id: probeCallId,
        observed_at: observedAt, confirmed_at: confirme ? avant?.confirmed_at ?? db.baseNow : null,
        failure_count: failureCount, next_probe_at: nextProbeAt, state_version: stateVersion,
        // Instant de PUBLICATION du verdict, horloge de la base.
        checked_at: db.baseNow,
        check_id: checkId ?? null, environment: environment ?? null, api_version: apiVersion ?? null,
        last_result_status: lastResultStatus ?? null, last_result_kind: lastResultKind ?? null, last_result_at: db.baseNow,
        probe_lease_generation: avant?.probe_lease_generation ?? 0,
      });
      return [];
    }
    if (/^\s*INSERT INTO ai_model_operational_history/.test(q)) {
      const [model, fp, capability, , source, outcome, , , , , , checkStatus, okAfter, applied, , , observedAt, checkId, , ,
        discarded] = params;
      db.historique.push({ model, fp, capability, source, outcome, checkStatus, okAfter, applied, observedAt, checkId, discarded });
      return [];
    }
    if (/FROM ai_model_operational_history/.test(q) && /check_id = \$3/.test(q)) {
      return db.historique.filter((h) => h.model === params[0] && h.fp === params[1] && h.checkId === params[2]).slice(0, 1);
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

/** La requalification n'est pas le sujet ici : observée, jamais exécutée. */
vi.mock('../model-qualification.service', async (orig) => ({
  ...(await orig<typeof import('../model-qualification.service')>()),
  markRequalificationRequired: vi.fn(async () => 0),
  runTargetedRequalification: vi.fn(async () => ({ attempted: [], qualified: [], failed: [], inconclusive: [], skipped: [] })),
}));

const O = await import('../model-operational.service');
const A = await import('../operational-admission');
const C = await import('../probe-classification');
const { setProviderSecretResolver } = await import('../provider-secret');
const { keyFingerprint } = await import('../access-identity');

const CLE = 'AIzaSyD-c786-ordre-publication-01234';
const MODELE = 'gemini-3.6-flash';
const refus = () => C.classifyProbeFailure(
  new Error(`{"error":{"code":404,"message":"This model models/${MODELE} is no longer available to new users","status":"NOT_FOUND"}}`),
  { model: MODELE },
);
const etat = (model = MODELE) => db.etats.get(`${model}|${keyFingerprint(CLE)}|text_generation`);
const t = (ms: string) => new Date(`2026-11-16T10:00:00.${ms}Z`);

/**
 * Enregistre un contrôle en nommant les TROIS instants que la carte distingue :
 *   · `envoi`  — quand le contrôle est PARTI (horloge du worker) ;
 *   · `base`   — l'horloge de la BASE au moment de l'enregistrement : c'est elle
 *                qui posera `checked_at`, l'instant de PUBLICATION ;
 *   · `montre` — l'heure que le worker CROIT être (par défaut : celle de la base,
 *                donc aucun écart d'horloge).
 */
const controler = (p: { issue: 'ok' | 'refus'; envoi: string; base: string; montre?: string; checkId: string;
  source?: 'catalog_refresh' | 'recovery_check' | 'provider_test'; }) => {
  db.baseNow = t(p.base).toISOString();
  return O.recordOperationalCheck({
    model: MODELE, secret: CLE, source: p.source ?? 'catalog_refresh', checkId: p.checkId,
    outcome: p.issue === 'ok' ? { status: 'ok' } : refus(),
    observedAt: t(p.envoi), now: t(p.montre ?? p.base),
  });
};

beforeEach(() => {
  db.etats.clear();
  db.historique = [];
  db.version = 0;
  db.baseNow = '2026-11-16T10:00:00.000Z';
  db.schema = 'presente';
  db.codeDonnees = null;
  O.__resetOperationalSchemaState();
  O.__resetOperationalSnapshotMemory();
  A.__resetLastReliableVerdicts();
  A.__enableAdmissionDbForTests(false);
  setProviderSecretResolver(async () => CLE);
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

// ════════════════════════════════════════════════════════════════════════════
describe('C786-R1 — « instant égal » : concurrence jugée sur la PUBLICATION, pas sur le départ du précédent', () => {
  /**
   * Preuve de la régression : le refus est publié à 10:00:00.200 (horloge de la base) ; la sonde de
   * rétablissement part 50 ms PLUS TARD, donc après ce commit. Elle lui est strictement postérieure et doit
   * s'appliquer. L'ancien arbitrage ne regardait que l'écart entre les deux instants d'ENVOI (150 ms, sous la
   * fenêtre d'égalité) : il écartait la sonde (`equal_instant`) et le refus ne se levait jamais.
   */
  it('C786-R1-01 — sonde de rétablissement partie APRÈS la publication du refus : elle s’applique', async () => {
    await controler({ issue: 'refus', envoi: '100', base: '200', checkId: 'r1-01-refus' });
    expect(etat()).toMatchObject({ ok: false, check_status: 'failed_confirmed', checked_at: t('200').toISOString() });

    const retabli = await controler({ issue: 'ok', envoi: '250', base: '300', checkId: 'r1-01-retabli', source: 'recovery_check' });
    expect(retabli.stale).toBeUndefined();
    expect(retabli.ok).toBe(true);
    expect(etat()).toMatchObject({ ok: true, check_status: 'ok' });
    // Aucun résultat écarté : rien n'a été traité comme « concurrent ».
    expect(db.historique.filter((h) => h.applied === false)).toHaveLength(0);
  });

  it('C786-R1-01 bis — même à UNE milliseconde après la publication, le résultat s’applique', async () => {
    await controler({ issue: 'refus', envoi: '100', base: '100', checkId: 'r1-01b-refus' });
    const apres = await controler({ issue: 'ok', envoi: '101', base: '102', checkId: 'r1-01b-ok', source: 'recovery_check' });
    expect(apres.ok).toBe(true);
    expect(etat()).toMatchObject({ ok: true });
  });

  /**
   * La garantie centrale de la carte (B02) reste vraie MOT POUR MOT : « un refus confirmé n'est jamais levé
   * par un résultat qui ne lui est pas strictement postérieur », et « quel que soit l'ordre dans lequel deux
   * workers commitent, le verdict final est le même ». Ici, les DEUX contrôles partent avant la première
   * publication : ils étaient réellement en vol ensemble, et le rang de prudence tranche.
   */
  it('C786-R1-02 — deux contrôles réellement en vol ensemble : le refus tient, dans les deux ordres de commit', async () => {
    // Ordre 1 : le refus commite d'abord ; le succès, parti avant cette publication, est ÉCARTÉ.
    await controler({ issue: 'refus', envoi: '000', base: '300', checkId: 'r1-02-refus' });
    const succes = await controler({ issue: 'ok', envoi: '100', base: '400', checkId: 'r1-02-succes', source: 'provider_test' });
    expect(succes.stale).toBe(true);
    expect(etat()).toMatchObject({ ok: false, check_status: 'failed_confirmed' });
    expect(db.historique.at(-1)).toMatchObject({ applied: false, discarded: 'equal_instant', checkId: 'r1-02-succes' });

    // Ordre 2 (mêmes départs, commits inversés) : le succès commite d'abord, le refus s'applique ensuite —
    // VERDICT FINAL IDENTIQUE, indépendant de l'ordre d'arrivée.
    db.etats.clear();
    db.historique = [];
    await controler({ issue: 'ok', envoi: '100', base: '300', checkId: 'r1-02b-succes', source: 'provider_test' });
    expect(etat()).toMatchObject({ ok: true });
    await controler({ issue: 'refus', envoi: '000', base: '400', checkId: 'r1-02b-refus' });
    expect(etat()).toMatchObject({ ok: false, check_status: 'failed_confirmed' });
  });

  it('C786-R1-03 — un résultat réellement plus ancien reste écarté « hors ordre »', async () => {
    await controler({ issue: 'refus', envoi: '000', base: '100', checkId: 'r1-03-refus' });
    // Envoyé 2 s avant celui qui fonde l'état, reçu après : écarté, quelle que soit la publication.
    const vieux = await O.recordOperationalCheck({
      model: MODELE, secret: CLE, source: 'provider_test', checkId: 'r1-03-vieux', outcome: { status: 'ok' },
      observedAt: new Date(t('000').getTime() - 2_000), now: t('500'),
    });
    expect(vieux.stale).toBe(true);
    expect(etat()).toMatchObject({ ok: false });
    expect(db.historique.at(-1)).toMatchObject({ applied: false, discarded: 'out_of_order' });
  });

  it('C786-R1-04 — `checked_at` absent (ligne d’un schéma antérieur) : arbitrage PRUDENT conservé', async () => {
    await controler({ issue: 'refus', envoi: '100', base: '200', checkId: 'r1-04-refus' });
    // La publication n'est pas datée : impossible de dire si le nouveau résultat était en vol — le refus tient.
    const ligne = etat()!;
    ligne.checked_at = null;
    const succes = await controler({ issue: 'ok', envoi: '150', base: '300', checkId: 'r1-04-ok', source: 'provider_test' });
    expect(succes.stale).toBe(true);
    expect(etat()).toMatchObject({ ok: false });
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('C786-R2 — « migration absente » n’est conclu que par `information_schema`', () => {
  /** Transaction de l'appelant (promotion, activation) : sa propre connexion, qui répond. */
  const txOK = { unsafe: async () => [] };

  /**
   * Preuve de la régression : une lecture de données en `42P01` (table momentanément absente — bascule de
   * schéma, renommage pendant une recette) posait « migration 1692 non appliquée » dans un drapeau de
   * processus JAMAIS effacé. Tout le reste du processus voyait ensuite un schéma réputé incomplet, et le
   * contrôle final rendait `unverifiable` sur une base parfaitement migrée.
   */
  it('C786-R2-01 — lecture de données impossible : aucune migration déclarée absente, contrôle final intact', async () => {
    A.__enableAdmissionDbForTests(true);
    db.codeDonnees = '42P01';
    const v = await O.readPublishedVerdict(MODELE, CLE);
    expect(v.reliable).toBe(false);
    // La lecture est NON FIABLE — et c'est tout ce qu'elle démontre.
    expect(O.operationalSchemaState().degradedReason).toBeNull();
    expect(O.operationalSchemaState().unreadableReason).toMatch(/illisible/);

    // La base répond de nouveau : le contrôle final est opposable, et ne refuse plus pour un schéma imaginaire.
    db.codeDonnees = null;
    expect(await O.operationalRefusalInTx(txOK, MODELE, CLE)).toEqual({ kind: 'clear' });
    // …et il refuse toujours ce qu'il doit refuser : un refus réellement publié.
    await controler({ issue: 'refus', envoi: '100', base: '100', checkId: 'r2-01-refus' });
    const verdict = await O.operationalRefusalInTx(
      { unsafe: async (q: string) => (/SAVEPOINT/.test(q) ? [] : [etat()!]) }, MODELE, CLE,
    );
    expect(verdict).toMatchObject({ kind: 'refused' });
  });

  /** A03 reste ENTIÈRE : une migration critique RÉELLEMENT absente bloque, en nommant la lacune. */
  it('C786-R2-02 — migration réellement absente : promotion et activation bloquées, lacune nommée', async () => {
    A.__enableAdmissionDbForTests(true);
    db.schema = 'absente';
    const verdict = await O.operationalRefusalInTx(txOK, MODELE, CLE);
    expect(verdict).toMatchObject({ kind: 'unverifiable' });
    if (verdict.kind === 'unverifiable') expect(verdict.detail).toMatch(/1815|1816/);
    expect(O.operationalSchemaState()).toMatchObject({ complete: false });
  });

  /**
   * Preuve de la seconde régression de la même famille : `catch { colonnes1815 = false }` gravait un négatif
   * sur une erreur passagère. Une fois posé, la réservation de sonde rendait `unreadable` et les colonnes
   * étendues étaient perdues — DÉFINITIVEMENT, sur un schéma pourtant complet.
   */
  it('C786-R2-03 — sonde de schéma en échec : prudence pour cet appel, AUCUN négatif mis en cache', async () => {
    db.schema = 'panne';
    expect(await O.acquireProbeLease({ model: MODELE, secret: CLE, owner: 'instance-A' }))
      .toMatchObject({ acquired: false, reason: 'unreadable' });
    // Rien n'est conclu : ni « migration absente », ni un négatif en cache.
    expect(O.operationalSchemaState()).toMatchObject({ complete: null, degradedReason: null });

    // La sonde répond de nouveau : la question est REPOSÉE, et tout refonctionne.
    db.schema = 'presente';
    const r = await controler({ issue: 'refus', envoi: '100', base: '100', checkId: 'r2-03-refus' });
    expect(r.persistence).toBe('published');
    // Les colonnes étendues sont de nouveau écrites (identifiant de contrôle conservé).
    expect(etat()).toMatchObject({ check_id: 'r2-03-refus' });
    expect(O.operationalSchemaState()).toMatchObject({ complete: true, degradedReason: null });
    // …et la réservation est de nouveau possible (échéance atteinte).
    etat()!.next_probe_at = null;
    expect(await O.acquireProbeLease({ model: MODELE, secret: CLE, owner: 'instance-A' })).toMatchObject({ acquired: true });
  });
});
