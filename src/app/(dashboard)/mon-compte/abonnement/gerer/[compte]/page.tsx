'use client';

/**
 * « Gérer mon abonnement sur Stripe » — lien PERMANENT CONTEXTUALISÉ (lot 72F,
 * rappel J−7) : `/mon-compte/abonnement/gerer/<compte facturé>`.
 *
 * Le segment est la référence durable du compte facturé : le serveur vérifie
 * que l'utilisateur connecté en est le titulaire payeur (invité Duo et compte
 * d'autrui refusés, cohérence compte / abonnement / client Stripe) et n'ouvre
 * que CE portail ; la session Stripe est créée au clic. Déconnecté : le
 * middleware renvoie à la connexion avec ce chemin complet en retour. Même
 * composant sur ordinateur et mobile (application installée comprise).
 */
import { useParams } from 'next/navigation';
import { ManageSubscriptionView } from '@/components/billing/ManageSubscriptionView';

export default function ManageAccountSubscriptionPage() {
  const params = useParams<{ compte?: string }>();
  const ref = typeof params?.compte === 'string' ? params.compte : null;
  return <ManageSubscriptionView accountRef={ref ?? 'invalide'} />;
}
