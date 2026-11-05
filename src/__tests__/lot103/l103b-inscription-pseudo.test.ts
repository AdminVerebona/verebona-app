/**
 * Lot 103B — inscription « Prénom ou pseudo » (décision PO du 31/10/2026) :
 * règles pures, affichage (nom, initiales, salutation), e-mails, formulaire
 * court, parrainage replié, mot de passe progressif, zones sûres iOS.
 * Parcours réels : `src/test/e2e/scenarios/l103b-inscription-pseudo.e2e.ts`.
 */
import * as React from 'react';
import { createElement as h } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

(globalThis as { React?: typeof React }).React = React;
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => '/signup' }));

const {
  validateDisplayName, personalAccountName, cleanCivilName, DISPLAY_NAME_MAX_LENGTH, DISPLAY_NAME_LABEL, DISPLAY_NAME_HELP,
} = await import('@/lib/auth/display-name');
const { greetingName, formatUserDisplayName, formatUserInitials, NEUTRAL_DISPLAY_NAME } = await import('@/lib/user-display-name');
const { neutralizeEmptyGreeting, safeTemplateVariables } = await import('@/lib/email/variable-safety');
const { PasswordRequirements, PASSWORD_SHORT_HELP } = await import('@/components/auth/PasswordRequirements');
const { ReferralCodeDisclosure } = await import('@/components/auth/ReferralCodeDisclosure');
const { SignupForm } = await import('@/app/(auth)/signup/SignupForm');

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const html = (el: React.ReactElement) => renderToStaticMarkup(el).replace(/&#x27;/g, "'").replace(/&amp;/g, '&');

describe('L103B — règles du « Prénom ou pseudo »', () => {
  it('obligatoire : absent, vide, espaces, invisibles → MISSING ; contrôle → INVALID ; > 60 → TOO_LONG', () => {
    for (const v of [undefined, null, 42, '', '   ', '\t\n', '\u200b\u2060\ufeff']) {
      expect(validateDisplayName(v)).toMatchObject({ ok: false, code: 'MISSING_DISPLAY_NAME' });
    }
    expect(validateDisplayName('So\u0000phie')).toMatchObject({ ok: false, code: 'INVALID_DISPLAY_NAME' });
    expect(validateDisplayName('So\nphie')).toMatchObject({ ok: false, code: 'INVALID_DISPLAY_NAME' });
    expect(DISPLAY_NAME_MAX_LENGTH).toBe(60);
    expect(validateDisplayName('a'.repeat(61))).toMatchObject({ ok: false, code: 'DISPLAY_NAME_TOO_LONG' });
    expect(validateDisplayName('a'.repeat(60))).toEqual({ ok: true, value: 'a'.repeat(60) });
  });

  it('normalisation : bords nettoyés, espaces internes réduits, NFC ; accents, Unicode, emoji (1 caractère perçu), HTML gardé comme texte', () => {
    expect(validateDisplayName('  Sophie  ')).toEqual({ ok: true, value: 'Sophie' });
    expect(validateDisplayName('Jean    Marc')).toEqual({ ok: true, value: 'Jean Marc' });
    expect(validateDisplayName('Zoé')).toEqual({ ok: true, value: 'Zoé' });
    expect(validateDisplayName('\u200bLê 李\u200b')).toEqual({ ok: true, value: 'Lê 李' });
    expect(validateDisplayName('<script>alert(1)</script>')).toEqual({ ok: true, value: '<script>alert(1)</script>' });
    expect(validateDisplayName(`${'👩\u200d👩\u200d👧'.repeat(60)}`).ok).toBe(true);
  });

  it('civils facultatifs nettoyés ; nom de compte « Compte de <pseudo> », jamais « Compte de  »', () => {
    expect(cleanCivilName(undefined)).toBe('');
    expect(cleanCivilName('  Marie\u0000 ')).toBe('Marie');
    expect(personalAccountName({ username: 'Sophie' })).toBe('Compte de Sophie');
    expect(personalAccountName({ username: ' ', firstName: 'Jean', lastName: 'Dupont' })).toBe('Compte de Jean Dupont');
    expect(personalAccountName({ username: null, firstName: '', lastName: '' })).toBe('Mon compte');
    expect(personalAccountName({})).not.toMatch(/Compte de\s*$/);
  });
});

describe('L103B — nom affiché, initiales, salutation', () => {
  const nouveau = { username: 'Sophie', firstName: '', lastName: '', email: 's@x.fr' };
  const ancienSansPseudo = { username: null, firstName: 'Geoffroy', lastName: 'Maupilier' };
  const incomplet = { username: null, firstName: '', lastName: '', email: 'zed@x.fr' };

  it('pseudo → ancien prénom → neutre ; jamais « undefined »', () => {
    expect(greetingName(nouveau)).toBe('Sophie');
    expect(greetingName(ancienSansPseudo)).toBe('Geoffroy');
    expect(greetingName(incomplet)).toBe('');
    expect(greetingName({ firstName: undefined, username: undefined })).toBe('');
    expect(formatUserDisplayName(nouveau)).toBe('Sophie');
    expect(formatUserDisplayName(ancienSansPseudo)).toBe('Geoffroy M.');
    expect(formatUserDisplayName(incomplet)).toBe(NEUTRAL_DISPLAY_NAME);
    for (const u of [nouveau, ancienSansPseudo, incomplet]) {
      expect(formatUserDisplayName(u)).not.toMatch(/undefined|null/);
    }
  });

  it('initiales jamais vides : civils (historique) → pseudo → prénom → adresse → « V »', () => {
    expect(formatUserInitials(ancienSansPseudo)).toBe('GM');
    expect(formatUserInitials({ ...ancienSansPseudo, username: 'Geoffroy' })).toBe('GM');
    expect(formatUserInitials(nouveau)).toBe('S');
    expect(formatUserInitials({ username: 'jean marc' })).toBe('JM');
    expect(formatUserInitials({ username: 'élodie' })).toBe('É');
    expect(formatUserInitials({ username: '😀 Zoé' })).toBe('Z');
    expect(formatUserInitials({ firstName: 'Anne', lastName: '' })).toBe('A');
    expect(formatUserInitials(incomplet)).toBe('Z');
    expect(formatUserInitials({ username: '😀' })).toBe('V');
  });

  it('accueil, menu, panneau mobile, écrans sans espace / réacceptation : même source', () => {
    expect(read('src/app/(dashboard)/accueil/page.tsx')).toContain('const greetingName = formatGreetingName(user);');
    expect(read('src/components/home/MascotSpeaks.tsx')).toContain("{greetingName ? `, ${greetingName}` : ''}");
    const layout = read('src/components/DashboardLayout.tsx');
    expect(layout).toContain('<NoSpaceScreen firstName={greetingName(user) || null}');
    expect(layout).toContain('firstName={greetingName(user) || null}');
  });
});

describe('L103B — e-mails : pseudo ou formule neutre', () => {
  it('« Bonjour {{firstName}}, » → « Bonjour, » si le nom est vide / absent ; inchangé sinon', () => {
    const t = 'Bonjour {{firstName}},\n\nTexte. <p style="x">Bonjour {{firstName}},</p>';
    expect(neutralizeEmptyGreeting(t, { firstName: '' })).toBe('Bonjour,\n\nTexte. <p style="x">Bonjour,</p>');
    expect(neutralizeEmptyGreeting(t, {})).not.toContain('{{firstName}}');
    expect(neutralizeEmptyGreeting(t, { firstName: 'undefined' })).not.toMatch(/Bonjour\s*,?\s*undefined/);
    expect(neutralizeEmptyGreeting(t, { firstName: 'Sophie' })).toBe(t);
  });

  it('un pseudo HTML est neutralisé dans l’e-mail (texte, jamais balise)', () => {
    const v = safeTemplateVariables({ firstName: '<b>Sophie</b> <img src=x onerror=1>' }, 'html');
    expect(v.firstName).not.toMatch(/<b>|<img/);
  });

  it('renderTemplate applique la salutation neutre ; vérification, bienvenue, mot de passe, compte existant, changement d’adresse et fin d’essai saluent par le pseudo', () => {
    expect(read('src/lib/email/email-service.ts')).toContain('neutralizeEmptyGreeting(template.body, aliased)');
    const pseudoSql = "COALESCE(NULLIF(btrim(username), ''), first_name) AS first_name";
    expect(read('src/services/email/transactional-email-jobs.service.ts')).toContain(pseudoSql);
    expect(read('src/services/auth/email-change.service.ts')).toContain(pseudoSql);
    expect(read('src/services/trial-lifecycle/sequence.service.ts')).toContain("COALESCE(NULLIF(btrim(u.username), ''), u.first_name) AS first_name");
    expect(read('src/app/api/auth/verify-email/route.ts')).toContain('firstName: greetingName(user)');
    expect(read('src/services/auth/password-reset.service.ts')).toContain('firstName: greetingName(user)');
    expect(read('src/services/auth/signup-existing-email.service.ts')).toContain('greetingName(user)');
    expect(read('src/lib/auth/oauth/social-signup.ts')).toContain("variables: { firstName: username ?? ''");
  });
});

describe('L103B — formulaire d’inscription court', () => {
  it('exactement quatre champs de saisie (pseudo, e-mail, mot de passe, confirmation), plus de prénom / nom / « Nom d’utilisateur (optionnel) »', () => {
    const out = html(h(SignupForm, {}));
    const inputs = [...out.matchAll(/<input\b[^>]*>/g)].map((m) => m[0]).filter((i) => !/type="(checkbox|hidden)"/.test(i));
    // Lot 111E : l'id du pseudo devient « displayName » (« username » était ambigu pour les gestionnaires de mots de passe).
    expect(inputs.map((i) => /id="([^"]+)"/.exec(i)?.[1])).toEqual(['displayName', 'email', 'password', 'confirmPassword']);
    expect(out).toContain(`${DISPLAY_NAME_LABEL} *`);
    expect(out).toContain(DISPLAY_NAME_HELP);
    expect(out).toContain('placeholder="Sophie"');
    expect(out).not.toMatch(/Nom d'utilisateur|Prénom \*|>Nom \*/);
    // Ordre du ticket : pseudo, e-mail, mot de passe, confirmation, parrainage replié, CGUV, bouton.
    const order = ['id="displayName"', 'id="email"', 'id="password"', 'id="confirmPassword"', 'J’ai un code de parrainage', 'id="acceptedTerms"', 'type="submit"'];
    const idx = order.map((s) => out.indexOf(s));
    expect(idx.every((v) => v >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    // Essai : introduction courte conservée (CDC tarification §3, §14).
    expect(out).toContain('7 jours d’essai gratuit, sans carte bancaire');
    expect(out).toContain('Aucun prélèvement automatique');
    expect(out).toContain('vos données');
    expect(out).toContain('Créer mon compte et démarrer l’essai gratuit');
  });

  it('mot de passe : aide courte au chargement (pas les six règles) ; critères restants au focus / en saisie ; règles inchangées', () => {
    const out = html(h(SignupForm, {}));
    expect(out).toContain(PASSWORD_SHORT_HELP);
    expect(out).not.toContain('Exigences du mot de passe');
    expect(out).not.toContain('Au moins 1 chiffre');
    const detail = html(h(PasswordRequirements, { password: 'abc', confirmPassword: '', showConfirmRule: true, progressive: true, expanded: true }));
    expect(detail).toContain('Minimum 10 caractères');
    expect(detail).toContain('Au moins 1 chiffre');
    expect(detail).not.toContain('Au moins 1 lettre'); // déjà remplie
    const ok = html(h(PasswordRequirements, { password: 'Abcdefgh1!', confirmPassword: 'Abcdefgh1!', showConfirmRule: true, progressive: true, expanded: true }));
    expect(ok).toContain('Mot de passe conforme');
    expect(ok).toContain('La confirmation est identique');
    // Écrans « Mon compte » : liste complète inchangée.
    const full = html(h(PasswordRequirements, { password: '', showConfirmRule: true }));
    expect(full).toContain('Exigences du mot de passe');
    expect((full.match(/<span>/g) ?? []).length).toBe(6);
    const form = read('src/app/(auth)/signup/SignupForm.tsx');
    expect(form).toContain('checkPassword(value)');
    expect(form).toContain("confirmPassword: z.string(),");
  });

  it('parrainage : replié ; code du lien affiché appliqué ; jamais pour un invité Duo', () => {
    const replie = html(h(ReferralCodeDisclosure, { id: 'r', value: '', onChange: () => {} }));
    expect(replie).toContain('J’ai un code de parrainage');
    expect(replie).not.toContain('<input');
    const applique = html(h(ReferralCodeDisclosure, { id: 'r', value: 'ABC123', onChange: () => {}, appliedFromLink: true }));
    expect(applique).toContain('ABC123');
    expect(applique).toContain('appliqué');
    expect(applique).toContain('parrain recevra');
    const saisi = html(h(ReferralCodeDisclosure, { id: 'r', value: 'XYZ', onChange: () => {} }));
    expect(saisi).toContain('id="r"');
    const duo = html(h(SignupForm, { invitation: { kind: 'duo', ownerName: null, inviteEmail: null } }));
    expect(duo).not.toMatch(/parrain/i);
    const form = read('src/app/(auth)/signup/SignupForm.tsx');
    expect(form).toContain('setReferralFromLink(true)');
    expect(form).toContain('referralCode: isDuoInvite ? undefined');
    expect(form).toContain('<MarketingSignupNotice');
    expect(form).toContain('useLegalLinks()');
    expect(form).not.toContain('DUPLICATE_USERNAME');
  });
});

describe('L103B — Google / Apple, profil, serveur, base', () => {
  it('connexion-sociale : un seul champ prérempli (prénom du fournisseur), plus de prénom / nom exigés', () => {
    const page = read('src/app/(auth)/connexion-sociale/page.tsx');
    expect(page).not.toMatch(/id="sp-first"|id="sp-last"/);
    expect(page).toContain('id="sp-display-name"');
    expect(page).toContain("setDisplayName(s.suggestedDisplayName ?? s.firstName ?? '')");
    expect(page).toContain("action: 'signup', username: dn.value");
    expect(page).toContain('<ReferralCodeDisclosure');
    expect(page).toContain('<MarketingSignupNotice');
    expect(read('src/lib/auth/oauth/pending.ts')).toContain('suggestedDisplayName: c.firstName?.trim() || null');
  });

  it('profil : « Prénom ou pseudo » en premier, civils facultatifs, envoi des seuls champs modifiés ; PUT partiel', () => {
    const tab = read('src/app/(dashboard)/mon-compte/informations/InformationsTab.tsx');
    expect(tab).not.toContain('Le prénom et le nom sont requis');
    expect(tab.indexOf('htmlFor="username"')).toBeLessThan(tab.indexOf('htmlFor="firstName"'));
    expect(tab).toContain('Prénom (facultatif)');
    expect(tab).toContain('if (profile.username !== initialProfile.username)');
    const put = read('src/app/api/users/me/route.ts');
    expect(put).not.toContain('Le prénom et le nom sont requis');
    expect(put).toContain("if ('username' in body)");
    expect(put).toContain("if ('firstName' in body)");
    expect(put).toContain('invalidateUserReadCache(session.userId)');
  });

  it('serveur : plus d’unicité ni de champs civils obligatoires ; base : migration 0935, schéma sans .unique()', () => {
    const route = read('src/app/api/users/route.ts');
    expect(route).not.toMatch(/DUPLICATE_USERNAME|existingUserByUsername|MISSING_FIRST_NAME|MISSING_LAST_NAME/);
    expect(route).toContain('name: personalAccountName({ username: sanitizedUsername })');
    const social = read('src/lib/auth/oauth/social-signup.ts');
    expect(social).not.toMatch(/MISSING_FIRST_NAME|MISSING_LAST_NAME/);
    const schema = read('src/db/schema.ts');
    expect(schema).toMatch(/username: text\('username'\),/);
    expect(schema).not.toMatch(/username: text\('username'\)\.unique\(\)/);
    expect(schema).toMatch(/email: text\('email'\)[^\n]*\.unique\(\)/);
    const sql = read('src/db/migrations/0935_l103b_pseudo_non_unique.sql');
    expect(sql).toContain('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_username_unique;');
    expect(sql).toContain("con.conkey = ARRAY[col]::smallint[]");
    expect(sql).not.toMatch(/DROP CONSTRAINT[^;\n]*email/i);
    expect(sql).not.toMatch(/auth_identities/);
  });

  it('zones sûres iOS : coquille d’auth avec encarts, voile sous la barre d’état ; viewport-fit=cover conservé', () => {
    expect(read('src/app/(auth)/layout.tsx')).toContain('className="public-page vb-auth-shell"');
    const css = read('src/app/globals.css');
    const bloc = css.slice(css.indexOf('.vb-auth-shell {'));
    expect(bloc).toContain('padding: var(--vb-safe-top) var(--vb-safe-right) var(--vb-safe-bottom) var(--vb-safe-left);');
    expect(bloc).toContain('.vb-auth-shell::before');
    expect(bloc).toContain('.vb-auth-shell .min-h-screen { min-height: calc(100dvh - var(--vb-safe-top) - var(--vb-safe-bottom)); }');
    expect(css).toContain('--vb-safe-top: max(var(--safe-area-inset-top, 0px), env(safe-area-inset-top, 0px));');
    expect(read('src/app/layout.tsx')).toContain("viewportFit: 'cover'");
    expect(read('mobile/capacitor.config.ts')).toContain("contentInset: 'never'");
  });
});
