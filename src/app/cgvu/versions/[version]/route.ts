/**
 * GET /cgvu/versions/{version} — ancien permalien (identifiant technique conservé).
 *
 * Lot 102B : redirige vers le permalien PUBLIC de cette version précise (jamais
 * vers une autre version) ; une archive antérieure au lot 102B, non encore
 * republiée par le site, reste consultable telle qu'acceptée
 * (`legal-redirects.ts`). Sans session ni cookie (accessible après fermeture
 * du compte).
 */
import { respondCguvVersion } from '@/services/legal/legal-redirects';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ version: string }> }) {
  const { version } = await params;
  return respondCguvVersion(version);
}
