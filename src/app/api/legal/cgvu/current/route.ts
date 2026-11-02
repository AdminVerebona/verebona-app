/**
 * GET /api/legal/cgvu/current — ancienne adresse (lot 102B).
 *
 * Redirige vers l'URL publique officielle des CGUV. Les métadonnées de la
 * version en vigueur (sans texte) : `GET /api/legal/cguv/current`.
 */
import { redirectToPublicCguv } from '@/services/legal/legal-redirects';

export const dynamic = 'force-dynamic';

export async function GET() {
  return redirectToPublicCguv();
}
