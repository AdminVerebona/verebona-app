"use client"

// Formulaire d'inscription. Rendu par ./page.tsx, qui décide selon
// SIGNUP_MODE (src/lib/prelaunch.ts) de l'afficher ou non.

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { LogoWithBaseline } from '@/components/Logo';
import { PasswordRequirements } from '@/components/auth/PasswordRequirements';
import { PasswordInput } from '@/components/ui/password-input';
import { LandingFooter } from '@/components/LandingFooter';
import { ArrowLeft, Crown, Users } from 'lucide-react';
import { FollowTheme } from '@/components/FollowTheme';
import { publicSiteUrl } from '@/lib/external-urls';
import { z } from 'zod';
import { MIN_PASSWORD_LENGTH, checkPassword } from '@/lib/auth/password-rules';
import { Checkbox } from '@/components/ui/checkbox';
import { rememberPendingDuoJoin } from '@/lib/duo/pending-duo-join';

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

const signupSchema = z.object({
  firstName: z.string().min(1, "Le prénom est requis"),
  lastName: z.string().min(1, "Le nom est requis"),
  username: z.string().optional(),
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
    message: "Vous devez accepter les CGSU pour créer un compte",
  }),
}).refine((data) => data.password === data.confirmPassword, {
  message: "Les mots de passe ne correspondent pas.",
  path: ["confirmPassword"],
});

