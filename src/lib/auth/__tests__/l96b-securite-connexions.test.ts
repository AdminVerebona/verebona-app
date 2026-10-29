/**
 * Lot 96B — CDC 18 sous-lot A « sécurité des connexions » (décisions PO Q2-Q6,
 * Q10, Q11, P2, P5). Sans base ni réseau (registre en mémoire, setup.ts).
 *
 *   L96B-P5   reconnaissance d'appareil : preuve SERVEUR uniquement (cookie
 *             signé) ; aucun en-tête déclaratif ne rend un appareil reconnu,
 *             ne supprime l'alerte ni ne change la règle D1 ;
 *   L96B-Q6   alerte « nouvel appareil » : une fois, jamais en
 *             renouvellement / changement d'espace / réouverture, ni pour un
 *             appareil reconnu ; contenu (date, appareil, lien), ni IP ni
 *             localisation ; notification de sécurité obligatoire ;
 *   L96B-P2   réauthentification Google / Apple : `prompt=login` + `max_age`,
 *             `auth_time` récent exigé ;
 *   L96B-D1   seuils D1 inchangés (Q10), message de pause (Q11) ;
 *   L96B-Q2   aucune double authentification affichée ni annoncée.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

vi.mock('@/db', async (orig) => ({
  ...(await orig<typeof import('@/db')>()),
  getUserSessionCutoff: vi.fn(async () => null),
}));
const activity: Array<{ activityType: string; details?: Record<string, unknown> }> = [];
vi.mock('@/lib/audit-logger', () => ({ logUserActivity: async (a: { activityType: string }) => { activity.push(a); } }));

import { createMemorySessionRegistryStore } from '@/lib/auth/session-registry-memory';
import { __setSessionRegistryStoreForTests } from '@/lib/auth/session-registry';
import { issueSession } from '@/lib/auth/session-issuance';
import { buildDeviceCookieValue, trustedDeviceFor } from '@/lib/auth/device-trust';
import {
  NEW_DEVICE_ALERT_METHODS, NEW_DEVICE_ALERT_ON_ACCOUNT_CREATION, __setNewDeviceAlertDepsForTests, type NewDeviceAlertMessage,
} from '@/lib/auth/new-device-alert';
import { LOGIN_THROTTLE_POLICIES, loginThrottleEntries, loginThrottledBody } from '@/lib/auth/login-throttle';
import { getCatalogEntry, NEW_DEVICE_LOGIN_LINK } from '@/lib/notifications/catalog';
import { NOTIFICATION_EMAIL_TEMPLATES, templateFormat, validateDraft, variableSpecFor } from '@/lib/email/template-editor';
import {
  PROVIDER_REAUTH_MAX_AGE_S, assertFreshProviderAuth, buildAuthorizationUrl, OAuthProviderError,
} from '@/lib/auth/oauth/providers';
import { socialErrorMessage } from '@/lib/auth/oauth/messages';
import type { ProviderConfig } from '@/lib/auth/oauth/config';

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const INSTALLATION = '0f8fad5b-d9cb-469f-a165-70867728950e';
const subject = (id: number, email = `u${id}@exemple.fr`) => ({ id, email, role: 'USER' as never, planType: 'STANDARD' as never, status: 'ACTIVE' as never });

let sent: NewDeviceAlertMessage[];
let creation: boolean;
beforeEach(() => {
  __setSessionRegistryStoreForTests(createMemorySessionRegistryStore());
  sent = [];
  creation = false;
  __setNewDeviceAlertDepsForTests({ account: async (userId) => ({ userId }), isAccountCreation: async () => creation, send: async (m) => { sent.push(m); } });
  activity.length = 0;
});

function req(opts: { cookie?: string; headers?: Record<string, string> } = {}) {
  return new NextRequest('http://localhost:3000/api/auth/login', {
    method: 'POST', headers: { 'user-agent': UA, ...(opts.cookie ? { cookie: opts.cookie } : {}), ...(opts.headers ?? {}) },
  });
}

/** Connexion « réelle » côté émission : cookie déposé comme le fait la route, puis issueSession. */
async function connexion(userId: number, opts: { cookie?: string | null; headers?: Record<string, string>; method?: string } = {}) {
  const { value, deviceId } = buildDeviceCookieValue(opts.cookie ?? null, { userId });
  const s = await issueSession(req({ cookie: opts.cookie ? `vb_device=${opts.cookie}` : undefined, headers: opts.headers }), NextResponse.json({}), {
    kind: 'open', method: opts.method ?? 'password', subject: subject(userId), deviceId, replaceCurrent: true,
  });
  return { ...s, cookie: value, deviceId };
}
const lastCreated = () => activity.filter((a) => a.activityType === 'SESSION_CREATED').at(-1)?.details;

