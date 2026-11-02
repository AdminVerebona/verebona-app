import { redirect } from 'next/navigation';

/**
 * Ancienne adresse de l'écran des conditions générales (identifiant technique
 * conservé). Lot 102B : l'écran BO est « CGUV » — référentiel des versions
 * relu dans le manifeste du site public, sans édition de texte.
 */
export default function LegacyRedirect() {
  redirect('/admin/cguv');
}
