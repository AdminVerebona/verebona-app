import { redirect } from 'next/navigation';

/**
 * Ancien écran « Templates Email » — supprimé par le CDC Back-Office V1 §15 (remplacé par Communications, sans édition de contenu).
 * L'URL historique renvoie vers l'écran cible ; aucune donnée ni action n'est
 * plus servie ici.
 */
export default function LegacyRedirect() {
  redirect('/admin/communications');
}
