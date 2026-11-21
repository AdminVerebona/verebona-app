/**
 * Carte #823 (sécurité L53A) — la trace AUTH_REAUTH_THROTTLED est validée AVEC
 * la pause de réauthentification — base PostgreSQL réelle, vraies routes,
 * vraies tables (`auth_rate_limits`, `user_activity_log`).
 *
 * AUCUNE temporisation, AUCUN sondage, AUCUNE relance : chaque attente est un
 * point de rendez-vous explicite (promesse résolue par le code observé, verrou
 * PostgreSQL), et chaque lecture SQL est faite immédiatement après la réponse.
 *
 *   · critère 2 : insertion suspendue → depuis une seconde connexion, ni la
 *     pause ni la trace ne sont visibles avant la validation ; les deux le
 *     sont dès la réponse ;
 *   · critère 3 : insertion refusée par PostgreSQL, puis compteurs partagés
 *     indisponibles → aucun verrou validé sans trace, dégradation signalée,
 *     action toujours refusée ;
 *   · critère 4 : tentatives simultanées au seuil, premières tentatives
 *     simultanées, seuils utilisateur ET IP franchis ensemble → une seule trace.
 *
 * Le critère 1 (parcours complet) est porté par PO-Q21-REAUTH-01
 * (`l53a-securite-cdc18.e2e.ts`).
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import bcrypt from 'bcrypt';
import { scenario } from '../scenario';
import { uid } from '../factories';
import type { AuthLimitTx, LimitCommit, LimitRecord } from '@/lib/auth/auth-rate-limit';

const PASSWORD = 'MotDePasseE2e1!';
const ORIGIN = 'http://localhost:3000';
const AGENT = 'NavigateurC823/1.0';
const SIGNAL = 'security.reauth_throttle_trace_degraded';

function req(path: string, init: { body?: unknown; cookie?: string; ip: string }) {
  const headers: Record<string, string> = {
    'content-type': 'application/json', origin: ORIGIN, 'x-forwarded-for': init.ip, 'user-agent': AGENT,
  };
  if (init.cookie) headers.cookie = init.cookie;
  return new NextRequest(`${ORIGIN}${path}`, { method: 'POST', headers, body: JSON.stringify(init.body ?? {}) });
}
type WithCookies = Response & { cookies: { get(n: string): { value: string } | undefined } };

/** Point de rendez-vous : une promesse et sa résolution, sans horloge. */
type RendezVous<T> = { promesse: Promise<T>; ouvrir: (v: T) => void };
function rendezVous<T = void>(): RendezVous<T> {
  let ouvrir!: (v: T) => void;
  const promesse = new Promise<T>((r) => { ouvrir = r; });
  return { promesse, ouvrir };
}

