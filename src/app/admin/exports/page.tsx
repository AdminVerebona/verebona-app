import { redirect } from 'next/navigation';

/**
 * Ancien écran « Exports » — supprimé par le CDC Back-Office V1 §15 (volumes dans le Dashboard, modèles dans Modèles d’export).
 * L'URL historique renvoie vers l'écran cible ; aucune donnée ni action n'est
 * plus servie ici.
 */
export default function LegacyRedirect() {
  redirect('/admin/export-templates');
}