describe('L96B-Q6 alerte « connexion depuis un nouvel appareil »', () => {
  it('R06 nouveau navigateur : une alerte ; reconnexions du même navigateur : aucune', async () => {
    const a = await connexion(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ userId: 1, payload: { deviceLabel: 'PC Windows', browserLabel: 'Chrome', clientType: 'WEB' } });
    expect(sent[0].dedupeKey).toMatch(/^security:new-device:1:/);
    expect(sent[0].dedupeKey).not.toContain(a.deviceId); // empreinte, jamais l'identifiant
    expect(lastCreated()).toMatchObject({ knownDevice: false, newDeviceAlert: 'sent' });
    for (let i = 0; i < 3; i++) await connexion(1, { cookie: a.cookie });
    expect(sent).toHaveLength(1);
    expect(lastCreated()).toMatchObject({ knownDevice: true, newDeviceAlert: 'known_device' });
  });

  it('jamais au renouvellement, au changement d’espace ni à la session rouverte (autres appareils, mot de passe, clôture)', async () => {
    const a = await connexion(2);
    sent.length = 0;
    await issueSession(req(), NextResponse.json({}), { kind: 'rotate', sid: a.sid, subject: subject(2) });
    await issueSession(req(), NextResponse.json({}), { kind: 'reissue', sid: a.sid, subject: subject(2) });
    await issueSession(req(), NextResponse.json({}), { kind: 'open', method: 'session_reopen', replaceCurrent: true, subject: subject(2) });
    expect(sent).toHaveLength(0);
    expect(lastCreated()).toMatchObject({ newDeviceAlert: 'not_a_login' });
    expect([...NEW_DEVICE_ALERT_METHODS].sort()).toEqual(['apple', 'email_link', 'google', 'password']);
  });

  it('Google / Apple et activation : mêmes règles ; la toute première session du compte (création) n’alerte pas', async () => {
    await connexion(3, { method: 'google' });
    await connexion(3, { method: 'apple' });
    expect(sent).toHaveLength(2);
    creation = true;
    await connexion(4, { method: 'email_link' });
    expect(sent).toHaveLength(2);
    expect(lastCreated()).toMatchObject({ newDeviceAlert: 'account_creation' });
    expect(NEW_DEVICE_ALERT_ON_ACCOUNT_CREATION).toBe(false);
  });

  it('P5 : un en-tête d’installation DÉCLARÉ ne rend pas un appareil reconnu et ne supprime pas l’alerte', async () => {
    const natif = { 'x-verebona-client': 'ios', 'x-verebona-installation-id': INSTALLATION };
    await connexion(5, { headers: natif });
    expect(sent).toHaveLength(1);
    // Un attaquant recopie l'identifiant d'installation du titulaire : nouvel appareil quand même.
    await connexion(5, { headers: natif });
    expect(sent).toHaveLength(2);
    expect(sent[1].payload).toMatchObject({ browserLabel: 'Application Verebona', clientType: 'IOS' });
  });

  it('P5 : un cookie fabriqué (identifiant d’appareil recopié, sans entrée signée) ne vaut rien', async () => {
    const a = await connexion(6);
    sent.length = 0;
    const forged = `d1.${a.deviceId}.`;
    const b = await connexion(6, { cookie: forged });
    expect(b.deviceId).not.toBe(a.deviceId); // le serveur n'adopte pas l'identifiant déclaré
    expect(sent).toHaveLength(1);
    expect(trustedDeviceFor(forged, { userId: 6 })).toBeNull(); // règle A de D1 inchangée
  });

  it('changement d’adresse (96A) : l’entrée du cookie est liée à l’identifiant — appareil toujours reconnu ; inconnu pour un autre compte → alerte', async () => {
    const a = await connexion(7);
    sent.length = 0;
    // Même compte 7, nouvelle adresse : le cookie (entrée `uid`) reconnaît l'appareil, sans passer par le registre.
    await issueSession(req({ cookie: `vb_device=${a.cookie}` }), NextResponse.json({}), {
      kind: 'open', method: 'password', replaceCurrent: true, subject: subject(7, 'nouvelle@exemple.fr'),
      deviceId: buildDeviceCookieValue(a.cookie, { userId: 7 }).deviceId,
    });
    expect(sent).toHaveLength(0);
    expect(lastCreated()).toMatchObject({ knownDevice: true, newDeviceAlert: 'known_device' });
    expect(trustedDeviceFor(a.cookie, { userId: 7 })).toBe(a.deviceId);
    // Même appareil (foyer), jamais utilisé par le compte 9 → alerte.
    const foyer = buildDeviceCookieValue(a.cookie, { userId: 8 }).value;
    await connexion(9, { cookie: foyer });
    expect(sent).toHaveLength(1);
  });

  it('jamais bloquant : un envoi en échec n’empêche pas la session', async () => {
    __setNewDeviceAlertDepsForTests({ account: async (userId) => ({ userId }), isAccountCreation: async () => false, send: async () => { throw new Error('smtp'); } });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = await connexion(10);
    expect(s.accessToken).toBeTruthy();
    expect(lastCreated()).toMatchObject({ newDeviceAlert: 'error' });
    err.mockRestore();
  });

  it('contenu : date / heure, appareil et navigateur, lien Appareils connectés ; ni IP ni localisation ; sécurité obligatoire', () => {
    const e = getCatalogEntry('NEW_DEVICE_LOGIN')!;
    expect(e).toMatchObject({ category: 'security', mandatoryBell: true, mandatoryEmail: true });
    const r = e.render({ at: '2026-10-26T13:05:00.000Z', deviceLabel: 'iPhone', browserLabel: 'Application Verebona', clientType: 'IOS' });
    expect(r.emailTemplateCode).toBe('notif_new_device_login');
    expect(r.bellBody).toContain('le 26 octobre 2026 à 14 h 05');
    expect(r.bellBody).toContain('iPhone · Application Verebona');
    expect(r.bellBody).toContain('Mon compte › Sécurité › Appareils connectés');
    expect(r.bellBody).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b|\bIP\b|adresse IP|localisation|ville/);
    expect(e.deepLink({})).toBe(NEW_DEVICE_LOGIN_LINK);
    expect(NEW_DEVICE_LOGIN_LINK).toBe('/mon-compte/informations#securite');
    expect(e.payloadSchema.safeParse({ at: 'x', deviceLabel: 'a', browserLabel: 'b', ip: '1.2.3.4' }).success).toBe(true);
    expect(Object.keys((e.payloadSchema.parse({ at: 'x', deviceLabel: 'a', browserLabel: 'b', ip: '1.2.3.4' }) as object))).not.toContain('ip');
    expect(NOTIFICATION_EMAIL_TEMPLATES.NOTIF_NEW_DEVICE_LOGIN.events).toEqual(['NEW_DEVICE_LOGIN']);
    expect(NOTIFICATION_EMAIL_TEMPLATES.NOTIF_SECURITY.events).not.toContain('NEW_DEVICE_LOGIN');
  });

  it('gabarit (migration 0832) : valide pour l’éditeur du BO, idempotent, sans IP', () => {
    const sql = read('src/db/migrations/0832_l96b_alerte_nouvel_appareil.sql');
    expect(sql).toMatch(/ON CONFLICT \(type\) DO NOTHING/);
    const [, subject, body] = /\('notif_new_device_login',\s*'((?:[^']|'')*)',\s*E'((?:[^']|'')*)'/.exec(sql)!;
    const b = body.replace(/''/g, "'").replace(/\\n/g, '\n');
    expect(validateDraft({ code: 'NOTIF_NEW_DEVICE_LOGIN', subject, body: b, format: templateFormat(b), spec: variableSpecFor('NOTIF_NEW_DEVICE_LOGIN', { format: templateFormat(b) }) })).toEqual([]);
    expect(b).not.toMatch(/\bIP\b|localisation/i);
  });
});

