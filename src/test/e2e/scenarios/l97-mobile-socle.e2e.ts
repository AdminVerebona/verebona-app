/**
 * Lot 97 — socle serveur de l'application mobile (CDC 12), sur PostgreSQL 16
 * réel, par les routes et le dispatcher réels. Fournisseur push SIMULÉ
 * (`setMobilePushProviderForTests`) : aucun appel réseau.
 *
 *   L97-E01 enregistrement idempotent, jeton chiffré, jamais renvoyé ;
 *   L97-E02 appareil réattribué à l'utilisateur qui s'y connecte ; même jeton
 *           sur une autre installation → l'ancienne est révoquée (AUTH-13) ;
 *   L97-E03 Duo A ON / B OFF : seul A reçoit (PUSH-11, DUO-04, REC-038) ;
 *   L97-E04 deux appareils, déconnexion de A : B continue (REC-039/040) ;
 *           révocation de session → push coupé (AUTH-10, PUSH-08) ;
 *   L97-E05 jeton invalide nettoyé sans impact sur l'autre appareil (PUSH-07) ;
 *   L97-E06 reprise du même événement : aucun second push (PUSH-06) ;
 *   L97-E07 catalogue §18.3 (pas de push commercial), interrupteur `push`,
 *           fournisseur absent ;
 *   L97-E08 récapitulatif quotidien : un seul push par utilisateur et par jour
 *           même avec deux espaces (PUSH-12) ;
 *   L97-E09 payload minimal, lien HTTPS, livraison par appareil (PUSH-04/05) ;
 *   L97-E10 configuration publique, fichiers d'association (404 / 200) ;
 *   L97-E11 suppression : appareils supprimés avec l'utilisateur, compte
 *           supprimé → rattachement retiré ; neutralisation et diagnostic.
 *   L97-E12 (lot 94, décision PO M2) « Appareils connectés » : un appareil
 *           seulement enregistré pour le push n'est jamais une session ;
 *           « Déconnecter » une session coupe le push de son appareil (même
 *           sans crochet, filet du dispatcher) ; reconnexion sur le même
 *           appareil : le push suit la session neuve ; Duo : un membre ne
 *           voit ni ne déconnecte les sessions de l'autre.
 */
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import type { MobilePushMessage, MobilePushProvider, MobilePushSendResult } from '@/lib/mobile/push-provider';

const session = vi.hoisted(() => ({ userId: 0, currentAccountId: 0 as number | undefined, sid: undefined as string | undefined }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ ...session, email: 'e2e@test.invalid', role: 'USER', status: 'ACTIVE', planType: 'STANDARD' }),
    handleSessionError: () => new Response('unauthorized', { status: 401 }),
  },
}));
// E-mails hors périmètre : acceptés sans réseau.
vi.mock('@/lib/email/email-service', () => ({
  emailService: { send: async () => ({ success: true, providerMessageId: 'em-e2e' }) },
}));

const envoi = vi.hoisted(() => ({ messages: [] as MobilePushMessage[] }));
const fakeProvider: MobilePushProvider = {
  name: 'fake',
  async send(m: MobilePushMessage): Promise<MobilePushSendResult> {
    envoi.messages.push(m);
    if (m.token.startsWith('bad-')) return { ok: false, kind: 'invalid_token', code: 'UNREGISTERED', statusCode: 404 };
    return { ok: true, messageId: `projects/e2e/messages/${envoi.messages.length}` };
  },
};

const tok = (s: string) => `${s}-${'x'.repeat(40)}`;
const inst = () => crypto.randomUUID();

