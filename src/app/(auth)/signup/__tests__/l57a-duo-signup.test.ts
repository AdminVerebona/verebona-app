/**
 * Lot 57A — ticket P2 « Premium Duo : supprimer le parrainage du formulaire
 * d'inscription des invités ». Rendu RÉEL du formulaire (même composant sur
 * ordinateur et mobile : une colonne `max-w-lg`, pleine largeur sur mobile).
 *
 * DUO-SIGNUP-01 invitation Duo valide : aucun champ ni texte de parrainage ;
 *               texte de contexte exact ; bouton « Créer mon compte et
 *               rejoindre le Duo » ; adresse invitée pré-remplie.
 * DUO-SIGNUP-02 inscription classique : parrainage visible, facultatif, avec
 *               le nouveau texte ; l'ancien « Un proche vous a invité ? » a
 *               disparu ; avantage du parrain conservé.
 * DUO-SIGNUP-03 invitation invalide / expirée / utilisée / inactive :
 *               message explicite + sorties, jamais le formulaire classique.
 * DUO-SIGNUP-04 contexte établi côté SERVEUR (page) à partir du jeton ; le
 *               formulaire ne déduit pas le Duo d'un paramètre d'URL.
 */
import * as React from 'react';
import { createElement as h } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

(globalThis as { React?: typeof React }).React = React;
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const { SignupForm, DUO_INVITE_SIGNUP_TEXT, DUO_INVITE_SIGNUP_BUTTON, REFERRAL_FIELD_HELP } = await import('../SignupForm');
const { SignupInvitationInvalid, invitationInvalidContent } = await import('../SignupInvitationInvalid');

const html = (el: React.ReactElement) => renderToStaticMarkup(el).replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('L57A — inscription des invités Premium Duo', () => {
  it('DUO-SIGNUP-01 — invitation Duo valide : aucun parrainage, texte et bouton dédiés, adresse invitée', () => {
    const out = html(h(SignupForm, { invitation: { kind: 'duo', ownerName: 'Camille Durand', inviteEmail: 'ami@proton.me' } }));
    expect(DUO_INVITE_SIGNUP_TEXT).toBe("Vous avez été invité à rejoindre un abonnement Premium Duo. Créez votre compte pour accepter l'invitation.");
    expect(DUO_INVITE_SIGNUP_BUTTON).toBe('Créer mon compte et rejoindre le Duo');
    expect(out).toContain(DUO_INVITE_SIGNUP_TEXT);
    expect(out).toContain(DUO_INVITE_SIGNUP_BUTTON);
    expect(out).not.toMatch(/parrain/i);
    expect(out).not.toContain('referralCode');
    expect(out).not.toContain('Un proche vous a invité');
    // Champs classiques conservés.
    for (const id of ['firstName', 'lastName', 'email', 'password', 'confirmPassword', 'acceptedTerms']) expect(out).toContain(`id="${id}"`);
    // Le texte de contexte est en haut : avant le premier champ.
    expect(out.indexOf(DUO_INVITE_SIGNUP_TEXT)).toBeLessThan(out.indexOf('id="firstName"'));
  });

  it('DUO-SIGNUP-02 — inscription classique : parrainage facultatif avec le nouveau texte', () => {
    const out = html(h(SignupForm, {}));
    expect(REFERRAL_FIELD_HELP).toBe("Vous disposez d'un code de parrainage ? Saisissez-le ici.");
    expect(out).toContain('Code de parrainage (facultatif)');
    expect(out).toContain(REFERRAL_FIELD_HELP);
    expect(out).toContain('parrain bénéficiera');
    expect(out).not.toContain('Un proche vous a invité');
    expect(out).not.toContain(DUO_INVITE_SIGNUP_TEXT);
    expect(out).toContain('Créer mon compte et démarrer l’essai gratuit');
  });

  it('DUO-SIGNUP-03 — invitation invalide, expirée, utilisée, abonnement inactif : message explicite, sorties proposées', () => {
    const cas = [
      [{ kind: 'duo', state: 'expired' }, /expirée/],
      [{ kind: 'duo', state: 'used' }, /déjà utilisée/],
      [{ kind: 'duo', state: 'inactive' }, /inactif/],
      [{ kind: 'unknown', state: 'invalid' }, /invalide/],
    ] as const;
    for (const [ctx, titre] of cas) {
      expect(invitationInvalidContent(ctx).title).toMatch(titre);
      const out = html(h(SignupInvitationInvalid, { context: ctx, allowClassicSignup: true }));
      expect(out).toMatch(titre);
      expect(out).toContain('href="/login"');
      expect(out).toContain('Créer un compte sans invitation');
      expect(out).not.toContain('id="password"'); // pas de formulaire classique silencieux
    }
    // Pré-lancement : pas d'inscription sans invitation proposée.
    expect(html(h(SignupInvitationInvalid, { context: { kind: 'duo', state: 'expired' }, allowClassicSignup: false })))
      .not.toContain('Créer un compte sans invitation');
  });

  it('DUO-SIGNUP-04 — contexte établi côté serveur à partir du jeton ; aucun parrainage transmis pour un invité', () => {
    const page = read('src/app/(auth)/signup/page.tsx');
    expect(page).toMatch(/describeSignupInvitation\(token\)/);
    expect(page).not.toMatch(/['"]use client['"]/);
    const form = read('src/app/(auth)/signup/SignupForm.tsx');
    expect(form).toMatch(/isDuoInvite = invitation\?\.kind === 'duo'/);
    expect(form).toMatch(/referralCode: isDuoInvite \? undefined/);
    expect(form).toMatch(/duoParam = isDuoInvite \? '&duo=1'/);
    expect(form).not.toMatch(/params\.get\('duo'\)/);
  });
});
