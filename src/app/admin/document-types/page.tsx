import { redirect } from 'next/navigation';

/**
 * Ancienne page « Types de documents » — CDC Back-Office V1 §9, §15.
 *
 * Les référentiels sont regroupés dans l'entrée « Référentiels », en lecture
 * seule (REFD-006). Redirection vers le sous-onglet correspondant.
 */
export default function DocumentTypesRedirect() {
  redirect('/admin/referentials?tab=document-types');
}
