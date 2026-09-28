import { redirect } from 'next/navigation';

/**
 * Ancien écran « Échéances » — supprimé par le CDC Back-Office V1 §15 (données liées visibles depuis les objets concernés, KPI dans Activité).
 * L'URL historique renvoie vers l'écran cible ; aucune donnée ni action n'est
 * plus servie ici.
 */
export default function LegacyRedirect() {
  redirect('/admin?tab=activity');
}
