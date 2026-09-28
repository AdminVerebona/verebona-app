import { redirect } from 'next/navigation';

/**
 * Ancien écran « Biens » — supprimé par le CDC Back-Office V1 §15 (informations support dans la fiche Compte).
 * L'URL historique renvoie vers l'écran cible ; aucune donnée ni action n'est
 * plus servie ici.
 */
export default function LegacyRedirect() {
  redirect('/admin/accounts');
}
