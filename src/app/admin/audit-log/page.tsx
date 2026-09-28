import { redirect } from 'next/navigation';

/**
 * Ancien écran « Journal d’audit » — supprimé par le CDC Back-Office V1 §15 (pas d’onglet V1, logs techniques conservés).
 * L'URL historique renvoie vers l'écran cible ; aucune donnée ni action n'est
 * plus servie ici.
 */
export default function LegacyRedirect() {
  redirect('/admin');
}
