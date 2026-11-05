"use client"

// Formulaire d'inscription. Rendu par ./page.tsx, qui décide selon
// SIGNUP_MODE (src/lib/prelaunch.ts) de l'afficher ou non.

import { useState, useEffect, useId } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AutofillInput } from '@/components/ui/autofill-input';
import { AUTOFILL, formFieldValue } from '@/lib/auth/autofill';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { LogoWithBaseline } from '@/components/Logo';
import { PasswordRequirements } from '@/components/auth/PasswordRequirements';
import { PasswordInput } from '@/components/ui/password-input';
import { LandingFooter } from '@/components/LandingFooter';
import { AuthBackHomeLink } from '@/components/auth/AuthBackHomeLink';
import { Crown, Users } from 'lucide-react';
import { FollowTheme } from '@/components/FollowTheme';
import { useLegalLinks } from '@/hooks/useLegalLinks';
import { CguvConsent } from '@/components/legal/CguvConsent';
import { useCurrentCguv } from '@/components/legal/useCurrentCguv';
import { z } from 'zod';
import { MIN_PASSWORD_LENGTH, checkPassword } from '@/lib/auth/password-rules';
import { MarketingSignupNotice, type MarketingChoiceValue } from '@/components/auth/MarketingSignupNotice';
import { rememberPendingDuoJoin } from '@/lib/duo/pending-duo-join';
import { SocialSignInButtons } from '@/components/auth/SocialSignInButtons';
import { socialErrorMessage } from '@/lib/auth/oauth/messages';
import { REFERRAL_TEXT } from '@/services/referral/referral-rules';
import { ReferralCodeDisclosure } from '@/components/auth/ReferralCodeDisclosure';
import { DISPOSABLE_EMAIL_MESSAGE, isDisposableEmailRefusal } from '@/lib/auth/disposable-email/messages';
import {
  DISPLAY_NAME_HELP, DISPLAY_NAME_LABEL, DISPLAY_NAME_MAX_LENGTH, DISPLAY_NAME_PLACEHOLDER, validateDisplayName,
} from '@/lib/auth/display-name';

/**
 * Contexte d'invitation établi CÔTÉ SERVEUR par ./page.tsx à partir du jeton
 * (lot 57A, ticket P2) — jamais déduit d'un paramètre d'URL côté client.
 */
export type SignupFormInvitation =
  | { kind: 'duo'; ownerName: string | null; inviteEmail: string | null }
  | { kind: 'account' };

/** Textes exacts du ticket P2 (invités Premium Duo / parrainage). */
export const DUO_INVITE_SIGNUP_TEXT =
  "Vous avez été invité à rejoindre un abonnement Premium Duo. Créez votre compte pour accepter l'invitation.";
export const DUO_INVITE_SIGNUP_BUTTON = 'Créer mon compte et rejoindre le Duo';
export const REFERRAL_FIELD_HELP = "Vous disposez d'un code de parrainage ? Saisissez-le ici.";

/** Refus d'invitation renvoyés par POST /api/users, en français. */
function invitationErrorMessage(code: string, duo: boolean): string | null {
  switch (code) {
    case 'INVITE_EMAIL_MISMATCH':
      return duo
        ? 'Cette invitation Premium Duo est destinée à une autre adresse e-mail. Utilisez l’adresse à laquelle vous avez reçu l’invitation.'
        : 'Ce lien d’invitation est destiné à une autre adresse e-mail.';
    case 'INVITE_TOKEN_EXPIRED':
      return duo
        ? 'Cette invitation Premium Duo a expiré. Demandez au titulaire de l’abonnement de vous en envoyer une nouvelle.'
        : 'Ce lien d’invitation a expiré. Demandez-en un nouveau à la personne qui vous a invité.';
    case 'INVALID_INVITE_TOKEN':
      return duo
        ? 'Cette invitation Premium Duo n’est plus valide (déjà utilisée ou retirée). Demandez une nouvelle invitation au titulaire.'
        : 'Ce lien d’invitation n’est plus valide. Demandez-en un nouveau à la personne qui vous a invité.';
    default:
      return null;
  }
}

