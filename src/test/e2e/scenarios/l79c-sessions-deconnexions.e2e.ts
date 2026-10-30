/**
 * Lot 79C — diagnostic des déconnexions « SESSION_REVOKED » (réutilisation
 * d'un jeton de renouvellement au-delà de la fenêtre de grâce de 30 s).
 * PostgreSQL 16 réel, VRAIES routes (connexion, renouvellement, API).
 *
 * Ces scénarios REPRODUISENT des parcours d'un client légitime, unique, sans
 * aucun tiers. Ils ne modifient RIEN aux protections : ils mesurent ce que le
 * serveur décide. Résultats et correctif distinct proposé :
 * docs/exploitation/sessions-deconnexions-diagnostic.md.
 *
 *   L79C-SES-01 plusieurs onglets : renouvellements simultanés (même cookie)
 *               → une rotation, les autres « concurrent », aucune révocation ;
 *   L79C-SES-02 retour au premier plan : N appels parallèles en 401 → mêmes
 *               garanties côté serveur (N renouvellements simultanés) ;
 *   L79C-SES-03 onglet en retard : un onglet présente l'ancien cookie après
 *               la rotation par un autre, dans les 30 s → aucune révocation ;
 *   L79C-SES-04 réponse de renouvellement PERDUE puis nouvelle tentative au-delà
 *               de 30 s (PWA suspendue, réseau mobile, délai client de 10 s
 *               dépassé) → révocation globale : FAUX POSITIF REPRODUIT ;
 *   L79C-SES-05 réponse perdue, nouvelle tentative DANS les 30 s → 200 sans
 *               cookie ; le client n'a toujours que l'ancien jeton : la tentative
 *               suivante, hors fenêtre, révoque tout — faux positif retardé ;
 *   L79C-SES-06 déconnexion volontaire puis jeton rejoué : refus simple ;
 *   partout : aucun e-mail SECURITY_SESSIONS_REVOKED ; journal
 *   AUTH_TOKEN_REUSE_DETECTED avec l'âge de la rotation, visible au BO
 *   (fiche utilisateur › Connexions et tentatives).
 */
import { expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import bcrypt from 'bcrypt';
import { scenario } from '../scenario';
import { uid } from '../factories';

const PASSWORD = 'MotDePasseE2e1!';
const ORIGIN = 'http://localhost:3000';
type WithCookies = Response & { cookies: { get(n: string): { value: string } | undefined } };

function post(path: string, init: { body?: unknown; cookie?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', origin: ORIGIN, 'x-forwarded-for': '81.10.20.30' };
  if (init.cookie) headers.cookie = init.cookie;
  return new NextRequest(`${ORIGIN}${path}`, { method: 'POST', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
}
const cookie = (res: Response, name: string) => (res as WithCookies).cookies.get(name)?.value;

scenario('L79C-SES', 'Déconnexions SESSION_REVOKED : scénarios légitimes reproductibles', ({ sql, make }) => {
  async function compte() {
    const email = `${uid('l79c')}@test.invalid`;
    const owner = await make.user({ email });
    await sql`UPDATE users SET password_hash = ${await bcrypt.hash(PASSWORD, 4)}, is_active = true, status = 'ACTIVE' WHERE id = ${owner.id}`;
    await make.account({ owner });
    return { id: owner.id, email };
  }
  async function connexion(email: string) {
    const { POST } = await import('@/app/api/auth/login/route');
    const res = await POST(post('/api/auth/login', { body: { email, password: PASSWORD } }));
    expect(res.status).toBe(200);
    return { access: cookie(res, 'access_token')!, refresh: cookie(res, 'refresh_token')! };
  }
  async function renouveler(refresh: string) {
    const { POST } = await import('@/app/api/auth/refresh/route');
    return POST(post('/api/auth/refresh', { cookie: `refresh_token=${refresh}` }));
  }
  /** Fait vieillir la rotation d'un jeton (horloge simulée, côté base). */
  async function vieillir(refresh: string, secondes: number) {
    const { hashToken } = await import('@/db');
    await sql`UPDATE revoked_tokens SET revoked_at = revoked_at - make_interval(secs => ${secondes}) WHERE token_hash = ${await hashToken(refresh)}`;
  }
  const revocations = (userId: number) => sql`SELECT 1 FROM user_session_revocations WHERE user_id = ${userId}`;
  async function aucunEmailSecurite(userId: number) {
    const { settleDetachedAuthTasks } = await import('@/lib/auth/anti-enumeration');
    await settleDetachedAuthTasks();
    expect(await sql`SELECT 1 FROM email_logs WHERE upper(template_code) = 'SECURITY_SESSIONS_REVOKED' AND recipient_user_id = ${userId}`).toHaveLength(0);
  }

  it('L79C-SES-01 plusieurs onglets : renouvellements simultanés du même cookie — aucune déconnexion', async () => {
    const u = await compte();
    const s = await connexion(u.email);
    const res = await Promise.all([renouveler(s.refresh), renouveler(s.refresh), renouveler(s.refresh)]);
    expect(res.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(res.filter((r) => cookie(r, 'refresh_token'))).toHaveLength(1);
    expect(await revocations(u.id)).toHaveLength(0);
    // Le jeton émis par la requête gagnante fonctionne.
    const gagnant = res.map((r) => cookie(r, 'refresh_token')).find(Boolean)!;
    expect((await renouveler(gagnant)).status).toBe(200);
  });

  it('L79C-SES-02 retour au premier plan : dix appels parallèles en 401 — une rotation, aucune révocation', async () => {
    const u = await compte();
    const s = await connexion(u.email);
    const res = await Promise.all(Array.from({ length: 10 }, () => renouveler(s.refresh)));
    expect(res.every((r) => r.status === 200)).toBe(true);
    expect(res.filter((r) => cookie(r, 'refresh_token'))).toHaveLength(1);
    expect(await revocations(u.id)).toHaveLength(0);
  });

  it('L79C-SES-03 onglet en retard de 20 s sur la rotation faite par un autre onglet : aucune révocation', async () => {
    const u = await compte();
    const s = await connexion(u.email);
    expect((await renouveler(s.refresh)).status).toBe(200);
    await vieillir(s.refresh, 20);
    const retard = await renouveler(s.refresh);
    expect(retard.status).toBe(200);
    expect(await retard.json()).toMatchObject({ rotation: 'concurrent' });
    expect(await revocations(u.id)).toHaveLength(0);
  });

  it('L79C-SES-04 réponse perdue, nouvelle tentative après 30 s : révocation globale d’un client légitime (faux positif reproduit)', async () => {
    const u = await compte();
    const s = await connexion(u.email);
    // 1. Le serveur tourne le jeton ; la réponse (et ses Set-Cookie) n'arrive
    //    jamais au navigateur : PWA suspendue, réseau coupé, délai client dépassé.
    const perdue = await renouveler(s.refresh);
    expect(perdue.status).toBe(200);
    const successeurJamaisRecu = cookie(perdue, 'refresh_token')!;
    // 2. Retour 45 s plus tard : le navigateur présente toujours l'ANCIEN cookie.
    await vieillir(s.refresh, 45);
    const retour = await renouveler(s.refresh);
    expect(retour.status).toBe(401);
    expect((await retour.json()).code).toBe('SESSION_REVOKED');
    expect(cookie(retour, 'refresh_token')).toBe('');
    // 3. Toutes les sessions sont révoquées, y compris le successeur, que
    //    personne n'a jamais utilisé : aucun tiers n'est intervenu.
    expect(await revocations(u.id)).toHaveLength(1);
    expect((await renouveler(successeurJamaisRecu)).status).toBe(401);
    // Le journal d'activité est écrit sans bloquer la réponse : on l'attend (5 s au plus),
    // le contenu restant vérifié exactement (course observée en CI, lot 101-ter).
    let journal: { details: string } | undefined;
    for (let essai = 0; essai < 50 && !journal; essai += 1) {
      [journal] = await sql<{ details: string }[]>`
        SELECT details FROM user_activity_log WHERE user_id = ${u.id} AND activity_type = 'AUTH_TOKEN_REUSE_DETECTED' ORDER BY id DESC LIMIT 1`;
      if (!journal) await new Promise((r) => setTimeout(r, 100));
    }
    expect(journal, 'journal AUTH_TOKEN_REUSE_DETECTED écrit').toBeDefined();
    const d = JSON.parse(journal!.details);
    expect(d).toMatchObject({ severity: 'security_incident', sessionsRevoked: true });
    expect(d.rotationAgeMs).toBeGreaterThanOrEqual(45_000);
    expect(d.rotationAgeMs).toBeLessThan(120_000);
    await aucunEmailSecurite(u.id);
    // Lisible au BO sans SQL : Utilisateurs › fiche › Connexions et tentatives.
    const { loadLoginHistory } = await import('@/services/admin/user-detail.service');
    const histo = await loadLoginHistory(u.id);
    const incident = histo.find((h) => h.result === 'session_revoked');
    expect(incident?.detail).toMatch(/^Sessions révoquées par précaution : ancien jeton présenté \d+ s après son renouvellement$/);
    // Une nouvelle connexion reste possible.
    await connexion(u.email);
  });

  it('L79C-SES-05 réponse perdue, nouvelle tentative DANS les 30 s : 200 sans cookie, puis révocation à la tentative suivante', async () => {
    const u = await compte();
    const s = await connexion(u.email);
    expect((await renouveler(s.refresh)).status).toBe(200); // réponse perdue
    await vieillir(s.refresh, 5);
    const grace = await renouveler(s.refresh);
    expect(grace.status).toBe(200);
    expect(cookie(grace, 'refresh_token')).toBeUndefined(); // rien à déposer : le client garde l'ancien jeton
    // Le jeton d'accès du client a expiré : prochain 401, le client renouvelle
    // avec le même ancien cookie, cette fois hors fenêtre.
    await vieillir(s.refresh, 60);
    const suivant = await renouveler(s.refresh);
    expect(suivant.status).toBe(401);
    expect((await suivant.json()).code).toBe('SESSION_REVOKED');
    expect(await revocations(u.id)).toHaveLength(1);
    await aucunEmailSecurite(u.id);
  });

  it('L79C-SES-06 réutilisation réelle après déconnexion volontaire : refus simple, sans révocation (protection inchangée)', async () => {
    const u = await compte();
    const s = await connexion(u.email);
    const { POST: logout } = await import('@/app/api/auth/logout/route');
    await logout(post('/api/auth/logout', { cookie: `refresh_token=${s.refresh}` }));
    expect((await renouveler(s.refresh)).status).toBe(401);
    expect(await revocations(u.id)).toHaveLength(0);
    await aucunEmailSecurite(u.id);
  });
});
