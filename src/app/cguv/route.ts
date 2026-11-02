/** GET /cguv — redirige vers l'URL publique officielle des CGUV (lot 102B). */
import { redirectToPublicCguv } from '@/services/legal/legal-redirects';

export const dynamic = 'force-dynamic';

export async function GET() {
  return redirectToPublicCguv();
}
