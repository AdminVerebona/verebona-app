import { redirect } from 'next/navigation';

/**
 * Ancienne page « Types de biens » — CDC Back-Office V1 §9, §15.
 *
 * Les référentiels sont regroupés dans l'entrée « Référentiels », en lecture
 * seule (REFD-006). Redirection permanente vers le sous-onglet correspondant.
 */
export default function AssetTypesRedirect() {
  redirect('/admin/referentials?tab=families');
}
