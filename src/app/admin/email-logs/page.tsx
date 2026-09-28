import { redirect } from 'next/navigation';

/**
 * Ancien écran « Journal des e-mails » — supprimé par le CDC Back-Office V1 §15 (historique individuel dans la fiche Utilisateur, anomalies dans Supervision).
 * L'URL historique renvoie vers l'écran cible ; aucune donnée ni action n'est
 * plus servie ici.
 */
export default function LegacyRedirect() {
  redirect('/admin/communications');
}
