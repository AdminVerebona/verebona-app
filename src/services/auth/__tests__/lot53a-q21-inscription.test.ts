/**
 * Lot 53A — retour PO Q21 : inscription non énumérable (CDC 18 §7.1, §9.1,
 * §40) et traçabilité D1 dans la fiche BO. Les parcours réels sont dans
 * `src/test/e2e/scenarios/l53a-securite-cdc18.e2e.ts` (PO-Q21-E2E-xx).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { DEFAULT_EMAIL_TEMPLATES } from '@/lib/email-defaults';
import { SIGNUP_NEUTRAL_MESSAGE } from '@/lib/auth/auth-messages';

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');
const { signupExistingEmailVariables, SIGNUP_EXISTING_ACCOUNT_TEMPLATE } = await import('@/services/auth/signup-existing-email.service');
const { TRANSACTIONAL_EMAILS, resolveTemplateVariables } = await import('@/services/admin/communications.service');
const { describeLoginActivity } = await import('@/services/admin/user-detail.service');

describe('PO-Q21 — inscription non énumérable', () => {
  const route = read('src/app/api/users/route.ts');

  it('PO-Q21-SIGN-01 adresse déjà inscrite : même réponse que la création (201, message neutre), sans écriture', () => {
    expect(SIGNUP_NEUTRAL_MESSAGE).not.toMatch(/déjà|existe/i);
    const branche = route.slice(route.indexOf('if (existingUserByEmail.length > 0) {'), route.indexOf('await releaseUnverifiedEmail(sanitizedEmail);\n\n    const now'));
    expect(branche).toContain('return neutralSignupResponse();');
    expect(branche).toContain('await bcrypt.hash(password, 10)');
    expect(branche).toContain('scheduleSignupExistingEmail(existingId)');
    expect(branche).not.toMatch(/db\.(insert|update|delete)/);
    // La création répond aussi par la réponse neutre (plus l'objet utilisateur).
    expect(route).not.toMatch(/excludePasswordHash/);
    expect((route.match(/return neutralSignupResponse\(\);/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('PO-Q21-SIGN-02 aucun refus ne dépend de l’existence du compte : nom d’utilisateur et invitation contrôlés AVANT l’adresse', () => {
    const iUser = route.indexOf("code: 'DUPLICATE_USERNAME'");
    const iInvite = route.indexOf('invitation ??= await resolveSignupInvitation(inviteToken, sanitizedEmail)');
    const iEmail = route.indexOf('const existingUserByEmail = await db');
    expect(iUser).toBeGreaterThan(0);
    expect(iUser).toBeLessThan(iEmail);
    expect(iInvite).toBeLessThan(iEmail);
    // Seule exception : invitation VALIDE pour cette adresse (preuve de la boîte).
    expect(route).toContain('if (invitation?.valid) return duplicateEmailResponse();');
  });

  it('PO-Q21-SIGN-03 e-mails après la réponse dans les deux cas (même durée de réponse)', () => {
    expect(route).toMatch(/runDetached\('e-mail de vérification \(inscription\)'/);
    expect(read('src/services/auth/signup-existing-email.service.ts')).toMatch(/runDetached\(/);
  });

  it('PO-Q21-SIGN-04 gabarit SIGNUP_EXISTING_ACCOUNT : migration 0342 idempotente, valeurs par défaut, amorçage, BO', () => {
    const sql = read('src/db/migrations/0342_signup_existing_account_email_template.sql');
    expect(sql).toMatch(/ON CONFLICT \(type\) DO NOTHING/);
    expect(sql).toContain("'SIGNUP_EXISTING_ACCOUNT'");
    const def = DEFAULT_EMAIL_TEMPLATES.SIGNUP_EXISTING_ACCOUNT;
    expect(sql).toContain(def.subject);
    expect(JSON.parse(def.placeholders)).toEqual(['firstName', 'requestDate', 'loginUrl', 'forgotPasswordUrl']);
    expect(read('src/db/seeds/email_templates_system.ts')).toContain('DEFAULT_EMAIL_TEMPLATES.SIGNUP_EXISTING_ACCOUNT.body');
    expect(TRANSACTIONAL_EMAILS.some((e) => e.templateCode === SIGNUP_EXISTING_ACCOUNT_TEMPLATE)).toBe(true);
    // Aperçu BO : toutes les variables du gabarit sont résolues.
    const r = resolveTemplateVariables([def.subject, def.body], { firstName: 'Jean', lastName: 'D', email: 'j@x.fr' } as never, 'https://app.example');
    expect(r.missingCount).toBe(0);
  });

  it('PO-Q21-SIGN-05 variables de l’e-mail : liste fermée, aucune donnée technique', () => {
    const v = signupExistingEmailVariables({ firstName: ' Jean ', at: new Date('2026-10-13T10:05:00Z'), appUrl: 'https://app.example/' });
    expect(v).toEqual({
      firstName: 'Jean', requestDate: '13 octobre 2026 à 12 h 05',
      loginUrl: 'https://app.example/login', forgotPasswordUrl: 'https://app.example/forgot-password',
    });
  });

  it('PO-Q21-PWD-01 le formulaire d’inscription applique la règle partagée (plus de regex recopiées) ; le serveur renvoie le code WEAK_PASSWORD attendu', () => {
    const form = read('src/app/(auth)/signup/SignupForm.tsx');
    expect(form).toContain('checkPassword(value)');
    expect(form).not.toMatch(/\.regex\(/);
    expect(read('src/lib/auth/password.ts')).toMatch(/code: "WEAK_PASSWORD"/);
  });
});

describe('PO-D1 — traçabilité dans BO › Utilisateurs › fiche', () => {
  it('PO-D1-16 libellés des tentatives : réussite, échec (motif), pause (règle, durée)', () => {
    expect(describeLoginActivity('LOGIN_SUCCESS', JSON.stringify({ trustedDevice: true }))).toEqual({ result: 'success', detail: null });
    expect(describeLoginActivity('LOGIN_SUCCESS', JSON.stringify({ trustedDevice: false })).detail).toBe('Premier succès sur cet appareil');
    expect(describeLoginActivity('LOGIN_SUCCESS', null)).toEqual({ result: 'success', detail: null });
    expect(describeLoginActivity('LOGIN_FAILED', JSON.stringify({ reason: 'invalid_password', trustedDevice: false }))).toEqual({ result: 'failure', detail: 'Mot de passe incorrect' });
    expect(describeLoginActivity('LOGIN_FAILED', JSON.stringify({ reason: 'invalid_password', trustedDevice: true })).detail).toBe('Mot de passe incorrect · appareil reconnu');
    expect(describeLoginActivity('AUTH_LOGIN_THROTTLED', JSON.stringify({ rule: 'identifier_untrusted', retryAfterSeconds: 900 })))
      .toEqual({ result: 'throttled', detail: 'Pause des appareils non reconnus (attaque possible) — 15 min' });
    expect(describeLoginActivity('LOGIN_FAILED', '{pas du json')).toEqual({ result: 'failure', detail: 'Échec' });
  });
});