describe('L96B-P2 réauthentification Google / Apple : authentification réellement récente', () => {
  const cfg = (provider: 'google' | 'apple') => ({
    provider, clientId: 'cid', clientSecret: 's', redirectUri: 'https://x.test/cb', pkce: true,
  }) as unknown as ProviderConfig;
  const now = Date.UTC(2026, 9, 26, 12, 0, 0);
  const nowS = Math.floor(now / 1000);

  it('Google : prompt=login + max_age en réauthentification ; choix du compte sinon', () => {
    const q = (reauth: boolean) => new URL(buildAuthorizationUrl(cfg('google'), { state: 's', nonce: 'n', codeChallenge: 'c', reauth })).searchParams;
    expect(q(true).get('prompt')).toBe('login');
    expect(q(true).get('max_age')).toBe(String(PROVIDER_REAUTH_MAX_AGE_S));
    expect(q(false).get('prompt')).toBe('select_account');
    expect(q(false).get('max_age')).toBeNull();
    expect(PROVIDER_REAUTH_MAX_AGE_S).toBe(300);
  });

  it('auth_time : récent → accepté ; absent, ancien (session silencieuse) ou futur → refusé', () => {
    expect(() => assertFreshProviderAuth({ auth_time: nowS - 10 }, now)).not.toThrow();
    expect(() => assertFreshProviderAuth({ auth_time: String(nowS - 200) }, now)).not.toThrow();
    for (const c of [{}, { auth_time: null }, { auth_time: 'hier' }, { auth_time: nowS - 3600 }, { auth_time: nowS - 361 }, { auth_time: nowS + 3600 }]) {
      let err: unknown = null;
      try { assertFreshProviderAuth(c, now); } catch (e) { err = e; }
      expect(err, JSON.stringify(c)).toBeInstanceOf(OAuthProviderError);
      expect((err as OAuthProviderError).code).toBe('ID_TOKEN_AUTH_TIME');
    }
  });

  it('câblage : contrôle appliqué aux seules réauthentifications, message clair', () => {
    expect(read('src/lib/auth/oauth/flow.ts')).toMatch(/if \(tx\.intent === 'reauth'\) assertFreshProviderAuth\(claims\);/);
    expect(socialErrorMessage('REAUTH_NOT_RECENT')).toMatch(/identifiez-vous à nouveau/);
  });
});

