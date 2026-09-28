import { redirect } from 'next/navigation';

/**
 * Ancien écran « CGSU » — supprimé par le CDC Back-Office V1 §15 (LEG-001 : gestion et versionnement hors BO).
 * L'URL historique renvoie vers l'écran cible ; aucune donnée ni action n'est
 * plus servie ici.
 */
export default function LegacyRedirect() {
  redirect('/admin');
}
