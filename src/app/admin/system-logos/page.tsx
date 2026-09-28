import { redirect } from 'next/navigation';

/**
 * Ancien écran « Logos système » — supprimé par le CDC Back-Office V1 §15 (hors BO, gérés dans le code).
 * L'URL historique renvoie vers l'écran cible ; aucune donnée ni action n'est
 * plus servie ici.
 */
export default function LegacyRedirect() {
  redirect('/admin');
}
