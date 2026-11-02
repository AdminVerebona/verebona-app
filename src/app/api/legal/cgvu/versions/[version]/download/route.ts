/**
 * GET /api/legal/cgvu/versions/{version}/download — ancienne adresse (lot 102B) :
 * redirige vers le permalien public de la version (le site public propose
 * l'enregistrement et l'impression) ; archive figée en téléchargement pour une
 * version antérieure non encore republiée.
 */
import { respondCguvVersion } from '@/services/legal/legal-redirects';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ version: string }> }) {
  const { version } = await params;
  return respondCguvVersion(version, { download: true });
}
