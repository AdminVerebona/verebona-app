import { redirect } from 'next/navigation';

/**
 * Ancien écran « Fichiers » — supprimé par le CDC Back-Office V1 §15 (métadonnées dans la fiche Compte, contenu inaccessible).
 * L'URL historique renvoie vers l'écran cible ; aucune donnée ni action n'est
 * plus servie ici.
 */
export default function LegacyRedirect() {
  redirect('/admin/accounts');
}
