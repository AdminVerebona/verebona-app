/**
 * GET /cguv/versions/{version} — permalien historique d'une version acceptée
 * (lot 102B) : permalien public de la version, ou archive de preuve figée
 * d'une version antérieure non encore republiée par le site public.
 */
import { respondCguvVersion } from '@/services/legal/legal-redirects';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ version: string }> }) {
  const { version } = await params;
  return respondCguvVersion(version);
}
