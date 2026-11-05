/**
 * Lot 110B — double authentification : briques PURES (sans base).
 * TOTP RFC 6238 (vecteurs officiels), chiffrement au repos et rotation de
 * clé, jetons (provisoire distinct, niveau de preuve, rotation non
 * promouvante), origines WebAuthn, liste fermée, garde centrale, codes de
 * récupération, textes exacts du ticket.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { matchTotpStep, normalizeTotpCode, __totpCodeForTests } from '../totp';
import { keyRingStatus, openSecret, readKeyRing, sealSecret, MfaKeyUnavailableError } from '../secret-box';
import { assuranceOf, strongAssurance } from '../assurance';
import { isAcceptableOrigin, readWebAuthnConfig, WebAuthnUnavailableError } from '../passkeys';
import { isAllowedWithoutMfa, MFA_PENDING_ROUTES, MFA_REQUIRED_CODE, STRONG_REAUTH_METHODS } from '../constants';
import { isEnforcedFor, __setMfaPolicyStoreForTests, mfaRequirementFor, type MfaPolicyStore } from '../policy';
import { assertMfaSatisfied } from '../guard';
import { formatRecoveryCode, normalizeRecoveryCode, recoveryCodeHash } from '../recovery-codes';
import {
  generateAccessToken, generateMfaPendingToken, generateRefreshToken, verifyAccessToken, verifyMfaPendingToken, verifyRefreshToken,
} from '@/lib/jwt';
import { PASSKEY_CARD_TEXT, PASSKEY_CARD_TITLE, SECURE_ACCOUNT_INTRO, SECURE_ACCOUNT_TITLE, TOTP_CARD_TITLE } from '@/components/auth/mfa/texts';

// RFC 6238 annexe B : secret ASCII « 12345678901234567890 » (SHA-1).
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('L110B-TOTP RFC 6238', () => {
  it('vecteurs officiels (6 derniers chiffres) et intervalle reconnu', () => {
    expect(matchTotpStep(RFC_SECRET, '287082', 59_000)).toBe(1);
    expect(matchTotpStep(RFC_SECRET, '081804', 1_111_111_109_000)).toBe(Math.floor(1_111_111_109 / 30));
    expect(matchTotpStep(RFC_SECRET, '005924', 1_234_567_890_000)).toBe(Math.floor(1_234_567_890 / 30));
  });
  it('fenêtre ±1 intervalle seulement', () => {
    const t = 1_700_000_000_000;
    const code = __totpCodeForTests(RFC_SECRET, t);
    expect(matchTotpStep(RFC_SECRET, code, t + 30_000)).not.toBeNull();
    expect(matchTotpStep(RFC_SECRET, code, t + 90_000)).toBeNull();
    expect(matchTotpStep(RFC_SECRET, code, t - 90_000)).toBeNull();
  });
  it('saisie normalisée : 6 chiffres exactement', () => {
    expect(normalizeTotpCode(' 123 456 ')).toBe('123456');
    for (const bad of ['12345', '1234567', 'abcdef', null, undefined, 123456]) {
      expect(normalizeTotpCode(bad as unknown)).toBe(bad === 123456 ? '123456' : null);
    }
  });
});

describe('L110B-CRYPTO secret TOTP chiffré (AES-256-GCM, clé hors base)', () => {
  const k1 = Buffer.alloc(32, 1).toString('base64');
  const k2 = Buffer.alloc(32, 2).toString('base64');
  it('chiffre / déchiffre, lié à l’utilisateur (AAD), jamais le secret en clair dans le stocké', () => {
    const env = { NODE_ENV: 'production', MFA_ENCRYPTION_KEYS: `k1:${k1}` };
    const { sealed, keyId } = sealSecret('JBSWY3DPEHPK3PXP', 7, env);
    expect(keyId).toBe('k1');
    expect(sealed).not.toContain('JBSWY3DPEHPK3PXP');
    expect(openSecret(sealed, 7, env)?.plain).toBe('JBSWY3DPEHPK3PXP');
    expect(openSecret(sealed, 8, env)).toBeNull();
  });
  it('rotation : ancienne clé lisible, marquée à rechiffrer ; clé retirée = illisible', () => {
    const old = sealSecret('S', 1, { NODE_ENV: 'production', MFA_ENCRYPTION_KEYS: `k1:${k1}` }).sealed;
    const env2 = { NODE_ENV: 'production', MFA_ENCRYPTION_KEYS: `k2:${k2},k1:${k1}`, MFA_ENCRYPTION_ACTIVE_KEY: 'k2' };
    expect(openSecret(old, 1, env2)).toMatchObject({ plain: 'S', keyId: 'k1', stale: true });
    expect(sealSecret('S', 1, env2).keyId).toBe('k2');
    expect(openSecret(old, 1, { NODE_ENV: 'production', MFA_ENCRYPTION_KEYS: `k2:${k2}` })).toBeNull();
  });
  it('production sans trousseau valable : refus explicite, jamais de repli ; état BO sans valeur', () => {
    expect(() => readKeyRing({ NODE_ENV: 'production' })).toThrow(MfaKeyUnavailableError);
    expect(() => readKeyRing({ NODE_ENV: 'production', MFA_ENCRYPTION_KEYS: 'k1:court' })).toThrow(MfaKeyUnavailableError);
    expect(() => readKeyRing({ NODE_ENV: 'production', MFA_ENCRYPTION_KEYS: `k1:${k1}`, MFA_ENCRYPTION_ACTIVE_KEY: 'k9' })).toThrow(MfaKeyUnavailableError);
    const st = keyRingStatus({ NODE_ENV: 'production', MFA_ENCRYPTION_KEYS: `k1:${k1}` });
    expect(st).toEqual({ configured: true, activeKeyId: 'k1', keyIds: ['k1'], problem: null });
    expect(JSON.stringify(st)).not.toContain(k1);
  });
});

describe('L110B-JWT jeton provisoire distinct, niveau de preuve porté par la session', () => {
  const subject = { id: 5, email: 'a@b.fr', role: 'USER' as const, planType: 'STANDARD' as never, status: 'ACTIVE' as const };
  it('le jeton provisoire n’est JAMAIS un jeton d’accès ni de renouvellement, et inversement', async () => {
    const p = await generateMfaPendingToken({ userId: 5, pid: 'p1', pm: 'password' }, 600);
    expect(await verifyAccessToken(p)).toBeNull();
    expect(await verifyRefreshToken(p)).toBeNull();
    expect(await verifyMfaPendingToken(p)).toMatchObject({ userId: 5, pid: 'p1', pm: 'password' });
    const a = await generateAccessToken(subject, { sid: 's' });
    const r = await generateRefreshToken(subject, { sid: 's' });
    expect(await verifyMfaPendingToken(a)).toBeNull();
    expect(await verifyMfaPendingToken(r)).toBeNull();
  });
  it('niveau 2 seulement s’il est explicitement fourni ; défaut niveau 1', async () => {
    const plain = await verifyAccessToken(await generateAccessToken(subject, { sid: 's' }));
    expect(assuranceOf(plain).aal).toBe(1);
    const strong = await verifyAccessToken(await generateAccessToken(subject, { sid: 's', assurance: strongAssurance('password', 'otp', 123) }));
    expect(assuranceOf(strong)).toEqual({ aal: 2, amr: ['pwd', 'otp'], mfaAt: 123 });
    expect(assuranceOf({ aal: '2' as never }).aal).toBe(1);
    expect(assuranceOf(null).aal).toBe(1);
  });
  it('renouvellement : niveau du jeton consommé recopié, jamais promu (option ignorée)', async () => {
    const { issueSession } = await import('../../session-issuance');
    const req = new NextRequest('http://localhost:3000/api/auth/refresh', { method: 'POST' });
    const weak = await issueSession(req, NextResponse.json({}), { kind: 'rotate', sid: 's1', subject, previous: { aal: 1 }, assurance: { aal: 2 } });
    expect(weak.assurance.aal).toBe(1);
    expect(assuranceOf(await verifyRefreshToken(weak.refreshToken)).aal).toBe(1);
    const strong = await issueSession(req, NextResponse.json({}), { kind: 'rotate', sid: 's2', subject, previous: { aal: 2, amr: ['passkey'], mfaAt: 9 } });
    expect(assuranceOf(await verifyAccessToken(strong.accessToken))).toMatchObject({ aal: 2, amr: ['passkey'] });
    const legacy = await issueSession(req, NextResponse.json({}), { kind: 'rotate', sid: 's3', subject });
    expect(legacy.assurance.aal).toBe(1);
  });
  it('ouverture sans preuve forte = niveau 1 ; réémission hérite du jeton présenté', async () => {
    const { issueSession } = await import('../../session-issuance');
    const open = await issueSession(new NextRequest('http://localhost:3000/api/auth/login', { method: 'POST' }), NextResponse.json({}), { kind: 'open', method: 'password', subject });
    expect(open.assurance.aal).toBe(1);
    const strongTok = await generateAccessToken(subject, { sid: 'x', assurance: { aal: 2, amr: ['passkey'] } });
    const req = new NextRequest('http://localhost:3000/api/auth/switch-account', { method: 'POST', headers: { cookie: `access_token=${strongTok}` } });
    const re = await issueSession(req, NextResponse.json({}), { kind: 'reissue', sid: 'x', subject });
    expect(re.assurance.aal).toBe(2);
  });
});

describe('L110B-WEBAUTHN origines et RP ID par environnement, aucune origine libre', () => {
  it('https sur le RP ID ou un sous-domaine ; http localhost hors production seulement', () => {
    expect(isAcceptableOrigin('https://app.verebona.fr', 'app.verebona.fr', true)).toBe(true);
    expect(isAcceptableOrigin('https://x.app.verebona.fr', 'app.verebona.fr', true)).toBe(true);
    expect(isAcceptableOrigin('https://evil.fr', 'app.verebona.fr', true)).toBe(false);
    expect(isAcceptableOrigin('https://app.verebona.fr.evil.fr', 'app.verebona.fr', true)).toBe(false);
    expect(isAcceptableOrigin('https://app.verebona.fr/', 'app.verebona.fr', true)).toBe(false);
    expect(isAcceptableOrigin('http://app.verebona.fr', 'app.verebona.fr', true)).toBe(false);
    expect(isAcceptableOrigin('http://localhost:3000', 'localhost', false)).toBe(true);
    expect(isAcceptableOrigin('http://localhost:3000', 'localhost', true)).toBe(false);
    expect(isAcceptableOrigin('android:apk-key-hash:AbCdEfGhIjKlMnOpQrStUvWxYz012345', 'app.verebona.fr', true)).toBe(true);
    expect(isAcceptableOrigin('*', 'app.verebona.fr', true)).toBe(false);
  });
  it('production sans configuration : indisponible (jamais devinée)', () => {
    expect(() => readWebAuthnConfig({ NODE_ENV: 'production' })).toThrow(WebAuthnUnavailableError);
    expect(() => readWebAuthnConfig({ NODE_ENV: 'production', WEBAUTHN_RP_ID: 'app.verebona.fr', WEBAUTHN_ORIGINS: 'https://app.verebona.fr,https://autre.fr' })).toThrow(WebAuthnUnavailableError);
    expect(readWebAuthnConfig({ NODE_ENV: 'production', WEBAUTHN_RP_ID: 'App.Verebona.fr', WEBAUTHN_ORIGINS: 'https://app.verebona.fr' }))
      .toEqual({ rpID: 'app.verebona.fr', rpName: 'Verebona', origins: ['https://app.verebona.fr'] });
  });
});

describe('L110B-POLICY obligation et garde centrale (fail closed)', () => {
  const now = new Date('2026-12-01T10:00:00Z');
  it('réglages : utilisateurs / administrateurs distincts, date future = non encore en vigueur', () => {
    const past = new Date('2026-11-30T00:00:00Z');
    const future = new Date('2026-12-02T00:00:00Z');
    expect(isEnforcedFor('USER', { users: null, admins: past }, now)).toBe(false);
    expect(isEnforcedFor('ADMIN', { users: null, admins: past }, now)).toBe(true);
    expect(isEnforcedFor('SUPER_ADMIN', { users: null, admins: future }, now)).toBe(false);
    expect(isEnforcedFor('USER', { users: past, admins: null }, now)).toBe(true);
    expect(isEnforcedFor('USER', { users: future, admins: null }, now)).toBe(false);
  });

  let state: Awaited<ReturnType<MfaPolicyStore['load']>> = null;
  let fail = false;
  beforeEach(() => {
    __setMfaPolicyStoreForTests({
      load: async () => { if (fail) throw new Error('ECONNREFUSED'); return state; },
      readSettings: async () => ({ users: null, admins: null }),
      writeSetting: async () => {},
    });
  });
  afterEach(() => { fail = false; state = null; });

  it('compte protégé : obligation PERMANENTE même si l’obligation globale est retirée', async () => {
    state = { role: 'USER', enabledAt: new Date('2026-10-01T00:00:00Z'), settings: { users: null, admins: null } };
    expect(await mfaRequirementFor(1, now)).toMatchObject({ required: true, enrolled: true, enforced: false });
  });
  it('session de niveau 1 refusée (403 MFA_REQUIRED) dès que la MFA est obligatoire ; niveau 2 admis sans lecture', async () => {
    state = { role: 'USER', enabledAt: null, settings: { users: new Date('2026-01-01T00:00:00Z'), admins: null } };
    await expect(assertMfaSatisfied({ userId: 1 }, '/api/assets', 'GET')).rejects.toThrow(MFA_REQUIRED_CODE);
    await expect(assertMfaSatisfied({ userId: 1, aal: 1 }, '/api/documents/zip', 'POST')).rejects.toThrow(MFA_REQUIRED_CODE);
    fail = true; // aucune lecture pour une session forte
    await expect(assertMfaSatisfied({ userId: 1, aal: 2 }, '/api/assets', 'GET')).resolves.toBeUndefined();
  });
  it('avant activation et sans facteur : comportement inchangé', async () => {
    state = { role: 'ADMIN', enabledAt: null, settings: { users: null, admins: null } };
    await expect(assertMfaSatisfied({ userId: 1 }, '/api/admin/users', 'GET')).resolves.toBeUndefined();
  });
  it('liste fermée sans MFA : déconnexion et résiliation seulement (aucun accès documentaire)', async () => {
    state = { role: 'USER', enabledAt: new Date(), settings: { users: null, admins: null } };
    await expect(assertMfaSatisfied({ userId: 1 }, '/api/auth/logout', 'POST')).resolves.toBeUndefined();
    await expect(assertMfaSatisfied({ userId: 1 }, '/api/billing/cancel-subscription', 'POST')).resolves.toBeUndefined();
    for (const p of ['/api/auth/me', '/api/users/me', '/api/users/me/gdpr-export', '/api/files/1', '/api/admin/users', '/api/users/me/security/mfa']) {
      expect(isAllowedWithoutMfa(p, 'GET')).toBe(false);
    }
  });
  it('base injoignable : 503 SESSION_UNAVAILABLE, jamais un accès', async () => {
    fail = true;
    await expect(assertMfaSatisfied({ userId: 1 }, '/api/assets', 'GET')).rejects.toThrow('SESSION_UNAVAILABLE');
  });
  it('utilisateur absent : refus (fail closed)', async () => {
    state = null;
    await expect(assertMfaSatisfied({ userId: 1 }, '/api/assets', 'GET')).rejects.toThrow(MFA_REQUIRED_CODE);
  });
});

describe('L110B-RECOVERY codes de récupération', () => {
  it('format, normalisation, empreinte par utilisateur', () => {
    expect(formatRecoveryCode('ABCDEFGHJKMNPQRS')).toBe('ABCD-EFGH-JKMN-PQRS');
    expect(normalizeRecoveryCode(' abcd-efgh jkmn-pqrs ')).toBe('ABCDEFGHJKMNPQRS');
    expect(recoveryCodeHash(1, 'abcd-efgh-jkmn-pqrs')).toBe(recoveryCodeHash(1, 'ABCDEFGHJKMNPQRS'));
    expect(recoveryCodeHash(1, 'ABCDEFGHJKMNPQRS')).not.toBe(recoveryCodeHash(2, 'ABCDEFGHJKMNPQRS'));
    expect(recoveryCodeHash(1, 'ABCDEFGHJKMNPQRS')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('L110B-TEXTES écran « Sécurisez votre compte » (textes exacts du ticket)', () => {
  it('titre, introduction et cartes', () => {
    expect(SECURE_ACCOUNT_TITLE).toBe('Sécurisez votre compte');
    expect(SECURE_ACCOUNT_INTRO).toBe('Verebona protège vos biens et vos documents. Choisissez comment sécuriser vos connexions.');
    expect(PASSKEY_CARD_TITLE).toBe('Clé d’accès');
    expect(PASSKEY_CARD_TEXT).toBe('Connectez-vous avec Face ID, Touch ID, Windows Hello, le code de votre appareil ou un gestionnaire de mots de passe, sans saisir de mot de passe.');
    expect(TOTP_CARD_TITLE).toBe('Mot de passe et code de sécurité');
    expect([SECURE_ACCOUNT_INTRO, PASSKEY_CARD_TEXT].join(' ')).not.toMatch(/informations personnelles/i);
  });
  it('méthodes de step-up fortes : clé d’accès et application seulement', () => {
    expect([...STRONG_REAUTH_METHODS].sort()).toEqual(['passkey', 'totp']);
    expect(MFA_PENDING_ROUTES.every((r) => r.startsWith('/api/auth/mfa/'))).toBe(true);
  });
});
