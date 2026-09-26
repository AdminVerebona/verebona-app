/**
 * Lien de vérification d'adresse — jeton signé, à durée limitée, à usage
 * unique.
 *
 * L'ancien jeton `base64(email:horodatage)` se fabriquait sans recevoir
 * l'e-mail, et `/api/auth/verify-email` ouvrait une session à l'issue : un
 * lien fabriqué valait connexion au compte d'autrui.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EMAIL_VERIFICATION_TTL_MS,
  buildEmailVerificationUrl,
  checkEmailVerificationToken,
  createEmailVerificationToken,
  emailVerificationSecret,
  isLegacyVerificationToken,
} from '@/services/auth/email-verification.service';
import { createPasswordResetToken } from '@/services/auth/password-reset.service';

const secret = 'test-secret';
const user = { id: 42, email: 'jean@exemple.fr' };
const now = 1_760_000_000_000;
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('jeton de vérification signé', () => {
  it('accepté pendant 24 heures, expiré au-delà', () => {
    const token = createEmailVerificationToken(user, now, secret);
    expect(checkEmailVerificationToken(token, user, now + 1000, secret)).toEqual({ ok: true, userId: 42 });
    expect(checkEmailVerificationToken(token, user, now + EMAIL_VERIFICATION_TTL_MS + 1, secret))
      .toEqual({ ok: false, code: 'TOKEN_EXPIRED' });
  });

  it('l’ancien format fabriqué (base64 email:horodatage) est refusé', () => {
    const forged = Buffer.from(`${user.email}:${now}`).toString('base64');
    expect(checkEmailVerificationToken(forged, user, now, secret)).toEqual({ ok: false, code: 'INVALID_TOKEN' });
  });

  it('refuse un autre secret, un autre compte, une autre adresse', () => {
    const token = createEmailVerificationToken(user, now, secret);
    expect(checkEmailVerificationToken(token, user, now, 'autre-secret').ok).toBe(false);
    expect(checkEmailVerificationToken(token, { ...user, id: 43 }, now, secret).ok).toBe(false);
    // Adresse neutralisée à la réinscription : le lien de l'ancien compte ne vaut plus.
    expect(checkEmailVerificationToken(token, { ...user, email: 'released+42+1@invalid.local' }, now, secret).ok)
      .toBe(false);
    expect(checkEmailVerificationToken(token, null, now, secret).ok).toBe(false);
  });

  it('l’adresse est comparée sans tenir compte de la casse', () => {
    const token = createEmailVerificationToken({ ...user, email: 'Jean@Exemple.FR' }, now, secret);
    expect(checkEmailVerificationToken(token, user, now, secret).ok).toBe(true);
  });

  it('signature altérée ou jeton daté dans le futur : refusé', () => {
    const token = createEmailVerificationToken(user, now, secret);
    const [id, ts, sig] = Buffer.from(token, 'base64url').toString('utf8').split('.');
    const altered = Buffer.from(`${id}.${ts}.${sig.slice(0, -2)}AA`).toString('base64url');
    expect(checkEmailVerificationToken(altered, user, now, secret).ok).toBe(false);
    const future = createEmailVerificationToken(user, now + 10 * 60_000, secret);
    expect(checkEmailVerificationToken(future, user, now, secret).ok).toBe(false);
  });

  it('un jeton de réinitialisation du mot de passe ne vaut pas vérification (contexte signé)', () => {
    const reset = createPasswordResetToken({ ...user, passwordHash: '' }, now, secret);
    expect(checkEmailVerificationToken(reset, user, now, secret).ok).toBe(false);
  });

  it('reconnaît un lien de l’ancien format pour l’expliquer, sans rien accorder', () => {
    const legacy = Buffer.from(`Jean@Exemple.fr:${now}`).toString('base64');
    expect(isLegacyVerificationToken(legacy)).toEqual({ email: 'jean@exemple.fr' });
    expect(isLegacyVerificationToken(createEmailVerificationToken(user, now, secret))).toBeNull();
    expect(isLegacyVerificationToken('nimportequoi')).toBeNull();
  });

  it('construit un lien vers la route de vérification, jeton encodé', () => {
    const url = new URL(buildEmailVerificationUrl('https://app.exemple.fr', user, 'premium', now));
    expect(url.pathname).toBe('/api/auth/verify-email');
    expect(url.searchParams.get('plan')).toBe('premium');
    expect(checkEmailVerificationToken(url.searchParams.get('token')!, user, now, emailVerificationSecret()).ok)
      .toBe(true);
  });
});

describe('secret de signature', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('en production, refuse de fonctionner sans secret ou avec la valeur publique', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('EMAIL_VERIFICATION_SECRET', '');
    vi.stubEnv('JWT_SECRET', '');
    expect(() => emailVerificationSecret()).toThrow(/EMAIL_VERIFICATION_SECRET/);
    vi.stubEnv('JWT_SECRET', 'your-secret-key-change-in-production');
    expect(() => emailVerificationSecret()).toThrow();
    vi.stubEnv('JWT_SECRET', 'un-vrai-secret');
    expect(emailVerificationSecret()).toBe('un-vrai-secret');
    vi.stubEnv('EMAIL_VERIFICATION_SECRET', 'dedie');
    expect(emailVerificationSecret()).toBe('dedie');
  });

  it('le démarrage vérifie les secrets avant toute autre étape', () => {
    const src = read('src/instrumentation.ts');
    const check = src.indexOf('emailVerificationSecret();');
    expect(check).toBeGreaterThan(0);
    expect(src).toMatch(/resetSecret\(\);/);
    expect(check).toBeLessThan(src.indexOf('await ensureMigrations()'));
  });
});

describe('producteurs et consommateur du lien', () => {
  it('inscription et renvoi n’émettent plus de base64(email:horodatage)', () => {
    for (const p of ['src/app/api/users/route.ts', 'src/app/api/auth/resend-verification/route.ts']) {
      const src = read(p);
      expect(src).toMatch(/buildEmailVerificationUrl\(/);
      expect(src).not.toMatch(/Buffer\.from\(tokenData\)/);
    }
  });

  it('la route vérifie la signature, active de façon conditionnelle et explique les anciens liens', () => {
    const src = read('src/app/api/auth/verify-email/route.ts');
    expect(src).not.toMatch(/Buffer\.from\(token, 'base64'\)/);
    expect(src).toMatch(/checkEmailVerificationToken\(token, user\)/);
    expect(src).toMatch(/consumeEmailVerification\(user\.id\)/);
    expect(src).toMatch(/error=link_outdated/);
    // La session n'est posée qu'après l'activation conditionnelle.
    expect(src.indexOf('consumeEmailVerification(user.id)')).toBeLessThan(src.indexOf('generateAccessToken('));
  });

  it('l’activation n’écrit que sur un compte encore non vérifié (usage unique)', () => {
    const src = read('src/services/auth/email-verification.service.ts');
    expect(src).toMatch(/and\(eq\(users\.id, userId\), eq\(users\.isActive, false\)\)/);
    expect(src).toMatch(/\.returning\(/);
  });

  it('la page propose le renvoi pour un lien périmé', () => {
    const src = read('src/app/(auth)/verify-email/page.tsx');
    expect(src).toMatch(/link_outdated: \{[\s\S]*?canResend: true/);
  });
});
