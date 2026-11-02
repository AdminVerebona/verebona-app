/**
 * GET /api/legal/cgvu/versions/{version} — ancienne adresse (lot 102B) :
 * redirige vers le permalien public de cette version précise.
 */
import { respondCguvVersion } from '@/services/legal/legal-redirects';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ version: string }> }) {
  const { version } = await params;
  return respondCguvVersion(version);
}