scenario('L97', 'Application mobile — socle serveur (push natif, versions, liens)', ({ sql, make }) => {
  beforeEach(async () => {
    envoi.messages.length = 0;
    const { setMobilePushProviderForTests } = await import('@/lib/mobile/push-provider');
    setMobilePushProviderForTests(fakeProvider);
    delete process.env.MOBILE_FEATURES_OFF;
  });
  afterEach(async () => {
    const { setMobilePushProviderForTests } = await import('@/lib/mobile/push-provider');
    setMobilePushProviderForTests(undefined);
  });
  afterAll(() => { delete process.env.MOBILE_FEATURES_OFF; });

  const enregistrer = async (userId: number, accountId: number, body: Record<string, unknown>, headers: Record<string, string> = {}) => {
    session.userId = userId;
    session.currentAccountId = accountId;
    const { POST } = await import('@/app/api/mobile/push-installations/route');
    const res = await POST(new NextRequest('http://x/api/mobile/push-installations', {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
    }));
    return { status: res.status, body: await res.json() as Record<string, any> };
  };
  const desinscrire = async (userId: number, installationId: string) => {
    session.userId = userId;
    const { DELETE } = await import('@/app/api/mobile/push-installations/current/route');
    const res = await DELETE(new NextRequest('http://x/api/mobile/push-installations/current', {
      method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ installationId }),
    }));
    return { status: res.status, body: await res.json() as Record<string, any> };
  };
  const ligne = async (installationId: string) => (await sql<Array<Record<string, any>>>`
    SELECT * FROM mobile_push_installations WHERE installation_id = ${installationId}`)[0];
  const dispatcher = async () => {
    const { processPending } = await import('@/lib/notifications');
    for (let i = 0; i < 20; i++) if ((await processPending(100)).claimed === 0) break;
  };
  const echeance = async (accountId: number, userIds: number[], cle: string) => {
    const { emit } = await import('@/lib/notifications');
    await emit({
      type: 'DEADLINE_DUE_IN_7_DAYS', recipientUserIds: userIds, accountId, entityType: 'agenda', entityId: cle,
      payload: { count: 1, date: '2026-11-02' }, dedupeKey: `l97:${cle}`, scheduledFor: new Date(),
    });
  };
  const livraisonsMobiles = async (userId: number) => sql<Array<{ status: string; code: string | null; inst: string }>>`
    SELECT d.status, d.last_error_code AS code, i.installation_id AS inst
      FROM notification_deliveries d JOIN mobile_push_installations i ON i.id = d.mobile_push_installation_id
     WHERE d.user_id = ${userId} ORDER BY d.created_at`;

  it('L97-E01 — enregistrement idempotent ; jeton chiffré au repos, jamais renvoyé', async () => {
    const c = await make.account();
    const id = inst();
    const r1 = await enregistrer(c.ownerUserId, c.id, { installationId: id, platform: 'ios', pushToken: tok('t1'), appVersion: '1.0.0', build: '7' });
    expect(r1.status).toBe(201);
    expect(r1.body).toMatchObject({ ok: true, created: true, installation: { status: 'active' }, pushEnabled: true, providerConfigured: true });
    expect(JSON.stringify(r1.body)).not.toContain(tok('t1'));
    const r2 = await enregistrer(c.ownerUserId, c.id, { installationId: id, platform: 'ios', pushToken: tok('t1b'), appVersion: '1.0.1' });
    expect(r2.status).toBe(200);
    expect(r2.body.created).toBe(false);
    const rows = await sql`SELECT 1 FROM mobile_push_installations WHERE installation_id = ${id}`;
    expect(rows).toHaveLength(1);
    const l = await ligne(id);
    expect(l).toMatchObject({ user_id: c.ownerUserId, account_id: c.id, platform: 'ios', app_version: '1.0.1', status: 'active', environment: 'local' });
    expect(l.push_token_enc).toMatch(/^v1:/);
    expect(l.push_token_enc).not.toContain('t1b');
    expect(l.push_token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('L97-E01b — validation : plateforme et identifiant concordent avec les en-têtes ; jeton requis', async () => {
    const c = await make.account();
    const id = inst();
    expect((await enregistrer(c.ownerUserId, c.id, { installationId: id, platform: 'android', pushToken: tok('v') }, { 'X-Verebona-Client': 'IOS' })).status).toBe(400);
    expect((await enregistrer(c.ownerUserId, c.id, { installationId: id, platform: 'ios', pushToken: tok('v') }, { 'X-Verebona-Installation-Id': inst() })).status).toBe(400);
    expect((await enregistrer(c.ownerUserId, c.id, { installationId: id, platform: 'ios', pushToken: 'court' })).status).toBe(400);
    // Tout depuis les en-têtes : accepté.
    const ok = await enregistrer(c.ownerUserId, c.id, { pushToken: tok('v') }, { 'X-Verebona-Client': 'ANDROID', 'X-Verebona-App-Version': '2.1.0+40', 'X-Verebona-Installation-Id': id });
    expect(ok.status).toBe(201);
    expect(await ligne(id)).toMatchObject({ platform: 'android', app_version: '2.1.0', build_number: '40' });
  });

  it('L97-E02 — changement d’utilisateur sur l’appareil ; même jeton réinstallé : l’ancienne installation est révoquée', async () => {
    const a = await make.account();
    const b = await make.account();
    const id = inst();
    await enregistrer(a.ownerUserId, a.id, { installationId: id, platform: 'android', pushToken: tok('partage') });
    const r = await enregistrer(b.ownerUserId, b.id, { installationId: id, platform: 'android', pushToken: tok('partage') });
    expect(r.body.created).toBe(false);
    expect((await ligne(id)).user_id).toBe(b.ownerUserId);
    const id2 = inst();
    await enregistrer(b.ownerUserId, b.id, { installationId: id2, platform: 'android', pushToken: tok('partage') });
    expect(await ligne(id)).toMatchObject({ status: 'revoked', status_reason: 'token_reassigned', push_token_enc: null, push_token_hash: null });
    expect((await ligne(id2)).status).toBe('active');
  });

  it('L97-E03 — Duo : A push activé, B push désactivé → seul A reçoit ; aucun envoi « au compte »', async () => {
    const duo = await make.account({ plan: 'premium_duo' });
    const b = await make.user();
    await sql`INSERT INTO account_memberships (account_id, user_id, role, status) VALUES (${duo.id}, ${b.id}, 'member', 'active')`;
    await sql`INSERT INTO notification_preferences (user_id, category, delivery_mode, channel, enabled)
              VALUES (${b.id}, 'deadlines', 'immediate', 'push', false)`;
    const ia = inst(); const ib = inst();
    await enregistrer(duo.ownerUserId, duo.id, { installationId: ia, platform: 'ios', pushToken: tok('duoA') });
    await enregistrer(b.id, duo.id, { installationId: ib, platform: 'android', pushToken: tok('duoB') });
    await echeance(duo.id, [duo.ownerUserId, b.id], `duo-${duo.id}`);
    await dispatcher();
    expect(envoi.messages.map((m) => m.token)).toEqual([tok('duoA')]);
    expect(await livraisonsMobiles(duo.ownerUserId)).toEqual([{ status: 'sent', code: null, inst: ia }]);
    expect(await livraisonsMobiles(b.id)).toEqual([]);
  });

  it('L97-E04 — deux appareils ; déconnexion de A : B continue ; révocation de session : push coupé', async () => {
    const c = await make.account();
    const ia = inst(); const ib = inst();
    await enregistrer(c.ownerUserId, c.id, { installationId: ia, platform: 'ios', pushToken: tok('devA') });
    // Intégration 92 + 97 : le `sid` est celui de la session vérifiée (getSession), plus un second décodage du jeton.
    session.sid = `sid-${ib}`;
    await enregistrer(c.ownerUserId, c.id, { installationId: ib, platform: 'android', pushToken: tok('devB') });
    session.sid = undefined;
    expect((await ligne(ib)).session_id).toBe(`sid-${ib}`);
    await echeance(c.id, [c.ownerUserId], `deux-${c.id}`);
    await dispatcher();
    expect(envoi.messages.map((m) => m.token).sort()).toEqual([tok('devA'), tok('devB')].sort());

    envoi.messages.length = 0;
    expect((await desinscrire(c.ownerUserId, ia)).body).toEqual({ ok: true, removed: true });
    expect((await desinscrire(c.ownerUserId, ia)).body).toEqual({ ok: true, removed: false }); // idempotent
    expect(await ligne(ia)).toMatchObject({ status: 'logged_out', push_token_enc: null });
    await echeance(c.id, [c.ownerUserId], `apres-logout-${c.id}`);
    await dispatcher();
    expect(envoi.messages.map((m) => m.token)).toEqual([tok('devB')]);

    // Filet serveur : révocation de la session (branchée sur onSessionRevoked à l'intégration).
    const { deactivatePushForSession } = await import('@/lib/mobile/push-installations');
    expect(await deactivatePushForSession({})).toBe(0); // jamais « tout désactiver »
    expect(await deactivatePushForSession({ sessionId: `sid-${ib}`, userId: c.ownerUserId + 999_999 })).toBe(0); // autre utilisateur
    // Intégration 92 + 97 : la session du registre (92) est terminée → crochet
    // onSessionRevoked (branché au démarrage) → push de B coupé.
    const { onSessionRevoked } = await import('@/lib/auth/session-hooks');
    const { registerMobilePushSessionHook } = await import('@/lib/mobile/session-revocation-hook');
    const offs: Array<() => void> = [];
    registerMobilePushSessionHook((h) => offs.push(onSessionRevoked(h, { key: 'mobile-push' })));
    const { recordSession, endSession, replaceSessions } = await import('@/lib/auth/session-registry');
    const { readSessionClient } = await import('@/lib/auth/session-client');
    const client = readSessionClient({ headers: new Headers({ 'x-verebona-client': 'android', 'x-verebona-installation-id': ib }) });
    const exp = new Date(Date.now() + 30 * 24 * 3600 * 1000);
    await recordSession({ sid: `sid-${ib}`, userId: c.ownerUserId, client, authMethod: 'password', registeredVia: 'LOGIN', refreshTokenHash: `h-${ib}`, expiresAt: exp, now: new Date() });
    // Remplacement sur le MÊME appareil (reconnexion) : le push reste actif.
    await recordSession({ sid: `sid2-${ib}`, userId: c.ownerUserId, client, authMethod: 'password', registeredVia: 'LOGIN', refreshTokenHash: `h2-${ib}`, expiresAt: exp, now: new Date() });
    await replaceSessions({ userId: c.ownerUserId, sid: `sid-${ib}`, exceptSid: `sid2-${ib}` });
    expect((await ligne(ib)).status).toBe('active');
    await sql`UPDATE mobile_push_installations SET session_id = ${`sid2-${ib}`} WHERE installation_id = ${ib}`;
    expect(await endSession(c.ownerUserId, `sid2-${ib}`)).toBe(true);
    offs.forEach((f) => f());
    expect(await ligne(ib)).toMatchObject({ status: 'logged_out', status_reason: 'session_revoked', push_token_enc: null });
    envoi.messages.length = 0;
    await echeance(c.id, [c.ownerUserId], `apres-revocation-${c.id}`);
    await dispatcher();
    expect(envoi.messages).toEqual([]);
  });

  it('L97-E05 — jeton invalide : installation nettoyée, l’autre appareil servi', async () => {
    const c = await make.account();
    const bad = inst(); const good = inst();
    await enregistrer(c.ownerUserId, c.id, { installationId: bad, platform: 'ios', pushToken: tok('bad-1') });
    await enregistrer(c.ownerUserId, c.id, { installationId: good, platform: 'ios', pushToken: tok('ok-1') });
    await echeance(c.id, [c.ownerUserId], `invalide-${c.id}`);
    await dispatcher();
    expect(await ligne(bad)).toMatchObject({ status: 'invalid_token', push_token_enc: null, push_token_hash: null, last_error_code: 'UNREGISTERED' });
    expect((await ligne(good)).last_success_at).not.toBeNull();
    const l = await livraisonsMobiles(c.ownerUserId);
    expect(l.find((x) => x.inst === bad)).toMatchObject({ status: 'expired', code: 'invalid_token:UNREGISTERED' });
    expect(l.find((x) => x.inst === good)).toMatchObject({ status: 'sent' });
    const [o] = await sql<{ status: string }[]>`SELECT status FROM notification_outbox WHERE dedupe_key = ${`l97:invalide-${c.id}:u${c.ownerUserId}`}`;
    expect(o.status).toBe('sent');
  });

  it('L97-E06 — reprise du même événement : aucun second push pour un appareil déjà servi', async () => {
    const c = await make.account();
    const i1 = inst();
    await enregistrer(c.ownerUserId, c.id, { installationId: i1, platform: 'android', pushToken: tok('dedup') });
    await echeance(c.id, [c.ownerUserId], `dedup-${c.id}`);
    await dispatcher();
    expect(envoi.messages).toHaveLength(1);
    // Reprise technique (ligne remise en file, double traitement) — même événement.
    await sql`UPDATE notification_outbox SET status = 'pending', processed_at = NULL WHERE dedupe_key = ${`l97:dedup-${c.id}:u${c.ownerUserId}`}`;
    await dispatcher();
    expect(envoi.messages).toHaveLength(1);
    expect((await livraisonsMobiles(c.ownerUserId)).map((x) => x.code)).toEqual([null, 'mobile_push_duplicate_suppressed']);
  });

  it('L97-E07 — pas de push commercial (§18.3) ; interrupteur `push` ; fournisseur non configuré', async () => {
    const c = await make.account();
    const i1 = inst();
    await enregistrer(c.ownerUserId, c.id, { installationId: i1, platform: 'ios', pushToken: tok('cat') });
    const { emit } = await import('@/lib/notifications');
    await emit({ type: 'TRIAL_ENDING', recipientUserIds: [c.ownerUserId], accountId: c.id, payload: {}, dedupeKey: `l97:trial-${c.id}`, scheduledFor: new Date() });
    await dispatcher();
    expect(envoi.messages).toEqual([]);
    expect((await livraisonsMobiles(c.ownerUserId)).map((x) => x.code)).toEqual(['mobile_push_not_in_catalog']);

    process.env.MOBILE_FEATURES_OFF = 'ios:push';
    await echeance(c.id, [c.ownerUserId], `coupe-${c.id}`);
    await dispatcher();
    expect(envoi.messages).toEqual([]);
    delete process.env.MOBILE_FEATURES_OFF;

    const { setMobilePushProviderForTests } = await import('@/lib/mobile/push-provider');
    setMobilePushProviderForTests(null);
    await echeance(c.id, [c.ownerUserId], `sans-fournisseur-${c.id}`);
    await dispatcher();
    expect((await livraisonsMobiles(c.ownerUserId)).map((x) => x.code)).toEqual(['mobile_push_not_in_catalog', 'mobile_push_disabled', 'mobile_push_not_configured']);
    expect((await ligne(i1)).status).toBe('active'); // rien n'est perdu : le push reprendra
  });

  it('L97-E08 — récapitulatif quotidien : un seul push par utilisateur et par jour, même avec deux espaces', async () => {
    const perso = await make.account();
    const duo = await make.account({ plan: 'premium_duo' });
    const u = perso.ownerUserId;
    await sql`INSERT INTO account_memberships (account_id, user_id, role, status) VALUES (${duo.id}, ${u}, 'member', 'active')`;
    await sql`INSERT INTO notification_preferences (user_id, category, delivery_mode, channel, enabled)
              VALUES (${u}, 'to_process', 'daily_digest', 'push', true)`;
    await enregistrer(u, perso.id, { installationId: inst(), platform: 'ios', pushToken: tok('recap') });
    const { emit } = await import('@/lib/notifications');
    const recap = (accountId: number) => emit({
      type: 'TO_PROCESS_DAILY_DIGEST', recipientUserIds: [u], accountId, entityType: 'to_process_digest', entityId: '2026-10-26',
      payload: { total: 2, byKind: { ARBITRATE: 1, COMPLETE: 1 }, byPriority: { DO_FIRST: 1, DO_NEXT: 1, CAN_WAIT: 0 } },
      dedupeKey: `l97:recap:a${accountId}`, scheduledFor: new Date(),
    });
    await recap(perso.id);
    await recap(duo.id);
    await dispatcher();
    expect(envoi.messages).toHaveLength(1);
    expect((await livraisonsMobiles(u)).map((x) => x.code).sort()).toEqual(['digest_already_pushed_today', null].sort());
  });

  it('L97-E09 — payload minimal : lien HTTPS de l’écran, catégorie, regroupement ; aucun jeton ni détail', async () => {
    const c = await make.account();
    await enregistrer(c.ownerUserId, c.id, { installationId: inst(), platform: 'android', pushToken: tok('payload') });
    process.env.APP_URL = 'https://app.preprod.verebona.example';
    try {
      await echeance(c.id, [c.ownerUserId], `payload-${c.id}`);
      await dispatcher();
    } finally {
      delete process.env.APP_URL;
    }
    const [m] = envoi.messages;
    expect(m.data.href).toBe(`https://app.preprod.verebona.example/agenda?date=2026-11-02&space=${c.id}`);
    expect(Object.keys(m.data).sort()).toEqual(['category', 'href', 'notificationId', 'type'].sort());
    expect(m.data.category).toBe('deadlines');
    expect(m.collapseKey).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(m.data)).not.toMatch(/token|dedupe|l97:/i);
    expect(m.title.length).toBeLessThanOrEqual(120);
  });

  it('L97-E10 — configuration publique ; fichiers d’association : 404 sans réglage, JSON sinon', async () => {
    process.env.MOBILE_MIN_VERSION_IOS = '3.0.0';
    try {
      const { GET } = await import('@/app/api/mobile/config/route');
      const res = await GET(new NextRequest('http://x/api/mobile/config', { headers: { 'X-Verebona-Client': 'IOS', 'X-Verebona-App-Version': '2.9.0' } }));
      const body = await res.json();
      expect(body).toMatchObject({ schema: 'verebona.mobile-config/1', platforms: { ios: { minVersion: '3.0.0' } }, client: { updateRequired: true } });
    } finally {
      delete process.env.MOBILE_MIN_VERSION_IOS;
    }
    const aasa = await import('@/app/.well-known/apple-app-site-association/route');
    expect((await aasa.GET()).status).toBe(404);
    process.env.MOBILE_IOS_TEAM_ID = 'ABCDE12345';
    process.env.MOBILE_IOS_BUNDLE_IDS = 'fr.verebona.app.preprod';
    try {
      const r = await aasa.GET();
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toBe('application/json');
      expect((await r.json()).applinks.details[0].appIDs).toEqual(['ABCDE12345.fr.verebona.app.preprod']);
    } finally {
      delete process.env.MOBILE_IOS_TEAM_ID; delete process.env.MOBILE_IOS_BUNDLE_IDS;
    }
    const al = await import('@/app/.well-known/assetlinks.json/route');
    expect((await al.GET()).status).toBe(404);
  });

  it('L97-E11 — suppression : appareils supprimés avec l’utilisateur ; compte supprimé → rattachement retiré ; registres', async () => {
    const fk = await sql<{ col: string; action: string }[]>`
      SELECT a.attname AS col, c.confdeltype AS action
        FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
       WHERE c.conrelid = 'mobile_push_installations'::regclass AND c.contype = 'f' ORDER BY a.attname`;
    expect(fk).toEqual([{ col: 'account_id', action: 'n' }, { col: 'user_id', action: 'c' }]);
    const c = await make.account();
    const i1 = inst();
    await enregistrer(c.ownerUserId, c.id, { installationId: i1, platform: 'ios', pushToken: tok('suppr') });
    await sql`DELETE FROM notification_deliveries WHERE user_id = ${c.ownerUserId}`;
    await sql`DELETE FROM users WHERE id = ${c.ownerUserId}`.catch(async () => {
      // Le titulaire porte des références métier : on supprime d'abord le compte.
      await sql`DELETE FROM accounts WHERE id = ${c.id}`;
      expect((await ligne(i1)).account_id).toBeNull();
      await sql`DELETE FROM users WHERE id = ${c.ownerUserId}`;
    });
    expect(await ligne(i1)).toBeUndefined();

    const { DIAG_TABLE_COVERAGE } = await import('@/services/admin/diagnostics-export/coverage');
    const { excludedColumnMotif } = await import('@/services/admin/diagnostics-export/security');
    expect(DIAG_TABLE_COVERAGE.mobile_push_installations).toBeTruthy();
    for (const col of ['push_token_enc', 'push_token_hash', 'session_id']) expect(excludedColumnMotif('mobile_push_installations', col), col).not.toBeNull();
    expect(excludedColumnMotif('mobile_push_installations', 'app_version')).toBeNull();
    const { NEUTRALIZATION_PLAN } = await import('@/services/ai/snapshot/neutralization-plan');
    expect(NEUTRALIZATION_PLAN.map((s) => s.id)).toContain('mobile_push_installations');
  });
  it('L97-E12 — M2 : sessions ≠ appareils push ; révocation → push coupé ; isolation Duo', async () => {
    const duo = await make.account({ plan: 'premium_duo' });
    const b = await make.user();
    await sql`INSERT INTO account_memberships (account_id, user_id, role, status) VALUES (${duo.id}, ${b.id}, 'member', 'active')`;
    const a = duo.ownerUserId;
    const { recordSession, sessionPublicId, isSessionRevoked, replaceSessions } = await import('@/lib/auth/session-registry');
    const { readSessionClient } = await import('@/lib/auth/session-client');
    const exp = new Date(Date.now() + 30 * 24 * 3600 * 1000);
    const ouvrir = async (sid: string, userId: number, headers: Record<string, string>) => {
      const client = readSessionClient({ headers: new Headers(headers) });
      await recordSession({ sid, userId, client, authMethod: 'password', registeredVia: 'LOGIN', refreshTokenHash: `h-${sid}`, expiresAt: exp, now: new Date() });
    };
    const k = crypto.randomUUID().slice(0, 8);
    const ia = inst(); const ipush = inst();
    const sWebA = `web-a-${k}`; const sMobA = `mob-a-${k}`; const sWebB = `web-b-${k}`;
    await ouvrir(sWebA, a, { 'user-agent': 'Mozilla/5.0 (Macintosh) Firefox/130.0' });
    await ouvrir(sMobA, a, { 'x-verebona-client': 'android', 'x-verebona-installation-id': ia });
    await ouvrir(sWebB, b.id, { 'user-agent': 'Mozilla/5.0 (Windows) Chrome/130.0' });
    // Téléphone de A connecté (session sMobA) + appareil SEULEMENT enregistré pour le push (aucune session).
    session.sid = sMobA;
    await enregistrer(a, duo.id, { installationId: ia, platform: 'android', pushToken: tok(`m2a-${k}`) });
    session.sid = undefined;
    await enregistrer(a, duo.id, { installationId: ipush, platform: 'ios', pushToken: tok(`m2p-${k}`) });

    const { GET } = await import('@/app/api/users/me/sessions/route');
    const { DELETE } = await import('@/app/api/users/me/sessions/[id]/route');
    const lister = async (userId: number, sid: string) => {
      session.userId = userId; session.sid = sid;
      const res = await GET(new NextRequest('http://x/api/users/me/sessions'));
      return await res.json() as { sessions: Array<{ id: string; current: boolean; clientType: string }> };
    };
    const deconnecter = async (userId: number, sid: string, id: string) => {
      session.userId = userId; session.sid = sid;
      return (await DELETE(new NextRequest(`http://x/api/users/me/sessions/${id}`, { method: 'DELETE' }), { params: Promise.resolve({ id }) })).status;
    };

    // 1. « Appareils connectés » de A : ses DEUX sessions, jamais l'appareil push seul.
    const vueA = await lister(a, sWebA);
    expect(vueA.sessions.map((x) => x.id).sort()).toEqual([sessionPublicId(sWebA), sessionPublicId(sMobA)].sort());
    expect(vueA.sessions.find((x) => x.current)?.id).toBe(sessionPublicId(sWebA));
    const brut = JSON.stringify(vueA);
    for (const secret of [ia, ipush, tok(`m2a-${k}`), tok(`m2p-${k}`), sWebA, sMobA]) expect(brut).not.toContain(secret);

    // 2. Duo : B ne voit que SA session et ne peut pas déconnecter celles de A (404, même réponse qu'inconnue).
    const vueB = await lister(b.id, sWebB);
    expect(vueB.sessions.map((x) => x.id)).toEqual([sessionPublicId(sWebB)]);
    expect(await deconnecter(b.id, sWebB, sessionPublicId(sMobA))).toBe(404);
    expect(await deconnecter(b.id, sWebB, sessionPublicId(sWebA))).toBe(404);
    expect(await isSessionRevoked({ userId: a, sid: sMobA })).toBe(false);
    expect((await ligne(ia)).status).toBe('active');

    // 3. A déconnecte son téléphone depuis le web — SANS crochet branché : le
    //    filet du dispatcher suffit, plus aucun push vers ce téléphone.
    expect(await deconnecter(a, sWebA, sessionPublicId(sMobA))).toBe(200);
    expect(await isSessionRevoked({ userId: a, sid: sMobA })).toBe(true);
    envoi.messages.length = 0;
    await echeance(duo.id, [a], `m2-filet-${k}`);
    await dispatcher();
    expect(envoi.messages.map((m) => m.token)).toEqual([tok(`m2p-${k}`)]);

    // 4. Avec le crochet (branché au démarrage) : reconnexion du téléphone (session
    //    neuve, même appareil) → le push suit ; « Déconnecter » la session neuve → coupé.
    const { onSessionRevoked } = await import('@/lib/auth/session-hooks');
    const { registerMobilePushSessionHook } = await import('@/lib/mobile/session-revocation-hook');
    const offs: Array<() => void> = [];
    registerMobilePushSessionHook((h) => offs.push(onSessionRevoked(h, { key: 'mobile-push' })));
    try {
      const sMobA2 = `mob-a2-${k}`; const sMobA3 = `mob-a3-${k}`;
      await ouvrir(sMobA2, a, { 'x-verebona-client': 'android', 'x-verebona-installation-id': ia });
      session.sid = sMobA2;
      await enregistrer(a, duo.id, { installationId: ia, platform: 'android', pushToken: tok(`m2a-${k}`) });
      await ouvrir(sMobA3, a, { 'x-verebona-client': 'android', 'x-verebona-installation-id': ia });
      await replaceSessions({ userId: a, sid: sMobA2, exceptSid: sMobA3 });
      expect(await ligne(ia)).toMatchObject({ status: 'active', session_id: sMobA3 });
      envoi.messages.length = 0;
      await echeance(duo.id, [a], `m2-remplacee-${k}`);
      await dispatcher();
      expect(envoi.messages.map((m) => m.token).sort()).toEqual([tok(`m2a-${k}`), tok(`m2p-${k}`)].sort());

      expect(await deconnecter(a, sWebA, sessionPublicId(sMobA3))).toBe(200);
      expect(await ligne(ia)).toMatchObject({ status: 'logged_out', status_reason: 'session_revoked', push_token_enc: null });
      expect((await ligne(ipush)).status).toBe('active'); // autre appareil non touché
    } finally {
      offs.forEach((f) => f());
      session.sid = undefined;
    }
  });
});
