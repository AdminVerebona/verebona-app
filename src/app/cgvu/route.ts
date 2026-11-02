/**
 * GET /cgvu — ancienne adresse des CGUV (identifiant technique conservé).
 *
 * Lot 102B : le site public est la source juridique unique. Cette adresse
 * redirige vers l'URL publique officielle des CGUV ; l'application ne sert
 * plus de texte juridique.
 */
import { redirectToPublicCguv } from '@/services/legal/legal-redirects';

export const dynamic = 'force-dynamic';

export async function GET() {
  return redirectToPublicCguv();
}
