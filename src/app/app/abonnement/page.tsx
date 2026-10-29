import type { Metadata } from 'next';
import Link from 'next/link';
import { CreditCard } from 'lucide-react';
import { NATIVE_COMMERCE_MESSAGE } from '@/lib/native/commerce';

/**
 * Écran d'information de l'application iOS / Android — lot 97B (CDC 12 COM-01,
 * COM-05, STORE-08 ; `lib/native/commerce`).
 *
 * Servi à la place de toute page d'offres, d'abonnement, de paiement ou de
 * rétractation ouverte DANS L'APP (lien, saisie, historique) : redirection du
 * middleware (agent utilisateur de l'app) et garde de l'hôte natif. Message
 * sobre, SANS lien ni adresse vers un achat (règles des stores, voir
 * `docs/exploitation/cdc12-mobile-ecarts.md`). Seuls des liens internes
 * (Mon compte, Accueil) sont proposés.
 */
export const metadata: Metadata = {
  title: 'Abonnement',
  robots: { index: false, follow: false },
};

export default function AbonnementDansApplicationPage() {
  return (
    <main className="public-page flex min-h-screen items-center justify-center p-6" data-testid="native-commerce-info">
      <div className="w-full max-w-sm space-y-4 text-center">
        <CreditCard className="mx-auto h-10 w-10 text-[color:var(--accent)]" aria-hidden />
        <h1 className="vb-app-title">Abonnement</h1>
        <p className="text-sm text-muted-foreground">{NATIVE_COMMERCE_MESSAGE}</p>
        <p className="text-sm text-muted-foreground">Votre offre actuelle reste visible dans Mon compte.</p>
        <div className="flex flex-col gap-2 pt-2">
          <Link href="/mon-compte" className="btn-add justify-center">Mon compte</Link>
          <Link href="/accueil" className="text-sm text-muted-foreground underline-offset-4 hover:underline">Retour à l’accueil</Link>
        </div>
      </div>
    </main>
  );
}