/**
 * Lot 103B (décision PO du 31/10/2026) : un seul nom, « Prénom ou pseudo »
 * (`username`, non unique) — mêmes règles que le serveur
 * (`lib/auth/display-name.ts`). Prénom / nom civils : plus demandés ici
 * (facultatifs, dans Mon compte).
 */
const signupSchema = z.object({
  username: z.string().superRefine((value, ctx) => {
    const r = validateDisplayName(value);
    if (!r.ok) ctx.addIssue({ code: 'custom', message: r.message });
  }),
  email: z.string().email("Email invalide"),
  // CDC 18 §10.1 (lot 53A) : la règle vient de la SOURCE PARTAGÉE
  // `password-rules` — celle que le serveur applique — et n'est plus
  // redéclarée ici (risque de divergence client/serveur).
  password: z.string().superRefine((value, ctx) => {
    const r = checkPassword(value);
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (!r.hasMinLength) fail(`Minimum ${MIN_PASSWORD_LENGTH} caractères`);
    if (!r.hasLetter) fail("Une lettre est requise");
    if (!r.hasDigit) fail("Un chiffre est requis");
    if (!r.hasSpecial) fail("Un caractère spécial est requis");
    if (!r.hasNoSpace) fail("Pas d'espace autorisé");
  }),
  confirmPassword: z.string(),
  acceptedTerms: z.boolean().refine((val) => val === true, {
    message: "Vous devez accepter les CGUV pour créer un compte",
  }),
}).refine((data) => data.password === data.confirmPassword, {
  message: "Les mots de passe ne correspondent pas.",
  path: ["confirmPassword"],
});