scenario('C823', 'Réauthentification — pause et trace AUTH_REAUTH_THROTTLED validées ensemble', ({ sql, make }) => {
  let ipSuivante = 0;
  /** Compte actif avec session ouverte (jeton d'accès). */
  async function compte() {
    const email = `${uid('c823')}@test.invalid`;
    const owner = await make.user({ email });
    const hash = await bcrypt.hash(PASSWORD, 4);
    await sql`UPDATE users SET password_hash = ${hash}, is_active = true, status = 'ACTIVE', first_name = 'Titulaire' WHERE id = ${owner.id}`;
    await make.account({ owner });
    const { POST } = await import('@/app/api/auth/login/route');
    const res = await POST(req('/api/auth/login', { body: { email, password: PASSWORD }, ip: `98.0.${++ipSuivante}.1` }));
    expect(res.status).toBe(200);
    return { id: owner.id, email, acces: (res as WithCookies).cookies.get('access_token')!.value };
  }
  async function essai(acces: string, currentPassword: string, ip: string) {
    const { POST: change } = await import('@/app/api/users/me/change-password/route');
    return change(req('/api/users/me/change-password', {
      cookie: `access_token=${acces}`, ip, body: { currentPassword, newPassword: 'NouveauMdp3!x' },
    }));
  }
  type Trace = { user_id: number; user_email: string; details: string };
  const tracesDe = (lecteur: typeof sql, userId: number) => lecteur<Trace[]>`
    SELECT user_id, user_email, details FROM user_activity_log
     WHERE user_id = ${userId} AND activity_type = 'AUTH_REAUTH_THROTTLED' ORDER BY id`;
  type Compteur = { attempts: number; locked_until: Date | string | null; lock_level: number };
  async function cles(userId: number, ip?: string) {
    const { limitKey } = await import('@/lib/auth/auth-rate-limit');
    return { user: limitKey('reauth', 'user', String(userId)), ip: ip ? limitKey('reauth', 'ip', ip) : null };
  }
  const compteur = async (lecteur: typeof sql, cle: string): Promise<Compteur | undefined> =>
    (await lecteur<Compteur[]>`SELECT attempts, locked_until, lock_level FROM auth_rate_limits WHERE bucket_key = ${cle}`)[0];
  const signalements = (espion: { mock: { calls: unknown[][] } }) =>
    espion.mock.calls.map((c) => c[0]).filter((a): a is string => typeof a === 'string' && a.includes(SIGNAL));

  beforeEach(async () => {
    // Limiteur du processus remis à neuf : aucune pause tenue en mémoire d'un test à l'autre.
    const { setAuthRateLimiterForTests } = await import('@/lib/auth/auth-rate-limit');
    setAuthRateLimiterForTests(null);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    const { setAuthRateLimiterForTests } = await import('@/lib/auth/auth-rate-limit');
    setAuthRateLimiterForTests(null);
    await sql.unsafe(`
      DROP TRIGGER IF EXISTS c823_refus ON user_activity_log;
      DROP FUNCTION IF EXISTS c823_refus();
      ALTER TABLE IF EXISTS auth_rate_limits_c823_off RENAME TO auth_rate_limits`);
  });

  /**
   * Magasin PostgreSQL RÉEL dont la transaction peut être suspendue à deux
   * endroits précis, une seule fois : juste avant l'insertion de la trace, puis
   * après l'insertion et avant la validation.
   */
  async function limiteurSuspendable() {
    const { AuthRateLimiter, FallbackAuthLimitStore, PgAuthLimitStore, setAuthRateLimiterForTests } = await import('@/lib/auth/auth-rate-limit');
    const { sql: frag } = await import('drizzle-orm');
    type Porte = {
      avantInsertion: RendezVous<void>; ouvrirInsertion: RendezVous<void>;
      apresInsertion: RendezVous<number>; ouvrirValidation: RendezVous<void>;
    };
    const etat: { porte: Porte | null; entree: RendezVous<void> | null } = { porte: null, entree: null };
    class MagasinSuspendable extends PgAuthLimitStore {
      override async updateMany(
        keys: string[],
        fn: (recs: Map<string, LimitRecord>) => Map<string, LimitRecord>,
        beforeCommit?: (tx: AuthLimitTx) => Promise<void>,
      ): Promise<LimitCommit> {
        // Rendez-vous « une tentative entre dans la transaction » (elle a donc passé le contrôle de pause).
        const entree = etat.entree;
        etat.entree = null;
        entree?.ouvrir();
        return super.updateMany(keys, fn, async (tx) => {
          const porte = etat.porte;
          etat.porte = null; // une seule transaction est suspendue
          if (porte) { porte.avantInsertion.ouvrir(); await porte.ouvrirInsertion.promesse; }
          if (beforeCommit) await beforeCommit(tx);
          if (porte) {
            const [{ pid }] = (await tx.execute(frag`SELECT pg_backend_pid() AS pid`)) as unknown as { pid: number }[];
            porte.apresInsertion.ouvrir(Number(pid));
            await porte.ouvrirValidation.promesse;
          }
        });
      }
    }
    setAuthRateLimiterForTests(new AuthRateLimiter(new FallbackAuthLimitStore(new MagasinSuspendable())));
    return {
      armer(): Porte {
        etat.porte = { avantInsertion: rendezVous(), ouvrirInsertion: rendezVous(), apresInsertion: rendezVous<number>(), ouvrirValidation: rendezVous() };
        return etat.porte;
      },
      /** Résolu quand la PROCHAINE tentative entre dans la transaction du limiteur. */
      prochaineEntree(): Promise<void> {
        etat.entree = rendezVous();
        return etat.entree.promesse;
      },
    };
  }

  // ── Critère 2 ────────────────────────────────────────────────────────────

  it('C823-02 insertion suspendue : depuis une seconde connexion, ni la pause ni la trace avant la validation ; les deux ensemble dès la réponse', async () => {
    const magasin = await limiteurSuspendable();
    const u = await compte();
    const k = await cles(u.id);
    for (let i = 0; i < 4; i++) expect((await essai(u.acces, 'Faux-123!', `98.1.${i}.1`)).status).toBe(401);

    const seconde = await sql.reserve(); // seconde connexion, réservée à l'observation
    try {
      const [{ pid: pidObservateur }] = await seconde<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      const observer = async () => ({
        compteur: await compteur(seconde as unknown as typeof sql, k.user),
        traces: (await tracesDe(seconde as unknown as typeof sql, u.id)).length,
      });

      const porte = magasin.armer();
      let rendue = false;
      const cinquieme = essai(u.acces, 'Faux-123!', '98.1.4.1').then((r) => { rendue = true; return r; });

      // 1) La transaction a compté l'échec et posé la pause, l'insertion n'a pas commencé.
      await porte.avantInsertion.promesse;
      const avant = await observer();
      expect(avant.compteur).toMatchObject({ attempts: 4, locked_until: null });
      expect(avant.traces).toBe(0);
      expect(rendue).toBe(false);

      // 2) Trace insérée dans la transaction, validation suspendue : toujours rien de visible.
      porte.ouvrirInsertion.ouvrir();
      const pidTransaction = await porte.apresInsertion.promesse;
      expect(pidTransaction).not.toBe(Number(pidObservateur)); // deux connexions réelles distinctes
      const pendant = await observer();
      expect(pendant.compteur).toMatchObject({ attempts: 4, locked_until: null });
      expect(pendant.traces).toBe(0);
      expect(rendue).toBe(false); // la réponse attend la validation

      // 3) Validation : la réponse revient, pause ET trace sont visibles ensemble, immédiatement.
      porte.ouvrirValidation.ouvrir();
      expect((await cinquieme).status).toBe(401);
      const apres = await observer();
      expect(apres.compteur?.locked_until).not.toBeNull();
      expect(apres.compteur?.lock_level).toBe(1);
      expect(apres.traces).toBe(1);
    } finally {
      seconde.release();
    }
    const [trace] = await tracesDe(sql, u.id);
    expect(JSON.parse(trace.details)).toMatchObject({ action: 'change_password', retryAfterSeconds: 900 });
    expect(trace.user_email).toBe(''); // aucune adresse e-mail en clair dans la trace
    const refus = await essai(u.acces, PASSWORD, '98.1.9.1');
    expect(refus.status).toBe(429);
    expect(await tracesDe(sql, u.id)).toHaveLength(1);
  });

  // ── Critère 3 ────────────────────────────────────────────────────────────

  it('C823-03a insertion de la trace refusée par PostgreSQL : aucun verrou validé sans trace, dégradation signalée (sans donnée sensible), action toujours refusée', async () => {
    const u = await compte();
    const v = await compte();
    const k = await cles(u.id);
    await sql.unsafe(`
      CREATE FUNCTION c823_refus() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'c823 : insertion de la trace refusée'; END $$;
      CREATE TRIGGER c823_refus BEFORE INSERT ON user_activity_log FOR EACH ROW
        WHEN (NEW.activity_type = 'AUTH_REAUTH_THROTTLED') EXECUTE FUNCTION c823_refus()`);
    const espion = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    // Quatre échecs ordinaires : comptés en base, AUCUNE insertion de trace tentée
    // (elle aurait été refusée, la transaction annulée et l'échec non compté).
    for (let i = 0; i < 4; i++) expect((await essai(u.acces, 'Faux-123!', `98.2.${i}.1`)).status).toBe(401);
    expect(await compteur(sql, k.user)).toMatchObject({ attempts: 4, locked_until: null });
    expect(signalements(espion)).toHaveLength(0);

    // Cinquième échec : la trace est refusée → rien n'est validé en base.
    expect((await essai(u.acces, 'Faux-123!', '98.2.4.1')).status).toBe(401);
    expect(await compteur(sql, k.user)).toMatchObject({ attempts: 4, locked_until: null }); // aucun verrou PostgreSQL sans trace
    expect(await tracesDe(sql, u.id)).toHaveLength(0);

    // Dégradation détectée et signalée, sans donnée sensible.
    const lignes = signalements(espion);
    expect(lignes).toHaveLength(1);
    const signal = JSON.parse(lignes[0]);
    expect(signal).toMatchObject({ event: SIGNAL, userId: u.id, action: 'change_password', retryAfterSeconds: 900 });
    expect(signal.cause).toMatch(/c823 : insertion de la trace refusée/);
    for (const interdit of [u.email, 'Faux-123!', PASSWORD, '98.2.4.1', AGENT, 'Failed query']) expect(lignes[0]).not.toContain(interdit);
    const { authRateLimiterHealth } = await import('@/lib/auth/auth-rate-limit');
    const sante = authRateLimiterHealth();
    expect(sante.lockTraceDegradedSince).not.toBeNull();
    expect(sante.lockTraceFailures).toBe(1);
    for (const interdit of [u.email, '98.2.4.1', AGENT, 'Failed query']) expect(JSON.stringify(sante)).not.toContain(interdit);
    const { buildHealthReport } = await import('@/lib/health/diagnostic');
    expect((await buildHealthReport({ detailed: false })).result.checks.authRateLimiter).toMatchObject({ status: 'warning', lockTraceFailures: 1 });

    // Protection maintenue : le BON mot de passe est refusé, avec Retry-After.
    const refus = await essai(u.acces, PASSWORD, '98.2.9.1');
    expect(refus.status).toBe(429);
    expect(Number(refus.headers.get('retry-after'))).toBeGreaterThan(0);
    // … y compris une fois l'insertion redevenue possible (la pause ne dépend pas de la trace).
    await sql.unsafe(`DROP TRIGGER c823_refus ON user_activity_log; DROP FUNCTION c823_refus()`);
    expect((await essai(u.acces, PASSWORD, '98.2.9.2')).status).toBe(429);
    expect(signalements(espion)).toHaveLength(1); // une tentative refusée ne signale ni ne trace rien de plus
    expect(await tracesDe(sql, u.id)).toHaveLength(0);
    // Un autre utilisateur n'est pas touché.
    expect((await essai(v.acces, PASSWORD, '98.2.10.1')).status).toBe(200);
  });

  it('C823-03b compteurs partagés indisponibles (repli mémoire) : pause appliquée, aucune trace durable (dit et signalé), rien validé en base au retour', async () => {
    const u = await compte();
    const v = await compte();
    const k = await cles(u.id);
    const espion = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // Indisponibilité réelle du magasin partagé : toute requête sur la table échoue côté PostgreSQL.
    await sql`ALTER TABLE auth_rate_limits RENAME TO auth_rate_limits_c823_off`;

    for (let i = 0; i < 5; i++) expect((await essai(u.acces, 'Faux-123!', `98.3.${i}.1`)).status).toBe(401);
    const refus = await essai(u.acces, PASSWORD, '98.3.9.1');
    expect(refus.status).toBe(429);
    expect(Number(refus.headers.get('retry-after'))).toBeGreaterThan(0);

    // Limite assumée : en repli mémoire, AUCUNE trace durable dans cette base — c'est signalé.
    expect(await tracesDe(sql, u.id)).toHaveLength(0);
    const lignes = signalements(espion);
    expect(lignes).toHaveLength(1);
    expect(JSON.parse(lignes[0])).toMatchObject({ event: SIGNAL, userId: u.id, action: 'change_password', retryAfterSeconds: 900 });
    for (const interdit of [u.email, PASSWORD, '98.3.', AGENT, 'Failed query']) expect(lignes[0]).not.toContain(interdit);
    const { authRateLimiterHealth } = await import('@/lib/auth/auth-rate-limit');
    expect(authRateLimiterHealth()).toMatchObject({ mode: 'memory-fallback', lockTraceFailures: 1 });
    expect(authRateLimiterHealth().lockTraceDegradedSince).not.toBeNull();

    // Retour de la base : aucun verrou n'y a été validé sans trace ; la pause reste appliquée par l'instance.
    await sql`ALTER TABLE auth_rate_limits_c823_off RENAME TO auth_rate_limits`;
    expect(await compteur(sql, k.user)).toBeUndefined();
    expect((await essai(u.acces, PASSWORD, '98.3.9.2')).status).toBe(429);
    expect((await essai(v.acces, PASSWORD, '98.3.10.1')).status).toBe(200);
  });

  // ── Critère 4 ────────────────────────────────────────────────────────────

  it('C823-04a deux tentatives simultanées AU SEUIL (deux transactions réelles, la première suspendue) : une seule entrée en pause, une seule trace', async () => {
    const magasin = await limiteurSuspendable();
    const u = await compte();
    const k = await cles(u.id);
    for (let i = 0; i < 4; i++) expect((await essai(u.acces, 'Faux-123!', `98.4.${i}.1`)).status).toBe(401);

    const porte = magasin.armer();
    const premiere = essai(u.acces, 'Faux-123!', '98.4.4.1');
    await porte.avantInsertion.promesse; // la première tient les verrous des clés, pause non validée
    // La seconde ne voit aucune pause (rien n'est validé) : elle passe le contrôle, entre à son
    // tour dans la transaction du limiteur et y attend, côté PostgreSQL, la fin de la première.
    const entree = magasin.prochaineEntree();
    const seconde = essai(u.acces, 'Faux-123!', '98.4.5.1');
    await entree;
    porte.ouvrirInsertion.ouvrir();
    await porte.apresInsertion.promesse;
    porte.ouvrirValidation.ouvrir();
    const [r1, r2] = await Promise.all([premiere, seconde]);
    expect([r1.status, r2.status]).toEqual([401, 401]);

    const traces = await tracesDe(sql, u.id);
    expect(traces).toHaveLength(1);
    expect(JSON.parse(traces[0].details)).toMatchObject({ action: 'change_password', retryAfterSeconds: 900 });
    const c = await compteur(sql, k.user);
    expect(c?.locked_until).not.toBeNull();
    expect(c?.lock_level).toBe(1); // une seule entrée en pause : le niveau de récidive n'a monté qu'une fois
    expect((await essai(u.acces, PASSWORD, '98.4.9.1')).status).toBe(429);
    expect(await tracesDe(sql, u.id)).toHaveLength(1);
  });

  it('C823-04b cinq PREMIÈRES tentatives simultanées (clés sans ligne) : toutes comptées, une seule pause, une seule trace', async () => {
    const { AUTH_LIMITS, AuthRateLimiter, FallbackAuthLimitStore, PgAuthLimitStore, limitKey } = await import('@/lib/auth/auth-rate-limit');
    const { insertUserActivity } = await import('@/lib/audit-logger');
    for (let tour = 0; tour < 5; tour++) {
      const u = await make.user({ email: `${uid('c823b')}@test.invalid` });
      const entrees = (ip: string) => [
        { key: limitKey('reauth', 'user', String(u.id)), policy: AUTH_LIMITS.reauthUser },
        { key: limitKey('reauth', 'ip', ip), policy: AUTH_LIMITS.reauthIp },
      ];
      // Cinq instances distinctes (comme cinq conteneurs web), cinq connexions réelles.
      const decisions = await Promise.all([0, 1, 2, 3, 4].map((i) =>
        new AuthRateLimiter(new FallbackAuthLimitStore(new PgAuthLimitStore())).recordFailureWithLockTrace(
          entrees(`98.5.${tour}.${i}`),
          (tx, pause) => insertUserActivity({
            activityType: 'AUTH_REAUTH_THROTTLED', userId: u.id, userEmail: '',
            details: { action: 'change_password', retryAfterSeconds: pause.retryAfterSeconds },
          }, tx),
        )));
      expect(decisions.filter((d) => d.lockedNow)).toHaveLength(1);
      expect(decisions.filter((d) => d.lockTrace === 'committed')).toHaveLength(1);
      expect(decisions.filter((d) => d.lockTrace === 'not_durable')).toHaveLength(0);
      const c = await compteur(sql, limitKey('reauth', 'user', String(u.id)));
      expect(c?.locked_until).not.toBeNull();
      expect(c?.lock_level).toBe(1);
      expect(await tracesDe(sql, u.id)).toHaveLength(1);
    }
  });

  it('C823-04c seuils utilisateur ET IP franchis par la même tentative : les deux pauses, une seule trace, durée la plus longue', async () => {
    const u = await compte();
    const ip = '98.6.6.6';
    const k = await cles(u.id, ip);
    // Compteurs amenés au bord des deux seuils (5 par utilisateur, 20 par IP).
    for (const [cle, n] of [[k.user, 4], [k.ip!, 19]] as const) {
      await sql`INSERT INTO auth_rate_limits (bucket_key, attempts, window_started_at, locked_until, lock_level, last_locked_at, updated_at)
                VALUES (${cle}, ${n}, now(), NULL, 0, NULL, now())`;
    }
    expect((await essai(u.acces, 'Faux-123!', ip)).status).toBe(401);
    expect((await compteur(sql, k.user))?.locked_until).not.toBeNull();
    expect((await compteur(sql, k.ip!))?.locked_until).not.toBeNull();
    const traces = await tracesDe(sql, u.id);
    expect(traces).toHaveLength(1);
    expect(JSON.parse(traces[0].details)).toMatchObject({ action: 'change_password', retryAfterSeconds: 900 });
    const refus = await essai(u.acces, PASSWORD, ip);
    expect(refus.status).toBe(429);
    expect(Number(refus.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await tracesDe(sql, u.id)).toHaveLength(1);
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM user_activity_log WHERE activity_type = 'AUTH_REAUTH_THROTTLED' AND ip_address = ${ip}`;
    expect(n).toBe(1);
  });
});
