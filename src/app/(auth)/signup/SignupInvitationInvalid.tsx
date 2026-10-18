import Link from 'next/link';
import { AlertCircle, ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { LogoWithBaseline } from '@/components/Logo';
import { LandingFooter } from '@/components/LandingFooter';
import { FollowTheme } from '@/components/FollowTheme';
import { publicSiteUrl } from '@/lib/external-urls';
import type { SignupInvitationContext } from '@/lib/prelaunch-invitations';

/** Titre et message par cas (lot 57A, ticket P2 — invitations invalides). */
export function invitationInvalidContent(ctx: SignupInvitationContext): { title: string; message: string } {
  const duo = ctx.kind === 'duo';
  switch (ctx.state) {
    case 'expired':
      return {
        title: duo ? 'Invitation Premium Duo expirée' : 'Invitation expirée',
        message: duo
          ? "Cette invitation à rejoindre un abonnement Premium Duo a expiré. Demandez au titulaire de l'abonnement de vous envoyer une nouvelle invitation."
          : "Ce lien d'invitation a expiré. Demandez à la personne qui vous a invité de vous en envoyer un nouveau.",
      };
    case 'used':
      return {
        title: duo ? 'Invitation Premium Duo déjà utilisée' : 'Invitation déjà utilisée',
        message: duo
          ? "Cette invitation Premium Duo a déjà été acceptée. Si vous l'avez acceptée vous-même, connectez-vous pour accéder à l'espace partagé ; sinon, demandez au titulaire une nouvelle invitation."
          : "Ce lien d'invitation a déjà été utilisé. Connectez-vous si vous avez déjà créé votre compte.",
      };
    case 'inactive':
      return {
        title: 'Abonnement Premium Duo inactif',
        message: "L'abonnement Premium Duo associé à cette invitation n'est plus actif. Rapprochez-vous de son titulaire.",
      };
    default:
      return {
        title: 'Invitation invalide',
        message: "Ce lien d'invitation n'est pas valide. Vérifiez que vous avez copié le lien en entier, ou demandez une nouvelle invitation à la personne qui vous a invité.",
      };
  }
}

/**
 * /signup avec un lien d'invitation expiré, déjà utilisé ou inconnu : message
 * EXPLICITE — jamais de basculement silencieux vers l'inscription classique.
 * Même gabarit que les autres pages d'authentification (une seule colonne,
 * ordinateur et mobile).
 */
export function SignupInvitationInvalid({
  context,
  allowClassicSignup,
}: {
  context: SignupInvitationContext;
  /** Inscription ouverte (hors pré-lancement) : proposer de continuer sans invitation. */
  allowClassicSignup: boolean;
}) {
  const { title, message } = invitationInvalidContent(context);
  return (
    <div className="public-page min-h-screen flex flex-col bg-[color:var(--bg-page)]">
      <FollowTheme />
      <div className="flex-1 flex items-center justify-center p-4">
        <Card className="w-full max-w-lg bg-[color:var(--bg-card)] border-[color:var(--border-subtle)] shadow-xl">
          <CardHeader className="space-y-4">
            <a
              href={publicSiteUrl('/')}
              className="inline-flex items-center gap-2 text-sm text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)] transition-colors w-fit"
            >
              <ArrowLeft className="w-4 h-4" />
              Retour à l&apos;accueil
            </a>
            <div className="flex justify-center">
              <LogoWithBaseline size={50} />
            </div>
            <div className="flex justify-center">
              <AlertCircle className="w-12 h-12 text-[color:var(--attention-on-soft)]" />
            </div>
            <CardTitle role="heading" aria-level={1} className="text-center text-[26px] font-extrabold tracking-[-.02em] text-[color:var(--text-primary)]" data-testid="signup-invitation-invalid">{title}</CardTitle>
            <CardDescription className="text-center text-[color:var(--text-muted)]">{message}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Button asChild className="w-full">
              <Link href="/login">J&apos;ai déjà un compte : me connecter</Link>
            </Button>
            {allowClassicSignup && (
              <Button asChild variant="outline" className="w-full">
                <Link href="/signup">Créer un compte sans invitation</Link>
              </Button>
            )}
            <Button asChild variant="ghost" className="w-full">
              <a href={publicSiteUrl('/')}>Retour à l&apos;accueil</a>
            </Button>
          </CardContent>
        </Card>
      </div>
      <LandingFooter />
    </div>
  );
}
