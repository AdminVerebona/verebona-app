import { redirect } from 'next/navigation';

/**
 * Ancien écran « Rétractations » — supprimé par le CDC Back-Office V1 §15 (SUB-015 : absorbées dans Abonnements & paiements et la fiche Compte).
 * L'URL historique renvoie vers l'écran cible ; aucune donnée ni action n'est
 * plus servie ici.
 */
export default function LegacyRedirect() {
  redirect('/admin/subscriptions');
}