type SignupFormData = z.infer<typeof signupSchema>;

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
  // ══════════════════════════════════════════════════════════════════════════
  // VERSION DES CGVU RÉELLEMENT PRÉSENTÉE — CDC 7 §8.1 et §18
  //
  // Chargée à l'ouverture du formulaire et transmise telle quelle au serveur.
  // Si une nouvelle version devient courante pendant que l'utilisateur remplit
  // le formulaire, c'est bien celle qu'il a eu sous les yeux qui est
  // enregistrée : « ne pas remplacer silencieusement le document ».
  // ══════════════════════════════════════════════════════════════════════════
  const [legalVersion, setLegalVersion] = useState<{
    versionCode: string;
    permalink: string;
  } | null>(null);
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
    firstName: '',
    lastName: '',
    username: '',
    email: '',
    password: '',
    confirmPassword: '',
    acceptedTerms: false,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('inviteToken');
    const transmission = params.get('transmissionToken');
    const emailParam = params.get('email');
    const ref = params.get('ref');

    if (ref && !isDuoInvite) {
      // Lot 57A (P2) : jamais de parrainage pour un invité Premium Duo.
      // CDC §4.2/§4.3 : le code de parrainage n'est conserve nulle part de
      // maniere persistante. Il vit uniquement en memoire pour la duree du
      // parcours, puis est propage par le parametre d'URL (§4.4).
      setReferralCode(ref.toUpperCase());
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

    // La version applicable est figée pour toute la durée du parcours.
    fetch('/api/legal/cgvu/current', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.versionCode) {
          setLegalVersion({ versionCode: data.versionCode, permalink: data.permalink });
        }
      })
      .catch(() => {
        // Sans version chargée, le serveur retiendra la version courante au
        // moment de la création. Le parcours n'est pas bloqué pour autant.
      });
    if (emailParam) {
      setFormData(prev => ({ ...prev, email: emailParam }));
    } else if (invitation?.kind === 'duo' && invitation.inviteEmail) {
      const invited = invitation.inviteEmail;
      setFormData(prev => (prev.email ? prev : { ...prev, email: invited }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- lecture unique à l'ouverture du formulaire
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData(prev => ({
      ...prev,
      [e.target.id]: e.target.value
    }));
    if (errors[e.target.id]) {
      setErrors(prev => {
        const newErrors = { ...prev };
        delete newErrors[e.target.id];
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

    const handleSubmit = async (e: React.FormEvent) => {
      e.preventDefault();
      setError('');
      setErrors({});
      setIsLoading(true);

      if (!formData.acceptedTerms) {
        setErrors({ acceptedTerms: "Vous devez accepter les CGSU pour créer un compte." });
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
          firstName: formData.firstName,
          lastName: formData.lastName,
          username: formData.username || undefined,
          // Pas de `signupPlan` : l'essai de 7 jours est attribue par le
          // serveur (`grantTrial`), et l'offre est choisie plus tard.
          planType: 'STANDARD',
          acceptedTerms: formData.acceptedTerms,
          // Code de la version affichée, jamais « la version courante » (§18).
          termsVersion: legalVersion?.versionCode,
          referralCode: isDuoInvite ? undefined : referralCode || undefined,
          inviteToken: inviteToken || undefined,
          transmissionToken: transmissionToken || undefined,
        }),
      });

      const data = await response.json();

          if (!response.ok) {
            if (data.code === 'DUPLICATE_EMAIL') {
              setError('Cette adresse email est déjà utilisée. Connectez-vous pour continuer.');
            } else if (data.code === 'DUPLICATE_USERNAME') {
              setError(data.error || 'Ce nom d\'utilisateur est déjà utilisé.');
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
        const duoParam = isDuoInvite ? '&duo=1' : '';
        router.push(`/verify-email?email=${encodeURIComponent(formData.email)}${refParam}${duoParam}`);
    } catch (err) {
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
            <a
              href={publicSiteUrl("/")}
              className="inline-flex items-center gap-2 text-sm text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)] transition-colors w-fit"
            >
              <ArrowLeft className="w-4 h-4" />
              Retour à l'accueil
            </a>
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
                : 'Votre essai gratuit de 7 jours commence dès la création du compte'}
            </CardDescription>
            )}

            {/* Essai de 7 jours — CDC tarification §3.1 à §3.3. Les trois
                mentions rassurantes sont explicitement demandées au §14 :
                aucune carte, aucun prélèvement, données conservées. */}
            {!inviteToken && (
              <div className="bg-[color:var(--accent-soft)] border border-[color:var(--border-info)] rounded-lg p-3 flex items-start gap-3">
                <Crown className="w-5 h-5 text-[color:var(--accent)] flex-shrink-0 mt-0.5" />
                <div className="text-sm">
                  <span className="font-medium text-[color:var(--text-info)]">7 jours d&apos;essai, toutes les fonctions Premium</span>
                  <p className="text-[color:var(--text-muted)] text-xs mt-0.5">
                    Sans carte bancaire et sans engagement. Aucun prélèvement automatique
                    à la fin de l&apos;essai : vous choisirez votre offre à ce moment-là,
                    et vos données sont conservées.
                  </p>
                  <p className="text-[color:var(--text-muted)] text-xs mt-1">
                    Pendant l&apos;essai : 2 biens et 30 documents.
                  </p>
                </div>
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
            {referralCode && !isDuoInvite && (
              <div className="bg-[color:var(--accent-soft)] border border-[color:var(--border-info)] rounded-lg p-3 flex items-start gap-3">
                <span className="text-xl flex-shrink-0">🎁</span>
                <div className="text-sm">
                  {/* L'avantage revient au parrain, jamais au filleul.
                      Ce bandeau annonçait « un mois offert » à qui le lit —
                      une promesse non tenue, affichée au moment précis où il
                      décide de payer. */}
                  <span className="font-medium text-[color:var(--text-info)]">Code de parrainage appliqué</span>
                  <p className="text-[color:var(--text-muted)] text-xs mt-0.5">
                    Code <span className="font-mono font-semibold text-[color:var(--accent)]">{referralCode}</span> enregistré.
                    Votre parrain bénéficiera d&apos;un mois offert lorsque vous souscrirez un
                    abonnement annuel.
                  </p>
                </div>
              </div>
            )}
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="firstName">Prénom *</Label>
                  <Input
                    id="firstName"
                    type="text"
                    value={formData.firstName}
                    onChange={handleChange}
                    required
                    disabled={isLoading}
                  />
                  {errors.firstName && (
                    <p className="text-sm text-destructive">{errors.firstName}</p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="lastName">Nom *</Label>
                  <Input
                    id="lastName"
                    type="text"
                    value={formData.lastName}
                    onChange={handleChange}
                    required
                    disabled={isLoading}
                  />
                  {errors.lastName && (
                    <p className="text-sm text-destructive">{errors.lastName}</p>
                  )}
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="username">Nom d'utilisateur (optionnel)</Label>
                <Input
                  id="username"
                  type="text"
                  placeholder="Ex: sophiem"
                  value={formData.username}
                  onChange={handleChange}
                  disabled={isLoading}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="email">Email *</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="votre.email@exemple.fr"
                  value={formData.email}
                  onChange={handleChange}
                  required
                  disabled={isLoading}
                />
                {errors.email && (
                  <p className="text-sm text-destructive">{errors.email}</p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="password">Mot de passe *</Label>
                <PasswordInput
                  id="password"
                  autoComplete="new-password"
                  value={formData.password}
                  onChange={handleChange}
                  required
                  disabled={isLoading}
                />
                {errors.password && (
                  <p className="text-sm text-destructive">{errors.password}</p>
                )}
                <PasswordRequirements 
                  password={formData.password}
                  confirmPassword={formData.confirmPassword}
                  showConfirmRule={true}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="confirmPassword">Confirmer le mot de passe *</Label>
                <PasswordInput
                  id="confirmPassword"
                  autoComplete="new-password"
                  value={formData.confirmPassword}
                  onChange={handleChange}
                  required
                  disabled={isLoading}
                />
                {errors.confirmPassword && (
                  <p className="text-sm text-destructive">{errors.confirmPassword}</p>
                )}
              </div>

              {/* Code de parrainage — saisie manuelle (CDC §4.1).
                  Pre-rempli si l'utilisateur est arrive par un lien ?ref=.
                  Lot 57A (P2) : absent pour un invité Premium Duo. */}
              {!isDuoInvite && (
              <div className="space-y-2" data-testid="referral-code-field">
                <Label htmlFor="referralCode">Code de parrainage (facultatif)</Label>
                <Input
                  id="referralCode"
                  type="text"
                  placeholder="Ex. ABC123"
                  value={referralCode ?? ''}
                  onChange={(e) => setReferralCode(e.target.value.toUpperCase().trim() || null)}
                  disabled={isLoading}
                  autoComplete="off"
                />
                <p className="text-xs text-[color:var(--text-muted)]">
                  {REFERRAL_FIELD_HELP} Votre parrain bénéficiera d&apos;un mois offert lorsque
                  vous souscrirez un abonnement annuel.
                </p>
              </div>
              )}

              <div className="space-y-3 pt-2">
                <div className="flex items-start gap-3">
                  <Checkbox
                    id="acceptedTerms"
                    checked={formData.acceptedTerms}
                    onCheckedChange={handleCheckboxChange}
                    disabled={isLoading}
                    className="mt-1"
                  />
                  <Label 
                    htmlFor="acceptedTerms" 
                    className="text-base leading-relaxed cursor-pointer font-normal text-foreground"
                  >
                    J&apos;ai lu et j&apos;accepte les Conditions générales de vente et
                    d&apos;utilisation de Verebona, incluant la Politique de confidentialité.
                    {legalVersion && (
                      <span className="block text-xs text-[color:var(--text-muted)] mt-1">
                        Version {legalVersion.versionCode}
                      </span>
                    )}
                  </Label>
                </div>
                <div className="flex justify-center">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    asChild
                    disabled={isLoading}
                  >
                    {/* Ouvre la version EXACTE proposée à cet instant (§8.1),
                        et non la page courante qui pourrait changer. */}
                    <Link
                      href={legalVersion?.permalink ?? '/cgvu'}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Lire les conditions générales
                    </Link>
                  </Button>
                </div>
                {errors.acceptedTerms && (
                  <p className="text-sm text-destructive">{errors.acceptedTerms}</p>
                )}
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

              <Button type="submit" className="w-full" disabled={isLoading}>
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