describe('L96B-D1 seuils conservés (Q10) et message de pause (Q11)', () => {
  it('valeurs D1 strictement inchangées', () => {
    const MIN = 60_000;
    expect(LOGIN_THROTTLE_POLICIES).toEqual({
      trustedDevice: { maxAttempts: 10, windowMs: 15 * MIN, lockMs: MIN, progressive: true, maxLockMs: 15 * MIN, levelResetMs: 24 * 60 * MIN },
      origin: { maxAttempts: 20, windowMs: 15 * MIN, lockMs: 15 * MIN, progressive: true, maxLockMs: 60 * MIN, levelResetMs: 24 * 60 * MIN },
      originIdentifier: { maxAttempts: 5, windowMs: 15 * MIN, lockMs: MIN, progressive: true, maxLockMs: 15 * MIN, levelResetMs: 24 * 60 * MIN },
      identifierUntrusted: { maxAttempts: 10, windowMs: 60 * MIN, lockMs: 15 * MIN, progressive: true, maxLockMs: 60 * MIN, levelResetMs: 24 * 60 * MIN },
    });
  });

  it('la règle dépend du seul cookie signé — jamais d’un en-tête', () => {
    const route = read('src/app/api/auth/login/route.ts');
    expect(route).toMatch(/trustedDeviceId: await trustedDeviceForLogin\(request, email, normalized\)/);
    expect(read('src/lib/auth/device-account.ts')).toMatch(/trustedDeviceFor\(raw, await deviceAccountByEmail\(email, normalized\)\)/);
    expect(read('src/lib/auth/login-throttle.ts')).not.toMatch(/installation|x-verebona/i);
    expect(loginThrottleEntries({ identifier: 'a@b.fr', ip: '1.1.1.1', trustedDeviceId: null }).map((e) => e.rule))
      .toEqual(['origin', 'origin_identifier', 'identifier_untrusted']);
  });

  it('message identique quelle que soit la règle : compréhensible, sans existence de compte ni seuil', () => {
    for (const s of [60, 900, 3600]) {
      const m = loginThrottledBody(s).message;
      expect(m).toMatch(/^Trop de tentatives de connexion\. Réessayez dans \d+ minutes?, ou utilisez « Mot de passe oublié \? »/);
      expect(m).not.toMatch(/compte|existe|inconnu|échecs?|seuil|\b(5|10|20) (tentatives|essais)/i);
    }
  });
});

describe('L96B-Q2/Q3/Q4 aucune double authentification en V1', () => {
  it('Mon compte › Sécurité : ni bloc ni « bientôt disponible » 2FA ; autres blocs intacts', () => {
    const card = read('src/components/account/security/SecurityCard.tsx');
    expect(card).not.toMatch(/title="Double authentification"|code à usage unique/);
    for (const t of ['title="Méthodes de connexion"', 'title="Biométrie"', 'title="Appareils connectés"']) expect(card).toContain(t);
    expect(read('src/app/api/users/me/security/route.ts')).not.toMatch(/twoFactor:/);
  });

  it('aucun code 2FA inactif ni TODO dans l’authentification', () => {
    for (const f of ['src/lib/auth/oauth/pending.ts', 'src/lib/auth/reauth.ts']) {
      expect(read(f)).not.toMatch(/TODO\(lot C|second_factor|MFA_REQUIRED/);
    }
  });
});
