/**
 * Lot 96A — CDC 18 Q7, Q8, Q9 : règles pures et raccords (les parcours réels
 * sont couverts par `src/test/e2e/scenarios/l96a-identite-compte.e2e.ts`).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EMAIL_CHANGE_LINK_TTL_MS, EMAIL_CHANGE_TEMPLATES, hashEmailChangeToken, isPlausibleEmail, maskEmail,
} from '@/services/auth/email-change.service';
import { REAUTH_PROOF_TTL_MS } from '@/lib/auth/reauth';
import { createMemoryReauthProofStore } from '@/lib/auth/reauth-memory';
import { AUTH_LIMITS } from '@/lib/auth/auth-rate-limit';
import { DEFAULT_EMAIL_TEMPLATES } from '@/lib/email-defaults';
import { transactionalLockReason } from '@/lib/notifications/channel-activation';
import { redactActionLinks } from '@/lib/email/email-service';
import { newSignupNonce } from '@/services/auth/email-verification.service';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('Q9 — activation protégée', () => {
  it('empreinte d’inscription aléatoire (128 bits), jamais réutilisée', () => {
    const a = newSignupNonce();
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(new Set(Array.from({ length: 50 }, newSignupNonce)).size).toBe(50);
  });

  it('tentatives limitées comme la réauthentification (D1) : 5 échecs / 15 min par inscription, 20 par IP', () => {
    expect(AUTH_LIMITS.activationUser).toMatchObject({ maxAttempts: 5, windowMs: 15 * 60_000, lockMs: 15 * 60_000, progressive: true });
    expect(AUTH_LIMITS.activationIp).toMatchObject({ maxAttempts: 20, windowMs: 15 * 60_000 });
  });

  it('l’inscription pose l’empreinte ; l’e-mail signe le lien avec elle', () => {
    expect(read('src/app/api/users/route.ts')).toMatch(/signupNonce: newSignupNonce\(\)/);
    expect(read('src/services/email/transactional-email-jobs.service.ts')).toMatch(/signupNonce: user\.signup_nonce/);
  });

  it('la page d’activation existe et appelle le POST avec le mot de passe ; reprise vers l’inscription', () => {
    const page = read('src/app/(auth)/verify-email/activer/page.tsx');
    expect(page).toMatch(/fetch\('\/api\/auth\/verify-email'/);
    expect(page).toMatch(/JSON\.stringify\(\{ token, password/);
    expect(page).toMatch(/href="\/signup"/);
  });
});

describe('Q7 — preuve de réauthentification', () => {
  it('retirée pour une session, ou pour toutes les sessions de l’utilisateur', async () => {
    const store = createMemoryReauthProofStore();
    const mk = (userId: number, sid: string) => store.insert({
      id: `${userId}-${sid}`, userId, sid, method: 'password', createdAt: new Date(), expiresAt: new Date(Date.now() + REAUTH_PROOF_TTL_MS), consumedAt: null, consumedFor: null,
    });
    await mk(1, 'a'); await mk(1, 'b'); await mk(2, 'c');
    expect(await store.invalidate(1, 'a')).toBe(1);
    expect(store.rows.map((r) => r.sid).sort()).toEqual(['b', 'c']);
    expect(await store.invalidate(1)).toBe(1);
    expect(store.rows.map((r) => r.sid)).toEqual(['c']); // isolation entre comptes
  });

  it('invalidée à la déconnexion, au mot de passe ajouté, à l’association / dissociation, au changement d’adresse', () => {
    expect(read('src/app/api/auth/logout/route.ts')).toMatch(/invalidateReauthProofs\(payload\.userId, \{ sid: payload\.sid/);
    expect(read('src/app/api/users/me/password/route.ts')).toMatch(/invalidateReauthProofs\(session\.userId, \{ reason: 'password_added' \}\)/);
    expect(read('src/lib/auth/oauth/flow.ts')).toMatch(/invalidateReauthProofs\(userId, \{ reason: `identity_\$\{kind\}` \}\)/);
    expect(read('src/app/api/users/me/email-change/confirm/route.ts')).toMatch(/invalidateReauthProofs\(session\.userId, \{ reason: 'primary_email_changed' \}\)/);
  });

  it('jamais prolongée : la demande de changement d’adresse lit la preuve sans la renouveler', () => {
    const src = read('src/app/api/users/me/email-change/route.ts');
    expect(src).toMatch(/requireFreshReauth\(request, \{ action: 'email_change' \}\)/);
    expect(src).not.toMatch(/issueReauthProof/);
  });
});

describe('Q8 — changement de l’adresse principale', () => {
  it('lien : délai PROPRE (24 h), distinct des 5 minutes de la preuve', () => {
    expect(EMAIL_CHANGE_LINK_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(EMAIL_CHANGE_LINK_TTL_MS).not.toBe(REAUTH_PROOF_TTL_MS);
  });

  it('empreinte du lien stable, non réversible ; adresses masquées dans les alertes', () => {
    expect(hashEmailChangeToken('abc')).toBe(hashEmailChangeToken('abc'));
    expect(hashEmailChangeToken('abc')).not.toContain('abc');
    expect(hashEmailChangeToken('abc')).toMatch(/^[0-9a-f]{64}$/);
    expect(maskEmail('jean.dupont@exemple.fr')).toBe('j***@exemple.fr');
    expect(isPlausibleEmail('a@b.fr')).toBe(true);
    for (const bad of ['', 'a@b', 'a b@c.fr', '@c.fr', `${'x'.repeat(250)}@c.fr`]) expect(isPlausibleEmail(bad)).toBe(false);
  });

  it('gabarits : textes par défaut, non désactivables, migration 0830, lien masqué au journal', () => {
    expect(DEFAULT_EMAIL_TEMPLATES.EMAIL_CHANGE_CONFIRMATION.body).toContain('{{confirmUrl}}');
    expect(DEFAULT_EMAIL_TEMPLATES.PRIMARY_EMAIL_CHANGED.body).toMatch(/\{\{oldEmail\}\}[\s\S]*\{\{newEmail\}\}/);
    expect(DEFAULT_EMAIL_TEMPLATES.EMAIL_CHANGE_ADDRESS_IN_USE.body).toContain('{{loginUrl}}');
    const mig = read('src/db/migrations/0830_l96a_gabarits_changement_adresse.sql');
    for (const code of Object.values(EMAIL_CHANGE_TEMPLATES)) {
      expect(transactionalLockReason(code)).toBeTruthy();
      expect(mig).toContain(`('${code}',`);
    }
    expect(mig).toMatch(/ON CONFLICT \(type\) DO NOTHING/);
    expect(redactActionLinks({ confirmUrl: 'https://app.verebona.fr/mon-compte/confirmer-adresse?token=secret123' }).confirmUrl)
      .toBe('https://app.verebona.fr/mon-compte/confirmer-adresse?token=[masqué]');
  });

  it('bascule : autres sessions révoquées (session courante gardée au registre), jetons réémis APRÈS la borne', () => {
    const src = read('src/app/api/users/me/email-change/confirm/route.ts');
    expect(src).toMatch(/revokeAllUserSessions\(session\.userId, 'EMAIL_CHANGED', \{ keepRegistrySid: session\.sid \}\)/);
    expect(src.indexOf('while (Date.now() <= cutoff.getTime())')).toBeLessThan(src.indexOf('issueSession('));
    expect(src).toMatch(/kind: 'open', method: 'session_reopen', replaceCurrent: true/);
  });

  it('Stripe : le client EXISTANT est mis à jour, jamais créé', () => {
    const src = read('src/lib/stripe-customer.ts');
    const sync = src.slice(src.indexOf('export async function syncStripeCustomerEmail'));
    expect(sync).not.toMatch(/customers\.create/);
    expect(src).toMatch(/customers\.update\(customerId, \{ email \}\)/);
  });

  it('table déclarée : diagnostic (sécurité), recette, RGPD, restauration ; empreinte d’inscription exclue', () => {
    expect(read('src/services/admin/diagnostics-export/coverage.ts')).toMatch(/email_change_requests: \{ category: 'SECURITE'/);
    expect(read('src/services/admin/diagnostics-export/recette-catalog.ts')).toMatch(/email_change_requests:/);
    expect(read('src/services/gdpr/export-content.ts')).toMatch(/'email_change_requests'/);
    expect(read('src/services/backup/schema-signature.ts')).toMatch(/'email_change_requests'/);
    expect(read('src/services/admin/diagnostics-export/security.ts')).toMatch(/signup_nonce: \{ kind: 'SECURITE'/);
  });

  it('écran : « Modifier » l’adresse dans Sécurité ; plus de « non modifiable » dans Informations', () => {
    expect(read('src/components/account/security/SignInMethodsBlock.tsx')).toMatch(/'\/api\/users\/me\/email-change'/);
    expect(read('src/app/(dashboard)/mon-compte/informations/InformationsTab.tsx')).not.toMatch(/non modifiable/);
    expect(read('src/app/api/users/me/auth-identities/[provider]/reauth/route.ts')).toMatch(/'change-email'/);
  });
});
