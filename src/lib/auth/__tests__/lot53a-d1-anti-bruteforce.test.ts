/**
 * Lot 53A — retour PO D1 : anti-force brute de la connexion SANS blocage du
 * titulaire par un tiers (CDC 18 §9.1, §20.4, §32, §33). Règles :
 * `lib/auth/login-throttle.ts` ; appareil reconnu : `lib/auth/device-trust.ts`.
 * Scénarios détaillés : docs/exploitation/cdc18-ecarts.md §D1.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AuthRateLimiter, MemoryAuthLimitStore } from '@/lib/auth/auth-rate-limit';
import {
  LOGIN_THROTTLE_POLICIES, checkLoginThrottle, loginThrottleEntries, loginThrottledBody, originBucket,
  passwordResetReleaseKeys, recordLoginFailure, recordLoginSuccess, type LoginAttemptContext,
} from '@/lib/auth/login-throttle';
import {
  DEVICE_TRUST_COOKIE_PATH, DEVICE_TRUST_MAX_ACCOUNTS, buildDeviceCookieValue, parseDeviceCookie, trustedDeviceFor,
  __legacyDeviceCookieValueForTests,
} from '@/lib/auth/device-trust';

const MIN = 60_000;
const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

let now = 10_000_000;
let lim: AuthRateLimiter;
beforeEach(() => { now = 10_000_000; lim = new AuthRateLimiter(new MemoryAuthLimitStore(), () => now); });

const untrusted = (identifier: string, ip: string): LoginAttemptContext => ({ identifier, ip, trustedDeviceId: null });
const trusted = (identifier: string, ip: string, dev = 'AAAAAAAAAAAAAAAAAAAAAA'): LoginAttemptContext => ({ identifier, ip, trustedDeviceId: dev });

describe('PO-D1 — un tiers ne bloque pas le titulaire', () => {
  it('PO-D1-01 attaque massive et distribuée sur une adresse : le titulaire passe depuis son appareil reconnu, depuis n’importe quelle IP', async () => {
    for (let i = 0; i < 60; i++) {
      await recordLoginFailure(lim, untrusted('titulaire@x.fr', `81.10.${i}.1`));
      now += 30_000; // 2 essais / minute pendant 30 min
    }
    // Les appareils NON reconnus sont en pause sur cette adresse…
    expect((await checkLoginThrottle(lim, untrusted('titulaire@x.fr', '90.1.1.1'))).allowed).toBe(false);
    // … le titulaire, sur son téléphone ou son ordinateur habituel, non.
    expect((await checkLoginThrottle(lim, trusted('titulaire@x.fr', '90.1.1.1'))).allowed).toBe(true);
    expect((await checkLoginThrottle(lim, trusted('titulaire@x.fr', '81.10.3.1'))).allowed).toBe(true);
  });

  it('PO-D1-02 pause maximale d’un appareil non reconnu bornée à 60 min (plafond), pas de prolongation par les essais refusés', async () => {
    const p = LOGIN_THROTTLE_POLICIES.identifierUntrusted;
    expect([p.lockMs, p.maxLockMs]).toEqual([15 * MIN, 60 * MIN]);
    for (let i = 0; i < 10; i++) await recordLoginFailure(lim, untrusted('c@x.fr', `82.0.${i}.1`));
    const v = await checkLoginThrottle(lim, untrusted('c@x.fr', '82.9.9.9'));
    expect(v).toMatchObject({ allowed: false, rule: 'identifier_untrusted', retryAfterSeconds: 15 * 60 });
    // Essais pendant la pause : refusés sans être comptés.
    now += 5 * MIN;
    await recordLoginFailure(lim, untrusted('c@x.fr', '82.9.9.9'));
    expect((await checkLoginThrottle(lim, untrusted('c@x.fr', '82.9.9.9'))).retryAfterSeconds).toBe(10 * 60);
  });
});

describe('PO-D1 — attaque distribuée (plusieurs IP) et ralentissement progressif', () => {
  it('PO-D1-03 10 échecs sur une adresse depuis 10 IP différentes → pause 15 min, puis 30, puis 60 (récidive 24 h)', async () => {
    const vague = async (base: number) => {
      for (let i = 0; i < 10; i++) await recordLoginFailure(lim, untrusted('cible@x.fr', `83.${base}.${i}.1`));
      return (await checkLoginThrottle(lim, untrusted('cible@x.fr', '83.200.0.1'))).retryAfterSeconds;
    };
    expect(await vague(1)).toBe(15 * 60);
    now += 16 * MIN;
    expect(await vague(2)).toBe(30 * 60);
    now += 31 * MIN;
    expect(await vague(3)).toBe(60 * 60);
    now += 61 * MIN;
    expect(await vague(4)).toBe(60 * 60);
  });

  it('PO-D1-04 une seule IP sur une adresse : ralentissement progressif dès 5 échecs (1 min, puis 2 min) ; une autre IP n’est pas ralentie', async () => {
    const ctx = untrusted('u@x.fr', '84.1.1.1');
    for (let i = 0; i < 5; i++) await recordLoginFailure(lim, ctx);
    let v = await checkLoginThrottle(lim, ctx);
    expect(v).toMatchObject({ allowed: false, rule: 'origin_identifier', retryAfterSeconds: 60 });
    expect((await checkLoginThrottle(lim, untrusted('u@x.fr', '84.2.2.2'))).allowed).toBe(true);
    now += 61_000;
    for (let i = 0; i < 4; i++) await recordLoginFailure(lim, ctx);
    v = await checkLoginThrottle(lim, ctx);
    expect(v.allowed).toBe(true); // 9 échecs : adresse pas encore en pause
    await recordLoginFailure(lim, ctx); // 10e échec : paire (2 min) ET adresse (15 min)
    v = await checkLoginThrottle(lim, ctx);
    expect(v.allowed).toBe(false);
    const p = LOGIN_THROTTLE_POLICIES.originIdentifier;
    expect([p.maxAttempts, p.lockMs, p.maxLockMs]).toEqual([5, MIN, 15 * MIN]);
  });

  it('PO-D1-05 une IP qui essaie 20 adresses (pulvérisation) est mise en pause ; les autres IP et les appareils reconnus derrière elle passent', async () => {
    for (let i = 0; i < 20; i++) await recordLoginFailure(lim, untrusted(`v${i}@x.fr`, '85.5.5.5'));
    const v = await checkLoginThrottle(lim, untrusted('nouvelle@x.fr', '85.5.5.5'));
    expect(v).toMatchObject({ allowed: false, rule: 'origin' });
    expect((await checkLoginThrottle(lim, untrusted('nouvelle@x.fr', '85.5.5.6'))).allowed).toBe(true);
    expect((await checkLoginThrottle(lim, trusted('voisin@x.fr', '85.5.5.5'))).allowed).toBe(true);
  });

  it('PO-D1-06 IPv6 : toutes les adresses d’un même /64 comptent comme une seule origine', () => {
    expect(originBucket('2001:db8:aa:bb::1')).toBe('2001:db8:aa:bb::/64');
    expect(originBucket('2001:0db8:00aa:00bb:1234:5678:9abc:def0')).toBe('2001:db8:aa:bb::/64');
    expect(originBucket('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(originBucket('::ffff:81.2.3.4')).toBe('81.2.3.4');
    expect(originBucket('81.2.3.4')).toBe('81.2.3.4');
    const a = loginThrottleEntries(untrusted('x@x.fr', '2001:db8:aa:bb::1'));
    const b = loginThrottleEntries(untrusted('x@x.fr', '2001:db8:aa:bb:ffff::2'));
    expect(a.map((e) => e.key)).toEqual(b.map((e) => e.key));
  });

  it('PO-D1-07 appareil reconnu : son propre compteur seulement (10 échecs → 1 min, plafond 15 min)', async () => {
    const ctx = trusted('t@x.fr', '86.1.1.1');
    expect(loginThrottleEntries(ctx).map((e) => e.rule)).toEqual(['trusted_device']);
    for (let i = 0; i < 9; i++) await recordLoginFailure(lim, ctx);
    expect((await checkLoginThrottle(lim, ctx)).allowed).toBe(true);
    const v = await recordLoginFailure(lim, ctx);
    expect(v).toMatchObject({ lockedNow: true, rule: 'trusted_device', retryAfterSeconds: 60 });
    // Un AUTRE appareil reconnu du titulaire n'est pas touché.
    expect((await checkLoginThrottle(lim, trusted('t@x.fr', '86.1.1.1', 'BBBBBBBBBBBBBBBBBBBBBB'))).allowed).toBe(true);
  });
});

describe('PO-D1 — réussite, réinitialisation, non-énumération, traçabilité', () => {
  it('PO-D1-08 une connexion réussie ne rend pas son crédit à une attaque : compteurs IP et adresse conservés', async () => {
    for (let i = 0; i < 9; i++) await recordLoginFailure(lim, untrusted('m@x.fr', `87.0.${i}.1`));
    await recordLoginSuccess(lim, untrusted('m@x.fr', '87.0.0.1'));
    await recordLoginFailure(lim, untrusted('m@x.fr', '87.0.50.1'));
    expect((await checkLoginThrottle(lim, untrusted('m@x.fr', '87.0.60.1'))).rule).toBe('identifier_untrusted');
  });

  it('PO-D1-09 la réinitialisation du mot de passe (preuve e-mail) lève la pause de l’adresse', async () => {
    for (let i = 0; i < 10; i++) await recordLoginFailure(lim, untrusted('r@x.fr', `88.0.${i}.1`));
    expect((await checkLoginThrottle(lim, untrusted('r@x.fr', '88.9.9.9'))).allowed).toBe(false);
    for (const k of passwordResetReleaseKeys('r@x.fr', '88.9.9.9')) await lim.reset(k);
    expect((await checkLoginThrottle(lim, untrusted('r@x.fr', '88.9.9.9'))).allowed).toBe(true);
    expect(read('src/app/api/auth/reset-password/route.ts')).toMatch(/passwordResetReleaseKeys\(identifier/);
    expect(read('src/app/api/auth/reset-password/route.ts')).toMatch(/rememberTrustedDevice\(request, response, deviceAccountOf\(\{ id: user\.id, email: identifier \}\)\)/);
  });

  it('PO-D1-10 aucune révélation de compte : clés et réponses ne dépendent que de l’adresse SAISIE et de l’IP', async () => {
    // Même traitement pour une adresse inscrite et une adresse inconnue (la
    // fonction ne reçoit même pas l'information).
    const inscrite = loginThrottleEntries(untrusted('inscrite@x.fr', '89.1.1.1'));
    expect(inscrite.map((e) => e.key.split(':').slice(0, 2).join(':'))).toEqual(['login:ip', 'login:pair', 'login:acctu']);
    for (const e of inscrite) expect(e.key).not.toMatch(/inscrite|89\.1/);
    for (let i = 0; i < 5; i++) {
      await recordLoginFailure(lim, untrusted('inscrite@x.fr', '89.1.1.1'));
      await recordLoginFailure(lim, untrusted('inconnue@x.fr', '89.1.1.2'));
    }
    const a = await checkLoginThrottle(lim, untrusted('inscrite@x.fr', '89.1.1.1'));
    const b = await checkLoginThrottle(lim, untrusted('inconnue@x.fr', '89.1.1.2'));
    expect({ ...a, blockedKey: null }).toEqual({ ...b, blockedKey: null });
    expect(loginThrottledBody(a.retryAfterSeconds)).toEqual(loginThrottledBody(b.retryAfterSeconds));
    // Le refus intervient AVANT toute lecture du compte.
    const route = read('src/app/api/auth/login/route.ts');
    expect(route.indexOf('checkLoginThrottle(limiter, throttleCtx)')).toBeLessThan(route.indexOf('FROM users'));
  });

  it('PO-D1-11 message du refus : tentatives, délai et « Mot de passe oublié ? » — rien sur le compte', () => {
    const b = loginThrottledBody(61);
    expect(b.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(b.message).toBe('Trop de tentatives de connexion. Réessayez dans 2 minutes, ou utilisez « Mot de passe oublié ? » pour recevoir un lien de réinitialisation par e-mail.');
    expect(b.message).not.toMatch(/compte|existe|inconnu/i);
  });

  it('PO-D1-12 traçabilité : échec et pause journalisés avec la règle (sans clé, IP ni adresse dans le détail)', () => {
    const route = read('src/app/api/auth/login/route.ts');
    expect(route).toMatch(/activityType: 'AUTH_LOGIN_THROTTLED'/);
    expect(route).toMatch(/details: \{ rule: verdict\.rule, retryAfterSeconds: verdict\.retryAfterSeconds, trustedDevice/);
    expect(read('src/services/admin/user-detail.service.ts')).toMatch(/'LOGIN_SUCCESS', 'LOGIN_FAILED', 'AUTH_LOGIN_THROTTLED'/);
  });
});

describe('PO-D1 — appareil reconnu (cookie signé, CDC 18 §20.4)', () => {
  const T0 = Date.UTC(2026, 9, 13);

  const moi = { userId: 1 };
  const autre = { userId: 2 };

  it('PO-D1-13 reconnu pour CE compte seulement ; falsification, autre compte ou expiration → non reconnu', () => {
    const { value, deviceId } = buildDeviceCookieValue(null, moi, T0);
    expect(trustedDeviceFor(value, moi, T0 + 1000)).toBe(deviceId);
    expect(trustedDeviceFor(value, autre, T0 + 1000)).toBeNull();
    expect(trustedDeviceFor(value, null, T0 + 1000)).toBeNull();
    // Signature modifiée.
    const parts = value.split('.');
    const forged = `${parts[0]}.${parts[1]}.${parts[2].slice(0, -1)}${parts[2].endsWith('A') ? 'B' : 'A'}`;
    expect(trustedDeviceFor(forged, moi, T0 + 1000)).toBeNull();
    // Identifiant d'appareil échangé (cookie d'un autre navigateur recopié partiellement).
    expect(trustedDeviceFor(`${parts[0]}.${'Z'.repeat(22)}.${parts[2]}`, moi, T0 + 1000)).toBeNull();
    // Après 180 jours.
    expect(trustedDeviceFor(value, moi, T0 + 181 * 24 * 3600 * 1000)).toBeNull();
    // Valeurs absurdes.
    for (const v of ['', 'x', 'd1..', 'd1.abc.def', 'a'.repeat(2000)]) expect(trustedDeviceFor(v, moi, T0)).toBeNull();
  });

  it('PO-D1-14 plusieurs comptes sur un même appareil (foyer, Duo) : identifiant conservé, 5 comptes au plus', () => {
    let v = buildDeviceCookieValue(null, { userId: 11 }, T0);
    const dev = v.deviceId;
    v = buildDeviceCookieValue(v.value, { userId: 12 }, T0 + 1000);
    expect(v.deviceId).toBe(dev);
    expect(trustedDeviceFor(v.value, { userId: 11 }, T0 + 2000)).toBe(dev);
    expect(trustedDeviceFor(v.value, { userId: 12 }, T0 + 2000)).toBe(dev);
    for (let i = 0; i < 6; i++) v = buildDeviceCookieValue(v.value, { userId: 20 + i, legacyEmail: `n${i}@x.fr` }, T0 + 3000 + i);
    expect(parseDeviceCookie(v.value)!.entries).toHaveLength(DEVICE_TRUST_MAX_ACCOUNTS);
    expect(v.value).not.toMatch(/@|x\.fr/); // aucune adresse en clair
  });

  it('INT96-P5 entrée liée à l’identifiant : un changement d’adresse ne change rien ; une adresse reprise n’hérite d’aucun appareil', () => {
    const v = buildDeviceCookieValue(null, { userId: 31, legacyEmail: 'ancienne@x.fr' }, T0);
    // Même compte après changement d'adresse (96A) : toujours reconnu.
    expect(trustedDeviceFor(v.value, { userId: 31, legacyEmail: 'ancienne@x.fr', legacyNotBeforeMs: T0 - 1 }, T0 + 1000)).toBe(v.deviceId);
    // Le compte 32 prend ensuite l'adresse « ancienne@x.fr » : appareil du 31 non reconnu pour lui.
    expect(trustedDeviceFor(v.value, { userId: 32, legacyEmail: 'ancienne@x.fr', legacyNotBeforeMs: 0 }, T0 + 1000)).toBeNull();
  });

  it('INT96-P5 transition : entrée HÉRITÉE (adresse) acceptée seulement pour l’adresse d’origine du compte, émise après sa création', () => {
    const legacy = __legacyDeviceCookieValueForTests('moi@x.fr', T0);
    const compte = { userId: 41, legacyEmail: 'moi@x.fr', legacyNotBeforeMs: T0 - 24 * 3600 * 1000 };
    // Déploiement : l'appareil reste reconnu (pas de fausse alerte, pas de pénalité D1)…
    expect(trustedDeviceFor(legacy.value, compte, T0 + 1000)).toBe(legacy.deviceId);
    // … y compris après un changement d'adresse : `legacyEmail` reste l'adresse d'ORIGINE.
    // Sans information de transition : seules les entrées `uid` comptent (prudent).
    expect(trustedDeviceFor(legacy.value, { userId: 41 }, T0 + 1000)).toBeNull();
    // Entrée émise AVANT la création du compte (ancien titulaire de l'adresse) : refusée.
    expect(trustedDeviceFor(legacy.value, { ...compte, legacyNotBeforeMs: T0 + 1000 }, T0 + 2000)).toBeNull();
    // Autre adresse d'origine (le compte a pris cette adresse par un changement) : refusée.
    expect(trustedDeviceFor(legacy.value, { ...compte, legacyEmail: 'autre@x.fr' }, T0 + 1000)).toBeNull();
    // Reconnexion : l'entrée héritée est remplacée par l'entrée `uid`, le même appareil est conservé.
    const renouvele = buildDeviceCookieValue(legacy.value, { userId: 41, legacyEmail: 'moi@x.fr' }, T0 + 2000);
    expect(renouvele.deviceId).toBe(legacy.deviceId);
    expect(parseDeviceCookie(renouvele.value)!.entries).toHaveLength(1);
    expect(trustedDeviceFor(renouvele.value, { userId: 41 }, T0 + 3000)).toBe(legacy.deviceId);
  });

  it('PO-D1-15 cookie HttpOnly limité aux routes d’authentification, déposé après connexion, activation et réinitialisation', () => {
    expect(DEVICE_TRUST_COOKIE_PATH).toBe('/api/auth');
    const src = read('src/lib/auth/device-trust.ts');
    expect(src).toMatch(/httpOnly: true/);
    expect(read('src/app/api/auth/login/route.ts')).toMatch(/rememberTrustedDevice\(request, response, deviceAccountOf\(user\)\)/);
    expect(read('src/app/api/auth/verify-email/route.ts')).toMatch(/rememberTrustedDevice\(request, response, deviceAccountOf\(user\)\)/);
    // Le verrou « adresse bloquée pour tous » du lot 37 a disparu.
    expect(read('src/lib/auth/auth-rate-limit.ts')).not.toMatch(/loginAccount:/);
  });
});
