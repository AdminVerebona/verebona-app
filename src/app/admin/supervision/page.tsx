import { redirect } from 'next/navigation';

/**
 * La Supervision est un sous-onglet du Dashboard (CDC BO DASH-002), pas une
 * entrée de navigation (§3) : l'URL courte y renvoie.
 */
export default function SupervisionIndexPage() {
  redirect('/admin?tab=supervision');
}
