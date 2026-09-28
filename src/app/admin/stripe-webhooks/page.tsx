import { redirect } from 'next/navigation';

/**
 * Ancien écran « Webhooks Stripe » — supprimé par le CDC Back-Office V1 §15 (absorbés dans Supervision et diagnostic Stripe).
 * L'URL historique renvoie vers l'écran cible ; aucune donnée ni action n'est
 * plus servie ici.
 */
export default function LegacyRedirect() {
  redirect('/admin?tab=supervision');
}