export function SignupForm(props: { invitation?: SignupFormInvitation | null }) {
  const invitation = props.invitation ?? null;
  const router = useRouter();
  // Lot 57A (P2) : invité Premium Duo — contexte distinct du parrainage.
  const isDuoInvite = invitation?.kind === 'duo';
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  // Transmission d'un bien reçue sans compte : le jeton ouvre l'inscription
  // en pré-lancement (POST /api/users) et le bien est accepté après la
  // première connexion (accueil → `pending_transfer_token`).
  const [transmissionToken, setTransmissionToken] = useState<string | null>(null);
  const [referralCode, setReferralCode] = useState<string | null>(null);
  // Lot 102D : instant signé d'usage du lien `/r/<code>` (fenêtre de 90 jours).
  const [referralTouch, setReferralTouch] = useState<string | null>(null);
  // ══════════════════════════════════════════════════════════════════════════
  // VERSION DES CGUV RÉELLEMENT PRÉSENTÉE — CDC 7 §8.1 et §18
  //
  // Chargée à l'ouverture du formulaire et transmise telle quelle au serveur.
  // Si une nouvelle version devient courante pendant que l'utilisateur remplit
  // le formulaire, c'est bien celle qu'il a eu sous les yeux qui est
  // enregistrée : « ne pas remplacer silencieusement le document ».
  // ══════════════════════════════════════════════════════════════════════════
  const legalLinks = useLegalLinks();
  // Lot 111O : version présentée + reprise automatique en état de blocage
  // (relecture au retour sur l'onglet, au retour du réseau, à intervalles
  // croissants, ou « Réessayer ») ; figée dès qu'elle est acceptable (§18).
  const { cguv: legalVersion, checking: legalChecking, retry: retryLegal, markUnavailable: markLegalUnavailable } = useCurrentCguv();
  // ══════════════════════════════════════════════════════════════════════════
  // AUCUNE OFFRE N'EST CHOISIE A L'INSCRIPTION — CDC tarification §3.1
  //
  // « Tout nouveau compte beneficie automatiquement d'un essai gratuit unique
  //   de 7 jours [...] L'utilisateur ne choisit donc pas Standard, Premium ou
  //   Premium Duo lors de la creation de son compte. »
  //
  // L'ecran precedent proposait « activer Standard (2 mois offerts) », lisait
  // un parametre `?plan=` et redirigeait vers un paiement. Ce parcours n'existe
  // plus : ni carte bancaire, ni abonnement Stripe avant la fin de l'essai
  // (§4.2). Le parametre `plan` eventuellement present dans un ancien lien est
  // desormais ignore.
  // ══════════════════════════════════════════════════════════════════════════
  const [formData, setFormData] = useState({
    username: '',
    email: '',
    password: '',
    confirmPassword: '',
    acceptedTerms: false,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  // Lot 103B : critères du mot de passe détaillés au focus / pendant la saisie / en erreur.
  const [passwordFocused, setPasswordFocused] = useState(false);
  // Code arrivé par un lien `?ref=` : affiché « appliqué », le champ reste replié.
  const [referralFromLink, setReferralFromLink] = useState(false);
  const fieldIds = useId();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('inviteToken');
    const transmission = params.get('transmissionToken');
    const emailParam = params.get('email');
    const ref = params.get('ref');
    // Lot 93 : retour d'un parcours Google / Apple refusé ou annulé.
    const socialError = socialErrorMessage(params.get('social_error'));
    if (socialError) setError(socialError);

    if (ref && !isDuoInvite) {
      // Lot 57A (P2) : jamais de parrainage pour un invité Premium Duo.
      // CDC §4.2/§4.3 : le code de parrainage n'est conserve nulle part de
      // maniere persistante. Il vit uniquement en memoire pour la duree du
      // parcours, puis est propage par le parametre d'URL (§4.4).
      setReferralCode(ref.toUpperCase());
      setReferralFromLink(true);
      setReferralTouch(params.get('rt'));
    }
    {
      setInviteToken(token);
    }
    if (token && isDuoInvite) {
      // Contexte Duo conservé à travers rafraîchissement, vérification de
      // l'adresse et redirections (même navigateur) ; ailleurs, la reprise se
      // fait par l'adresse vérifiée (voir `lib/duo/pending-duo-join`).
      rememberPendingDuoJoin(token);
    }
    if (transmission) {
      setTransmissionToken(transmission);
      // Mécanisme existant de la page /transmission/[token] : l'accueil
      // accepte la transmission dès la première connexion. Reposé ici pour
      // le cas où l'utilisateur arrive par le lien « Créer mon compte ».
      try { localStorage.setItem('pending_transfer_token', transmission); } catch { /* stockage indisponible */ }
    }

    // La version applicable est chargée par `useCurrentCguv` (lot 111O) et
    // figée pour toute la durée du parcours dès qu'elle est acceptable.
    if (emailParam) {
      setFormData(prev => ({ ...prev, email: emailParam }));
    } else if (invitation?.kind === 'duo' && invitation.inviteEmail) {
      const invited = invitation.inviteEmail;
      setFormData(prev => (prev.email ? prev : { ...prev, email: invited }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- lecture unique à l'ouverture du formulaire
  }, []);

  // Lot 111O : la case vaut pour UNE version ; nouvelle version présentée
  // (ex. reprise après blocage) ou blocage → case décochée, jamais reportée.
  const presentedCode = legalVersion?.available ? legalVersion.versionCode : null;
  useEffect(() => {
    setFormData((prev) => (prev.acceptedTerms ? { ...prev, acceptedTerms: false } : prev));
  }, [presentedCode]);

  // Lot 102C : choix sur les relances commerciales (bloc fourni par le serveur selon le réglage BO).
  const [marketingChoice, setMarketingChoice] = useState<MarketingChoiceValue | null>(null);

  // Lot 111E : clé de l'état lue sur `data-field` (l'id du nom affiché n'est
  // plus « username », ambigu pour les gestionnaires de mots de passe) ; la
  // valeur est lue AVANT la mise à jour (deux champs remplis dans le même
  // instant par un gestionnaire ne s'écrasent pas).
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const key = e.target.dataset.field ?? e.target.id;
    const value = e.target.value;
    setFormData(prev => ({
      ...prev,
      [key]: value
    }));
    if (errors[key]) {
      setErrors(prev => {
        const newErrors = { ...prev };
        delete newErrors[key];
        return newErrors;
      });
    }
  };

  const handleCheckboxChange = (checked: boolean) => {
    setFormData(prev => ({
      ...prev,
      acceptedTerms: checked
    }));
    if (errors.acceptedTerms) {
      setErrors(prev => {
        const newErrors = { ...prev };
        delete newErrors.acceptedTerms;
        return newErrors;
      });
    }
  };

    // Lot 111E : état du rendu courant (la variable locale `formData` de l'envoi le complète).
    const formState = formData;
    const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      // Lot 111E : identifiant et mots de passe réellement présents (remplis /
      // générés par le gestionnaire sans événement vu par React).
      const form = e.currentTarget;
      const formData = {
        ...formState,
        email: formFieldValue(form, 'username', formState.email),
        password: formFieldValue(form, 'new-password', formState.password),
        confirmPassword: formFieldValue(form, 'confirm-password', formState.confirmPassword),
      };
      if (formData.email !== formState.email || formData.password !== formState.password || formData.confirmPassword !== formState.confirmPassword) {
        setFormData(formData);
      }
      setError('');
      setErrors({});
      setIsLoading(true);

      if (!formData.acceptedTerms) {
        setErrors({ acceptedTerms: "Vous devez accepter les CGUV pour créer un compte." });
        setIsLoading(false);
        return;
      }

        try {
          signupSchema.parse(formData);
      } catch (err) {
        if (err instanceof z.ZodError) {
          const fieldErrors: Record<string, string> = {};
          if (err.issues && Array.isArray(err.issues)) {
            err.issues.forEach((error) => {
              const path = error.path[0] as string;
              fieldErrors[path] = error.message;
            });
          }
          setErrors(fieldErrors);
          setIsLoading(false);
          return;
        }
      }

    try {
      // Aucune ecriture dans le stockage du navigateur : la session repose sur
      // des cookies HttpOnly, et le code de parrainage ne doit survivre ni a la
      // fermeture de l'onglet ni au parcours (CDC parrainage §4.2).
      const response = await fetch('/api/users', {
      credentials: 'include',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: formData.email,
          password: formData.password,
          // Lot 103B : seul nom transmis (prénom / nom civils non demandés).
          username: formData.username,
          // Pas de `signupPlan` : l'essai de 7 jours est attribue par le
          // serveur (`grantTrial`), et l'offre est choisie plus tard.
          planType: 'STANDARD',
          acceptedTerms: formData.acceptedTerms,
          // Code de la version affichée, jamais « la version courante » (§18).
          termsVersion: legalVersion?.versionCode,
          referralCode: isDuoInvite ? undefined : referralCode || undefined,
          referralTouch: isDuoInvite || !referralCode ? undefined : referralTouch || undefined,
          inviteToken: inviteToken || undefined,
          transmissionToken: transmissionToken || undefined,
          marketing: marketingChoice ?? undefined,
        }),
      });

      const data = await response.json();

          if (!response.ok) {
            if (data.code === 'CGUV_PUBLIC_TEXT_UNAVAILABLE') {
              // Lot 111O : refus serveur → état de blocage explicite et reprise automatique.
              markLegalUnavailable();
            } else if (data.code === 'DUPLICATE_EMAIL') {
              setError('Cette adresse email est déjà utilisée. Connectez-vous pour continuer.');
            } else if (isDisposableEmailRefusal(data)) {
              // Lot 109F : sous le champ e-mail, message unique du serveur.
              setErrors({ email: DISPOSABLE_EMAIL_MESSAGE });
            } else if (['MISSING_DISPLAY_NAME', 'DISPLAY_NAME_TOO_LONG', 'INVALID_DISPLAY_NAME'].includes(String(data.code))) {
              // Lot 103B : refus du « Prénom ou pseudo » (mêmes règles que le client).
              setErrors({ username: data.error || 'Indiquez votre prénom ou un pseudo.' });
            } else if (data.code === 'WEAK_PASSWORD') {
            setError(data.message || 'Le mot de passe ne respecte pas les exigences de sécurité.');
          } else if (invitationErrorMessage(String(data.code ?? ''), isDuoInvite)) {
            setError(invitationErrorMessage(String(data.code), isDuoInvite)!);
          } else {
            // La reference technique permet de retrouver l'incident dans les
            // journaux sans exposer la cause a l'utilisateur.
            const ref = data.reference ? ` (réf. ${data.reference})` : '';
            setError((data.error || 'Une erreur est survenue lors de la création du compte.') + ref);
          }
          setIsLoading(false);
          return;
        }

        // Verification de l'email obligatoire avant connexion. Aucune offre
        // n'est transportee : l'essai de 7 jours est deja actif cote serveur.
        // Lot 57A (P2) : le contexte Duo suit l'utilisateur jusqu'à la page
        // d'attente (rafraîchissement compris) ; aucun parrainage pour lui.
        const refParam = referralCode && !isDuoInvite ? `&ref=${referralCode}` : '';
        // Lot 72D : invitation à un compte partagé — même page d'attente
        // sans annonce d'essai (`joined=1`), l'identité rejoignant un compte.
        const duoParam = isDuoInvite ? '&duo=1' : invitation?.kind === 'account' ? '&joined=1' : '';
        router.push(`/verify-email?email=${encodeURIComponent(formData.email)}${refParam}${duoParam}`);
    } catch {
      setError('Une erreur est survenue. Veuillez réessayer.');
      setIsLoading(false);
    }
  };

  return (
    <div className="public-page min-h-screen flex flex-col bg-[color:var(--bg-page)]">
      <FollowTheme />
      <div className="flex-1 flex items-center justify-center p-4">
        <Card className="w-full max-w-lg bg-[color:var(--bg-card)] border-[color:var(--border-subtle)] shadow-xl">
          <CardHeader className="space-y-4">
            {/* Lot 103A : lien Web seulement — jamais rendu dans l'app iOS / Android. */}
            <AuthBackHomeLink />
            <div className="flex justify-center">
              <LogoWithBaseline size={50} />
            </div>
            <CardTitle role="heading" aria-level={1} className="text-center text-[26px] font-extrabold tracking-[-.02em] text-[color:var(--text-primary)]">Créer un compte</CardTitle>
            {isDuoInvite ? (
              <div
                data-testid="duo-invite-signup-context"
                className="bg-[color:var(--bg-success)] border border-[color:var(--border-success)] rounded-lg p-3 flex items-start gap-3"
              >
                <Users className="w-5 h-5 text-[color:var(--text-success)] flex-shrink-0 mt-0.5" />
                <div className="text-sm">
                  <p className="font-medium text-[color:var(--text-success)]">{DUO_INVITE_SIGNUP_TEXT}</p>
                  {invitation?.kind === 'duo' && invitation.ownerName && (
                    <p className="text-[color:var(--text-muted)] text-xs mt-0.5">
                      Invitation de {invitation.ownerName}. Rien ne vous sera facturé.
                    </p>
                  )}
                </div>
              </div>
            ) : (
            <CardDescription className="text-center text-[color:var(--text-muted)]">
              {inviteToken
                ? 'Créez votre compte pour rejoindre le compte partagé'
                : '7 jours d\u2019essai gratuit, sans carte bancaire'}
            </CardDescription>
            )}

            {/* Essai de 7 jours — CDC tarification §3.1 à §3.3. Les trois
                mentions rassurantes sont explicitement demandées au §14 :
                aucune carte, aucun prélèvement, données conservées.
                Lot 103B : introduction courte (une ligne + une note). */}
            {!inviteToken && (
              <div className="flex items-start gap-2 text-xs text-[color:var(--text-muted)]" data-testid="trial-intro">
                <Crown className="w-4 h-4 text-[color:var(--accent)] flex-shrink-0 mt-0.5" aria-hidden="true" />
                <p>
                  Toutes les fonctions Premium. Aucun prélèvement automatique à la fin de
                  l&apos;essai : vous choisirez votre offre à ce moment-là, et vos données
                  sont conservées. Pendant l&apos;essai : 2 biens et 30 documents.
                </p>
              </div>
            )}

            {inviteToken && !isDuoInvite && (
              <div className="bg-[color:var(--bg-success)] border border-[color:var(--border-success)] rounded-lg p-3 flex items-start gap-3">
                <Users className="w-5 h-5 text-[color:var(--text-success)] flex-shrink-0 mt-0.5" />
                <div className="text-sm">
                  <span className="font-medium text-[color:var(--text-success)]">Invitation à un compte partagé</span>
                  <p className="text-[color:var(--text-muted)] text-xs mt-0.5">
                    Vous rejoignez un compte Premium Duo existant. Rien ne vous sera facturé.
                  </p>
                </div>
              </div>
            )}
          </CardHeader>
          <CardContent>
            {/* Lot 93 (CDC 18 §7, SIGN-01) : Google, Apple, « ou », puis le formulaire.
                Le contexte (invitation, transmission, parrainage) suit au serveur. */}
            <SocialSignInButtons
              mode="signup"
              inviteToken={inviteToken}
              transmissionToken={transmissionToken}
              referralCode={isDuoInvite ? null : referralCode}
              referralTouch={isDuoInvite ? null : referralTouch}
              disabled={isLoading}
              className="mb-4"
            />
            <form onSubmit={handleSubmit} method="post" className="space-y-4" data-testid="signup-form">
              {/* Lot 103B : un seul nom, « Prénom ou pseudo » (non unique, obligatoire). */}
              <div className="space-y-2">
                {/* Lot 111E : id / name « displayName » (et non « username ») —
                    l'identifiant de connexion est l'e-mail ci-dessous. */}
                <Label htmlFor="displayName">{DISPLAY_NAME_LABEL} *</Label>
                <Input
                  id="displayName"
                  name="displayName"
                  data-field="username"
                  type="text"
                  placeholder={DISPLAY_NAME_PLACEHOLDER}
                  value={formData.username}
                  onChange={handleChange}
                  required
                  maxLength={DISPLAY_NAME_MAX_LENGTH * 2}
                  autoComplete="nickname"
                  autoCapitalize="words"
                  aria-invalid={errors.username ? true : undefined}
                  aria-describedby={`${fieldIds}-username-help${errors.username ? ` ${fieldIds}-username-error` : ''}`}
                  disabled={isLoading}
                />
                <p id={`${fieldIds}-username-help`} className="text-xs text-[color:var(--text-muted)]">{DISPLAY_NAME_HELP}</p>
                {errors.username && (
                  <p id={`${fieldIds}-username-error`} role="alert" className="text-sm text-destructive">{errors.username}</p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="email">E-mail *</Label>
                {/* Lot 111E : identifiant du compte enregistré par le gestionnaire. */}
                <AutofillInput
                  id="email"
                  name="username"
                  data-field="email"
                  type="email"
                  placeholder="votre.email@exemple.fr"
                  value={formData.email}
                  onChange={handleChange}
                  required
                  autoComplete={AUTOFILL.username}
                  inputMode="email"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  aria-invalid={errors.email ? true : undefined}
                  aria-describedby={errors.email ? `${fieldIds}-email-error` : undefined}
                  disabled={isLoading}
                />
                {errors.email && (
                  <p id={`${fieldIds}-email-error`} role="alert" className="text-sm text-destructive" data-testid="signup-email-error">{errors.email}</p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="password">Mot de passe *</Label>
                <PasswordInput
                  id="password"
                  name="new-password"
                  data-field="password"
                  autoComplete={AUTOFILL.newPassword}
                  value={formData.password}
                  onChange={handleChange}
                  onFocus={() => setPasswordFocused(true)}
                  onBlur={() => setPasswordFocused(false)}
                  required
                  aria-invalid={errors.password ? true : undefined}
                  aria-describedby={`${fieldIds}-password-rules${errors.password ? ` ${fieldIds}-password-error` : ''}`}
                  disabled={isLoading}
                />
                {errors.password && (
                  <p id={`${fieldIds}-password-error`} role="alert" className="text-sm text-destructive">{errors.password}</p>
                )}
                {/* Lot 103B : aide courte, critères détaillés au focus / en saisie / en erreur.
                    Règles inchangées (`password-rules`, vérifiées aussi par le serveur). */}
                <PasswordRequirements
                  id={`${fieldIds}-password-rules`}
                  password={formData.password}
                  confirmPassword={formData.confirmPassword}
                  showConfirmRule={true}
                  progressive
                  expanded={passwordFocused || formData.password.length > 0 || !!errors.password || !!errors.confirmPassword}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="confirmPassword">Confirmer le mot de passe *</Label>
                <PasswordInput
                  id="confirmPassword"
                  name="confirm-password"
                  data-field="confirmPassword"
                  autoComplete={AUTOFILL.newPassword}
                  value={formData.confirmPassword}
                  onChange={handleChange}
                  required
                  aria-invalid={errors.confirmPassword ? true : undefined}
                  aria-describedby={errors.confirmPassword ? `${fieldIds}-confirm-error` : undefined}
                  disabled={isLoading}
                />
                {errors.confirmPassword && (
                  <p id={`${fieldIds}-confirm-error`} role="alert" className="text-sm text-destructive">{errors.confirmPassword}</p>
                )}
              </div>

              {/* Code de parrainage — saisie manuelle (CDC §4.1).
                  Pre-rempli si l'utilisateur est arrive par un lien ?ref=.
                  Lot 57A (P2) : absent pour un invité Premium Duo. */}
              {!isDuoInvite && (
                // Lot 103B : replié derrière « J'ai un code de parrainage » ;
                // code reçu par lien `?ref=` affiché déjà appliqué.
                <ReferralCodeDisclosure
                  id="referralCode"
                  value={referralCode ?? ''}
                  onChange={(code) => setReferralCode(code || null)}
                  appliedFromLink={referralFromLink}
                  help={`${REFERRAL_FIELD_HELP} ${REFERRAL_TEXT.referredNotice}`}
                  termsHref={legalLinks.parrainage}
                  disabled={isLoading}
                />
              )}

              <div className="space-y-3 pt-2">
                {/* Lot 111O : case, libellé, version, « Lire les CGUV » et « Confidentialité »
                    sur une même colonne alignée (desktop + mobile) ; encart d'attente
                    seulement en état de blocage. */}
                <CguvConsent
                  id="acceptedTerms"
                  checked={formData.acceptedTerms}
                  onCheckedChange={handleCheckboxChange}
                  cguv={legalVersion}
                  fallbackCguvHref={legalLinks.cguv}
                  fallbackPrivacyHref={legalLinks.confidentialite}
                  disabled={isLoading}
                  checking={legalChecking}
                  onRetry={retryLegal}
                  error={errors.acceptedTerms}
                  readTestId="signup-read-cguv"
                />
                <MarketingSignupNotice onChange={setMarketingChoice} disabled={isLoading} />
              </div>

              {error && (
                <div className="text-sm text-destructive bg-destructive/10 p-3 rounded-md space-y-2">
                  <p>{error}</p>
                  {error.includes('déjà utilisée') && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="w-full border-destructive/40 text-destructive hover:bg-destructive/10"
                      onClick={() => router.push('/login')}
                    >
                      Se connecter
                    </Button>
                  )}
                </div>
              )}

              <Button type="submit" className="w-full" disabled={isLoading || legalVersion?.available === false}>
                {isLoading
                  ? 'Création...'
                  : isDuoInvite
                  ? DUO_INVITE_SIGNUP_BUTTON
                  : inviteToken
                  ? 'Créer mon compte et rejoindre'
                  : 'Créer mon compte et démarrer l\u2019essai gratuit'
                }
              </Button>

              <div className="text-center text-sm text-muted-foreground">
                Déjà un compte ?{' '}
                <Link href="/login" className="text-primary hover:underline">
                  Se connecter
                </Link>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
      <LandingFooter />
    </div>
  );
}
