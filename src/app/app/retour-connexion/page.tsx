import type { Metadata } from 'next';
import { ReturnToApp } from './ReturnToApp';

/**
 * Repli du retour Google / Apple de l'application mobile — lot 95 (PO M1 ;
 * APP_OAUTH_RETURN_URL = origine + `/app/retour-connexion`).
 *
 * Normalement, cette adresse n'est jamais affichée : l'application la capte
 * (ASWebAuthenticationSession sur iOS, App Link sur Android) et échange le code
 * elle-même. Si le navigateur l'ouvre malgré tout (lien non vérifié,
 * application absente), la page invite à revenir dans l'application. Elle ne
 * lit, n'échange ni ne journalise jamais le code : seul le vérificateur PKCE
 * détenu par l'application peut l'utiliser.
 */
export const metadata: Metadata = {
  title: 'Retour dans l’application',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default function RetourConnexionApplicationPage() {
  return (
    <main className="public-page flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-4 text-center">
        <h1 className="vb-app-title">Connexion presque terminée</h1>
        <p className="text-sm text-muted-foreground">
          Revenez dans l’application Verebona sur votre téléphone pour terminer la connexion.
        </p>
        <ReturnToApp />
        <p className="text-xs text-muted-foreground">
          Sur un ordinateur, connectez-vous directement sur le site Verebona.
        </p>
      </div>
    </main>
  );
}
