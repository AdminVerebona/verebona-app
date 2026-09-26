import Link from 'next/link';
import { ArrowLeft, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { LogoWithBaseline } from '@/components/Logo';
import { LandingFooter } from '@/components/LandingFooter';
import { ForceTheme } from '@/components/ForceTheme';
import { publicSiteUrl } from '@/lib/external-urls';
import type { InvitationError } from '@/lib/prelaunch-invitations';

const INVITATION_MESSAGES: Record<InvitationError, string> = {
  INVALID_INVITE_TOKEN: "Ce lien d'invitation n'est plus valide. Demandez à la personne qui vous a invité de vous en envoyer un nouveau.",
  INVITE_TOKEN_EXPIRED: "Ce lien d'invitation a expiré. Demandez à la personne qui vous a invité de vous en envoyer un nouveau.",
  INVITE_EMAIL_MISMATCH: "Ce lien d'invitation est destiné à une autre adresse email.",
};

/**
 * /signup pendant le pré-lancement (SIGNUP_MODE=prelaunch) — inscription
 * fermée. Même gabarit que les autres pages d'authentification.
 */
export function SignupClosed({ invitationError }: { invitationError?: InvitationError | null }) {
  return (
    <div className="public-page min-h-screen flex flex-col bg-[color:var(--bg-page)]">
      <ForceTheme theme="blue" />
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
            <CardTitle className="text-center text-[color:var(--text-primary)]">Verebona ouvre bientôt</CardTitle>
            <CardDescription className="text-center text-[color:var(--text-muted)]">
              Les inscriptions ne sont pas encore ouvertes. Pour le moment, seules les personnes
              invitées peuvent créer un compte.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {invitationError && (
              <div role="alert" className="text-sm text-destructive bg-destructive/10 p-3 rounded-md">
                {INVITATION_MESSAGES[invitationError]}
              </div>
            )}
            <div className="bg-blue-950/40 border border-blue-500/30 rounded-lg p-3 flex items-start gap-3">
              <Sparkles className="w-5 h-5 text-blue-400 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-[color:var(--text-muted)]">
                Découvrez Verebona sur notre site en attendant l&apos;ouverture.
              </p>
            </div>
            <Button asChild className="w-full">
              <a href={publicSiteUrl('/')}>Découvrir Verebona</a>
            </Button>
            <div className="text-center text-sm text-muted-foreground">
              Déjà un compte ?{' '}
              <Link href="/login" className="text-primary hover:underline">
                Se connecter
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
      <LandingFooter />
    </div>
  );
}
