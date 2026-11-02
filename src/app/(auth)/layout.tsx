import { ReactNode } from 'react';
import { headers } from 'next/headers';
import { FollowTheme } from '@/components/FollowTheme';
import { NativeShellProvider } from '@/components/auth/AuthBackHomeLink';
import { isNativeAppUserAgent } from '@/lib/native/commerce';

export default async function AuthLayout({ children }: { children: ReactNode }) {
  // Lot 103A : vue de l'application iOS / Android (marqueur `VerebonaApp/` de
  // l'agent utilisateur, posé par le build) — décidé AU RENDU SERVEUR pour que
  // les éléments propres au Web (« Retour à l'accueil ») ne clignotent pas.
  const native = isNativeAppUserAgent((await headers()).get('user-agent'));
  return (
    // Lot 103B : `vb-auth-shell` réserve les zones sûres iOS / Android (barre
    // d'état, encoche / Dynamic Island, barre d'accueil) — globals.css.
    <div className="public-page vb-auth-shell" data-testid="auth-shell">
      <FollowTheme />
      <NativeShellProvider native={native}>{children}</NativeShellProvider>
    </div>
  );
}
