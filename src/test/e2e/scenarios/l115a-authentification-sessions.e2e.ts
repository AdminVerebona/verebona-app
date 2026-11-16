/**
 * Lot 115A — authentification et sessions : cartes #798, #793, #799.
 * PostgreSQL 16 réel, VRAIES routes (connexion, identité, déconnexion),
 * garde serveur de la double authentification réelle, journal d'activité et
 * historique BO réels.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUI EST PROUVÉ ICI
 *
 *   L115A-E01 (#793) session COMPLÈTE de niveau 1 + obligation de double
 *             authentification devenue active → `GET /api/users/me` répond un
 *             403 `MFA_REQUIRED` RAPIDE (refus volontaire, pas un délai) ;
 *             le client le classe « reconnexion exigée » et non
 *             « indisponibilité » (AVANT / APRÈS sur le MÊME refus), et
 *             l'identité affichée est purgée ;
 *   L115A-E02 (#798 / #799) connexion acceptée puis sortie décidée par
 *             l'application : le code du refus initial est tracé et le BO
 *             affiche « Déconnexion après refus d'authentification », jamais
 *             « Déconnexion par précaution » ; la tentative se retrouve par
 *             son code de diagnostic ;
 *   L115A-E03 (#799) refus non tracé → « non disponible » ; révocation de
 *             sécurité QUALIFIÉE → libellé et délai conservés ;
 *   L115A-E04 (#798 CA05) les refus véritables gardent leurs refus : mot de
 *             passe faux, jeton de renouvellement révoqué, appel sans cookie,
 *             et l'obligation de double authentification n'est pas relâchée.
 *
 * L'iPhone n'existe pas dans cet atelier : ces scénarios reproduisent la
 * MÉCANIQUE serveur et la décision du client, pas le comportement de
 * WKWebView. Aucun jeton, mot de passe ni cookie n'est écrit dans une trace.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { afterEach, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import bcrypt from 'bcrypt';
import { scenario } from '../scenario';
import { uid } from '../factories';
import { LOGIN_ATTEMPT_HEADER, LOGOUT_CODE_HEADER, LOGOUT_REASON_HEADER } from '@/lib/auth/login-diagnostics';
import { MFA_REQUIRED_CODE } from '@/lib/auth/mfa/constants';
import { SessionStore, classifySessionError } from '@/lib/session/session-store';
import { LOGIN_RESULT_LABEL, filterLoginEntries } from '@/lib/admin/login-activity';

const PASSWORD = 'MotDePasseE2e1!';
const ORIGIN = 'http://localhost:3000';
const UA_IOS_APP = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 VerebonaApp/1.0.4 (12; preprod)';
const COOKIES = ['access_token', 'refresh_token', 'vb_device', 'vb_mfa'];

type WithCookies = Response & { cookies: { get(n: string): { value: string } | undefined } };

let ipN = 1;
class Appareil {
  jar = new Map<string, string>();
  ip = `115.${(ipN++) % 250}.${Math.floor(Math.random() * 250)}.7`;
  cookie() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '); }
  absorb(res: Response) {
    for (const n of COOKIES) {
      const v = (res as WithCookies).cookies.get(n)?.value;
      if (v === undefined) continue;
      if (v === '') this.jar.delete(n); else this.jar.set(n, v);
    }
    return res;
  }
  req(path: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}, withCookies = true) {
    return new NextRequest(`${ORIGIN}${path}`, {
      method,
      headers: {
        'content-type': 'application/json', origin: ORIGIN, 'x-forwarded-for': this.ip, 'user-agent': UA_IOS_APP,
        'x-verebona-client': 'ios', 'x-verebona-app-version': '1.0.4', 'x-verebona-app-build': '12',
        ...(withCookies && this.jar.size ? { cookie: this.cookie() } : {}), ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
}

scenario('L115A', 'Authentification : refus typés, sortie corrélée, diagnostic au BO', ({ sql, make }) => {
  async function compte(status: 'ACTIVE' | 'SUSPENDED' = 'ACTIVE') {
    const email = `${uid('l115a')}@test.invalid`;
    const u = await make.user({ email });
    await sql`UPDATE users SET password_hash = ${await bcrypt.hash(PASSWORD, 4)}, is_active = true, status = ${status} WHERE id = ${u.id}`;
    await make.account({ owner: u });
    return { id: u.id, email };
  }
  const obligation = async (from: Date | null) => {
    await sql`UPDATE mfa_enforcement_settings SET enforced_from = ${from ? from.toISOString() : null} WHERE scope = 'users'`;
  };
  async function connecter(app: Appareil, email: string, password = PASSWORD, attemptId: string | null = null) {
    const { POST } = await import('@/app/api/auth/login/route');
    return app.absorb(await POST(app.req('/api/auth/login', 'POST', { email, password }, attemptId ? { [LOGIN_ATTEMPT_HEADER]: attemptId } : {})));
  }
  async function moi(app: Appareil, extra: Record<string, string> = {}) {
    const { GET } = await import('@/app/api/users/me/route');
    return GET(app.req('/api/users/me', 'GET', undefined, extra));
  }
  async function deconnecter(app: Appareil, extra: Record<string, string>) {
    const { POST } = await import('@/app/api/auth/logout/route');
    return app.absorb(await POST(app.req('/api/auth/logout', 'POST', {}, extra)));
  }
  /** Journal d'activité (écrit sans bloquer la réponse). */
  async function journal(userId: number, type: string) {
    for (let i = 0; i < 40; i++) {
      const rows = await sql<{ details: string | null }[]>`
        SELECT details FROM user_activity_log WHERE user_id = ${userId} AND activity_type = ${type} ORDER BY id`;
      if (rows.length > 0) return rows.map((r) => JSON.parse(r.details ?? '{}') as Record<string, unknown>);
      await new Promise((r) => setTimeout(r, 25));
    }
    return [];
  }
  /** Historique BO, attendu jusqu'à ce qu'il porte la ligne cherchée. */
  async function historique(userId: number, attendu: (e: { result: string }) => boolean) {
    const { loadLoginHistory } = await import('@/services/admin/user-detail.service');
    let h = await loadLoginHistory(userId);
    for (let i = 0; i < 40 && !h.some(attendu); i++) {
      await new Promise((r) => setTimeout(r, 25));
      h = await loadLoginHistory(userId);
    }
    return h;
  }
  /** Erreur telle que le client HTTP la rend à partir d'une réponse de refus. */
  async function erreurClient(res: Response) {
    const body = await res.json() as { code?: string; requestId?: string };
    return Object.assign(new Error(body.code ?? 'UNKNOWN'), { status: res.status, code: body.code, requestId: body.requestId });
  }

  /** L'obligation de double authentification est un réglage GLOBAL : chaque
   *  scénario part du repos et y revient, sinon les connexions suivantes
   *  n'ouvriraient aucune session (seconde étape exigée). */
  afterEach(async () => { await obligation(null); });

  it('L115A-E01 #793 : 403 MFA_REQUIRED rapide → « reconnexion exigée », jamais un écran de panne', async () => {
    await obligation(null);
    const u = await compte();
    const app = new Appareil();
    expect((await connecter(app, u.email)).status).toBe(200);
    expect((await moi(app)).status).toBe(200);

    // L'obligation devient active : la session COMPLÈTE de niveau 1 est sous garde.
    await obligation(new Date(Date.now() - 86_400_000));
    const debut = Date.now();
    const refus = await moi(app);
    const duree = Date.now() - debut;
    expect(refus.status).toBe(403);
    const corps = await refus.clone().json();
    expect(corps.code).toBe(MFA_REQUIRED_CODE);
    expect(typeof corps.requestId).toBe('string');
    // C'est un refus VOLONTAIRE, pas un délai : la carte #793 insiste là-dessus.
    expect(duree).toBeLessThan(5_000);

    const err = await erreurClient(refus);
    // AVANT (carte #793) : ni 401, ni ACCOUNT_SUSPENDED, ni code de la liste
    // des refus définitifs ⇒ dernière branche ⇒ « indisponible » ⇒ écran
    // « Connexion au service momentanément impossible » et boucle « Réessayer ».
    const UNAUTHENTICATED_AVANT = ['UNAUTHORIZED', 'AUTH_REQUIRED', 'INVALID_TOKEN', 'TOKEN_EXPIRED', 'ACCOUNT_SUSPENDED'];
    const avant = refus.status === 401 || UNAUTHENTICATED_AVANT.includes(corps.code) ? 'unauthenticated' : 'unavailable';
    expect(avant).toBe('unavailable');
    // APRÈS : genre propre, message du serveur, `requestId` conservé.
    const apres = classifySessionError(err);
    expect(apres.kind).toBe('reauth-required');
    expect(apres.requestId).toBe(corps.requestId);
    expect(apres.message).toBe(corps.message);

    // CA08 : le magasin purge l'identité — aucun bien ni ancienne identité
    // affiché comme preuve d'accès pendant une MFA non satisfaite. Première
    // lecture : l'identité servie plus haut (la session était utilisable) ;
    // seconde : le refus RÉEL de la route, tel que le client HTTP le rend.
    let refuser = false;
    const store = new SessionStore({
      fetchMe: async () => {
        if (refuser) throw await erreurClient(await moi(app));
        return { id: u.id } as never;
      },
    });
    await store.refetch();
    expect(store.getSnapshot()).toMatchObject({ status: 'authenticated', user: { id: u.id } });
    refuser = true;
    await store.refetch();
    expect(store.getSnapshot()).toMatchObject({ status: 'reauth-required', user: null });
  });

  it('L115A-E02 #798 / #799 : sortie après refus → BO exact, code du refus initial, tentative retrouvée', async () => {
    const u = await compte();
    const app = new Appareil();
    expect((await connecter(app, u.email, PASSWORD, 'B77RTX8W3E')).status).toBe(200);

    // La procédure de sortie du client déclare l'origine ET le code du refus.
    const out = await deconnecter(app, {
      [LOGIN_ATTEMPT_HEADER]: 'B77RTX8W3E',
      [LOGOUT_REASON_HEADER]: 'auth-failure',
      [LOGOUT_CODE_HEADER]: 'AUTH_REQUIRED',
    });
    expect(out.status).toBe(200);
    const sorties = await journal(u.id, 'AUTH_LOGOUT');
    expect(sorties.at(-1)).toMatchObject({ trigger: 'auth-failure', loginAttemptId: 'B77RTX8W3E', refusalCode: 'AUTH_REQUIRED' });
    // Aucun secret au journal.
    expect(JSON.stringify(sorties)).not.toContain(PASSWORD);
    expect(JSON.stringify(sorties)).not.toMatch(/access_token|refresh_token/);

    const h = await historique(u.id, (e) => e.result === 'app_signed_out');
    const ligne = h.find((e) => e.result === 'app_signed_out')!;
    expect(ligne.category).toBe('session_incident');
    expect(LOGIN_RESULT_LABEL[ligne.result]).toBe('Déconnexion après refus d’authentification');
    expect(LOGIN_RESULT_LABEL[ligne.result]).not.toBe('Déconnexion par précaution');
    expect(ligne.detail).toContain('refus initial : AUTH_REQUIRED');
    expect(ligne.detail).toContain('diagnostic B77RTX8W3E');
    expect(ligne.attemptId).toBe('B77RTX8W3E');
    expect(ligne.refusalCode).toBe('AUTH_REQUIRED');
    // Aucune ligne de cette fiche n'est présentée comme une alerte de sécurité.
    expect(h.some((e) => e.category === 'security')).toBe(false);

    // CA04 : retrouver la tentative depuis la fiche, sans SQL.
    const trouvees = filterLoginEntries(h, 'b77rtx8w3e');
    expect(trouvees.length).toBeGreaterThanOrEqual(2); // connexion acceptée + sortie
    expect(trouvees.every((e) => (e.detail ?? '').includes('B77RTX8W3E'))).toBe(true);
    expect(filterLoginEntries(h, 'ZZZZZZZZZZ')).toHaveLength(0);
  });

  it('L115A-E03 #799 : refus non tracé → « non disponible » ; révocation de sécurité qualifiée → libellé conservé', async () => {
    const u = await compte();
    const app = new Appareil();
    expect((await connecter(app, u.email, PASSWORD, 'NOCODE2345')).status).toBe(200);
    // Client antérieur à la carte (aucun code déclaré) : rien n'est inventé.
    expect((await deconnecter(app, { [LOGIN_ATTEMPT_HEADER]: 'NOCODE2345', [LOGOUT_REASON_HEADER]: 'auth-failure' })).status).toBe(200);
    const h1 = await historique(u.id, (e) => e.result === 'app_signed_out');
    const sortie = h1.find((e) => e.result === 'app_signed_out')!;
    expect(sortie.refusalCode).toBeNull();
    expect(sortie.detail).toContain('refus initial : non disponible');

    // Révocation de sécurité QUALIFIÉE. Sa production réelle (jeton de
    // renouvellement rejoué hors fenêtre de grâce) est couverte par
    // L79C-SES-04 ; on vérifie ici la seule PRÉSENTATION au BO.
    await sql`
      INSERT INTO user_activity_log (timestamp, user_id, user_email, activity_type, details, created_at)
      VALUES (now(), ${u.id}, '', 'AUTH_TOKEN_REUSE_DETECTED',
              ${JSON.stringify({ severity: 'security_incident', rotationAgeMs: 45_000, sessionsRevoked: true })}, now())`;
    const h2 = await historique(u.id, (e) => e.result === 'session_revoked');
    const incident = h2.find((e) => e.result === 'session_revoked')!;
    expect(incident.category).toBe('security');
    expect(LOGIN_RESULT_LABEL[incident.result]).toBe('Déconnexion par précaution');
    expect(incident.detail).toContain('45 s après son renouvellement');
    // Les deux événements restent distincts dans la même fiche.
    expect(h2.filter((e) => e.result === 'app_signed_out')).toHaveLength(1);
  });

  it('L115A-E04 #798 CA05 : les refus véritables gardent leurs refus, aucune protection relâchée', async () => {
    const u = await compte();
    const suspendu = await compte('SUSPENDED');

    // Mot de passe faux : refus propre, jamais un succès.
    expect((await connecter(new Appareil(), u.email, 'MauvaisMotDePasse1!')).status).toBe(401);
    expect((await connecter(new Appareil(), suspendu.email)).status).toBe(403);

    // Jeton de renouvellement révoqué par une déconnexion volontaire.
    const app = new Appareil();
    expect((await connecter(app, u.email)).status).toBe(200);
    const refresh = app.jar.get('refresh_token')!;
    expect((await deconnecter(app, { [LOGOUT_REASON_HEADER]: 'user' })).status).toBe(200);
    const { POST: renouveler } = await import('@/app/api/auth/refresh/route');
    const rejoue = new Appareil();
    rejoue.jar.set('refresh_token', refresh);
    expect((await renouveler(rejoue.req('/api/auth/refresh', 'POST', {}))).status).toBe(401);

    // Appel sans cookie : 401 du middleware réel (cookie non transmis).
    const { middleware } = await import('@/middleware');
    const sansCookie = await middleware(app.req('/api/users/me', 'GET', undefined, {}, false));
    expect(sansCookie.status).toBe(401);
    expect((await sansCookie.json()).code).toBe('MISSING_TOKEN');

    // Obligation de double authentification toujours appliquée.
    await obligation(new Date(Date.now() - 86_400_000));
    const app2 = new Appareil();
    const r = await connecter(app2, u.email);
    expect(r.status).toBe(200);
    const corps = await r.json() as { mfaRequired?: boolean };
    // Soit la connexion exige la seconde étape, soit la session émise est
    // refusée par la garde : dans les deux cas, aucun accès métier.
    if (!corps.mfaRequired) expect((await moi(app2)).status).toBe(403);
  });
});
