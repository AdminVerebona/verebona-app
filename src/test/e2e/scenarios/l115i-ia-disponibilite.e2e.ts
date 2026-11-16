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
 *   E09 · R02 / R10 — contrôle final de disponibilité dans une transaction : refus explicite.
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
});
