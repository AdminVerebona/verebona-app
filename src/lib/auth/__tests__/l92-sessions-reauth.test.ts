/**
 * Lot 92 — registre des sessions (CDC 18 §20, SESS-05..08, SEC-03) et preuve
 * de réauthentification (§18, REAUTH-01/02/06). Stockages en mémoire
 * (setup.ts) ; le parcours complet en base est couvert par l'e2e L92.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

vi.mock('@/db', async (orig) => ({
  ...(await orig<typeof import('@/db')>()),
  getUserSessionCutoff: vi.fn(async () => null),
}));
const activity: Array<{ activityType: string; details?: Record<string, unknown> }> = [];
vi.mock('@/lib/audit-logger', () => ({ logUserActivity: async (a: { activityType: string }) => { activity.push(a); } }));

import { createMemorySessionRegistryStore } from '@/lib/auth/session-registry-memory';
import {
  __setSessionRegistryStoreForTests, isSessionRevoked, listUserSessions, recordSession, revokeOtherUserSessions,
  revokeUserSessionByPublicId, sessionPublicId, endSession, purgeSessionRegistry,
} from '@/lib/auth/session-registry';
import { describeSessionDevice, deviceKeyFor, readSessionClient, resolveClientType, type SessionClientInfo } from '@/lib/auth/session-client';
import { authenticDeviceId, buildDeviceCookieValue } from '@/lib/auth/device-trust';
import { onSessionRevoked, type RevokedSessionInfo } from '@/lib/auth/session-hooks';
import { createMemoryReauthProofStore } from '@/lib/auth/reauth-memory';
import {
  __setReauthProofStoreForTests, consumeReauthProof, getReauthState, issueReauthProof, requireFreshReauth,
  REAUTH_PROOF_TTL_MS, listReauthMethodsFor, registerReauthMethod, ReauthError,
} from '@/lib/auth/reauth';
import { issueSession } from '@/lib/auth/session-issuance';
import { generateAccessToken, verifyAccessToken } from '@/lib/jwt';
import { serverCacheClear } from '@/lib/server-cache';

const UA_CHROME_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const UA_SAFARI_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const client = (over: Partial<SessionClientInfo> = {}): SessionClientInfo => ({
  clientType: 'WEB', appVersion: null, deviceKey: null, deviceSource: null, deviceLabel: 'PC Windows', browserLabel: 'Chrome', ...over,
});
const subject = (id: number) => ({ id, email: `u${id}@exemple.fr`, role: 'USER' as never, planType: 'STANDARD' as never, status: 'ACTIVE' as never });
const T0 = new Date('2026-10-26T10:00:00.000Z');
const in30d = (d: Date) => new Date(d.getTime() + 30 * 86_400_000);

let store: ReturnType<typeof createMemorySessionRegistryStore>;
let proofs: ReturnType<typeof createMemoryReauthProofStore>;
beforeEach(() => {
  store = createMemorySessionRegistryStore();
  __setSessionRegistryStoreForTests(store);
  proofs = createMemoryReauthProofStore();
  __setReauthProofStoreForTests(proofs);
  activity.length = 0;
  serverCacheClear();
});

async function ouvrir(userId: number, sid: string, over: Partial<SessionClientInfo> = {}, now = T0) {
  return recordSession({ sid, userId, client: client(over), authMethod: 'password', registeredVia: 'LOGIN', refreshTokenHash: `h-${sid}`, expiresAt: in30d(now), now });
}

describe('L92-CLIENT appareil décrit sans fingerprinting (§20.2, §37, CDC 12 §25)', () => {
  it('type de client déclaratif : web|pwa|ios|android, défaut WEB, valeurs inconnues ignorées', () => {
    const h = (v?: string) => new Headers(v === undefined ? {} : { 'x-verebona-client': v });
    expect(resolveClientType(h())).toBe('WEB');
    expect(resolveClientType(h('pwa'))).toBe('PWA');
    expect(resolveClientType(h('IOS'))).toBe('IOS');
    expect(resolveClientType(h('android'))).toBe('ANDROID');
    expect(resolveClientType(h('admin'))).toBe('WEB');
  });

  it('libellés lisibles ; User-Agent illisible → « Appareil » / « Navigateur web » ; application → « Application Verebona »', () => {
    expect(describeSessionDevice(UA_CHROME_WIN, 'WEB')).toEqual({ deviceLabel: 'PC Windows', browserLabel: 'Chrome' });
    expect(describeSessionDevice(UA_SAFARI_IPHONE, 'WEB')).toEqual({ deviceLabel: 'iPhone', browserLabel: 'Safari' });
    expect(describeSessionDevice('???', 'WEB')).toEqual({ deviceLabel: 'Appareil', browserLabel: 'Navigateur web' });
    expect(describeSessionDevice(UA_SAFARI_IPHONE, 'IOS')).toEqual({ deviceLabel: 'iPhone', browserLabel: 'Application Verebona' });
  });

  it('lot 96B (P5) : l’identifiant d’installation DÉCLARÉ ne fait jamais l’appareil ; seul le cookie signé prouvé par le serveur', () => {
    const uuid = '0f8fad5b-d9cb-469f-a165-70867728950e';
    const req = (h: Record<string, string>, cookie?: string) => ({ headers: new Headers(h), cookies: { get: (n: string) => (n === 'vb_device' && cookie ? { value: cookie } : undefined) } });
    const natif = readSessionClient(req({ 'x-verebona-client': 'ios', 'x-verebona-installation-id': uuid, 'x-verebona-app-version': '1.2.0' }));
    expect(natif).toMatchObject({ clientType: 'IOS', deviceSource: null, deviceKey: null, appVersion: '1.2.0', browserLabel: 'Application Verebona' });
    expect(readSessionClient(req({ 'x-verebona-installation-id': uuid })).deviceKey).toBeNull();
    // Application avec le cookie signé de sa WebView : empreinte du cookie, jamais en clair.
    const { value, deviceId } = buildDeviceCookieValue(null, { userId: 1 });
    const avecCookie = readSessionClient(req({ 'x-verebona-client': 'ios', 'x-verebona-installation-id': uuid }, value));
    expect(avecCookie).toMatchObject({ deviceSource: 'cookie', deviceKey: deviceKeyFor('cookie', deviceId) });
    expect(avecCookie.deviceKey).not.toContain(deviceId);
    // Cookie fabriqué (identifiant choisi, sans entrée signée) : simple déclaration, ignorée.
    expect(readSessionClient(req({}, `d1.${deviceId}.`)).deviceKey).toBeNull();
    expect(authenticDeviceId(`d1.${deviceId}.`)).toBeNull();
    // …et le serveur ne signe jamais une entrée sur un identifiant choisi par le client.
    expect(buildDeviceCookieValue(`d1.${deviceId}.`, { userId: 666 }).deviceId).not.toBe(deviceId);
    expect(buildDeviceCookieValue(value, { userId: 2 }).deviceId).toBe(deviceId);
  });
});

describe('L92-SESS registre des sessions', () => {
  it('SESS-05 chaque session ouverte figure au registre ; la rotation met à jour la même ligne', async () => {
    expect(await ouvrir(1, 's1')).toBe('created');
    expect(await recordSession({ sid: 's1', userId: 1, client: client(), authMethod: null, registeredVia: 'REFRESH', refreshTokenHash: 'h2', expiresAt: in30d(T0), now: T0 })).toBe('updated');
    expect(store.rows.get('s1')).toMatchObject({ refreshVersion: 2, refreshTokenHash: 'h2', registeredVia: 'LOGIN' });
  });

  it('SESS-06 / SESS-09 liste : appareil, navigateur, dernière activité, badge courant — ni sid, ni IP', async () => {
    await ouvrir(1, 'a', {}, T0);
    await ouvrir(1, 'b', { deviceLabel: 'iPhone', browserLabel: 'Safari' }, new Date(T0.getTime() + 60_000));
    await ouvrir(2, 'autre');
    const list = await listUserSessions(1, 'a', new Date(T0.getTime() + 120_000));
    expect(list.map((s) => s.current)).toEqual([true, false]);
    expect(list[1]).toMatchObject({ deviceLabel: 'iPhone', browserLabel: 'Safari' });
    for (const s of list) expect(Object.keys(s).sort()).toEqual(['browserLabel', 'clientType', 'createdAt', 'current', 'deviceLabel', 'id', 'lastSeenAt']);
    expect(list.map((s) => s.id)).not.toContain('a');
    expect(list[0].id).toBe(sessionPublicId('a'));
  });

  it('SESS-07 / SEC-03 révocation unitaire immédiate ; isolation : l’identifiant d’un autre compte est introuvable', async () => {
    await ouvrir(1, 'a');
    await ouvrir(1, 'b');
    await ouvrir(2, 'c');
    expect(await revokeUserSessionByPublicId(1, sessionPublicId('c'), 'USER_REVOKED')).toBeNull();
    expect(await isSessionRevoked({ userId: 2, sid: 'c' })).toBe(false);
    expect((await revokeUserSessionByPublicId(1, sessionPublicId('b'), 'USER_REVOKED'))?.sid).toBe('b');
    expect(await isSessionRevoked({ userId: 1, sid: 'b' })).toBe(true);
    expect(await isSessionRevoked({ userId: 1, sid: 'a' })).toBe(false);
    // Une session révoquée n'est jamais réinscrite par un renouvellement.
    expect(await ouvrir(1, 'b')).toBe('revoked');
  });

  it('Q5 session inconnue du registre (ouverte avant le déploiement) ou sans sid : jamais refusée pour cette raison', async () => {
    expect(await isSessionRevoked({ userId: 1, sid: 'jamais-vue' })).toBe(false);
    expect(await isSessionRevoked({ userId: 1 })).toBe(false);
  });

  it('SESS-08 « autres appareils » : toutes sauf la courante ; crochets onSessionRevoked appelés', async () => {
    const vus: RevokedSessionInfo[] = [];
    const off = onSessionRevoked((s) => { vus.push(s); });
    try {
      await ouvrir(1, 'a'); await ouvrir(1, 'b'); await ouvrir(1, 'c'); await ouvrir(2, 'd');
      const r = await revokeOtherUserSessions(1, 'a', 'USER_REVOKED_OTHERS');
      expect(r.map((x) => x.sid).sort()).toEqual(['b', 'c']);
      expect(vus.map((v) => [v.sid, v.scope, v.sameDeviceContinues])).toEqual(expect.arrayContaining([['b', 'others', false], ['c', 'others', false]]));
      expect(await isSessionRevoked({ userId: 2, sid: 'd' })).toBe(false);
      await endSession(1, 'a');
      expect(vus.at(-1)).toMatchObject({ sid: 'a', scope: 'logout', reason: 'LOGOUT' });
    } finally { off(); }
  });

  it('purge : lignes terminées depuis plus de 90 jours seulement', async () => {
    await ouvrir(1, 'vieille', {}, new Date('2026-01-01T00:00:00Z'));
    await ouvrir(1, 'active', {}, T0);
    expect(await purgeSessionRegistry(T0)).toBe(1);
    expect([...store.rows.keys()]).toEqual(['active']);
  });
});

describe('L92-ISSUE fonction d’émission unique', () => {
  const req = (cookie?: string, h: Record<string, string> = {}) => new NextRequest('http://localhost:3000/api/auth/login', {
    method: 'POST', headers: { 'user-agent': UA_CHROME_WIN, ...(cookie ? { cookie } : {}), ...h },
  });

  it('ouverture : cookies + registre + journal SESSION_CREATED ; rotation : même sid, version suivante', async () => {
    const res = NextResponse.json({});
    const s = await issueSession(req(), res, { kind: 'open', method: 'password', subject: subject(7), deviceId: 'AAAAAAAAAAAAAAAAAAAAAA' });
    expect(res.cookies.get('access_token')?.value).toBe(s.accessToken);
    expect(res.cookies.get('refresh_token')?.value).toBe(s.refreshToken);
    expect((await verifyAccessToken(s.accessToken))?.sid).toBe(s.sid);
    expect(store.rows.get(s.sid)).toMatchObject({ userId: 7, clientType: 'WEB', deviceLabel: 'PC Windows', browserLabel: 'Chrome', authMethod: 'password' });
    expect(activity.find((a) => a.activityType === 'SESSION_CREATED')?.details).toMatchObject({ method: 'password', clientType: 'WEB', knownDevice: false, newDeviceAlert: 'sent' });

    const r = await issueSession(req(), NextResponse.json({}), { kind: 'rotate', sid: s.sid, subject: subject(7) });
    expect(r.sid).toBe(s.sid);
    expect(store.rows.get(s.sid)?.refreshVersion).toBe(2);
  });

  it('CDC 12 AUTH-14 : une nouvelle connexion n’éjecte jamais un autre appareil ; seule l’ancienne session de CE navigateur est remplacée', async () => {
    const autre = await issueSession(req(undefined, { 'x-verebona-client': 'ios', 'x-verebona-installation-id': '0f8fad5b-d9cb-469f-a165-70867728950e' }), NextResponse.json({}), { kind: 'open', method: 'password', subject: subject(8) });
    const cookie = buildDeviceCookieValue(null, { userId: 8 });
    const premiere = await issueSession(req(), NextResponse.json({}), { kind: 'open', method: 'password', subject: subject(8), deviceId: cookie.deviceId });
    // Reconnexion depuis le même navigateur, qui présente encore son ancien jeton et son cookie signé.
    const seconde = await issueSession(req(`refresh_token=${premiere.refreshToken}; vb_device=${cookie.value}`), NextResponse.json({}), { kind: 'open', method: 'password', replaceCurrent: true, subject: subject(8), deviceId: cookie.deviceId });
    expect(store.rows.get(premiere.sid)).toMatchObject({ revocationReason: 'SESSION_REPLACED' });
    expect(store.rows.get(seconde.sid)?.revokedAt).toBeNull();
    expect(store.rows.get(autre.sid)?.revokedAt).toBeNull();
    // Lot 96B (P5) : l'application sans cookie signé n'a pas d'empreinte (l'en-tête d'installation est déclaratif).
    expect(store.rows.get(autre.sid)).toMatchObject({ clientType: 'IOS', browserLabel: 'Application Verebona', deviceSource: null, deviceKey: null });
    expect(activity.filter((a) => a.activityType === 'SESSION_CREATED').at(-1)?.details).toMatchObject({ knownDevice: true, newDeviceAlert: 'known_device' });
  });

  it('câblage : aucune route n’émet de jetons ni ne pose de cookies de session en dehors de issueSession', () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) { if (f !== '__tests__') walk(p); } else if (/\.tsx?$/.test(f)) files.push(p);
      }
    };
    walk(join(process.cwd(), 'src/app'));
    walk(join(process.cwd(), 'src/services'));
    // Intégration 92 + 93 : la connexion Google / Apple passe aussi par issueSession.
    walk(join(process.cwd(), 'src/lib/auth/oauth'));
    const fautifs = files.filter((f) => /generateSessionTokens|generateAccessToken|generateRefreshToken|setSessionCookies\(/.test(readFileSync(f, 'utf8')));
    expect(fautifs).toEqual([]);
    const issuance = readFileSync(join(process.cwd(), 'src/lib/auth/session-issuance.ts'), 'utf8');
    expect(issuance).toMatch(/setSessionCookies\(response, \{ accessToken, refreshToken \}\)/);
    expect(issuance).toMatch(/recordSession\(/);
    const social = readFileSync(join(process.cwd(), 'src/lib/auth/oauth/session-bridge.ts'), 'utf8');
    expect(social).toMatch(/issueSession\(request, response, \{\s*kind: 'open',\s*method,/);
  });

  it('intégration 93 : une seule preuve (92) — plus de cookie vb_reauth, Google / Apple enregistrés comme méthodes à redirection', () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) { if (f !== '__tests__') walk(p); } else if (/\.tsx?$/.test(f)) files.push(p);
      }
    };
    walk(join(process.cwd(), 'src'));
    expect(files.filter((f) => /vb_reauth/.test(readFileSync(f, 'utf8')))).toEqual([]);
    const bridge = readFileSync(join(process.cwd(), 'src/lib/auth/oauth/reauth-bridge.ts'), 'utf8');
    expect(bridge).toMatch(/registerReauthMethod\(\{/);
    expect(bridge).toMatch(/kind: 'redirect'/);
    expect(bridge).toContain('/api/users/me/auth-identities/${p}/reauth');
    expect(readFileSync(join(process.cwd(), 'src/app/api/users/me/security/route.ts'), 'utf8')).toContain("import '@/lib/auth/oauth/reauth-bridge'");
    // Une seule fenêtre « Confirmez votre identité ».
    // (texte affiché : ligne JSX seule ou chaîne — pas les commentaires)
    const ui = files.filter((f) => f.endsWith('.tsx') && /^\s*Confirmez votre identité\s*$|['"`]Confirmez votre identité/m.test(readFileSync(f, 'utf8')));
    expect(ui.map((f) => f.slice(f.indexOf('src/')))).toEqual(['src/components/account/security/ReauthProvider.tsx']);
  });
});

describe('L92-REAUTH preuve de réauthentification (§18)', () => {
  it('REAUTH-01 valable 5 minutes, puis refusée (REAUTH_EXPIRED)', async () => {
    await ouvrir(1, 'a');
    const { expiresAt } = await issueReauthProof(1, 'a', 'password', { now: T0 });
    expect(expiresAt.getTime() - T0.getTime()).toBe(REAUTH_PROOF_TTL_MS);
    expect((await getReauthState(1, 'a', new Date(T0.getTime() + 4 * 60_000 + 59_000))).state).toBe('fresh');
    expect((await getReauthState(1, 'a', new Date(T0.getTime() + 5 * 60_000))).state).toBe('expired');
  });

  it('REAUTH-02 liée à l’utilisateur ET à la session : une autre session ou un autre compte n’en profite pas', async () => {
    await ouvrir(1, 'a'); await ouvrir(1, 'b'); await ouvrir(2, 'c');
    await issueReauthProof(1, 'a', 'password', { now: T0 });
    expect((await getReauthState(1, 'b', T0)).state).toBe('missing');
    expect((await getReauthState(2, 'a', T0)).state).toBe('missing');
  });

  it('réutilisable dans le bloc Sécurité, consommable une seule fois (risque maximal)', async () => {
    await ouvrir(1, 'a');
    await issueReauthProof(1, 'a', 'password', { now: T0 });
    const s = await getReauthState(1, 'a', T0);
    expect(s.state).toBe('fresh');
    expect((await getReauthState(1, 'a', T0)).state).toBe('fresh');
    const id = s.state === 'fresh' ? s.proof.id : '';
    expect(await consumeReauthProof(id, 'account_deletion', T0)).toBe(true);
    expect(await consumeReauthProof(id, 'account_deletion', T0)).toBe(false);
    expect((await getReauthState(1, 'a', T0)).state).toBe('expired');
  });

  it('§18.4 invalide si la session est révoquée : aucune preuve émise pour une session terminée', async () => {
    await ouvrir(1, 'a');
    await revokeUserSessionByPublicId(1, sessionPublicId('a'), 'USER_REVOKED');
    await expect(issueReauthProof(1, 'a', 'password')).rejects.toBeInstanceOf(ReauthError);
  });

  it('REAUTH-06 requireFreshReauth : 403 REAUTH_REQUIRED sans preuve, REAUTH_EXPIRED après 5 min, accepté sinon', async () => {
    const sid = 'sid-route';
    await ouvrir(5, sid);
    const tok = await generateAccessToken(subject(5), { sid });
    const r = () => new NextRequest('http://localhost:3000/api/users/me/sessions/revoke-others', { method: 'POST', headers: { cookie: `access_token=${tok}` } });
    const sans = await requireFreshReauth(r(), { action: 'test' });
    expect(sans.ok).toBe(false);
    if (!sans.ok) expect(await sans.response.json()).toMatchObject({ code: 'REAUTH_REQUIRED' });
    await issueReauthProof(5, sid, 'password', { now: new Date(Date.now() - 6 * 60_000) });
    const expiree = await requireFreshReauth(r(), { action: 'test' });
    if (!expiree.ok) expect(await expiree.response.json()).toMatchObject({ code: 'REAUTH_EXPIRED' }); else throw new Error('attendu : refus');
    await issueReauthProof(5, sid, 'password');
    const ok = await requireFreshReauth(r(), { action: 'test', consume: true });
    expect(ok.ok).toBe(true);
    expect((await requireFreshReauth(r(), { action: 'test', consume: true })).ok).toBe(false);
    // Session révoquée entre-temps : la requête elle-même est refusée (401).
    await issueReauthProof(5, sid, 'password');
    await revokeUserSessionByPublicId(5, sessionPublicId(sid), 'USER_REVOKED');
    const revoquee = await requireFreshReauth(r(), { action: 'test' });
    if (!revoquee.ok) expect(revoquee.response.status).toBe(401); else throw new Error('attendu : refus');
  });

  it('interface des méthodes : une méthode à redirection (sous-lot 93) est proposée avec son URL de départ', async () => {
    registerReauthMethod({ id: 'test-provider', label: 'Continuer avec Test', kind: 'redirect', isAvailableFor: async (u) => u === 9, startUrl: (r) => `/api/auth/oauth/test/start?reauth=1&returnTo=${encodeURIComponent(r)}` });
    const m = await listReauthMethodsFor(9);
    expect(m.find((x) => x.id === 'test-provider')).toMatchObject({ kind: 'redirect', startUrl: expect.stringContaining('reauth=1') });
    expect((await listReauthMethodsFor(10)).find((x) => x.id === 'test-provider')).toBeUndefined();
  });
});
