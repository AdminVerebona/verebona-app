'use client';

/**
 * « Gérer mon abonnement sur Stripe » — lien PERMANENT (lot 68C) sans
 * référence de compte : bouton historique, liens antérieurs au lot 72F.
 * Vue partagée : `components/billing/ManageSubscriptionView.tsx` (session
 * Stripe créée à l'ouverture, connexion puis retour, repli application
 * installée, refus explicites). Même composant sur ordinateur et mobile.
 */
import { ManageSubscriptionView } from '@/components/billing/ManageSubscriptionView';

export default function ManageSubscriptionPage() {
  return <ManageSubscriptionView />;
}
