/**
 * Lot 93 — points d'intégration de la connexion Google / Apple (sans base) :
 * notifications NOTIF-01, gabarits e-mail, journal sans secret, CSRF du
 * retour Apple, couverture du diagnostic.
 */
import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { getCatalogEntry } from '@/lib/notifications/catalog';
import { NOTIFICATION_EMAIL_TEMPLATES } from '@/lib/email/template-editor';
import { redactActionLinks } from '@/lib/email/email-service';
import { DEFAULT_EMAIL_TEMPLATES } from '@/lib/email-defaults';
import { transactionalLockReason } from '@/lib/notifications/channel-activation';
import { verifyRequestOrigin } from '@/lib/csrf';
import { DIAG_TABLE_COVERAGE, DIAG_TABLE_EXCLUSIONS } from '@/services/admin/diagnostics-export/coverage';
import { excludedColumnMotif } from '@/services/admin/diagnostics-export/security';
import { RECETTE_EXCLUDED } from '@/services/admin/diagnostics-export/recette-catalog';

describe('L93 — raccords', () => {
  it('NOTIF-01 : Google / Apple associé ou dissocié — e-mail obligatoire (lot 101B : sans cloche ni push), nom du fournisseur seulement', () => {
    for (const t of ['AUTH_IDENTITY_LINKED', 'AUTH_IDENTITY_UNLINKED']) {
      const e = getCatalogEntry(t)!;
      expect(e).toMatchObject({ category: 'security', mandatoryBell: false, mandatoryEmail: true });
      expect(Object.keys(e.retiredChannels ?? {}).sort()).toEqual(['bell', 'push']);
      const r = e.render({ provider: 'apple' });
      expect(r.emailTemplateCode).toBe('notif_security');
      expect(r.bellTitle).toMatch(/Apple/);
      expect(NOTIFICATION_EMAIL_TEMPLATES.NOTIF_SECURITY.events).toContain(t);
    }
    expect(getCatalogEntry('AUTH_IDENTITY_LINKED')!.render({ provider: 'google' }).bellBody).toMatch(/Google/);
  });

  it('gabarits : « mot de passe oublié » sans mot de passe et code de confirmation, non désactivables', () => {
    expect(DEFAULT_EMAIL_TEMPLATES.PASSWORD_RESET_SOCIAL_ONLY.body).toContain('{{loginUrl}}');
    expect(DEFAULT_EMAIL_TEMPLATES.PASSWORD_RESET_SOCIAL_ONLY.body).not.toContain('resetUrl');
    expect(DEFAULT_EMAIL_TEMPLATES.SOCIAL_SIGNUP_EMAIL_CODE.body).toContain('{{code}}');
    expect(transactionalLockReason('PASSWORD_RESET_SOCIAL_ONLY')).toBeTruthy();
    expect(transactionalLockReason('SOCIAL_SIGNUP_EMAIL_CODE')).toBeTruthy();
  });

  it('journal des e-mails : le code de confirmation n’est jamais conservé en clair', () => {
    expect(redactActionLinks({ code: '123456', firstName: 'Léa' })).toEqual({ code: '[masqué]', firstName: 'Léa' });
  });

  it('CSRF : seul le retour Apple (form_post) est exempté, au chemin exact', () => {
    const post = (path: string) => new NextRequest(`http://localhost:3000${path}`, { method: 'POST', headers: { origin: 'https://appleid.apple.com' } });
    expect(verifyRequestOrigin(post('/api/auth/oauth/apple/callback')).allowed).toBe(true);
    expect(verifyRequestOrigin(post('/api/auth/oauth/google/callback')).allowed).toBe(false);
    expect(verifyRequestOrigin(post('/api/auth/oauth/pending')).allowed).toBe(false);
    expect(verifyRequestOrigin(post('/api/auth/oauth/apple/callback/x')).allowed).toBe(false);
  });

  it('diagnostic : identités couvertes sans identifiant ni jeton ; transactions exclues (sécurité)', () => {
    expect(DIAG_TABLE_COVERAGE.auth_identities).toBeTruthy();
    expect(DIAG_TABLE_EXCLUSIONS.auth_transactions.category).toBe('SECURITE');
    expect(excludedColumnMotif('auth_identities', 'subject')).toBeTruthy();
    expect(excludedColumnMotif('auth_identities', 'refresh_token_ciphertext')).toBeTruthy();
    expect(excludedColumnMotif('auth_identities', 'provider')).toBeNull();
    expect(RECETTE_EXCLUDED.auth_identities).toBeTruthy();
    expect(RECETTE_EXCLUDED.auth_transactions).toBeTruthy();
  });
});
