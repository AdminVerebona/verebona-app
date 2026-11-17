/**
 * L115I — carte Trello #786 « IA — Corriger les 8 écarts du lot 114Q », sur PostgreSQL réel (migrations 1692 et
 * 1815). Fournisseur SIMULÉ : aucun réseau, aucun appel IA réel. Partie unitaire :
 * `services/ai/provider/__tests__/l115i-admission-disponibilite.test.ts` ; routage :
 * `services/ai/gateway/__tests__/l115i-admission-routage.test.ts`.
 *
 *   E01 · migration 1815 : colonnes, index d'idempotence, rejouable sans effet ;
 *   E02 · R01 — cache chaud contenant un refus puis état partagé ILLISIBLE : l'interdiction tient, zéro envoi
 *         autorisé, aucun modèle réactivé (reproduction avant / après) ;
 *   E03 · R03 — DEUX instances : verdict publié par l'une, opposable à l'autre AU PROCHAIN ENVOI, sans attendre
 *         aucun délai de tolérance ; verdicts simultanés : un seul état cohérent, historique complet ;
 *   E04 · R08 — idempotence sur la base réelle : rejouer un contrôle ne crée aucune ligne, ne change aucun
 *         compteur ni échéance (index unique) ;
 *   E05 · R07 — ordre : résultat ancien reçu tard, instants égaux, rotation de clé en vol ;
 *   E06 · R13 — réservation partagée des recontrôles : deux instances à l'échéance = UNE sonde ; bail expiré
 *         repris ; échéance non atteinte refusée ; geste manuel dédupliqué ;
 *   E07 · R06 / R11 — qualification refusée sur une route indisponible ; rétablissement : qualifications
 *         marquées à requalifier, aucune activation, aucune configuration modifiée ;
 *   E08 · R14 — décomptes fidèles : refus + dernier contrôle non concluant reste compté indisponible, et une
 *         lecture illisible ne vaut aucun décompte ni aucune résolution d'alerte ;
 *   E09 · R02 / R10 — contrôle final de disponibilité dans une transaction : refus explicite ;
 *   E10 · R09 — migration 1816 : la CAPACITÉ est dans la clé primaire ; un refus par capacité n'affecte pas les
 *         autres, le refus de la capacité de base est opposable à toutes, le PROJET reste vide ;
 *   E11 · R11 — campagne ciblée relancée AU RÉTABLISSEMENT : marque posée puis effacée par le résultat, bornée,
 *         aucune activation, aucune configuration modifiée ;
 *   E12 · R10 — réactivation d'une configuration HISTORIQUE et IMPORT : contrôle final de disponibilité refusé
 *         (refus confirmé comme contrôle impossible), et les deux gestes partagent la même façade.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scenario } from '../scenario';

const CLE = 'AIzaE2E-l115i-cle-active-00000000';
const AUTRE_CLE = 'AIzaE2E-l115i-autre-cle-11111111';
const REFUSE = 'gemini-3.6-flash';
const SAIN = 'gemini-3.1-flash-lite';
const refus404 = (model: string) => new Error(
  `got status: 404. {"error":{"code":404,"message":"This model models/${model} is no longer available to new users","status":"NOT_FOUND"}}`);

scenario('L115I', 'IA — admission des envois : aucune requête ordinaire vers une route confirmée indisponible, sur toutes les instances', ({ sql }) => {
  const O = () => import('@/services/ai/provider/model-operational.service');
  const A = () => import('@/services/ai/provider/operational-admission');
  const F = () => import('@/services/ai/gateway/fallback-context');
  const C = () => import('@/services/ai/provider/probe-classification');
  const empreinte = async (cle = CLE) => (await O()).keyFingerprint(cle);

  beforeAll(async () => {
    const { setProviderSecretResolver } = await import('@/services/ai/provider/provider-secret');
    setProviderSecretResolver(async () => CLE);
    for (const t of ['ai_model_operational_status', 'ai_model_operational_history']) await sql.unsafe(`DELETE FROM ${t}`);
    (await F()).__enableFallbackContextDbForTests(true);
    (await A()).__enableAdmissionDbForTests(true);
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterAll(async () => {
    (await F()).__enableFallbackContextDbForTests(false);
    (await A()).__enableAdmissionDbForTests(false);
    (await import('@/services/ai/provider/provider-secret')).setProviderSecretResolver(null);
    await sql`DELETE FROM ai_model_operational_status`;
    await sql`DELETE FROM ai_model_operational_history`;
    vi.restoreAllMocks();
  });

  /** Écrit un contrôle comme le ferait une instance quelconque. */
  const controler = async (p: {
    model: string; cle?: string; echec?: boolean; checkId?: string; observedAt?: Date; now?: Date; source?: 'catalog_refresh' | 'recovery_check' | 'provider_test' | 'gateway_call';
    accessFingerprint?: string;
  }) => {
    const { recordOperationalCheck } = await O();
    const { classifyProbeFailure } = await C();
    const cle = p.cle ?? CLE;
    return recordOperationalCheck({
      model: p.model, secret: cle, source: p.source ?? 'catalog_refresh',
      outcome: p.echec === false ? { status: 'ok' } : classifyProbeFailure(refus404(p.model), { model: p.model }),
      ...(p.checkId ? { checkId: p.checkId } : {}),
      ...(p.observedAt ? { observedAt: p.observedAt } : {}),
      ...(p.now ? { now: p.now } : {}),
      ...(p.accessFingerprint ? { accessFingerprint: p.accessFingerprint } : {}),
    });
  };
  const etat = async (model: string, cle = CLE) => (await sql<Array<Record<string, unknown>>>`
    SELECT ok, check_status, error, failure_count, next_probe_at, state_version, confirmed_at, check_id, environment,
           api_version, last_result_status, last_result_kind, probe_lease_owner, probe_lease_until, observed_at
      FROM ai_model_operational_status WHERE model = ${model} AND key_fingerprint = ${await empreinte(cle)}`)[0];
  const histo = async (model: string) => sql<Array<Record<string, unknown>>>`
    SELECT outcome, check_status, applied, check_id, discarded_reason, observed_at FROM ai_model_operational_history
     WHERE model = ${model} ORDER BY id`;
  /** Rend la table de l'état illisible (panne simulée par un vrai échec SQL), puis la rétablit. */
  const avecEtatIllisible = async <T>(fn: () => Promise<T>): Promise<T> => {
    await sql`ALTER TABLE ai_model_operational_status RENAME TO ai_model_operational_status_l115i`;
    try {
      return await fn();
    } finally {
      await sql`ALTER TABLE ai_model_operational_status_l115i RENAME TO ai_model_operational_status`;
    }
  };

  it('L115I-E01 — migration 1815 : colonnes, index d’idempotence ; rejouable sans effet', async () => {
    const texte = await readFile(join(process.cwd(), 'src/db/migrations/1815_l115i_disponibilite_ia_admission.sql'), 'utf8');
    await sql.unsafe(texte);
    await sql.unsafe(texte); // rejouable
    const cols = (await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'ai_model_operational_status'`).map((c) => c.column_name);
    for (const c of ['environment', 'api_version', 'check_id', 'last_result_status', 'last_result_kind', 'last_result_at',
      'probe_lease_owner', 'probe_lease_until', 'probe_lease_at']) expect(cols, c).toContain(c);
    const hcols = (await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'ai_model_operational_history'`).map((c) => c.column_name);
    for (const c of ['check_id', 'environment', 'api_version', 'discarded_reason']) expect(hcols, c).toContain(c);
    // Index UNIQUE partiel : un identifiant de contrôle n'est écrit qu'une fois par route et par accès.
    const idx = (await sql<{ indexname: string }[]>`SELECT indexname FROM pg_indexes WHERE tablename = 'ai_model_operational_history'`).map((i) => i.indexname);
    expect(idx).toContain('ai_model_operational_history_check_uidx');
    // Les lignes SANS identifiant restent toutes conservées (index partiel).
    for (let i = 0; i < 2; i++) {
      await sql`INSERT INTO ai_model_operational_history (provider, model, key_fingerprint, source, outcome, observed_at)
                VALUES ('gemini', 'e2e-sans-id', 'fp', 'catalog_refresh', 'ok', now())`;
    }
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ai_model_operational_history WHERE model = 'e2e-sans-id'`;
    expect(n).toBe(2);
    await sql`DELETE FROM ai_model_operational_history WHERE model = 'e2e-sans-id'`;
  });

  it('L115I-E02 (R01) — cache chaud puis état partagé ILLISIBLE : l’interdiction tient, zéro envoi autorisé', async () => {
    const { guardSend, admissionMetrics } = await A();
    // AVANT : la route est saine, l'envoi est admis.
    await controler({ model: REFUSE, echec: false, checkId: 'e02-sain' });
    expect((await guardSend({ model: REFUSE, point: 'gateway_send' })).admitted).toBe(true);

    // Verdict publié : refus confirmé, lu par la garde.
    await controler({ model: REFUSE, checkId: 'e02-refus' });
    expect(await etat(REFUSE)).toMatchObject({ ok: false, check_status: 'failed_confirmed' });
    const refuse = await guardSend({ model: REFUSE, point: 'gateway_send' });
    expect(refuse.admitted).toBe(false);
    if (!refuse.admitted) expect(refuse.code).toBe('MODEL_UNAVAILABLE');
    // Cache CHAUD du lecteur de routage : il contient l'exclusion.
    const { fallbackContext, invalidateFallbackStatusCache } = await F();
    invalidateFallbackStatusCache();
    expect([...(await fallbackContext().knownUnavailable()).keys()]).toContain(REFUSE);

    // APRÈS : état partagé illisible (panne réelle) — l'interdiction est CONSERVÉE, rien n'est réactivé.
    await avecEtatIllisible(async () => {
      const a = await guardSend({ model: REFUSE, point: 'gateway_send' });
      expect(a.admitted).toBe(false);
      if (!a.admitted) expect(a.code).toBe('MODEL_UNAVAILABLE');
      expect(a.verdict.fromLastReliable).toBe(true);
      // Le lecteur du routage ne vide pas non plus ses exclusions.
      // Même après une invalidation de cache (sonde de rétablissement, changement de verdict) pendant la
      // panne : le dernier état FIABLE reste appliqué — aucune exclusion n'est perdue (#786, E01).
      invalidateFallbackStatusCache();
      const lu = [...(await fallbackContext().knownUnavailable()).keys()];
      expect(lu).toContain(REFUSE);
      // Et une route lue fiablement comme saine reste admise (l'inconnu n'exclut rien).
      expect((await guardSend({ model: SAIN, point: 'gateway_send' })).admitted).toBe(true);
    });
    expect(admissionMetrics().servedFromLastReliable).toBeGreaterThanOrEqual(1);
  });

  it('L115I-E03 (R03) — deux instances : verdict publié par l’une, opposable à l’autre au prochain envoi, sans délai', async () => {
    const { guardSend } = await A();
    await sql`DELETE FROM ai_model_operational_status`;
    await controler({ model: SAIN, echec: false, checkId: 'e03-sain' });
    expect((await guardSend({ model: SAIN, point: 'gateway_send' })).admitted).toBe(true);

    // INSTANCE B (autre processus) : écriture directe du verdict, comme le ferait sa transaction.
    await sql`UPDATE ai_model_operational_status
                 SET ok = FALSE, check_status = 'failed_confirmed', error = 'HTTP 404 NOT_FOUND', checked_at = now(), observed_at = now()
               WHERE model = ${SAIN} AND key_fingerprint = ${await empreinte()}`;
    // INSTANCE A : AUCUNE invalidation de cache, AUCUNE attente — l'envoi suivant est déjà refusé.
    const a = await guardSend({ model: SAIN, point: 'gateway_send' });
    expect(a.admitted).toBe(false);

    // Verdicts SIMULTANÉS des deux instances sur la même route : un seul état cohérent, historique complet.
    await sql`DELETE FROM ai_model_operational_status`;
    await sql`DELETE FROM ai_model_operational_history`;
    const quand = new Date();
    const [r1, r2] = await Promise.all([
      controler({ model: REFUSE, checkId: 'e03-a', observedAt: quand, source: 'catalog_refresh' }),
      controler({ model: REFUSE, checkId: 'e03-b', observedAt: new Date(quand.getTime() + 1_000), source: 'provider_test' }),
    ]);
    expect([r1.ok, r2.ok]).toEqual([false, false]);
    const e = await etat(REFUSE);
    expect(e).toMatchObject({ ok: false, check_status: 'failed_confirmed' });
    const lignes = await histo(REFUSE);
    expect(lignes.map((l) => l.check_id).sort()).toEqual(['e03-a', 'e03-b']);
    expect(lignes.filter((l) => l.applied === true).length).toBeGreaterThanOrEqual(1);
    // L'état retenu est celui du contrôle le PLUS RÉCENT (par instant d'envoi).
    expect(new Date(String(e.observed_at)).getTime()).toBe(quand.getTime() + 1_000);
  });

  it('L115I-E04 (R08) — rejeu d’un contrôle : aucune ligne, aucun compteur, aucune échéance changés', async () => {
    await sql`DELETE FROM ai_model_operational_status`;
    await sql`DELETE FROM ai_model_operational_history`;
    const t = new Date('2026-11-16T06:00:00.000Z');
    const un = await controler({ model: REFUSE, checkId: 'e04-1', observedAt: t, now: t });
    const avant = await etat(REFUSE);
    const nAvant = (await histo(REFUSE)).length;
    // Même contrôle rejoué deux fois (reprise après erreur de commit, réception en double).
    const deux = await controler({ model: REFUSE, checkId: 'e04-1', observedAt: t, now: new Date('2026-11-16T07:30:00.000Z') });
    const trois = await controler({ model: REFUSE, checkId: 'e04-1', observedAt: t, now: new Date('2026-11-16T09:00:00.000Z') });
    expect(deux.changed).toBe(false);
    expect(trois.changed).toBe(false);
    expect(await etat(REFUSE)).toMatchObject({
      failure_count: avant.failure_count, next_probe_at: avant.next_probe_at, state_version: avant.state_version,
    });
    expect((await histo(REFUSE)).length).toBe(nAvant);
    expect(un.nextProbeAt).toBe(deux.nextProbeAt);
    // Un recontrôle NOUVEAU qui échoue de nouveau garde son effet : échéance doublée.
    const quatre = await controler({ model: REFUSE, checkId: 'e04-2', source: 'recovery_check', now: new Date('2026-11-16T10:00:00.000Z') });
    expect(quatre.nextProbeAt).toBe('2026-11-16T12:00:00.000Z');
    expect(await etat(REFUSE)).toMatchObject({ failure_count: 2 });
  });

  it('L115I-E05 (R07) — ordre : résultat ancien reçu tard, instants égaux, rotation de clé en vol', async () => {
    await sql`DELETE FROM ai_model_operational_status`;
    await sql`DELETE FROM ai_model_operational_history`;
    const t = new Date('2026-11-16T09:00:00.000Z');
    await controler({ model: REFUSE, checkId: 'e05-refus', observedAt: t });
    // Résultat ENVOYÉ avant le refus, reçu après : écarté, historisé, le refus tient.
    const ancien = await controler({ model: REFUSE, echec: false, checkId: 'e05-ancien', observedAt: new Date(t.getTime() - 60_000), source: 'provider_test' });
    expect(ancien.stale).toBe(true);
    expect(await etat(REFUSE)).toMatchObject({ ok: false });
    // Instants ÉGAUX : un succès ne lève pas un refus confirmé.
    const egal = await controler({ model: REFUSE, echec: false, checkId: 'e05-egal', observedAt: t, source: 'provider_test' });
    expect(egal.stale).toBe(true);
    expect(await etat(REFUSE)).toMatchObject({ ok: false });
    const lignes = await histo(REFUSE);
    expect(lignes.filter((l) => l.applied === false).map((l) => l.discarded_reason).sort()).toEqual(['equal_instant', 'out_of_order']);

    // Rotation de clé EN VOL : le résultat est attribué à l'accès qui a envoyé, jamais à la nouvelle clé.
    await controler({ model: REFUSE, cle: AUTRE_CLE, accessFingerprint: await empreinte(CLE), source: 'gateway_call', checkId: 'e05-rot', observedAt: new Date(t.getTime() + 60_000) });
    expect(await etat(REFUSE, CLE)).toMatchObject({ ok: false });
    expect(await etat(REFUSE, AUTRE_CLE)).toBeUndefined();
    // Un succès sur l'accès B ne réhabilite pas A.
    await controler({ model: REFUSE, cle: AUTRE_CLE, echec: false, checkId: 'e05-b', source: 'provider_test' });
    expect(await etat(REFUSE, CLE)).toMatchObject({ ok: false });
    expect(await etat(REFUSE, AUTRE_CLE)).toMatchObject({ ok: true });
  });

  it('L115I-E06 (R13) — réservation partagée : deux instances à l’échéance = UNE sonde ; bail expiré repris', async () => {
    const { acquireProbeLease, releaseProbeLease } = await O();
    await sql`DELETE FROM ai_model_operational_status`;
    await controler({ model: REFUSE, checkId: 'e06-refus' });
    // Échéance NON atteinte (1 h après le refus) : aucune sonde (ni ici, ni ailleurs).
    expect(await acquireProbeLease({ model: REFUSE, secret: CLE, owner: 'instance-A' })).toMatchObject({ acquired: false, reason: 'not_due' });
    // Échéance atteinte : deux instances demandent EN MÊME TEMPS — une seule obtient la réservation.
    await sql`UPDATE ai_model_operational_status SET next_probe_at = now() - interval '1 minute'
               WHERE model = ${REFUSE} AND key_fingerprint = ${await empreinte()}`;
    const demandes = await Promise.all([
      acquireProbeLease({ model: REFUSE, secret: CLE, owner: 'instance-A', leaseMs: 60_000 }),
      acquireProbeLease({ model: REFUSE, secret: CLE, owner: 'instance-B', leaseMs: 60_000 }),
      acquireProbeLease({ model: REFUSE, secret: CLE, owner: 'instance-C', leaseMs: 60_000 }),
    ]);
    expect(demandes.filter((d) => d.acquired)).toHaveLength(1);
    expect(demandes.filter((d) => !d.acquired).every((d) => d.reason === 'held_elsewhere')).toBe(true);
    // Geste manuel : l'échéance est ignorée, mais la réservation reste exigée (double clic dédupliqué).
    expect(await acquireProbeLease({ model: REFUSE, secret: CLE, owner: 'bo-admin', immediate: true })).toMatchObject({ acquired: false, reason: 'held_elsewhere' });
    // Bail EXPIRÉ (arrêt brutal du détenteur) : une autre instance reprend.
    await sql`UPDATE ai_model_operational_status SET probe_lease_until = now() - interval '1 second'
               WHERE model = ${REFUSE} AND key_fingerprint = ${await empreinte()}`;
    expect(await acquireProbeLease({ model: REFUSE, secret: CLE, owner: 'instance-D', leaseMs: 60_000 })).toMatchObject({ acquired: true });
    // Libération : seul le détenteur courant peut libérer.
    await releaseProbeLease({ model: REFUSE, secret: CLE, owner: 'instance-A' });
    expect(await etat(REFUSE)).toMatchObject({ probe_lease_owner: 'instance-D' });
    await releaseProbeLease({ model: REFUSE, secret: CLE, owner: 'instance-D' });
    expect(await etat(REFUSE)).toMatchObject({ probe_lease_owner: null });
    // Route inconnue : rien à dédupliquer, la sonde part.
    expect(await acquireProbeLease({ model: 'e2e-inconnu-l115i', secret: CLE, owner: 'instance-A' })).toMatchObject({ acquired: true, reason: 'no_state' });
    // État illisible : AUCUNE sonde (pas de rafale pendant une panne).
    await avecEtatIllisible(async () => {
      expect(await acquireProbeLease({ model: REFUSE, secret: CLE, owner: 'instance-A' })).toMatchObject({ acquired: false, reason: 'unreadable' });
    });
  });

  it('L115I-E07 (R06, R11) — qualification refusée sur une route indisponible ; rétablissement : à requalifier, aucune activation', async () => {
    const { assertSendAdmissible, guardSend } = await A();
    const { markRequalificationRequired, loadQualifications, needsQualification } = await import('@/services/ai/provider/model-qualification.service');
    await sql`DELETE FROM ai_model_operational_status`;
    await controler({ model: REFUSE, checkId: 'e07-refus' });
    // Une épreuve de qualification n'est PAS une sonde de récupération : elle ne part pas.
    await expect(assertSendAdmissible({ model: REFUSE, point: 'qualification_trial' })).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' });
    // Les sondes explicites de disponibilité et de rétablissement, elles, atteignent la route.
    for (const point of ['availability_probe', 'recovery_probe'] as const) {
      expect((await guardSend({ model: REFUSE, point })).admitted, point).toBe(true);
    }

    // Qualification existante du modèle, puis RÉTABLISSEMENT prouvé par une sonde réussie.
    await sql`DELETE FROM ai_model_qualification WHERE model = ${REFUSE}`;
    await sql`INSERT INTO ai_model_qualification (provider, model, key_fingerprint, qualification_version, generate_ok, qualified_at)
              VALUES ('gemini', ${REFUSE}, ${await empreinte()}, 'v-e2e', TRUE, now() - interval '2 days')`;
    expect(needsQualification((await loadQualifications(CLE)).get(REFUSE), new Date())).toBe(true); // version différente
    const marquees = await markRequalificationRequired([REFUSE], CLE, 'rétabli (e2e l115i)');
    expect(marquees).toBe(1);
    const q = (await loadQualifications(CLE)).get(REFUSE);
    expect(q).toMatchObject({ requalificationReason: 'rétabli (e2e l115i)' });
    expect(q?.requalificationRequiredAt).toEqual(expect.any(String));
    // Idempotent : une marque déjà posée n'est pas réécrite (campagne dédupliquée, reprenable).
    expect(await markRequalificationRequired([REFUSE], CLE, 'rétabli (e2e l115i)')).toBe(0);
    // Le résultat de qualification lui-même n'est PAS effacé (preuves conservées) et rien n'est activé.
    expect(q?.generate).toBe(true);
    await sql`DELETE FROM ai_model_qualification WHERE model = ${REFUSE}`;

    // Une sonde réussie lève le blocage de disponibilité (et seulement lui).
    await controler({ model: REFUSE, echec: false, checkId: 'e07-retabli', source: 'recovery_check' });
    expect(await etat(REFUSE)).toMatchObject({ ok: true, check_status: 'ok' });
    expect((await guardSend({ model: REFUSE, point: 'gateway_send' })).admitted).toBe(true);
  });

  it('L115I-E08 (R14) — décomptes fidèles : refus + dernier contrôle non concluant reste indisponible ; lecture illisible = aucun décompte', async () => {
    const { loadOperationalDiagnostics, loadOperationalSnapshot } = await O();
    const { operationalWatchOf, resolveRecoveredModelAlerts } = await import('@/services/ai/provider/active-model-anomalies');
    await sql`DELETE FROM ai_model_operational_status`;
    await controler({ model: REFUSE, checkId: 'e08-refus' });
    await controler({ model: SAIN, echec: false, checkId: 'e08-sain' });
    // Recontrôle NON CONCLUANT de la route refusée : l'état retenu reste « indisponible ».
    const { recordOperationalCheck } = await O();
    await recordOperationalCheck({
      model: REFUSE, secret: CLE, source: 'recovery_check', checkId: 'e08-inconclusive',
      outcome: { status: 'inconclusive', kind: 'quota', error: 'HTTP 429 RESOURCE_EXHAUSTED — Quota exceeded' },
    });
    const e = await etat(REFUSE);
    expect(e).toMatchObject({ ok: false, check_status: 'inconclusive', last_result_status: 'inconclusive', last_result_kind: 'quota' });
    const veille = operationalWatchOf(await loadOperationalDiagnostics(CLE));
    expect(veille.counts).toMatchObject({ controlled: 2, ok: 1, failedConfirmed: 1, unavailableWithInconclusiveLastCheck: 1 });

    // Lecture illisible : aucun décompte opposable, AUCUNE alerte résolue (une erreur de base ≠ rétablissement).
    await avecEtatIllisible(async () => {
      const snap = await loadOperationalSnapshot(CLE);
      expect(snap.reliable).toBe(false);
      const v = operationalWatchOf(new Map(), false);
      expect(v.reliable).toBe(false);
      expect(v.summary).toMatch(/illisible/);
      expect(await resolveRecoveredModelAlerts([], false)).toBe(0);
    });
  });

  it('L115I-E09 (R02, R10) — contrôle final de disponibilité dans une transaction', async () => {
    const { operationalRefusalInTx } = await O();
    await sql`DELETE FROM ai_model_operational_status`;
    // La transaction de l'appelant (promotion, activation) : la lecture se fait sur SA connexion.
    const dans = <T>(fn: (tx: { unsafe: (q: string, p?: never[]) => Promise<unknown> }) => Promise<T>) =>
      sql.begin(async (t) => fn({ unsafe: (q, p) => t.unsafe(q, (p ?? []) as never[]) as unknown as Promise<unknown> }));
    expect(await dans((tx) => operationalRefusalInTx(tx, REFUSE, CLE))).toEqual({ kind: 'clear' });
    await controler({ model: REFUSE, checkId: 'e09-refus' });
    expect(await dans((tx) => operationalRefusalInTx(tx, REFUSE, CLE))).toMatchObject({
      kind: 'refused', error: expect.stringContaining('no longer available to new users'),
    });
    // Un autre accès n'hérite de rien.
    expect(await dans((tx) => operationalRefusalInTx(tx, REFUSE, AUTRE_CLE))).toEqual({ kind: 'clear' });
    // Aucun secret n'apparaît dans l'état ni dans l'historique.
    const tout = JSON.stringify(await sql`SELECT * FROM ai_model_operational_status`) + JSON.stringify(await histo(REFUSE));
    expect(tout).not.toContain(CLE);
    expect(tout).not.toContain(AUTRE_CLE);
  });

  it('L115I-E10 (R09) — migration 1816 : un verdict PAR CAPACITÉ, portée exacte, projet jamais inventé', async () => {
    const texte = await readFile(join(process.cwd(), 'src/db/migrations/1816_l115i_disponibilite_par_capacite.sql'), 'utf8');
    await sql.unsafe(texte);
    await sql.unsafe(texte); // rejouable sans effet
    // La CAPACITÉ fait partie de la clé primaire.
    const [{ cols }] = await sql<{ cols: string[] }[]>`
      SELECT array_agg(a.attname ORDER BY a.attname) AS cols
        FROM pg_constraint c JOIN unnest(c.conkey) k ON TRUE
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k
       WHERE c.conrelid = 'ai_model_operational_status'::regclass AND c.contype = 'p'`;
    expect(cols).toEqual(['capability', 'key_fingerprint', 'model', 'provider']);
    for (const t of ['ai_model_operational_status', 'ai_model_operational_history']) {
      const c = (await sql<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns WHERE table_name = ${t}`).map((x) => x.column_name);
      expect(c, t).toContain('provider_project');
    }

    await sql`DELETE FROM ai_model_operational_status`;
    const { recordOperationalCheck, readPublishedVerdict, loadOperationalDiagnostics, operationalProjectDimension } = await O();
    const { guardSend } = await A();
    // Refus propre à une CAPACITÉ (paramètre refusé) : les autres capacités restent admises.
    await recordOperationalCheck({
      model: REFUSE, secret: CLE, source: 'qualification', checkId: 'e10-capacite', capability: 'structured_output',
      outcome: { status: 'failed', kind: 'probe_parameter_rejected', error: 'HTTP 400 INVALID_ARGUMENT — paramètre refusé', definitive: true },
    });
    const lignes = await sql<Array<{ capability: string; ok: boolean | null; provider_project: string | null }>>`
      SELECT capability, ok, provider_project FROM ai_model_operational_status WHERE model = ${REFUSE}`;
    expect(lignes).toHaveLength(1);
    expect(lignes[0]).toMatchObject({ capability: 'structured_output', ok: false, provider_project: null });
    expect((await readPublishedVerdict(REFUSE, CLE, 'structured_output')).state).toBe('unavailable');
    expect((await readPublishedVerdict(REFUSE, CLE, 'text_generation')).state).toBe('unknown');
    expect((await guardSend({ model: REFUSE, point: 'gateway_send', capability: 'multimodal' })).admitted).toBe(true);
    expect((await guardSend({ model: REFUSE, point: 'gateway_send', capability: 'structured_output' })).admitted).toBe(false);

    // Refus de la capacité de BASE : opposable à TOUTES (prérequis), et la portée est dite.
    await controler({ model: REFUSE, checkId: 'e10-base' });
    expect(await readPublishedVerdict(REFUSE, CLE, 'multimodal')).toMatchObject({ state: 'unavailable', scopeExtendedFromBase: true });
    expect((await guardSend({ model: REFUSE, point: 'gateway_send', capability: 'multimodal' })).admitted).toBe(false);
    // Un succès sur la base ne lève PAS le refus de l'autre capacité.
    await controler({ model: REFUSE, echec: false, checkId: 'e10-base-ok' });
    expect((await readPublishedVerdict(REFUSE, CLE, 'text_generation')).state).toBe('healthy');
    expect((await readPublishedVerdict(REFUSE, CLE, 'structured_output')).state).toBe('unavailable');
    const diag = (await loadOperationalDiagnostics(CLE)).get(REFUSE);
    expect(diag?.refusedCapabilities).toEqual(['structured_output']);
    // Dimension « projet » : vide et explicitée (jamais devinée, jamais fusionnée avec l'accès).
    expect(operationalProjectDimension().known).toBe(false);
    expect(diag?.providerProject ?? null).toBeNull();
    // La réservation de recontrôle porte sur la ligne de la capacité de base, jamais sur les autres.
    const { acquireProbeLease, releaseProbeLease } = await O();
    expect(await acquireProbeLease({ model: REFUSE, secret: CLE, owner: 'instance-E10' })).toMatchObject({ acquired: true });
    const bails = await sql<Array<{ capability: string; probe_lease_owner: string | null }>>`
      SELECT capability, probe_lease_owner FROM ai_model_operational_status WHERE model = ${REFUSE} ORDER BY capability`;
    expect(bails.filter((b) => b.probe_lease_owner !== null).map((b) => b.capability)).toEqual(['text_generation']);
    await releaseProbeLease({ model: REFUSE, secret: CLE, owner: 'instance-E10' });
  });

  it('L115I-E11 (R11) — rétablissement : campagne ciblée immédiate, bornée, aucune activation', async () => {
    const { runTargetedRequalification, loadQualifications, markRequalificationRequired } = await import('@/services/ai/provider/model-qualification.service');
    await sql`DELETE FROM ai_model_operational_status`;
    await sql`DELETE FROM ai_model_qualification WHERE model IN (${REFUSE}, ${SAIN})`;
    // Modèle rétabli, qualification ANCIENNE marquée à requalifier (ce que fait la sonde de rétablissement).
    await controler({ model: REFUSE, echec: false, checkId: 'e11-retabli', source: 'recovery_check' });
    await sql`INSERT INTO ai_model_qualification (provider, model, key_fingerprint, qualification_version, generate_ok, structured_ok, qualified_at)
              VALUES ('gemini', ${REFUSE}, ${await empreinte()}, 'qualif-v2', TRUE, TRUE, now() - interval '3 days')`;
    expect(await markRequalificationRequired([REFUSE], CLE, 'rétabli (e2e l115i E11)')).toBe(1);

    const avant = await sql<Array<Record<string, unknown>>>`SELECT * FROM ai_config_versions WHERE status = 'ACTIVE'`;
    const appels: string[] = [];
    const bilan = await runTargetedRequalification([REFUSE], CLE, {
      max: 1, call: async (i) => { appels.push(i.model); return { rawText: '{"ok":true,"mot":"ok"}', inputTokens: 1, outputTokens: 1 }; },
    });
    expect(bilan.attempted).toEqual([REFUSE]);
    expect(appels.length).toBeGreaterThanOrEqual(1);
    // Le résultat EFFACE la marque : la campagne est reprenable sans doublon.
    const q = (await loadQualifications(CLE)).get(REFUSE);
    expect(q?.requalificationRequiredAt ?? null).toBeNull();
    expect(q?.version).toBe('qualif-v2');
    // Relancée aussitôt : plus rien à reprendre (déduplication par la marque).
    const bis = await runTargetedRequalification([REFUSE], CLE, { call: async () => ({ rawText: '{"ok":true,"mot":"ok"}' }) });
    expect(bis.attempted).toEqual([]);
    expect(bis.skipped).toEqual([{ model: REFUSE, reason: 'not_marked' }]);
    // AUCUNE activation, aucune configuration modifiée.
    expect(await sql<Array<Record<string, unknown>>>`SELECT * FROM ai_config_versions WHERE status = 'ACTIVE'`).toEqual(avant);
    await sql`DELETE FROM ai_model_qualification WHERE model = ${REFUSE}`;
  });

  it('L115I-E12 (R10) — réactivation d’une configuration historique et import : contrôle final partagé', async () => {
    const { activationAvailabilityRefusal, chainModelsOf } = await import('@/services/ai/config/activation-availability');
    await sql`DELETE FROM ai_model_operational_status`;
    const dans = <T>(fn: (tx: { unsafe: (q: string, p?: never[]) => Promise<unknown> }) => Promise<T>) =>
      sql.begin(async (t) => fn({ unsafe: (q, p) => t.unsafe(q, (p ?? []) as never[]) as unknown as Promise<unknown> }));
    const chaine = chainModelsOf([{ primaryModel: REFUSE, fallback1: SAIN }]);
    expect(chaine).toEqual([REFUSE, SAIN]);
    // Rien ne s'oppose encore.
    expect(await dans((tx) => activationAvailabilityRefusal(tx, chaine, 'Activation annulée'))).toBeNull();
    // Verdict publié : la réactivation d'une configuration historique est refusée…
    await controler({ model: REFUSE, checkId: 'e12-refus' });
    expect(await dans((tx) => activationAvailabilityRefusal(tx, chaine, 'Activation annulée'))).toMatchObject({
      code: 'BLOCKED_MODEL_UNAVAILABLE', model: REFUSE,
    });
    // … et l'IMPORT aussi, avec le message de son geste.
    const refusImport = await dans((tx) => activationAvailabilityRefusal(tx, chaine, 'Import annulé'));
    expect(refusImport?.message).toMatch(/^Import annulé dans la transaction/);
    // Les deux appelants partagent bien CETTE façade (aucune logique dupliquée).
    for (const f of ['src/services/ai/config/config-version.service.ts', 'src/services/ai/config/config-import.service.ts']) {
      expect(await readFile(join(process.cwd(), f), 'utf8'), f).toContain('activationAvailabilityRefusal');
    }
  });
});
